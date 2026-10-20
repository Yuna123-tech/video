import { GoogleGenAI, Type, Modality } from "@google/genai";
import { CharacterProfile, AspectRatio, ScriptAnalysisResult, NarrationSettings, PhotoPlacement, CharacterPresence, PresenterPose } from "../types";
import { dataUrlToInlineData } from "./imageUtils";
import { CallKind, getBudgetSettings, checkBudget, recordCall, markExhausted, isHardQuotaError, isRateLimitError, BudgetError } from "./budgetService";
import { NARRATION_STYLES, SPEED_DIRECTIONS, TTS_MODELS } from "../constants";
import { base64ToInt16, parseSampleRate, processSpeech, applyPronunciationDict } from "./audioUtils";

// API key: one the user typed into the app (saved in this browser) wins over the build-time key.
// In AI Studio the build-time key is AI Studio's own; locally it comes from GEMINI_API_KEY in .env.local.
const USER_KEY_STORAGE = 'geminiApiKey';

export const getUserApiKey = (): string => {
  try { return localStorage.getItem(USER_KEY_STORAGE) || ''; } catch { return ''; }
};

export const setUserApiKey = (key: string) => {
  try {
    if (key.trim()) localStorage.setItem(USER_KEY_STORAGE, key.trim());
    else localStorage.removeItem(USER_KEY_STORAGE);
  } catch { /* storage unavailable */ }
};

export const getApiKeySource = (): 'user' | 'env' | 'none' =>
  getUserApiKey() ? 'user' : process.env.API_KEY ? 'env' : 'none';

const getApiKey = () => getUserApiKey() || process.env.API_KEY || '';

const getClient = () => new GoogleGenAI({ apiKey: getApiKey() });

// --- Usage tracking: how many calls of each kind this session made, and their tokens ---
export interface UsageStats {
  text: number;
  image: number;
  tts: number;
  video: number;
  inputTokens: number;
  outputTokens: number;
}

const emptyUsage = (): UsageStats => ({ text: 0, image: 0, tts: 0, video: 0, inputTokens: 0, outputTokens: 0 });
let usage = emptyUsage();
const usageListeners = new Set<(u: UsageStats) => void>();

export const subscribeUsage = (fn: (u: UsageStats) => void) => {
  usageListeners.add(fn);
  fn(usage);
  return () => { usageListeners.delete(fn); };
};

export const resetUsage = () => {
  usage = emptyUsage();
  usageListeners.forEach(fn => fn(usage));
};

const trackUsage = (kind: 'text' | 'image' | 'tts' | 'video', response?: any) => {
  const meta = response?.usageMetadata;
  usage = {
    ...usage,
    [kind]: usage[kind] + 1,
    inputTokens: usage.inputTokens + (meta?.promptTokenCount || 0),
    outputTokens: usage.outputTokens + (meta?.candidatesTokenCount || 0),
  };
  usageListeners.forEach(fn => fn(usage));
  recordCall(kind);
};

// Every API request goes through here: refuse when over budget, count it when it succeeds
async function guardedCall<T>(kind: CallKind, fn: () => Promise<T>): Promise<T> {
  checkBudget(kind);
  const res = await fn();
  trackUsage(kind, res);
  return res;
}

const KIND_NAMES: Record<CallKind, string> = { text: '대본 분석', image: '이미지', tts: '음성', video: 'Veo 영상' };

// When Google says the daily/free quota (or spending cap) is used up, stop calling that kind for today
async function stopOnExhaustion<T>(kind: CallKind, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (!(error instanceof BudgetError) && isHardQuotaError(msg)) {
      markExhausted(kind, 'Google 무료/일일 한도 소진');
      throw new BudgetError(kind, `Google에서 ${KIND_NAMES[kind]} 한도가 소진됐다고 응답했습니다. 추가 요금이 나가지 않도록 여기서 멈춥니다.`);
    }
    throw error;
  }
}

// In saving mode, re-running the same script with the same settings reuses the previous analysis
const analysisCache = new Map<string, ScriptAnalysisResult>();

