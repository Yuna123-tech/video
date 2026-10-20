
export enum AspectRatio {
  Shorts = '9:16',
  Landscape = '16:9',
  Square = '1:1'
}

export enum GenerationStatus {
  Idle = 'idle',
  Analyzing = 'analyzing',
  GeneratingMedia = 'generating_media',
  GeneratingAudio = 'generating_audio',
  Ready = 'ready',
  Error = 'error'
}

export type GenerationMode = 'text_to_video' | 'image_to_video';

export interface CharacterProfile {
  id: string;
  name: string;
  stylePrompt: string; // The prefix for image generation style (e.g., "3D render of...")
  description: string;
  avatar: string; // URL for UI preview
}

export type SubtitleMode = 'dual' | 'en' | 'ko' | 'none';

export interface Scene {
  id: number;
  text: string; // The script segment
  textEn?: string; // English subtitle for YouTube
  visualPrompt: string; // The prompt for the image generator (used in text mode)
  duration: number; // In seconds (estimated or actual audio length)
  imageUrl?: string; // Generated image base64/url OR Uploaded image
  videoUrl?: string; // Generated video url (Veo)
  audioUrl?: string; // Generated audio blob url
  ttsText?: string; // Spoken-form text for TTS (numbers/English written as pronounced). Falls back to `text`.
  speechOffset?: number; // Seconds of lead-in silence before speech starts in audioUrl
  speechDuration?: number; // Seconds of actual speech in audioUrl (excluding pauses)
  audioStale?: boolean; // Narration text changed after audio was generated
  photoIndex?: number; // Index into VideoConfig.uploadedImages when the visual is the user's own photo
  focusX?: number; // 0..1 horizontal position of the main subject (for cropping/zoom)
  focusY?: number; // 0..1 vertical position of the main subject
  pose?: PresenterPose; // Presenter character's pose for this scene
}

// How the narrator character appears:
// overlay  = character stands in the corner of every scene and explains (explainer-video style)
// in_scene = character is drawn inside each AI image (photo scenes still get the overlay)
// none     = no character on screen
export type CharacterPresence = 'overlay' | 'in_scene' | 'none';

export type PresenterPose = 'explain' | 'point' | 'surprised' | 'happy';

export interface PresenterAsset {
  base: string; // Main image (also used as the 'explain' pose and as reference for consistency)
  poses: Partial<Record<PresenterPose, string>>;
  isCutout: boolean; // Transparent background; otherwise shown inside a framed card
  source: 'ai' | 'upload';
  signature: string; // Character settings it was generated from (AI only)
}

export interface PresenterSettings {
  presence: CharacterPresence;
  position: 'left' | 'right';
  asset: PresenterAsset | null;
}

export type PhotoPlacement = 'auto' | 'ordered';

export type ThumbnailLayout = 'bold' | 'box' | 'clean';

export type ThumbnailSourceKind = 'ai' | 'scene' | 'photo' | 'photo_ai';

export interface ThumbnailDesign {
  baseUrl: string | null; // Background image currently used
  source: ThumbnailSourceKind;
  text: string; // Hook text; '\n' separates lines
  layout: ThumbnailLayout;
  highlightColor: string;
}

export type TtsModel = 'flash' | 'pro';

export interface NarrationSettings {
  voiceName: string;
  styleId: string; // Preset id from NARRATION_STYLES
  customStyle: string; // Free-form direction, used when styleId === 'custom'
  speed: 'slow' | 'normal' | 'fast';
  pauseSeconds: number; // Breathing pause appended after each scene
  model: TtsModel;
  pronunciationDict: string; // Lines of "word=reading"
}

export interface BgmSettings {
  url: string | null;
  name: string;
  volume: number; // 0..1
}

export interface VideoMetadata {
  title: string;
  titleEn?: string;
  description?: string;
  tags?: string[];
  thumbnailPrompt: string;
  thumbnailUrl?: string;
  thumbnailText?: string; // Short 2-line hook for the thumbnail (not the title)
  thumbnailPhotoIndex?: number; // Best user photo for the thumbnail, if any
}

export interface ScriptAnalysisResult {
  scenes: Scene[];
  metadata: VideoMetadata;
}

export interface VideoConfig {
  mode: GenerationMode; // Text vs Image mode
  script: string;
  uploadedImages: string[]; // User photos: all visuals in image mode, optional extras in text mode
  photoPlacement: PhotoPlacement; // Image mode: keep upload order or let AI arrange
  characterId: string;
  customCharacterDescription: string;
  aspectRatio: AspectRatio;
  language: string;
  narration: NarrationSettings;
  bgm: BgmSettings;
  isVideoMode: boolean;
  styleReferenceImage: string | null;
  presenter: PresenterSettings;
  subtitleMode: SubtitleMode; // 'dual' | 'en' | 'ko' | 'none'
}

export interface GenerationProgress {
  total: number;
  current: number;
  message: string;
}

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    aistudio?: AIStudio;
  }
}