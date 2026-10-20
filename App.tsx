import React, { useState, useRef, useMemo, useEffect } from 'react';
import { VideoConfig, Scene, GenerationStatus, AspectRatio, GenerationProgress, VideoMetadata, GenerationMode, SubtitleMode, NarrationSettings, PresenterAsset, PresenterPose, PresenterSettings } from './types';
import { CHARACTERS, LANGUAGES, VOICES, ASPECT_RATIOS, NARRATION_STYLES, PAUSE_OPTIONS } from './constants';
import { analyzeScriptAndBreakdown, analyzeImagesAndCreateScript, generateSceneImage, generateSceneAudio, generateSceneVideo, generateThumbnailImage, generatePresenterImage, generatePresenterPose } from './services/geminiService';
import { renderAndDownloadVideo, downloadSrtFile } from './services/recorderService';
import { downscaleDataUrl } from './services/imageUtils';
import { PhotoManager, readPhotoFiles } from './components/PhotoManager';
import { ThumbnailStudio } from './components/ThumbnailStudio';
import { PresenterPanel } from './components/PresenterPanel';
import { ApiUsagePanel } from './components/ApiUsagePanel';
import { BudgetError, CALL_LABELS, CallKind, getBudgetSettings, remainingCalls, subscribeBudget } from './services/budgetService';
import { preparePresenterImage, presenterSignature, loadPresenterSettings, savePresenterSettings, flattenImage, POSE_LABELS } from './services/presenterService';
import { VideoPlayer } from './components/VideoPlayer';
import { 
  Sparkles, Video, Type as TypeIcon, Image as ImageIcon, Music, Loader2, 
  AlertCircle, Film, Camera, Download, Upload, X, Youtube, User, Save, 
  Lock, Layers, FileImage, History, RotateCcw, Play, Subtitles, Globe, 
  Check, Copy, Edit3, AlignLeft, FileText, RefreshCw, Mic, Volume2, BookA 
} from 'lucide-react';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_NARRATION: NarrationSettings = {
  voiceName: 'Kore',
  styleId: 'natural',
  customStyle: '',
  speed: 'normal',
  pauseSeconds: 0.35,
  model: 'flash',
  pronunciationDict: '',
};

const loadNarrationSettings = (): NarrationSettings => {
  try {
    return { ...DEFAULT_NARRATION, ...JSON.parse(localStorage.getItem('narrationSettings') || '{}') };
  } catch {
    return DEFAULT_NARRATION;
  }
};

const VOICE_PREVIEW_TEXT = "요즘 가장 많이 듣는 질문이 있어요. 정말 이렇게 쉽게 영상을 만들 수 있냐는 거죠. 직접 들어보시면, 차이를 바로 느끼실 거예요.";