const cachedAnalysis = async (args: unknown[], run: () => Promise<ScriptAnalysisResult>): Promise<ScriptAnalysisResult> => {
  const key = hashString(JSON.stringify(args));
  const hit = analysisCache.get(key);
  if (hit && getBudgetSettings().savingMode) return structuredClone(hit);
  const result = await run();
  analysisCache.set(key, structuredClone(result));
  return result;
};

// Tiny string hash for cache keys (photos are big data URLs)
const hashString = (str: string) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + str.length.toString(36);
};

// Retry Helper for Stability
async function retryWithDelay<T>(
  operation: () => Promise<T>,
  retries = 3, 
  delay = 2000
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const msg = error.message || JSON.stringify(error);
    if (retries <= 0 || error instanceof BudgetError || isHardQuotaError(msg)) throw error;
    const isRateLimit = isRateLimitError(msg);
    const isTransient = msg.includes("500") || msg.includes("503") || msg.includes("Rpc failed") || msg.includes("server error") || msg.includes("overloaded");

    if (isRateLimit || isTransient) {
        const waitTime = isRateLimit ? Math.max(delay, 5000) : delay;
        console.warn(`API Error. Retrying in ${waitTime}ms... (${retries} left).`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return retryWithDelay(operation, retries - 1, waitTime * 2); 
    }
    throw error;
  }
}

// Helper to clean text
const cleanScriptText = (text: string): string => {
    if (!text) return "";
    return text
        .replace(/\*\*(.*?)\*\*/g, '$1') 
        .replace(/\*(.*?)\*/g, '$1')     
        .replace(/__(.*?)__/g, '$1')     
        .replace(/\[.*?\]/g, '')
        .replace(/\([^)]*\)/g, '')  // non-greedy: "A(1) B (2) C" must keep "B"
        .replace(/\s{2,}/g, ' ')
        .trim();
};

// Helper: Generate content with fallback
async function generateContentWithFallback(
    ai: GoogleGenAI,
    modelParams: any,
    useFlashFallback: boolean = true
) {
  return stopOnExhaustion('text', async () => {
    try {
        return await retryWithDelay(() => guardedCall('text', () => ai.models.generateContent(modelParams)), 1, 2000);
    } catch (error: any) {
        if (!useFlashFallback || error instanceof BudgetError) throw error;
        const msg = error.message || JSON.stringify(error);
        // The lighter model has its own (larger) quota, so it can often finish the job within the free tier
        if (isRateLimitError(msg)) {
             console.warn("Falling back to gemini-3.1-flash-lite.");
             const fallbackParams = { ...modelParams, model: "gemini-3.1-flash-lite" };
             return await retryWithDelay(() => guardedCall('text', () => ai.models.generateContent(fallbackParams)), 3, 5000);
        }
        throw error;
    }
  });
}

// Shared metadata/thumbnail instructions for both analysis modes
const METADATA_INSTRUCTIONS = `
    - YouTube Metadata:
      - title: Punchy Korean video title (high CTR, crisp)
      - titleEn: Natural English title for global audience
      - description: Clean YouTube video description with summary and timestamps
      - tags: Array of 5-8 relevant SEO keywords (Korean and English)
      - thumbnailText: The big text printed ON the thumbnail. NOT the title — a short curiosity hook in 2 lines separated by "\\n",
        each line at most ~9 Korean characters (e.g. "월급 300만원\\n이렇게 썼더니", "아무도 몰랐던\\n진짜 이유"). No emoji, no quotes.
      - thumbnailPrompt: English prompt for the thumbnail BACKGROUND image: one clear subject with strong emotion or a striking object,
        high contrast, vibrant colors, cinematic lighting, with clean empty space on one side for big title text. NO text or letters in the image.`;

const METADATA_SCHEMA = {
  title: { type: Type.STRING },
  titleEn: { type: Type.STRING },
  description: { type: Type.STRING },
  tags: { type: Type.ARRAY, items: { type: Type.STRING } },
  thumbnailText: { type: Type.STRING },
  thumbnailPrompt: { type: Type.STRING },
};

const parseJson = (text: string | undefined) =>
  JSON.parse((text || "{}").replace(/^```json\s*/, "").replace(/\s*```$/, ""));

const parseMetadata = (data: any, photoCount: number) => ({
  title: data.title,
  titleEn: data.titleEn || data.title,
  description: data.description || "",
  tags: data.tags || [],
  thumbnailText: (data.thumbnailText || data.title || "").replace(/\\n/g, "\n").trim(),
  thumbnailPrompt: data.thumbnailPrompt,
  thumbnailPhotoIndex: validPhotoIndex(data.thumbnailPhotoIndex, photoCount),
});

const validPhotoIndex = (value: any, photoCount: number): number | undefined =>
  Number.isInteger(value) && value >= 0 && value < photoCount ? value : undefined;

const validPose = (value: any): PresenterPose | undefined =>
  POSES.includes(value) ? value : undefined;

const clamp01 = (value: any): number | undefined =>
  typeof value === 'number' && isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;

// Label each photo so the model can refer to it by index
const photoParts = (photos: string[]) =>
  photos.flatMap((img, i) => [{ text: `Photo ${i}:` }, dataUrlToInlineData(img)]);

const NARRATION_RULES = (language: string, isKorean: boolean) => `
    🚨 CRITICAL DIRECTIVE 1: STRICTLY NO GREETINGS OR INTRODUCTION FLUFF!
    - DO NOT start with any greeting (e.g. absolutely NO "안녕하세요", "여러분 안녕하세요", "반갑습니다", "Hello everyone", "오늘 영상에서는...", "오늘 알아볼 것은...", "채널 구독과 좋아요...").
    - Jump IMMEDIATELY into the core hook, central question, or main body of content in Scene 1!
    - The very first second must grab the viewer's attention with substance, not introductory pleasantries.

    📖 CRITICAL DIRECTIVE 2: CLEAN, READABLE SCRIPT & DUAL SUBTITLES
    - Divide the narration into clean, easy-to-read scene segments.
    - Korean Narration ('text'): Natural, polite, engaging tone (해요체/존댓말). Highly readable sentences without filler words.
    - TTS Script ('ttsText'): The SAME sentence as 'text', rewritten exactly as it should be SPOKEN by a text-to-speech voice.
      Write numbers, units, dates, symbols and English words/acronyms the way a native speaker reads them aloud
      (e.g. "3가지" -> "세 가지", "2026년" -> "이천이십육 년", "50%" -> "오십 퍼센트", "AI" -> "에이아이", "GPT-5" -> "지피티 파이브").
      Add commas where a natural speaker would breathe. Do not change the meaning or add words.
    - English Subtitle ('textEn'): Provide an accurate, natural, fluent English subtitle for EVERY scene, perfectly suited for YouTube international viewers and dual-subtitle overlays.
    - Language for narration: ${language} ${isKorean ? "(text must be Korean)" : ""}`;

const POSES: PresenterPose[] = ['explain', 'point', 'surprised', 'happy'];

const characterDetails = (character: CharacterProfile, description: string) =>
  description.trim()
    ? `${character.name} (${character.stylePrompt}), Appearance details: ${description.trim()}`
    : `${character.name} (${character.stylePrompt})`;

// The narrator character hosts the video: narration is written in its voice, and each scene gets a pose
const PRESENTER_RULES = (charDetails: string, presence: CharacterPresence) => presence === 'none' ? '' : `
    🎙️ CRITICAL DIRECTIVE: THE CHARACTER HOSTS THIS VIDEO
    - The user's narrator character [${charDetails}] is on screen in EVERY scene and personally explains everything to the viewer.
    - Write ALL narration as this character speaking directly to the viewer, explainer-video style: friendly and confident,
      asks the viewer short questions ("왜 그럴까요?"), reacts to facts ("놀랍게도", "여기서 중요한 건요"), and keeps the SAME personality in every scene.
    - Still no greetings or self-introductions; start explaining immediately.
    - For each scene choose 'pose' for the character:
      "explain" (default, calmly explaining), "point" (introducing/pointing at something shown), "surprised" (shocking fact or twist), "happy" (good news, tip, conclusion).
      Vary poses naturally; use "explain" for most scenes.`;