export default function App() {
  // Config State
  const [config, setConfig] = useState<VideoConfig>({
    mode: 'text_to_video',
    script: "",
    uploadedImages: [],
    photoPlacement: 'auto',
    characterId: CHARACTERS[0].id, 
    customCharacterDescription: "", 
    aspectRatio: AspectRatio.Shorts,
    language: 'ko',
    narration: loadNarrationSettings(),
    bgm: { url: null, name: '', volume: 0.12 },
    isVideoMode: false,
    styleReferenceImage: null,
    presenter: loadPresenterSettings(),
    subtitleMode: 'dual' // Default to dual subtitles for YouTube reach
  });

  // App State
  const [status, setStatus] = useState<GenerationStatus>(GenerationStatus.Idle);
  const [progress, setProgress] = useState<GenerationProgress>({ total: 0, current: 0, message: '' });
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const multiImageInputRef = useRef<HTMLInputElement>(null);
  
  // Voice Preview State
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [voiceGender, setVoiceGender] = useState<'all' | '여성' | '남성'>('all');
  const [showAdvancedVoice, setShowAdvancedVoice] = useState(false);
  const bgmInputRef = useRef<HTMLInputElement>(null);
  const sceneAudioRef = useRef<HTMLAudioElement | null>(null);

  // Per-scene regeneration state ("audio-3", "image-3")
  const [busyScenes, setBusyScenes] = useState<Record<string, boolean>>({});
  const [isRegeneratingAll, setIsRegeneratingAll] = useState(false);

  // Photo picker per scene & a counter that resets the thumbnail studio on each generation
  const [photoPickerFor, setPhotoPickerFor] = useState<number | null>(null);
  const [generationId, setGenerationId] = useState(0);
  const [showTextModePhotos, setShowTextModePhotos] = useState(false);
  
  // Character History State
  const [characterHistory, setCharacterHistory] = useState<string[]>([]);
  
  // Editable Metadata State
  const [editableTitle, setEditableTitle] = useState("");
  const [editableTitleEn, setEditableTitleEn] = useState("");
  const [copiedTags, setCopiedTags] = useState(false);
  const [copiedDesc, setCopiedDesc] = useState(false);
  
  // Rendering State
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);

  const selectedCharacter = CHARACTERS.find(c => c.id === config.characterId) || CHARACTERS[0];

  // Load Character Description & History from Local Storage on Mount
  useEffect(() => {
      const savedDesc = localStorage.getItem('customCharacterDescription');
      if (savedDesc) {
          setConfig(prev => ({ ...prev, customCharacterDescription: savedDesc }));
      }
      
      try {
          const savedHistory = JSON.parse(localStorage.getItem('characterHistory') || '[]');
          if (Array.isArray(savedHistory)) setCharacterHistory(savedHistory);
      } catch (e) {
          console.error("Failed to load character history", e);
      }
  }, []);

  useEffect(() => {
      localStorage.setItem('narrationSettings', JSON.stringify(config.narration));
  }, [config.narration]);

  const updateNarration = (patch: Partial<NarrationSettings>) =>
      setConfig(prev => ({ ...prev, narration: { ...prev.narration, ...patch } }));

  // --- Presenter character (the narrator who explains on screen) ---
  const [presenterBusy, setPresenterBusy] = useState<string | null>(null);

  // --- Spending guard ---
  const [budget, setBudget] = useState(getBudgetSettings());
  const [budgetNotice, setBudgetNotice] = useState<string | null>(null);
  useEffect(() => subscribeBudget(() => setBudget(getBudgetSettings())), []);

  // Compare what a job needs with what's left today; ask before starting something that can't finish
  const confirmWithinBudget = (needs: Partial<Record<CallKind, number>>, what: string) => {
      const short = (Object.entries(needs) as [CallKind, number][])
          .filter(([kind, n]) => n > 0 && remainingCalls(kind) < n)
          .map(([kind, n]) => `${CALL_LABELS[kind]}: 필요 ${n}회 / 남은 ${remainingCalls(kind)}회`);
      if (!short.length) return true;
      return window.confirm(`${what}에 필요한 호출이 남은 한도보다 많습니다.\n\n${short.join('\n')}\n\n가능한 만큼만 만들고 멈출까요? (취소하면 아무것도 호출하지 않습니다)`);
  };

  useEffect(() => {
      savePresenterSettings(config.presenter);
  }, [config.presenter]);

  const updatePresenter = (patch: Partial<PresenterSettings>) =>
      setConfig(prev => ({ ...prev, presenter: { ...prev.presenter, ...patch } }));

  const currentPresenterSignature = presenterSignature(config.characterId, config.customCharacterDescription);
  const isPresenterOutdated = (asset: PresenterAsset | null) =>
      !asset || (asset.source === 'ai' && asset.signature !== currentPresenterSignature);

  const createAiPresenter = async (): Promise<PresenterAsset> => {
      setPresenterBusy('캐릭터를 그리는 중... (처음 한 번만, 이후 계속 재사용)');
      try {
          const raw = await generatePresenterImage(selectedCharacter, config.customCharacterDescription, config.styleReferenceImage);
          const { url, isCutout } = await preparePresenterImage(raw);
          const asset: PresenterAsset = { base: url, poses: {}, isCutout, source: 'ai', signature: currentPresenterSignature };
          updatePresenter({ asset });
          return asset;
      } finally {
          setPresenterBusy(null);
      }
  };

  const handlePresenterUpload = async (file: File) => {
      setPresenterBusy('이미지 배경 정리 중...');
      try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(file);
          });
          const { url, isCutout } = await preparePresenterImage(dataUrl);
          updatePresenter({ asset: { base: url, poses: {}, isCutout, source: 'upload', signature: '' } });
      } catch (e: any) {
          alert(`캐릭터 이미지를 열 수 없습니다: ${e.message || e}`);
      } finally {
          setPresenterBusy(null);
      }
  };

  // Extra poses are drawn from the base image so the character stays identical
  const addPresenterPoses = async (asset: PresenterAsset, poses: PresenterPose[]) => {
      const missing = [...new Set(poses)].filter(p => p !== 'explain' && !asset.poses[p]);
      if (!missing.length) return;
      const reference = await flattenImage(asset.base, '#00FF00');
      for (const pose of missing) {
          setPresenterBusy(`포즈 만드는 중: ${POSE_LABELS[pose]}`);
          try {
              const { url, isCutout } = await preparePresenterImage(await generatePresenterPose(reference, pose));
              // A pose whose background couldn't be removed would look different from the base; skip it
              if (isCutout !== asset.isCutout) continue;
              setConfig(prev => prev.presenter.asset?.base === asset.base
                  ? { ...prev, presenter: { ...prev.presenter, asset: { ...prev.presenter.asset, poses: { ...prev.presenter.asset.poses, [pose]: url } } } }
                  : prev);
          } catch (e) {
              console.warn(`Pose ${pose} failed; the base image will be used`, e);
          }
      }
      setPresenterBusy(null);
  };

  const handleGenerateAllPoses = async () => {
      if (!config.presenter.asset) return;
      await addPresenterPoses(config.presenter.asset, Object.keys(POSE_LABELS) as PresenterPose[]);
  };

  // Save Character Description to Local Storage whenever it changes
  useEffect(() => {
      localStorage.setItem('customCharacterDescription', config.customCharacterDescription);
  }, [config.customCharacterDescription]);

  // Helper: Save current description to history list
  const saveToHistory = (desc: string) => {
      if (!desc.trim()) return;
      // Prevent duplicates and keep top 100 most recent
      const newHistory = [desc, ...characterHistory.filter(h => h !== desc)].slice(0, 100);
      setCharacterHistory(newHistory);
      localStorage.setItem('characterHistory', JSON.stringify(newHistory));
  };

  // Calculate estimated duration
  const estimatedDuration = useMemo(() => {
    const cleanText = config.script.replace(/\s/g, '');
    const seconds = cleanText.length / 4.5;
    return seconds;
  }, [config.script]);

  // Handle Style Reference Image
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setConfig({ ...config, styleReferenceImage: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  };

  // Handle Multiple Images for Image-to-Video Mode
  const setPhotos = (photos: string[]) => setConfig(prev => ({ ...prev, uploadedImages: photos }));

  // Swap a scene's visual to one of the user's photos
  const assignPhotoToScene = (sceneIndex: number, photoIndex: number, photos = config.uploadedImages) => {
      patchScene(sceneIndex, { imageUrl: photos[photoIndex], photoIndex, videoUrl: undefined, focusX: undefined, focusY: undefined });
      setPhotoPickerFor(null);
  };

  const handleScenePhotoUpload = async (sceneIndex: number, files: FileList | null) => {
      if (!files?.length) return;
      const { ok, failed } = await readPhotoFiles(files);
      if (failed.length) alert(failed.join('\n'));
      if (!ok.length) return;
      const photos = [...config.uploadedImages, ok[0]];
      setPhotos(photos);
      assignPhotoToScene(sceneIndex, photos.length - 1, photos);
  };

  const handleBgmChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (config.bgm.url) URL.revokeObjectURL(config.bgm.url);
      setConfig(prev => ({ ...prev, bgm: { ...prev.bgm, url: URL.createObjectURL(file), name: file.name } }));
      e.target.value = '';
  };

  const removeBgm = () => {
      if (config.bgm.url) URL.revokeObjectURL(config.bgm.url);
      setConfig(prev => ({ ...prev, bgm: { ...prev.bgm, url: null, name: '' } }));
  };

  const patchScene = (index: number, patch: Partial<Scene>) =>
      setScenes(prev => prev.map((s, idx) => idx === index ? { ...s, ...patch } : s));

  // Saving mode: always the Flash TTS model (cheaper quota than Pro)
  const synthesizeScene = (scene: Scene, index: number, total: number) =>
      generateSceneAudio(
          scene.ttsText || scene.text,
          budget.savingMode ? { ...config.narration, model: 'flash' } : config.narration,
          index === total - 1
      );

  const handlePreviewVoice = async (voiceId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent selecting the voice when clicking preview
    if (previewingVoiceId) return; // Prevent multiple clicks

    setPreviewingVoiceId(voiceId);
    try {
        const { audioUrl } = await generateSceneAudio(VOICE_PREVIEW_TEXT, { ...config.narration, voiceName: voiceId });
        const audio = new Audio(audioUrl);
        audio.onended = () => setPreviewingVoiceId(null);
        audio.onerror = () => {
            console.error("Audio playback error");
            setPreviewingVoiceId(null);
        };
        await audio.play();
    } catch (err) {
        console.error("Preview failed", err);
        alert("미리듣기 실패: 잠시 후 다시 시도해주세요.");
        setPreviewingVoiceId(null);
    }
  };

  const handleGenerate = async () => {
    // Validation
    if (config.mode === 'text_to_video' && !config.script.trim()) {
      setError("대본을 입력해주세요.");
      return;
    }
    if (config.mode === 'image_to_video' && config.uploadedImages.length === 0) {
      setError("최소 1장 이상의 사진을 업로드해주세요.");
      return;
    }

    // Save Character Description to History before generating
    if (config.customCharacterDescription) {
        saveToHistory(config.customCharacterDescription);
    }

    if (remainingCalls('text') < 1) {
      setError("오늘 대본 분석 한도를 모두 사용했습니다. 'API 키 · 사용량'에서 한도를 확인하세요.");
      return;
    }

    setError(null);
    setBudgetNotice(null);
    setScenes([]);
    setMetadata(null);
    setStatus(GenerationStatus.Analyzing);

    try {
      // API Key Check for Veo
      if (config.isVideoMode && config.mode === 'text_to_video') {
          const hasKey = window.aistudio ? await window.aistudio.hasSelectedApiKey() : true;
          if (!hasKey && window.aistudio) {
             const confirmed = window.confirm("Veo 영상 생성을 위해서는 유료 API 키 선택이 필요합니다. 선택 창을 여시겠습니까?");
             if (confirmed) {
                 await window.aistudio.openSelectKey();
             } else {
                 setStatus(GenerationStatus.Idle);
                 return;
             }
          }
      }

      // Step 1: Analyze & Plan
      let brokenDownScenes: Scene[] = [];
      let generatedMetadata: VideoMetadata | null = null;

      // The presenter is drawn once and reused in every video; (re)make it alongside the script analysis
      const presence = config.presenter.presence;
      const presenterTask: Promise<PresenterAsset | null> = presence === 'none'
          ? Promise.resolve(null)
          : isPresenterOutdated(config.presenter.asset)
          ? createAiPresenter().catch(e => { console.warn('Presenter generation failed', e); return config.presenter.asset; })
          : Promise.resolve(config.presenter.asset);

      // Small copies for the vision model; full-size photos are used in the video
      const photos = config.uploadedImages;
      const analysisPhotos = photos.length
          ? await Promise.all(photos.map(p => downscaleDataUrl(p, photos.length > 12 ? 512 : 768)))
          : [];

      if (config.mode === 'text_to_video') {
          setProgress({ total: 100, current: 5, message: '대본 분석 및 연출 기획 중...' });
          const result = await analyzeScriptAndBreakdown(
              config.script, 
              selectedCharacter,
              config.customCharacterDescription,
              config.language, 
              config.aspectRatio,
              presence,
              config.presenter.position,
              analysisPhotos
          );
          brokenDownScenes = result.scenes;
          generatedMetadata = result.metadata;

      } else {
          // Image Mode
          setProgress({ total: 100, current: 5, message: `사진 ${photos.length}장 분석 및 편집 구성 중...` });
          // Note: We use the `script` field as "Context/Topic" (or a full script) in this mode
          const result = await analyzeImagesAndCreateScript(
              analysisPhotos,
              config.script,
              selectedCharacter,
              config.language,
              config.aspectRatio,
              config.photoPlacement,
              config.customCharacterDescription,
              presence
          );
          brokenDownScenes = result.scenes;
          generatedMetadata = result.metadata;
      }
      
      // Attach the full-size photo to every scene the AI placed one in
      brokenDownScenes = brokenDownScenes.map(scene =>
          scene.photoIndex !== undefined ? { ...scene, imageUrl: photos[scene.photoIndex] } : scene
      );

      // Now the exact number of media calls is known — check it against today's remaining budget
      const aiScenes = config.mode === 'text_to_video' ? brokenDownScenes.filter(sc => sc.photoIndex === undefined).length : 0;
      const wantsAiThumbnail = config.mode === 'text_to_video' && !budget.savingMode;
      const proceed = confirmWithinBudget({
          image: aiScenes + (wantsAiThumbnail ? 1 : 0),
          tts: brokenDownScenes.length,
          video: config.isVideoMode && !budget.savingMode ? aiScenes : 0,
      }, '이번 영상');
      if (!proceed) {
          setScenes(brokenDownScenes);
          setMetadata(generatedMetadata);
          setEditableTitle(generatedMetadata?.title || "");
          setEditableTitleEn(generatedMetadata?.titleEn || "");
          setStatus(GenerationStatus.Ready);
          setBudgetNotice('대본만 만들고 멈췄습니다. 한도가 생기면 "빈 장면 채우기"로 이어서 만들 수 있어요.');
          return;
      }

      const presenterAsset = await presenterTask;
      // Reference image so the character drawn inside AI scenes matches the presenter
      const characterRef = presence === 'in_scene' && presenterAsset ? await flattenImage(presenterAsset.base, '#FFFFFF') : null;

      setGenerationId(id => id + 1);
      setScenes(brokenDownScenes);
      setMetadata(generatedMetadata);
      setEditableTitle(generatedMetadata?.title || "");
      setEditableTitleEn(generatedMetadata?.titleEn || "");
      setStatus(GenerationStatus.GeneratingMedia);

      // Step 2: Media Generation
      // In Image Mode, visuals are already provided (except Thumbnail maybe).
      // In Text Mode, we generate visuals.
      
      // Thumbnail background (photo-only videos use the user's own photo by default)
      if (generatedMetadata?.thumbnailPrompt && wantsAiThumbnail) {
           generateThumbnailImage(generatedMetadata.thumbnailPrompt, config.aspectRatio, config.styleReferenceImage)
             .then(url => {
                 setMetadata(prev => prev ? { ...prev, thumbnailUrl: url } : null);
             })
             .catch(e => console.warn("Thumbnail failed", e));
      }

      // Visuals and narration use different models/quotas, so run the two pipelines in parallel.
      const totalSteps = brokenDownScenes.length * 2;
      let completedSteps = 0;
      const step = (message: string) => setProgress({ total: totalSteps, current: completedSteps, message });

      const visualsTask = async () => {
        if (config.mode !== 'text_to_video') {
          completedSteps += brokenDownScenes.length;
          return;
        }
        for (let i = 0; i < brokenDownScenes.length; i++) {
          const scene = brokenDownScenes[i];
          let visualGenerated = !!scene.imageUrl; // The user's photo was placed here

          // Attempt Video Generation (Veo) — off in saving mode (most expensive call)
          if (config.isVideoMode && !budget.savingMode && !visualGenerated) {
            step(`장면 ${i+1}: AI 영상 생성 중 (Veo)...`);
            try {
              const videoUrl = await generateSceneVideo(scene.visualPrompt, config.aspectRatio);
              if (videoUrl) {
                patchScene(i, { videoUrl });
                visualGenerated = true;
              }
            } catch (err) {
              console.error("Veo Error caught in App:", err);
            }
          }

          // Fallback to Image Generation if Veo failed or mode is Image
          if (!visualGenerated) {
            step(config.isVideoMode ? `장면 ${i+1}: 영상 생성 실패 -> 이미지로 대체 중...` : `장면 ${i+1}: AI 이미지 생성 중...`);
            if (i > 0) await delay(1000); // Slight delay for rate limits
            const imageUrl = await generateSceneImage(scene.visualPrompt, config.aspectRatio, config.styleReferenceImage, characterRef);
            patchScene(i, { imageUrl });
          }
          completedSteps++;
        }
      };

      const audioTask = async () => {
        for (let i = 0; i < brokenDownScenes.length; i++) {
          step(`장면 ${i+1}: 자연스러운 음성 합성 중...`);
          const audio = await synthesizeScene(brokenDownScenes[i], i, brokenDownScenes.length);
          patchScene(i, { ...audio, audioStale: false });
          completedSteps++;
        }
      };

      // Saving mode: one presenter image for every scene, no extra pose images
      const posesTask = async () => {
        if (presenterAsset && !budget.savingMode) await addPresenterPoses(presenterAsset, brokenDownScenes.map(s => s.pose).filter((p): p is PresenterPose => !!p));
      };

      // allSettled: when one pipeline hits the budget, the other still finishes what it started
      const results = await Promise.allSettled([visualsTask(), audioTask(), posesTask()]);
      const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure && !(failure.reason instanceof BudgetError)) throw failure.reason;
      if (failure) setBudgetNotice(`${failure.reason.message} 만든 장면까지는 그대로 두었고, 한도가 생기면 "빈 장면 채우기"로 이어서 만들 수 있어요.`);

      setStatus(GenerationStatus.Ready);
      setProgress({ total: 100, current: 100, message: '완료!' });

    } catch (e: any) {
      console.error(e);
      if (e instanceof BudgetError) {
          setStatus(GenerationStatus.Error);
          setError(e.message);
          return;
      }
      setStatus(GenerationStatus.Error);
      const msg = e.message || JSON.stringify(e);
      if (msg.includes("429") || msg.includes("quota")) {
          setError("API 사용 한도 초과. 잠시 후 다시 시도해주세요.");
      } else {
          setError("생성 중 오류가 발생했습니다. (" + msg + ")");
      }
    }
  };

  // Resume after a budget stop: only scenes still missing an image or narration are generated
  const missingImages = config.mode === 'text_to_video' ? scenes.filter(sc => !sc.imageUrl && !sc.videoUrl).length : 0;
  const missingAudio = scenes.filter(sc => !sc.audioUrl).length;

  const handleFillMissing = async () => {
      if (!confirmWithinBudget({ image: missingImages, tts: missingAudio }, '빈 장면 채우기')) return;
      setIsRegeneratingAll(true);
      setBudgetNotice(null);
      const asset = config.presenter.asset;
      const characterRef = config.presenter.presence === 'in_scene' && asset ? await flattenImage(asset.base, '#FFFFFF') : null;
      try {
          for (let i = 0; i < scenes.length; i++) {
              const sc = scenes[i];
              if (config.mode === 'text_to_video' && !sc.imageUrl && !sc.videoUrl) {
                  setBusyScenes(prev => ({ ...prev, [`image-${i}`]: true }));
                  try {
                      patchScene(i, { imageUrl: await generateSceneImage(sc.visualPrompt, config.aspectRatio, config.styleReferenceImage, characterRef) });
                  } finally {
                      setBusyScenes(prev => ({ ...prev, [`image-${i}`]: false }));
                  }
              }
              if (!sc.audioUrl) {
                  setBusyScenes(prev => ({ ...prev, [`audio-${i}`]: true }));
                  try {
                      patchScene(i, { ...(await synthesizeScene(sc, i, scenes.length)), audioStale: false });
                  } finally {
                      setBusyScenes(prev => ({ ...prev, [`audio-${i}`]: false }));
                  }
              }
          }
      } catch (e: any) {
          setBudgetNotice(e instanceof BudgetError ? `${e.message} 나머지는 다음에 이어서 채울 수 있어요.` : `오류: ${e.message || e}`);
      } finally {
          setIsRegeneratingAll(false);
      }
  };

  const handleDownloadVideo = async () => {
      if (!scenes.length) return;
      setIsRendering(true);
      setRenderProgress(0);
      try {
          await renderAndDownloadVideo(
            scenes, 
            config.aspectRatio, 
            (pct) => setRenderProgress(pct),
            config.subtitleMode,
            config.bgm,
            safeFileTitle(),
            config.presenter
          );
      } catch (e) {
          console.error(e);
          alert("렌더링 오류가 발생했습니다.");
      } finally {
          setIsRendering(false);
      }
  };

  const safeFileTitle = () =>
    (editableTitle || 'youtube_video').replace(/[^\w\s가-힣]/gi, '').trim().replace(/\s+/g, '_') || 'youtube_video';

  const handleDownloadEnglishSrt = () => {
    if (!scenes.length) return;
    downloadSrtFile(scenes, 'en', `${safeFileTitle()}_english_subtitles.srt`, config.aspectRatio);
  };

  const handleDownloadDualSrt = () => {
    if (!scenes.length) return;
    downloadSrtFile(scenes, 'dual', `${safeFileTitle()}_bilingual_subtitles.srt`, config.aspectRatio);
  };

  const handleDownloadKoSrt = () => {
    if (!scenes.length) return;
    downloadSrtFile(scenes, 'ko', `${safeFileTitle()}_korean_subtitles.srt`, config.aspectRatio);
  };

  // Editing narration invalidates the spoken-form text and the audio
  const handleUpdateSceneText = (index: number, newText: string) => {
    setScenes(prev => prev.map((s, idx) => idx === index ? { ...s, text: newText, ttsText: undefined, audioStale: !!s.audioUrl } : s));
  };

  const handleUpdateSceneTtsText = (index: number, newText: string) => {
    setScenes(prev => prev.map((s, idx) => idx === index ? { ...s, ttsText: newText, audioStale: !!s.audioUrl } : s));
  };

  const runSceneTask = async (key: string, task: () => Promise<void>) => {
    setBusyScenes(prev => ({ ...prev, [key]: true }));
    try {
      await task();
    } catch (e: any) {
      console.error(e);
      alert(`재생성 실패: ${e.message || e}`);
    } finally {
      setBusyScenes(prev => ({ ...prev, [key]: false }));
    }
  };

  const handleRegenerateAudio = (index: number) =>
    runSceneTask(`audio-${index}`, async () => {
      const audio = await synthesizeScene(scenes[index], index, scenes.length);
      patchScene(index, { ...audio, audioStale: false });
    });

  const handleRegenerateImage = (index: number) =>
    runSceneTask(`image-${index}`, async () => {
      const asset = config.presenter.asset;
      const characterRef = config.presenter.presence === 'in_scene' && asset ? await flattenImage(asset.base, '#FFFFFF') : null;
      const imageUrl = await generateSceneImage(scenes[index].visualPrompt, config.aspectRatio, config.styleReferenceImage, characterRef);
      patchScene(index, { imageUrl, videoUrl: undefined, photoIndex: undefined, focusX: undefined, focusY: undefined });
    });

  // Re-voice every scene (e.g. after changing voice/style) or only the edited ones
  const handleRegenerateAllAudio = async (onlyStale: boolean) => {
    setIsRegeneratingAll(true);
    try {
      for (let i = 0; i < scenes.length; i++) {
        if (onlyStale && !scenes[i].audioStale && scenes[i].audioUrl) continue;
        setBusyScenes(prev => ({ ...prev, [`audio-${i}`]: true }));
        try {
          const audio = await synthesizeScene(scenes[i], i, scenes.length);
          patchScene(i, { ...audio, audioStale: false });
        } finally {
          setBusyScenes(prev => ({ ...prev, [`audio-${i}`]: false }));
        }
      }
    } catch (e: any) {
      console.error(e);
      alert(`음성 재생성 중 오류: ${e.message || e}`);
    } finally {
      setIsRegeneratingAll(false);
    }
  };

  const handlePlaySceneAudio = (index: number) => {
    const url = scenes[index].audioUrl;
    if (!url) return;
    sceneAudioRef.current?.pause();
    sceneAudioRef.current = new Audio(url);
    sceneAudioRef.current.play().catch(() => {});
  };

  const staleCount = scenes.filter(s => s.audioStale).length;
  const totalDuration = scenes.reduce((sum, s) => sum + (s.duration || 0), 0);

  const handleUpdateSceneTextEn = (index: number, newTextEn: string) => {
    setScenes(prev => prev.map((s, idx) => idx === index ? { ...s, textEn: newTextEn } : s));
  };

  const handleCopyTags = () => {
    if (!metadata?.tags?.length) return;
    navigator.clipboard.writeText(metadata.tags.map(t => `#${t.replace(/^#/, '')}`).join(' '));
    setCopiedTags(true);
    setTimeout(() => setCopiedTags(false), 2000);
  };

  const handleCopyDesc = () => {
    if (!metadata?.description) return;
    navigator.clipboard.writeText(metadata.description);
    setCopiedDesc(true);
    setTimeout(() => setCopiedDesc(false), 2000);
  };


  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col md:flex-row">
      
      {/* Sidebar */}
      <div className="w-full md:w-[450px] bg-gray-900 border-r border-gray-800 flex flex-col h-screen overflow-y-auto custom-scrollbar">
        <div className="p-6">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-primary-500 to-purple-500 bg-clip-text text-transparent flex items-center gap-2 mb-6">
            <Video className="text-primary-500" /> AI Video Studio
          </h1>
          <div className="mb-6 -mt-3">
            <ApiUsagePanel />
          </div>

          <div className="space-y-6">
            
            {/* Format Selection */}
            <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">영상 포맷 (Ratio)</label>
                <div className="grid grid-cols-3 gap-2">
                    {ASPECT_RATIOS.map(ratio => (
                        <button
                            key={ratio.id}
                            onClick={() => setConfig({...config, aspectRatio: ratio.id})}
                            className={`p-2 rounded-lg border text-xs flex flex-col items-center gap-1 transition-all ${
                                config.aspectRatio === ratio.id 
                                ? 'bg-primary-600/20 border-primary-500 text-white' 
                                : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-750'
                            }`}
                        >
                            {ratio.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Subtitle Configuration for YouTube */}
            <div>
                <label className="block text-sm font-medium text-gray-400 mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                        <Subtitles size={15} className="text-primary-400" /> 자막 설정 (Subtitles)
                    </span>
                    <span className="text-[10px] bg-primary-950 border border-primary-500/40 text-primary-300 px-2 py-0.5 rounded-full font-medium">유튜브 최적화</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={() => setConfig({...config, subtitleMode: 'dual'})}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                            config.subtitleMode === 'dual'
                            ? 'bg-primary-600/20 border-primary-500 text-white shadow-sm ring-1 ring-primary-500/50' 
                            : 'bg-gray-800/80 border-gray-700 text-gray-400 hover:bg-gray-750'
                        }`}
                    >
                        <div className="text-xs font-bold text-white flex items-center gap-1.5">
                            🇰🇷+🇺🇸 한/영 동시
                        </div>
                        <div className="text-[10px] text-gray-400 mt-1 leading-snug">한국어 음성에 영어 자막 병행 (추천)</div>
                    </button>
                    <button
                        type="button"
                        onClick={() => setConfig({...config, subtitleMode: 'en'})}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                            config.subtitleMode === 'en'
                            ? 'bg-primary-600/20 border-primary-500 text-white shadow-sm ring-1 ring-primary-500/50' 
                            : 'bg-gray-800/80 border-gray-700 text-gray-400 hover:bg-gray-750'
                        }`}
                    >
                        <div className="text-xs font-bold text-white flex items-center gap-1.5">
                            🇺🇸 영어만
                        </div>
                        <div className="text-[10px] text-gray-400 mt-1 leading-snug">글로벌 시청자 전용 영문 자막</div>
                    </button>
                    <button
                        type="button"
                        onClick={() => setConfig({...config, subtitleMode: 'ko'})}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                            config.subtitleMode === 'ko'
                            ? 'bg-primary-600/20 border-primary-500 text-white shadow-sm ring-1 ring-primary-500/50' 
                            : 'bg-gray-800/80 border-gray-700 text-gray-400 hover:bg-gray-750'
                        }`}
                    >
                        <div className="text-xs font-bold text-white flex items-center gap-1.5">
                            🇰🇷 한글만
                        </div>
                        <div className="text-[10px] text-gray-400 mt-1 leading-snug">한국어 자막만 깔끔하게 표시</div>
                    </button>
                    <button
                        type="button"
                        onClick={() => setConfig({...config, subtitleMode: 'none'})}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                            config.subtitleMode === 'none'
                            ? 'bg-primary-600/20 border-primary-500 text-white shadow-sm ring-1 ring-primary-500/50' 
                            : 'bg-gray-800/80 border-gray-700 text-gray-400 hover:bg-gray-750'
                        }`}
                    >
                        <div className="text-xs font-bold text-white flex items-center gap-1.5">
                            자막 숨김
                        </div>
                        <div className="text-[10px] text-gray-400 mt-1 leading-snug">영상 화면에 자막 미포함</div>
                    </button>
                </div>
            </div>

            {/* Mode Toggles */}
            <div className="bg-gray-800 p-1 rounded-lg flex border border-gray-700">
                 <button 
                    onClick={() => setConfig({...config, mode: 'text_to_video'})}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-all ${config.mode === 'text_to_video' ? 'bg-primary-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                 >
                    <TypeIcon size={16} /> 대본으로 제작
                 </button>
                 <button 
                    onClick={() => setConfig({...config, mode: 'image_to_video'})}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-all ${config.mode === 'image_to_video' ? 'bg-primary-600 text-white shadow' : 'text-gray-400 hover:text-white'}`}
                 >
                    <FileImage size={16} /> 내 사진으로만 편집
                 </button>
            </div>

            {config.mode === 'text_to_video' && (
                <div className="bg-gray-800 p-1 rounded-lg flex border border-gray-700">
                    <button
                        onClick={() => setConfig({...config, isVideoMode: false})}
                        className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-medium transition-all ${!config.isVideoMode || budget.savingMode ? 'bg-gray-700 text-white' : 'text-gray-400'}`}
                    >
                        <Camera size={14} /> AI 이미지
                    </button>
                    <button
                        onClick={() => setConfig({...config, isVideoMode: true})}
                        disabled={budget.savingMode}
                        title={budget.savingMode ? '절약 모드에서는 가장 비싼 Veo 영상 생성을 쓰지 않습니다' : undefined}
                        className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${config.isVideoMode && !budget.savingMode ? 'bg-purple-600 text-white' : 'text-gray-400'}`}
                    >
                        <Film size={14} /> AI 영상 (Veo){budget.savingMode ? ' · 절약모드 OFF 필요' : ''}
                    </button>
                </div>
            )}

            {/* Character Setup */}
            <div className="space-y-3 border-t border-gray-800 pt-4">
                <label className="text-sm font-medium text-gray-400">내레이터 캐릭터 (Narrator)</label>
                <p className="text-[10px] text-gray-500 -mt-2">스타일과 고정 설명으로 캐릭터를 한 번 만들어 두면, 모든 영상에서 같은 캐릭터가 설명합니다.</p>
                
                {/* Character Select */}
                <div className="grid grid-cols-1 gap-2">
                    {CHARACTERS.map(char => (
                    <button
                        key={char.id}
                        onClick={() => setConfig({...config, characterId: char.id})}
                        className={`p-2 rounded-lg border text-left flex items-center gap-3 transition-all ${
                        config.characterId === char.id 
                        ? 'bg-gray-800 border-primary-500 ring-1 ring-primary-500' 
                        : 'bg-gray-800/50 border-gray-700'
                        }`}
                    >
                        <img src={char.avatar} className="w-8 h-8 rounded-full border border-gray-600" />
                        <span className="text-sm font-medium">{char.name}</span>
                    </button>
                    ))}
                </div>

                {/* Consistency Input & History */}
                <div className="bg-gray-800/30 p-3 rounded-lg border border-gray-700">
                    <label className="flex items-center gap-2 text-xs font-medium text-primary-300 mb-2">
                        <Lock size={12} /> 캐릭터 고정 설명 (History 지원)
                    </label>
                    <input 
                        type="text"
                        value={config.customCharacterDescription}
                        onChange={(e) => setConfig({...config, customCharacterDescription: e.target.value})}
                        placeholder="예: 빨간 목도리를 한 하얀 토끼"
                        className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-xs focus:ring-1 focus:ring-primary-500 focus:outline-none mb-2"
                    />
                    
                    {/* Character Description History */}
                    {characterHistory.length > 0 && (
                        <div>
                            <div className="flex items-center gap-1 mb-1.5">
                                <History size={10} className="text-gray-500" />
                                <span className="text-[10px] text-gray-500 font-medium">최근 사용 (클릭하여 적용)</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto custom-scrollbar p-1">
                                {characterHistory.map((hist, idx) => (
                                    <button
                                        key={idx}
                                        onClick={() => setConfig({...config, customCharacterDescription: hist})}
                                        className="max-w-full text-left truncate text-[10px] bg-gray-700/50 hover:bg-gray-700 border border-gray-600 rounded px-2 py-1 text-gray-300 transition-colors flex items-center gap-1 shrink-0"
                                        title={hist}
                                    >
                                        <RotateCcw size={8} className="opacity-50 shrink-0" />
                                        <span className="truncate">{hist.length > 18 ? hist.substring(0, 18) + '...' : hist}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                <PresenterPanel
                    settings={config.presenter}
                    onChange={updatePresenter}
                    isOutdated={config.presenter.asset?.source === 'ai' && isPresenterOutdated(config.presenter.asset)}
                    busy={presenterBusy}
                    onGenerate={() => createAiPresenter().catch(e => alert(`캐릭터 생성 실패: ${e.message || e}`))}
                    onUpload={handlePresenterUpload}
                    onGeneratePoses={handleGenerateAllPoses}
                />
            </div>

            {/* Narration (TTS) */}
            <div className="space-y-3 border-t border-gray-800 pt-4">
                <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-400 flex items-center gap-1.5">
                        <Mic size={15} className="text-primary-400" /> 내레이션 음성 (TTS)
                    </label>
                    <div className="flex bg-gray-800 rounded-md p-0.5 text-[10px]">
                        {(['all', '여성', '남성'] as const).map(g => (
                            <button
                                key={g}
                                onClick={() => setVoiceGender(g)}
                                className={`px-2 py-0.5 rounded ${voiceGender === g ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
                            >
                                {g === 'all' ? '전체' : g}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">
                    {VOICES.filter(v => voiceGender === 'all' || v.gender === voiceGender).map(voice => (
                        <div 
                            key={voice.id} 
                            className={`p-2 rounded-lg border flex items-center justify-between transition-all ${
                                config.narration.voiceName === voice.id
                                ? 'bg-gray-800 border-primary-500 ring-1 ring-primary-500 text-white'
                                : 'bg-gray-800/50 border-gray-700 text-gray-400 hover:bg-gray-750'
                            }`}
                        >
                            <button
                                className="flex-1 min-w-0 text-left outline-none"
                                onClick={() => updateNarration({ voiceName: voice.id })}
                            >
                                <div className="text-xs font-medium truncate">{voice.name}</div>
                                <div className="text-[10px] text-gray-500 truncate">{voice.gender} · {voice.tone}</div>
                            </button>
                            <button
                                onClick={(e) => handlePreviewVoice(voice.id, e)}
                                disabled={!!previewingVoiceId}
                                className="p-1.5 rounded-full transition-colors ml-1 hover:bg-gray-600 disabled:opacity-50"
                                title="현재 스타일로 미리듣기"
                            >
                                {previewingVoiceId === voice.id ? (
                                    <Loader2 size={12} className="animate-spin text-current" />
                                ) : (
                                    <Play size={12} fill="currentColor" className="text-current" />
                                )}
                            </button>
                        </div>
                    ))}
                </div>

                {/* Delivery style */}
                <div>
                    <label className="text-xs font-medium text-gray-400 mb-1.5 block">말투 / 연출</label>
                    <div className="grid grid-cols-2 gap-1.5">
                        {NARRATION_STYLES.map(style => (
                            <button
                                key={style.id}
                                onClick={() => updateNarration({ styleId: style.id })}
                                className={`px-2 py-1.5 rounded-lg border text-[11px] text-left transition ${
                                    config.narration.styleId === style.id
                                    ? 'bg-primary-600/20 border-primary-500 text-white'
                                    : 'bg-gray-800/50 border-gray-700 text-gray-400 hover:bg-gray-750'
                                }`}
                            >
                                {style.name}
                            </button>
                        ))}
                    </div>
                    {config.narration.styleId === 'custom' && (
                        <textarea
                            value={config.narration.customStyle}
                            onChange={(e) => updateNarration({ customStyle: e.target.value })}
                            rows={2}
                            placeholder="예: 친한 친구에게 비밀을 알려주듯 낮고 다정하게, 중요한 단어는 살짝 힘주어 읽어줘"
                            className="mt-2 w-full bg-gray-900 border border-gray-600 rounded p-2 text-xs focus:ring-1 focus:ring-primary-500 focus:outline-none resize-none"
                        />
                    )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <div>
                        <label className="text-[11px] text-gray-500 mb-1 block">말하기 속도</label>
                        <div className="flex bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                            {([['slow', '느리게'], ['normal', '보통'], ['fast', '빠르게']] as const).map(([id, label]) => (
                                <button
                                    key={id}
                                    onClick={() => updateNarration({ speed: id })}
                                    className={`flex-1 py-1 rounded-md text-[11px] ${config.narration.speed === id ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className="text-[11px] text-gray-500 mb-1 block">장면 사이 숨 고르기</label>
                        <div className="flex bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                            {PAUSE_OPTIONS.map(opt => (
                                <button
                                    key={opt.value}
                                    onClick={() => updateNarration({ pauseSeconds: opt.value })}
                                    className={`flex-1 py-1 rounded-md text-[11px] ${config.narration.pauseSeconds === opt.value ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <button
                    onClick={() => setShowAdvancedVoice(v => !v)}
                    className="text-[11px] text-gray-500 hover:text-gray-300 flex items-center gap-1"
                >
                    <BookA size={12} /> 고급 설정 (음질 모델 · 발음 사전) {showAdvancedVoice ? '▲' : '▼'}
                </button>

                {showAdvancedVoice && (
                    <div className="bg-gray-800/30 p-3 rounded-lg border border-gray-700 space-y-3">
                        <div>
                            <label className="text-[11px] text-gray-400 mb-1 block">TTS 모델</label>
                            <div className="flex bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                                <button
                                    onClick={() => updateNarration({ model: 'flash' })}
                                    className={`flex-1 py-1 rounded-md text-[11px] ${config.narration.model === 'flash' ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
                                >
                                    Flash (빠름)
                                </button>
                                <button
                                    onClick={() => updateNarration({ model: 'pro' })}
                                    className={`flex-1 py-1 rounded-md text-[11px] ${config.narration.model === 'pro' ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
                                >
                                    Pro (고품질)
                                </button>
                            </div>
                            <p className="text-[10px] text-gray-500 mt-1">Pro는 억양이 더 자연스럽지만 느리고 한도가 작습니다. 실패 시 Flash로 자동 전환됩니다.</p>
                        </div>
                        <div>
                            <label className="text-[11px] text-gray-400 mb-1 block">발음 사전 (한 줄에 하나, 단어=읽는 법)</label>
                            <textarea
                                value={config.narration.pronunciationDict}
                                onChange={(e) => updateNarration({ pronunciationDict: e.target.value })}
                                rows={3}
                                placeholder={"ChatGPT=챗지피티\nYouTube=유튜브\n1위=일 위"}
                                className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-xs font-mono focus:ring-1 focus:ring-primary-500 focus:outline-none resize-none"
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Background Music */}
            <div className="space-y-2 border-t border-gray-800 pt-4">
                <label className="text-sm font-medium text-gray-400 flex items-center gap-1.5">
                    <Music size={15} className="text-primary-400" /> 배경음악 (BGM)
                </label>
                {config.bgm.url ? (
                    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-2.5 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-xs text-gray-300 truncate">{config.bgm.name}</span>
                            <button onClick={removeBgm} className="text-gray-500 hover:text-red-400"><X size={14} /></button>
                        </div>
                        <div className="flex items-center gap-2">
                            <Volume2 size={13} className="text-gray-500 shrink-0" />
                            <input
                                type="range"
                                min={0}
                                max={0.5}
                                step={0.01}
                                value={config.bgm.volume}
                                onChange={(e) => setConfig(prev => ({ ...prev, bgm: { ...prev.bgm, volume: parseFloat(e.target.value) } }))}
                                className="flex-1 accent-primary-500"
                            />
                            <span className="text-[10px] text-gray-500 w-8 text-right">{Math.round(config.bgm.volume * 200)}%</span>
                        </div>
                    </div>
                ) : (
                    <button
                        onClick={() => bgmInputRef.current?.click()}
                        className="w-full border border-dashed border-gray-700 rounded-lg p-2.5 text-xs text-gray-400 hover:border-primary-500 hover:text-gray-200 transition flex items-center justify-center gap-2"
                    >
                        <Upload size={13} /> 음악 파일 추가 (MP3, WAV) — 내레이션 아래 낮게 깔립니다
                    </button>
                )}
                <input type="file" ref={bgmInputRef} onChange={handleBgmChange} accept="audio/*" className="hidden" />
            </div>

            {/* INPUT SECTION */}
            <div className="border-t border-gray-800 pt-4 space-y-4">
                
                {config.mode === 'image_to_video' && (
                    <PhotoManager
                        photos={config.uploadedImages}
                        onChange={setPhotos}
                        label="영상에 쓸 내 사진"
                        hint="직접 찍은 사진만으로 편집합니다. 세로·가로 사진 모두 화면 비율에 맞게 자동 배치돼요."
                        placement={config.photoPlacement}
                        onPlacementChange={(photoPlacement) => setConfig(prev => ({ ...prev, photoPlacement }))}
                    />
                )}

                <div>
                    <div className="flex justify-between items-center mb-2">
                        <label className="text-sm font-medium text-gray-400">
                            {config.mode === 'text_to_video' ? '대본 (Script)' : '주제 · 메모 또는 완성 대본'}
                        </label>
                        {config.mode === 'text_to_video' && (
                            <span className={`text-[10px] px-2 py-0.5 rounded ${estimatedDuration > 60 ? 'bg-yellow-900/50 text-yellow-200' : 'bg-green-900/50 text-green-200'}`}>
                                약 {Math.floor(estimatedDuration / 60)}분 {Math.floor(estimatedDuration % 60)}초
                            </span>
                        )}
                    </div>

                    <div className="mb-2 bg-gradient-to-r from-primary-950/70 to-indigo-950/40 border border-primary-500/30 rounded-lg p-2.5 flex items-start gap-2 text-xs">
                        <Sparkles size={14} className="text-primary-400 shrink-0 mt-0.5" />
                        <div className="text-gray-300 leading-relaxed text-[11px]">
                            <span className="font-semibold text-white">본론 직행 & 영문 자막 탑재:</span> 인사말(안녕하세요 등)을 배제하고 즉시 흥미로운 훅과 본론으로 전개되며, 유튜브 업로드용 영문 자막이 함께 구성됩니다.
                        </div>
                    </div>

                    <textarea 
                        value={config.script}
                        onChange={(e) => setConfig({...config, script: e.target.value})}
                        placeholder={config.mode === 'text_to_video' ? "영상 내용을 적어주세요. (예: 인공지능이 2026년 일자리를 어떻게 바꾸는지 3가지 핵심 요약)" : "주제나 메모를 적으면 사진을 보고 대본을 써 드려요. 완성된 대본을 붙여넣으면 문장마다 맞는 사진을 배치합니다. (예: 2박 3일 부산 여행 브이로그, 해운대 맛집 위주)"}
                        className="w-full h-24 bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm focus:ring-2 focus:ring-primary-500 focus:outline-none resize-none placeholder-gray-500"
                    ></textarea>
                </div>

                {/* Optional: mix the user's own photos into an AI-illustrated video */}
                {config.mode === 'text_to_video' && (
                    <div className="bg-gray-800/30 border border-gray-700 rounded-lg">
                        <button
                            onClick={() => setShowTextModePhotos(v => !v)}
                            className="w-full flex items-center justify-between p-3 text-xs text-gray-300"
                        >
                            <span className="flex items-center gap-2">
                                <Camera size={14} className="text-primary-400" /> 내 사진 함께 쓰기 (선택)
                                {config.uploadedImages.length > 0 && (
                                    <span className="bg-primary-600 text-white text-[10px] px-1.5 rounded-full">{config.uploadedImages.length}</span>
                                )}
                            </span>
                            <span className="text-gray-500">{showTextModePhotos ? '▲' : '▼'}</span>
                        </button>
                        {showTextModePhotos && (
                            <div className="px-3 pb-3">
                                <PhotoManager
                                    photos={config.uploadedImages}
                                    onChange={setPhotos}
                                    label="첨부 사진"
                                    hint="AI가 대본 내용과 어울리는 장면에 사진을 넣고, 나머지 장면만 AI 이미지로 채웁니다."
                                />
                            </div>
                        )}
                    </div>
                )}

                <button
                    onClick={handleGenerate}
                    disabled={status !== GenerationStatus.Idle && status !== GenerationStatus.Ready && status !== GenerationStatus.Error}
                    className={`w-full py-4 rounded-xl font-bold text-lg shadow-lg flex items-center justify-center gap-2 transition-all ${
                        status === GenerationStatus.Idle || status === GenerationStatus.Ready || status === GenerationStatus.Error
                        ? 'bg-gradient-to-r from-primary-600 to-indigo-600 hover:from-primary-500 hover:to-indigo-500 text-white'
                        : 'bg-gray-700 text-gray-400 cursor-not-allowed'
                    }`}
                >
                    {status === GenerationStatus.Idle || status === GenerationStatus.Ready || status === GenerationStatus.Error ? (
                        <>
                            <Sparkles className="w-5 h-5" /> 
                            {config.mode === 'image_to_video' ? '사진으로 영상 편집하기' : config.isVideoMode && !budget.savingMode ? 'Veo 영상 생성하기' : '영상 생성하기'}
                        </>
                    ) : (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" /> {config.mode === 'image_to_video' ? '분석 중...' : '생성 중...'}
                        </>
                    )}
                </button>
                {error && <div className="text-red-400 text-xs text-center">{error}</div>}
            </div>

          </div>
        </div>
      </div>

      {/* Main Preview Area */}
      <div className="flex-1 bg-gray-950 flex flex-col items-center justify-center p-4 md:p-12 relative overflow-hidden">
        
        {/* Background Ambient Glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary-900/20 rounded-full blur-[120px] pointer-events-none"></div>

        {/* Rendering Overlay */}
        {isRendering && (
             <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center">
                <Loader2 className="w-16 h-16 text-green-500 animate-spin mb-6" />
                <h3 className="text-2xl font-bold text-white mb-2">렌더링 중...</h3>
                <div className="w-96 h-4 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
                    <div 
                        className="h-full bg-green-500 transition-all duration-300 ease-linear"
                        style={{ width: `${renderProgress}%` }}
                    ></div>
                </div>
                <p className="mt-4 text-green-400 font-mono text-lg">{Math.round(renderProgress)}%</p>
             </div>
        )}

        {/* Progress Overlay */}
        {(status === GenerationStatus.Analyzing || status === GenerationStatus.GeneratingMedia) && !isRendering && (
             <div className="absolute inset-0 z-20 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center">
                <Loader2 className="w-12 h-12 text-primary-500 animate-spin mb-4" />
                <h3 className="text-xl font-bold text-white mb-2">AI 작업 중...</h3>
                <p className="text-gray-400 text-sm mb-4">{progress.message}</p>
                <div className="w-64 h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div 
                        className="h-full bg-primary-500 transition-all duration-300 ease-out"
                        style={{ width: `${(progress.current / progress.total) * 100}%` }}
                    ></div>
                </div>
             </div>
        )}

        {/* Content Container */}
        <div className="z-10 w-full flex flex-col items-center gap-8">
            {scenes.length > 0 ? (
                <>
                    <div className="flex items-center justify-between w-full max-w-lg">
                        <h2 className="text-xl font-bold text-gray-200 flex items-center gap-2">
                            <Video className="w-5 h-5 text-gray-400" /> 미리보기 (Preview)
                        </h2>
                        
                        <button 
                            onClick={handleDownloadVideo}
                            disabled={status !== GenerationStatus.Ready || isRegeneratingAll}
                            title={staleCount > 0 ? '수정된 장면의 음성을 먼저 다시 만들어 주세요' : undefined}
                            className="disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-lg font-medium transition shadow-lg hover:shadow-green-500/20"
                        >
                            <Download size={18} /> 영상 다운로드
                        </button>
                    </div>

                    <div className="w-full flex flex-col items-center gap-8">
                        {/* Video Player */}
                        <VideoPlayer 
                            scenes={scenes} 
                            aspectRatio={config.aspectRatio} 
                            subtitleMode={config.subtitleMode}
                            onSubtitleModeChange={(mode) => setConfig(prev => ({ ...prev, subtitleMode: mode }))}
                            bgmUrl={config.bgm.url}
                            bgmVolume={config.bgm.volume}
                            presenter={config.presenter}
                        />

                        {/* Budget stop notice & resume */}
                        {status === GenerationStatus.Ready && (budgetNotice || missingImages > 0 || missingAudio > 0) && (
                            <div className="w-full max-w-lg bg-amber-900/20 border border-amber-500/40 rounded-xl p-3 text-xs text-amber-100 space-y-2">
                                {budgetNotice && <p>💸 {budgetNotice}</p>}
                                {(missingImages > 0 || missingAudio > 0) && (
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-amber-200/80">비어 있는 장면: 이미지 {missingImages}개 · 음성 {missingAudio}개</span>
                                        <button
                                            onClick={handleFillMissing}
                                            disabled={isRegeneratingAll}
                                            className="shrink-0 flex items-center gap-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg"
                                        >
                                            <RefreshCw size={12} className={isRegeneratingAll ? 'animate-spin' : ''} /> 빈 장면 채우기
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Narration status & bulk actions */}
                        {status === GenerationStatus.Ready && (
                            <div className="w-full max-w-lg flex flex-wrap items-center gap-2 text-xs">
                                <span className="text-gray-500 font-mono mr-auto">총 길이 {Math.floor(totalDuration / 60)}:{String(Math.round(totalDuration % 60)).padStart(2, '0')}</span>
                                {staleCount > 0 && (
                                    <button
                                        onClick={() => handleRegenerateAllAudio(true)}
                                        disabled={isRegeneratingAll}
                                        className="flex items-center gap-1.5 bg-amber-600/20 border border-amber-500/50 text-amber-200 px-3 py-1.5 rounded-lg hover:bg-amber-600/30 disabled:opacity-50"
                                    >
                                        <RefreshCw size={12} className={isRegeneratingAll ? 'animate-spin' : ''} /> 수정된 {staleCount}개 장면 음성 다시 만들기
                                    </button>
                                )}
                                <button
                                    onClick={() => handleRegenerateAllAudio(false)}
                                    disabled={isRegeneratingAll}
                                    className="flex items-center gap-1.5 bg-gray-800 border border-gray-700 text-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-750 disabled:opacity-50"
                                    title="목소리/말투 설정을 바꾼 뒤 전체 내레이션을 새로 녹음합니다"
                                >
                                    <Mic size={12} /> 현재 음성 설정으로 전체 재녹음
                                </button>
                            </div>
                        )}

                        {/* Title & YouTube Metadata Card */}
                        {metadata && (
                            <div className="w-full max-w-lg bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-2xl">
                                <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-gray-850">
                                    <div className="flex items-center gap-2">
                                        <Youtube className="w-5 h-5 text-red-500" />
                                        <h3 className="font-bold text-gray-200">YouTube 최적화 정보</h3>
                                    </div>
                                    <span className="text-[11px] bg-red-950/80 border border-red-500/40 text-red-300 px-2.5 py-0.5 rounded-full font-medium">
                                        글로벌 유튜브 업로드 준비완료
                                    </span>
                                </div>
                                <div className="p-6 flex flex-col gap-6">
                                    {/* Titles: Korean and English */}
                                    <div className="space-y-4">
                                        <div>
                                            <div className="flex items-center justify-between mb-1.5">
                                                <label className="text-xs text-gray-400 font-semibold flex items-center gap-1.5">
                                                    <span>🇰🇷</span> 한국어 제목 (Korean Title)
                                                </label>
                                            </div>
                                            <input 
                                                type="text" 
                                                value={editableTitle}
                                                onChange={(e) => setEditableTitle(e.target.value)}
                                                placeholder="한국어 유튜브 제목"
                                                className="w-full bg-black/60 p-3 rounded-xl border border-gray-700 text-base font-bold text-white focus:border-primary-500 focus:outline-none"
                                            />
                                        </div>

                                        <div>
                                            <div className="flex items-center justify-between mb-1.5">
                                                <label className="text-xs text-gray-400 font-semibold flex items-center gap-1.5">
                                                    <Globe size={14} className="text-blue-400" /> 영문 제목 (English Title for YouTube)
                                                </label>
                                            </div>
                                            <input 
                                                type="text" 
                                                value={editableTitleEn}
                                                onChange={(e) => setEditableTitleEn(e.target.value)}
                                                placeholder="English title for international viewers"
                                                className="w-full bg-black/60 p-3 rounded-xl border border-gray-700 text-sm font-semibold text-yellow-200 focus:border-primary-500 focus:outline-none"
                                            />
                                        </div>
                                    </div>

                                    {/* YouTube Subtitles (.SRT) Export Actions */}
                                    <div className="bg-gray-950/70 border border-gray-800 rounded-xl p-4 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <label className="text-xs text-gray-300 font-bold flex items-center gap-1.5">
                                                <Subtitles size={14} className="text-primary-400" /> 유튜브 자막 파일 (.srt)
                                            </label>
                                            <span className="text-[10px] text-gray-500">YouTube Studio에 업로드 가능</span>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                            <button 
                                                onClick={handleDownloadKoSrt}
                                                className="flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-750 text-white border border-gray-700 px-3 py-2.5 rounded-lg text-xs font-semibold transition shadow-sm"
                                            >
                                                <Download size={14} /> 🇰🇷 한글
                                            </button>
                                            <button 
                                                onClick={handleDownloadEnglishSrt}
                                                className="flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-750 text-yellow-300 hover:text-yellow-200 border border-gray-700 hover:border-yellow-500/40 px-3 py-2.5 rounded-lg text-xs font-semibold transition shadow-sm"
                                            >
                                                <Download size={14} /> 🇺🇸 영문
                                            </button>
                                            <button 
                                                onClick={handleDownloadDualSrt}
                                                className="flex items-center justify-center gap-2 bg-gray-800 hover:bg-gray-750 text-white hover:text-primary-200 border border-gray-700 hover:border-primary-500/40 px-3 py-2.5 rounded-lg text-xs font-semibold transition shadow-sm"
                                            >
                                                <Download size={14} /> 🇰🇷+🇺🇸 한/영
                                            </button>
                                        </div>
                                    </div>

                                    {/* Description & Tags */}
                                    {metadata.description && (
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <label className="text-xs text-gray-400 font-semibold flex items-center gap-1.5">
                                                    <FileText size={13} className="text-gray-500" /> 유튜브 설명란 (Description)
                                                </label>
                                                <button 
                                                    onClick={handleCopyDesc}
                                                    className="text-[11px] text-primary-400 hover:text-primary-300 flex items-center gap-1 transition"
                                                >
                                                    {copiedDesc ? <><Check size={12} className="text-green-400" /> 복사 완료</> : <><Copy size={12} /> 설명 복사</>}
                                                </button>
                                            </div>
                                            <div className="bg-black/50 p-3 rounded-xl border border-gray-800 text-xs text-gray-300 whitespace-pre-wrap max-h-24 overflow-y-auto leading-relaxed">
                                                {metadata.description}
                                            </div>
                                        </div>
                                    )}

                                    {metadata.tags && metadata.tags.length > 0 && (
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <label className="text-xs text-gray-400 font-semibold">추천 해시태그 (Tags)</label>
                                                <button 
                                                    onClick={handleCopyTags}
                                                    className="text-[11px] text-primary-400 hover:text-primary-300 flex items-center gap-1 transition"
                                                >
                                                    {copiedTags ? <><Check size={12} className="text-green-400" /> 태그 복사</> : <><Copy size={12} /> 태그 복사</>}
                                                </button>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {metadata.tags.map((tag, idx) => (
                                                    <span key={idx} className="bg-gray-800/80 border border-gray-700 text-gray-300 text-[11px] px-2.5 py-0.5 rounded-full">
                                                        #{tag.replace(/^#/, '')}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Thumbnail */}
                                    <ThumbnailStudio
                                        key={generationId}
                                        metadata={metadata}
                                        scenes={scenes}
                                        photos={config.uploadedImages}
                                        aspectRatio={config.aspectRatio}
                                        styleReferenceImage={config.styleReferenceImage}
                                        fileTitle={safeFileTitle()}
                                        onAiThumbnailChange={(url) => setMetadata(prev => prev ? { ...prev, thumbnailUrl: url } : prev)}
                                    />
                                </div>
                            </div>
                        )}

                        {/* Scene Breakdown & Editable Subtitles Card */}
                        <div className="w-full max-w-lg bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-xl">
                            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-gray-850">
                                <div className="flex items-center gap-2">
                                    <AlignLeft className="w-5 h-5 text-primary-400" />
                                    <h3 className="font-bold text-gray-200">대본 & 자막 가독성 확인 (장면별)</h3>
                                </div>
                                <span className="text-xs text-gray-400 font-mono">총 {scenes.length}개 장면</span>
                            </div>
                            <div className="p-4 space-y-4 max-h-[500px] overflow-y-auto">
                                {scenes.map((scene, idx) => (
                                    <div key={scene.id || idx} className="bg-black/60 border border-gray-800 hover:border-gray-700 rounded-xl p-3.5 space-y-2.5 transition">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className="text-xs font-bold bg-primary-950 border border-primary-500/40 text-primary-300 px-2.5 py-0.5 rounded-full shrink-0">
                                                    장면 {idx + 1} ({(scene.duration || 4).toFixed(1)}초)
                                                </span>
                                                {scene.audioStale && (
                                                    <span className="text-[10px] text-amber-300 bg-amber-900/40 border border-amber-500/40 px-1.5 py-0.5 rounded shrink-0">음성 갱신 필요</span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <button
                                                    onClick={() => handlePlaySceneAudio(idx)}
                                                    disabled={!scene.audioUrl}
                                                    className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-30"
                                                    title="이 장면 음성 듣기"
                                                >
                                                    <Volume2 size={13} />
                                                </button>
                                                <button
                                                    onClick={() => handleRegenerateAudio(idx)}
                                                    disabled={busyScenes[`audio-${idx}`] || status !== GenerationStatus.Ready}
                                                    className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-30"
                                                    title="이 장면 음성 다시 만들기"
                                                >
                                                    {busyScenes[`audio-${idx}`] ? <Loader2 size={13} className="animate-spin" /> : <Mic size={13} />}
                                                </button>
                                                {config.mode === 'text_to_video' && (
                                                    <button
                                                        onClick={() => handleRegenerateImage(idx)}
                                                        disabled={busyScenes[`image-${idx}`] || status !== GenerationStatus.Ready}
                                                        className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-30"
                                                        title="이 장면 이미지 다시 만들기"
                                                    >
                                                        {busyScenes[`image-${idx}`] ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex gap-2 items-start">
                                            <button
                                                onClick={() => setPhotoPickerFor(photoPickerFor === idx ? null : idx)}
                                                disabled={status !== GenerationStatus.Ready}
                                                className="relative w-14 h-14 rounded-md overflow-hidden border border-gray-800 shrink-0 bg-gray-900 group disabled:cursor-default"
                                                title="장면 사진 바꾸기"
                                            >
                                                {scene.imageUrl
                                                    ? <img src={scene.imageUrl} className="w-full h-full object-cover" />
                                                    : <Loader2 size={14} className="animate-spin text-gray-600 m-auto" />}
                                                <span className="absolute inset-0 bg-black/60 text-[9px] text-white items-center justify-center hidden group-enabled:group-hover:flex">바꾸기</span>
                                            </button>
                                            <div className="min-w-0 space-y-1">
                                                <span className={`inline-block text-[9px] px-1.5 py-0.5 rounded ${scene.photoIndex !== undefined ? 'bg-emerald-900/50 text-emerald-300 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 border border-gray-700'}`}>
                                                    {scene.photoIndex !== undefined ? '📷 내 사진' : scene.videoUrl ? '🎬 AI 영상' : '✨ AI 이미지'}
                                                </span>
                                                {config.presenter.presence !== 'none' && (
                                                    <select
                                                        value={scene.pose || 'explain'}
                                                        onChange={async (e) => {
                                                            const pose = e.target.value as PresenterPose;
                                                            patchScene(idx, { pose });
                                                            if (config.presenter.asset) addPresenterPoses(config.presenter.asset, [pose]);
                                                        }}
                                                        className="ml-1.5 bg-gray-800 border border-gray-700 rounded text-[9px] text-gray-300 px-1 py-0.5"
                                                        title="이 장면에서 캐릭터 포즈"
                                                    >
                                                        {(Object.keys(POSE_LABELS) as PresenterPose[]).map(p => (
                                                            <option key={p} value={p}>🧑‍🏫 {POSE_LABELS[p]}</option>
                                                        ))}
                                                    </select>
                                                )}
                                                {scene.photoIndex === undefined && (
                                                    <p className="text-[10px] text-gray-500 line-clamp-2" title={scene.visualPrompt}>{scene.visualPrompt}</p>
                                                )}
                                            </div>
                                        </div>

                                        {/* Photo picker: swap this scene's visual for one of the user's photos */}
                                        {photoPickerFor === idx && (
                                            <div className="bg-gray-900 border border-gray-700 rounded-lg p-2 space-y-2">
                                                <div className="flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar">
                                                    {config.uploadedImages.map((photo, pIdx) => (
                                                        <button
                                                            key={pIdx}
                                                            onClick={() => assignPhotoToScene(idx, pIdx)}
                                                            className={`shrink-0 w-14 h-14 rounded-md overflow-hidden border-2 ${scene.imageUrl === photo ? 'border-primary-500' : 'border-transparent hover:border-gray-500'}`}
                                                        >
                                                            <img src={photo} className="w-full h-full object-cover" />
                                                        </button>
                                                    ))}
                                                    <label className="shrink-0 w-14 h-14 rounded-md border border-dashed border-gray-600 flex flex-col items-center justify-center text-[9px] text-gray-400 cursor-pointer hover:border-primary-500">
                                                        <Upload size={13} /> 새 사진
                                                        <input type="file" accept="image/*" className="hidden" onChange={(e) => { handleScenePhotoUpload(idx, e.target.files); e.target.value = ''; }} />
                                                    </label>
                                                </div>
                                                {config.mode === 'text_to_video' && (
                                                    <button
                                                        onClick={() => { setPhotoPickerFor(null); handleRegenerateImage(idx); }}
                                                        className="text-[10px] text-primary-300 hover:text-primary-200 flex items-center gap-1"
                                                    >
                                                        <Sparkles size={10} /> 사진 대신 AI 이미지로 만들기
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                        
                                        {/* Korean Narration (Editable) */}
                                        <div className="space-y-1">
                                            <label className="text-[10px] text-gray-400 font-medium flex items-center gap-1">
                                                <Edit3 size={10} /> 🇰🇷 한국어 내레이션 (본론 직행)
                                            </label>
                                            <textarea 
                                                value={scene.text}
                                                onChange={(e) => handleUpdateSceneText(idx, e.target.value)}
                                                rows={2}
                                                className="w-full bg-gray-900 border border-gray-700 rounded-lg p-2 text-xs text-white focus:border-primary-500 focus:outline-none resize-none leading-relaxed"
                                            />
                                        </div>

                                        {/* Spoken form used by TTS (pronunciation fixes) */}
                                        <div className="space-y-1">
                                            <label className="text-[10px] text-primary-300/80 font-medium flex items-center gap-1" title="자막에는 표시되지 않고 음성 합성에만 쓰입니다. 숫자·영어를 읽는 그대로 적고, 쉼표로 숨 쉬는 위치를 조절하세요.">
                                                <Mic size={10} /> 🔊 읽기용 텍스트 (발음·쉼 조절, 자막 미표시)
                                            </label>
                                            <textarea 
                                                value={scene.ttsText ?? ''}
                                                onChange={(e) => handleUpdateSceneTtsText(idx, e.target.value)}
                                                rows={2}
                                                placeholder={scene.text || '비워두면 위 내레이션을 그대로 읽습니다'}
                                                className="w-full bg-gray-900 border border-primary-500/20 rounded-lg p-2 text-xs text-gray-300 focus:border-primary-500 focus:outline-none resize-none leading-relaxed"
                                            />
                                        </div>

                                        {/* English Subtitle (Editable) */}
                                        <div className="space-y-1">
                                            <label className="text-[10px] text-yellow-400/90 font-medium flex items-center gap-1">
                                                <Globe size={10} /> 🇺🇸 영문 자막 (English Subtitle)
                                            </label>
                                            <textarea 
                                                value={scene.textEn || ''}
                                                onChange={(e) => handleUpdateSceneTextEn(idx, e.target.value)}
                                                rows={2}
                                                placeholder="English subtitle translation..."
                                                className="w-full bg-gray-900 border border-yellow-500/30 rounded-lg p-2 text-xs text-yellow-200 focus:border-yellow-400 focus:outline-none resize-none leading-relaxed"
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </>
            ) : (
                <div className="text-center p-12 border-2 border-dashed border-gray-800 rounded-3xl bg-gray-900/50">
                    <div className="flex gap-4 justify-center mb-6">
                        <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center text-primary-500">
                            <TypeIcon className="w-8 h-8" />
                        </div>
                        <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center text-purple-500">
                            <ImageIcon className="w-8 h-8" />
                        </div>
                    </div>
                    <h3 className="text-xl font-bold text-gray-300">나만의 AI 영상을 만들어보세요</h3>
                    <p className="text-gray-500 mt-2 max-w-sm mx-auto text-sm">
                        대본을 입력하거나 블로그 사진을 업로드하세요.<br/>
                        내가 설정한 캐릭터가 등장하여 이야기를 들려줍니다.
                    </p>
                </div>
            )}
        </div>

      </div>
    </div>
  );
}