/**
 * MODE 1: Analyze Script and Break Down into Scenes.
 * Optional user photos are placed into the scenes they fit; the rest get AI images.
 */
export const analyzeScriptAndBreakdown = (...args: Parameters<typeof analyzeScriptUncached>) =>
  cachedAnalysis(['script', ...args], () => analyzeScriptUncached(...args));

const analyzeScriptUncached = async (
  script: string,
  character: CharacterProfile,
  customCharacterDescription: string,
  language: string,
  aspectRatio: string,
  presence: CharacterPresence,
  presenterPosition: 'left' | 'right',
  photos: string[] = [] // Downscaled user photos for vision analysis
): Promise<ScriptAnalysisResult> => {
  const ai = getClient();
  const isKorean = language.includes('ko') || language.includes('Korean');
  const isShortForm = aspectRatio === AspectRatio.Shorts || aspectRatio === AspectRatio.Square;
  const charDetails = characterDetails(character, customCharacterDescription);

  const characterInstruction = presence === 'in_scene'
      ? `- **CHARACTER INCLUSION**: The user has configured a custom narrator character: [${charDetails}].
         Every scene's 'visualPrompt' MUST prominently feature this character reacting to, demonstrating, or narrating the scene content while maintaining strict visual style consistency.
         Describe the character the same way in every visualPrompt (a reference image of the character is supplied to the image model).`
      : presence === 'overlay'
      ? `- **PRESENTER OVERLAY**: The narrator character is composited onto every scene separately, standing in the lower-${presenterPosition} corner.
         Do NOT draw the narrator character in visualPrompt. Show the topic itself: objects, places, situations, illustrated diagrams or metaphors that make the explanation easy to grasp.
         Keep the lower-${presenterPosition} area visually simple (no key subject there). Use a consistent art style across scenes: ${character.stylePrompt}.`
      : `- **CONSISTENCY**: Focus on environment and subject visuals matching the script.`;

  const visualInstruction = presence === 'in_scene'
      ? `- **VISUAL COMPOSITION**: Character is clearly visible and integrated into the scene context (e.g., side guide, active narrator, or central demonstrator depending on the scene). High visual appeal.`
      : `- **VISUAL COMPOSITION**: Expressive, clear shot matching the scene script.`;

  // Pacing & Readability
  const pacingInstruction = isShortForm
    ? `- **Structure**: Fast, punchy short-form pacing. 1 clear, short sentence per scene (3-5s). Maximum 15-20 words per scene.
       - Ultra-clean readability on mobile screens.`
    : `- **Structure**: Dynamic, well-cut pacing. 1-2 clear, rhythmic sentences per scene (4-7s).
       - Ensure natural flow, no run-on sentences, and clean breaks for easy subtitle reading.`;

  const photoInstruction = photos.length
    ? `
    📷 CRITICAL DIRECTIVE 4: USER'S OWN PHOTOS
    - The user attached ${photos.length} of their own photos (Photo 0 .. Photo ${photos.length - 1}). Real photos make the video personal, so use them where they genuinely fit.
    - For each scene set 'photoIndex' to the photo that matches what the narration is talking about, or -1 if none fits (an AI image will be generated from visualPrompt).
    - Try to use every relevant photo at least once, in an order that supports the story. Never force an unrelated photo into a scene.
    - Still write 'visualPrompt' for every scene. For AI-image scenes, match the look and mood of the user's photos so the video feels consistent.
    - For scenes with a photo, set focusX/focusY (0-1) to where the main subject (face, person, key object) is in that photo.
    - thumbnailPhotoIndex: the most eye-catching photo for the thumbnail (clear subject, emotion, good light), or -1 if none is suitable.`
    : '';

  const systemPrompt = `
    You are an elite YouTube Creator & Video Director.
    TASK: Transform the user's script/idea into a polished, high-engagement video scene breakdown with bilingual English subtitles.
    ${NARRATION_RULES(language, isKorean)}
    ${PRESENTER_RULES(charDetails, presence)}
    ${pacingInstruction}

    🎨 CRITICAL DIRECTIVE 3: VISUAL PROMPT & CHARACTER CONSISTENCY
    ${characterInstruction}
    ${visualInstruction}
    - Visual prompt must be in English for image generation models.
    - NO text, words, watermarks, or microphone in visualPrompt.
    ${photoInstruction}
    ${METADATA_INSTRUCTIONS}
    - Output Format: JSON
  `;

  const sceneProps: Record<string, any> = {
    text: { type: Type.STRING, description: "Korean narration text (NO greetings, clean and readable)" },
    ttsText: { type: Type.STRING, description: "Same narration in fully spoken form for TTS (numbers/English written as pronounced)" },
    textEn: { type: Type.STRING, description: "Fluent English subtitle translation" },
    visualPrompt: { type: Type.STRING, description: "Detailed visual prompt in English for this scene" },
  };
  if (presence !== 'none') sceneProps.pose = { type: Type.STRING, enum: POSES };
  const metadataProps: Record<string, any> = { ...METADATA_SCHEMA };
  if (photos.length) {
    sceneProps.photoIndex = { type: Type.INTEGER, description: "Index of the user photo used for this scene, or -1" };
    sceneProps.focusX = { type: Type.NUMBER };
    sceneProps.focusY = { type: Type.NUMBER };
    metadataProps.thumbnailPhotoIndex = { type: Type.INTEGER };
  }

  const response = await generateContentWithFallback(ai, {
    model: "gemini-3.8-flash", 
    contents: photos.length ? { parts: [{ text: `SCRIPT / IDEA:\n${script}` }, ...photoParts(photos)] } : script,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          ...metadataProps,
          scenes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: sceneProps,
              required: ["text", "ttsText", "textEn", "visualPrompt"]
            }
          }
        },
        required: ["title", "thumbnailText", "thumbnailPrompt", "scenes"]
      }
    }
  });

  const data = parseJson(response.text);
  const scenes = (data.scenes || []).map((item: any, index: number) => ({
    id: index,
    text: cleanScriptText(item.text),
    ttsText: item.ttsText ? cleanScriptText(item.ttsText) : undefined,
    textEn: cleanScriptText(item.textEn || ""),
    visualPrompt: item.visualPrompt,
    duration: isShortForm ? 4 : 6, 
    pose: validPose(item.pose),
    photoIndex: validPhotoIndex(item.photoIndex, photos.length),
    focusX: clamp01(item.focusX),
    focusY: clamp01(item.focusY),
  }));

  return { metadata: parseMetadata(data, photos.length), scenes };
};

/**
 * MODE 2: Photos only. Writes (or fits the user's) narration to the user's photos.
 */
export const analyzeImagesAndCreateScript = (...args: Parameters<typeof analyzeImagesUncached>) =>
  cachedAnalysis(['images', ...args], () => analyzeImagesUncached(...args));

const analyzeImagesUncached = async (
  images: string[], // Downscaled user photos for vision analysis
  contextPrompt: string,
  character: CharacterProfile,
  language: string,
  aspectRatio: string,
  placement: PhotoPlacement = 'auto',
  customCharacterDescription = '',
  presence: CharacterPresence = 'overlay'
): Promise<ScriptAnalysisResult> => {
  // Photos can't contain the drawn character, so it always presents from the corner here
  const photoPresence: CharacterPresence = presence === 'none' ? 'none' : 'overlay';
  const ai = getClient();
  const isShortForm = aspectRatio === AspectRatio.Shorts || aspectRatio === AspectRatio.Square;
  const isKorean = language.includes('ko') || language.includes('Korean');

  const lengthInstruction = isShortForm
    ? `Short-form YouTube Shorts style: 3-5 seconds per scene. 1 punchy sentence per scene.`
    : `Detailed story: 1-2 sentences (5-10 seconds) per scene. Dynamic and engaging.`;

  const placementInstruction = placement === 'ordered'
    ? `- PHOTO ORDER IS FIXED: create exactly ${images.length} scenes, scene i uses Photo i (imageIndex = i). The narration must follow this order.`
    : `- Arrange the photos in the most compelling story order (not necessarily the upload order).
       - Use EVERY photo at least once. A photo may span 2 consecutive scenes if the narration needs more time there.`;

  const promptText = `
    You are an expert YouTube Creator and video editor.
    TASK: Edit the user's own ${images.length} photos (Photo 0 .. Photo ${images.length - 1}) into a video with narration and dual English subtitles.
    Narrator Character: ${characterDetails(character, customCharacterDescription)}
    ${lengthInstruction}

    USER INPUT (topic, notes, or a full script):
    """
    ${contextPrompt || "(none) — explain the story the photos tell, engagingly."}
    """
    - If the user input is a complete script (several sentences), KEEP its wording as the narration and split it across the photos so each sentence lands on the photo it describes.
    - Otherwise, write new narration from what is actually visible in the photos plus the user's topic. Describe real details (places, food, people's actions, mood); never invent things that contradict the photos.

    📷 PHOTO EDITING:
    ${placementInstruction}
    - focusX/focusY (0-1): where the main subject (face, person, key object) is in that scene's photo, so the crop keeps it in frame.
    - thumbnailPhotoIndex: the most eye-catching photo for the thumbnail (clear subject, emotion, good light).
    ${NARRATION_RULES(language, isKorean)}
    ${PRESENTER_RULES(characterDetails(character, customCharacterDescription), photoPresence)}
    ${METADATA_INSTRUCTIONS}
  `;

  const response = await generateContentWithFallback(ai, {
    model: "gemini-3.8-flash",
    contents: { parts: [{ text: promptText }, ...photoParts(images)] },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          ...METADATA_SCHEMA,
          thumbnailPhotoIndex: { type: Type.INTEGER },
          scenes: {
            type: Type.ARRAY,
            items: { 
              type: Type.OBJECT, 
              properties: { 
                imageIndex: { type: Type.INTEGER }, 
                text: { type: Type.STRING, description: "Korean narration, NO greetings" },
                ttsText: { type: Type.STRING, description: "Same narration in fully spoken form for TTS" },
                textEn: { type: Type.STRING, description: "English subtitle translation" },
                focusX: { type: Type.NUMBER },
                focusY: { type: Type.NUMBER },
                pose: { type: Type.STRING, enum: POSES },
              },
              required: ["imageIndex", "text", "textEn"]
            }
          }
        },
        required: ["title", "thumbnailText", "thumbnailPrompt", "scenes"]
      }
    }
  });

  const data = parseJson(response.text);
  const scenes = (data.scenes || []).map((item: any, index: number) => {
    const photoIndex = placement === 'ordered'
      ? index % images.length
      : validPhotoIndex(item.imageIndex, images.length) ?? index % images.length;
    return {
      id: index,
      text: cleanScriptText(item.text),
      ttsText: item.ttsText ? cleanScriptText(item.ttsText) : undefined,
      textEn: cleanScriptText(item.textEn || ""),
      visualPrompt: "User uploaded image",
      photoIndex,
      focusX: clamp01(item.focusX),
      focusY: clamp01(item.focusY),
      pose: photoPresence === 'none' ? undefined : validPose(item.pose),
      duration: isShortForm ? 4 : 7,
    };
  });

  return { metadata: parseMetadata(data, images.length), scenes };
};

const IMAGE_MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"];

// Try the newest image model first, fall back to the older one
const generateImage = (parts: any[], aspectRatio: string): Promise<string> => {
  const ai = getClient();
  return stopOnExhaustion('image', () => retryWithDelay(async () => {
    let lastError: any;
    for (const model of IMAGE_MODELS) {
      try {
        const response = await guardedCall('image', () => ai.models.generateContent({
          model,
          contents: { parts },
          config: { imageConfig: { aspectRatio: aspectRatio as any } }
        }));
        for (const part of response.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
        }
        lastError = new Error("No image data");
      } catch (err: any) {
        if (err instanceof BudgetError) throw err;
        console.warn(`${model} failed`, err);
        lastError = err;
      }
    }
    throw lastError;
  }));
};

export const generateSceneImage = async (
  prompt: string,
  aspectRatio: string,
  styleRef?: string | null,
  characterRef?: string | null // Presenter image: keeps the character identical across scenes
): Promise<string> => {
  const parts: any[] = [{ text: prompt + " . High quality illustration. Vibrant composition. NO TEXT. NO MICROPHONE." }];
  if (characterRef) {
    parts.push({ text: "Character reference — the character in this scene must be EXACTLY this character (same face, hair, outfit, colors and art style), in a pose that fits the scene:" });
    parts.push(dataUrlToInlineData(characterRef));
  }
  if (styleRef) {
    parts.push({ text: "Art style reference:" });
    parts.push(dataUrlToInlineData(styleRef));
    parts[0].text += " Match the art style of the style reference.";
  }
  return generateImage(parts, aspectRatio);
};

const POSE_DIRECTIONS: Record<PresenterPose, string> = {
  explain: 'explaining with one open palm raised at chest height, friendly confident smile, looking at the viewer',
  point: `pointing with one arm toward the side of the frame as if presenting something next to them, engaged expression`,
  surprised: 'surprised expression, eyebrows raised, mouth open, hands up near the face',
  happy: 'big happy smile, giving a thumbs up, energetic',
};

const GREEN_SCREEN = 'Waist-up shot, the whole head and both hands inside the frame, character centered. ' +
  'Background: one flat, perfectly uniform pure chroma-key green (#00FF00) with no gradient, no floor, no shadows and no objects. ' +
  'Do not use green anywhere on the character. No text, no logo, no microphone.';

// Base presenter image for the user's narrator character (on a green screen, keyed out later)
export const generatePresenterImage = async (
  character: CharacterProfile,
  description: string,
  styleRef?: string | null
): Promise<string> => {
  const parts: any[] = [{
    text: `A YouTube explainer-video host character: ${characterDetails(character, description)}. ` +
      `Pose: ${POSE_DIRECTIONS.explain}. Clean, appealing character design that reads well at small size. ${GREEN_SCREEN}`
  }];
  if (styleRef) {
    parts.push({ text: "Art style reference:" });
    parts.push(dataUrlToInlineData(styleRef));
  }
  return generateImage(parts, '3:4');
};

// Same character, different pose — the base image is the identity reference
export const generatePresenterPose = async (base: string, pose: PresenterPose): Promise<string> =>
  generateImage([
    dataUrlToInlineData(base),
    {
      text: `Draw EXACTLY this same character again — identical face, hair, outfit, colors, proportions and art style. ` +
        `Only change the pose and expression: ${POSE_DIRECTIONS[pose]}. ${GREEN_SCREEN}`
    },
  ], '3:4');

export const generateThumbnailImage = async (prompt: string, aspectRatio: string, styleRef?: string | null): Promise<string> => {
  const parts: any[] = [{
    text: `${prompt}. YouTube thumbnail background: bold, high contrast, saturated colors, dramatic lighting, one large clear focal subject, ` +
      `clean uncluttered area on one side reserved for big title text. Absolutely NO text, letters, numbers, logos or watermarks.`
  }];
  if (styleRef) {
    parts.push(dataUrlToInlineData(styleRef));
    parts[0].text += " Match this art style.";
  }
  return generateImage(parts, aspectRatio);
};

// Restyle the user's own photo into a punchier thumbnail background, keeping the subject identical
export const enhancePhotoForThumbnail = async (photo: string, hook: string, aspectRatio: string): Promise<string> =>
  generateImage([
    dataUrlToInlineData(photo),
    {
      text: `Turn this photo into a striking YouTube thumbnail background (${aspectRatio}). The video hook is: "${hook.replace(/\n/g, ' ')}". ` +
        `Keep the people, their faces and identity, and the main subject EXACTLY as in the photo — do not change who or what it is. ` +
        `Reframe so the subject is large and prominent, boost contrast and color, add cinematic lighting and gentle background depth, ` +
        `and leave clean space on one side for big title text. Do NOT add any text, letters, logos, stickers or watermarks.`
    },
  ], aspectRatio);

export const generateSceneVideo = async (prompt: string, aspectRatio: string): Promise<string | undefined> => {
    const ai = getClient();
    try {
        const style = " . 2D animation style. Wide shot. NO TEXT.";
        checkBudget('video');
        let operation = await ai.models.generateVideos({
            model: 'veo-3.1-fast-generate-preview',
            prompt: prompt + style,
            config: { numberOfVideos: 1, resolution: '720p', aspectRatio: (aspectRatio === AspectRatio.Square ? AspectRatio.Shorts : aspectRatio) as any }
        });
        trackUsage('video');
        const startTime = Date.now();
        while (!operation.done) {
            if (Date.now() - startTime > 150000) throw new Error("Timeout");
            await new Promise(r => setTimeout(r, 6000));
            operation = await ai.operations.getVideosOperation({ operation });
        }
        const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
        if (!videoUri) throw new Error("No URI");
        const res = await fetch(`${videoUri}&key=${getApiKey()}`);
        const blob = await res.blob();
        return URL.createObjectURL(blob);
    } catch (error) {
        console.warn("Veo Error:", error);
        return undefined;
    }
}

const buildTtsPrompt = (text: string, settings: NarrationSettings): string => {
  const preset = NARRATION_STYLES.find(st => st.id === settings.styleId);
  const style = settings.styleId === 'custom' ? settings.customStyle.trim() : preset?.prompt || '';
  const speed = SPEED_DIRECTIONS[settings.speed] || '';
  const direction = [style, speed].filter(Boolean).join('. ').replace(/\.\s*$/, '');
  // "Direction: text" is the prompt format Gemini TTS is tuned for; it speaks only the text.
  return direction ? `${direction}:\n${text}` : text;
};

async function synthesizeOnce(ai: GoogleGenAI, model: string, prompt: string, voice: string) {
  const response = await guardedCall('tts', () => ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } },
    },
  }));
  const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  // TTS occasionally returns text or nothing; treat as transient so it gets retried.
  if (!part?.inlineData?.data) throw new Error("503 No audio returned");
  return { base64: part.inlineData.data, mimeType: part.inlineData.mimeType };
}

export interface SceneAudio {
  audioUrl: string;
  duration: number;
  speechOffset: number;
  speechDuration: number;
}

// Same text + same voice settings = same audio, so never pay for it twice
const audioCache = new Map<string, SceneAudio>();

export const generateSceneAudio = async (
  text: string,
  settings: NarrationSettings,
  isLastScene = false
): Promise<SceneAudio> => {
  const ai = getClient();
  const spoken = applyPronunciationDict(cleanScriptText(text), settings.pronunciationDict);
  if (!spoken) throw new Error("빈 내레이션입니다.");
  const prompt = buildTtsPrompt(spoken, settings);
  const cacheKey = JSON.stringify([prompt, settings.voiceName, settings.model, settings.pauseSeconds, isLastScene]);
  const cached = audioCache.get(cacheKey);
  if (cached) return cached;
  const audio = await stopOnExhaustion('tts', () => synthesizeAudio(ai, prompt, settings, isLastScene));
  audioCache.set(cacheKey, audio);
  return audio;
};

const synthesizeAudio = async (ai: GoogleGenAI, prompt: string, settings: NarrationSettings, isLastScene: boolean): Promise<SceneAudio> => {
  let result;
  try {
    result = await retryWithDelay(() => synthesizeOnce(ai, TTS_MODELS[settings.model], prompt, settings.voiceName), 3, 3000);
  } catch (err) {
    if (settings.model === 'flash' || err instanceof BudgetError) throw err;
    console.warn("Pro TTS failed, falling back to Flash TTS", err);
    result = await retryWithDelay(() => synthesizeOnce(ai, TTS_MODELS.flash, prompt, settings.voiceName), 3, 3000);
  }

  const processed = processSpeech(base64ToInt16(result.base64), {
    sampleRate: parseSampleRate(result.mimeType),
    pauseAfter: isLastScene ? Math.max(settings.pauseSeconds, 0.8) : settings.pauseSeconds,
  });

  return {
    audioUrl: URL.createObjectURL(processed.wav),
    duration: processed.duration,
    speechOffset: processed.speechOffset,
    speechDuration: processed.speechDuration,
  };
};
