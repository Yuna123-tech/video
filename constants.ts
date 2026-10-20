import { CharacterProfile, AspectRatio } from './types';

export const CHARACTERS: CharacterProfile[] = [
  {
    id: 'webtoon_style',
    name: '인기 웹툰 스타일 (2D)',
    stylePrompt: 'High quality Korean webtoon style character. 2D illustration, cel shaded, hand-drawn feel. Anime style.',
    description: '깔끔한 선화와 채색이 돋보이는 인기 웹툰 작화. 3D 느낌 없이 자연스러운 2D 일러스트 스타일.',
    avatar: 'https://picsum.photos/id/64/200/200'
  },
  {
    id: 'watercolor_sketch',
    name: '감성 수채화 (Hand-drawn)',
    stylePrompt: 'Soft watercolor illustration, hand-drawn artistic style',
    description: '종이 질감이 느껴지는 따뜻한 수채화 스타일. 동화책 같은 편안한 분위기.',
    avatar: 'https://picsum.photos/id/40/200/200' 
  },
  {
    id: 'ghibli_style',
    name: '지브리 애니메이션 스타일',
    stylePrompt: 'Studio Ghibli style animation, detailed background, vibrant colors',
    description: '풍부한 색감과 디테일한 배경이 특징인 고퀄리티 애니메이션 스타일.',
    avatar: 'https://picsum.photos/id/237/200/200'
  },
  {
    id: 'realistic_anchor',
    name: '뉴스 앵커 (실사)',
    stylePrompt: 'A professional news anchor, photorealistic',
    description: '정보 전달에 적합한 깔끔한 실사 뉴스 앵커 스타일.',
    avatar: 'https://picsum.photos/id/1025/200/200'
  }
];

export const LANGUAGES = [
  { code: 'ko', name: '한국어 (Korean)' },
  { code: 'en', name: 'English (US)' },
  { code: 'ja', name: '日本語 (Japanese)' },
];

// Gemini TTS prebuilt voices (all speak Korean). tone = Google's official voice characteristic.
export const VOICES = [
  { id: 'Kore', name: 'Kore', gender: '여성', tone: '단단하고 차분함' },
  { id: 'Sulafat', name: 'Sulafat', gender: '여성', tone: '따뜻함' },
  { id: 'Aoede', name: 'Aoede', gender: '여성', tone: '산뜻함' },
  { id: 'Leda', name: 'Leda', gender: '여성', tone: '젊고 밝음' },
  { id: 'Zephyr', name: 'Zephyr', gender: '여성', tone: '밝음' },
  { id: 'Despina', name: 'Despina', gender: '여성', tone: '부드러움' },
  { id: 'Vindemiatrix', name: 'Vindemiatrix', gender: '여성', tone: '온화함' },
  { id: 'Achernar', name: 'Achernar', gender: '여성', tone: '소프트' },
  { id: 'Charon', name: 'Charon', gender: '남성', tone: '정보 전달형' },
  { id: 'Puck', name: 'Puck', gender: '남성', tone: '경쾌함' },
  { id: 'Orus', name: 'Orus', gender: '남성', tone: '단단함' },
  { id: 'Achird', name: 'Achird', gender: '남성', tone: '친근함' },
  { id: 'Iapetus', name: 'Iapetus', gender: '남성', tone: '또렷함' },
  { id: 'Algieba', name: 'Algieba', gender: '남성', tone: '매끄러움' },
  { id: 'Sadaltager', name: 'Sadaltager', gender: '남성', tone: '지적임' },
  { id: 'Fenrir', name: 'Fenrir', gender: '남성', tone: '흥분/강렬' },
];

// Natural-language direction prepended to the TTS prompt. Gemini TTS follows these closely.
export const NARRATION_STYLES = [
  { id: 'natural', name: '자연스러운 내레이션', prompt: 'Read this aloud as a natural, warm Korean YouTube narrator. Conversational and sincere, with natural intonation and small pauses at commas' },
  { id: 'info', name: '차분한 정보 전달', prompt: 'Read this aloud as a calm, trustworthy Korean explainer. Clear articulation, even pacing, confident and friendly' },
  { id: 'story', name: '스토리텔링', prompt: 'Read this aloud as an engaging Korean storyteller. Expressive, with gentle emphasis on key words and a sense of curiosity' },
  { id: 'docu', name: '다큐멘터리', prompt: 'Read this aloud as a Korean documentary narrator. Deep, measured, and immersive, with a slightly slower cinematic delivery' },
  { id: 'shorts', name: '에너지 넘치는 쇼츠', prompt: 'Read this aloud as an energetic Korean YouTube Shorts host. Upbeat, punchy and lively, but still natural and not shouting' },
  { id: 'news', name: '뉴스 앵커', prompt: 'Read this aloud as a professional Korean news anchor. Crisp, neutral and authoritative' },
  { id: 'none', name: '스타일 지시 없음', prompt: '' },
  { id: 'custom', name: '직접 입력', prompt: '' },
];

export const SPEED_DIRECTIONS = {
  slow: 'Speak at a slightly slow, relaxed pace.',
  normal: '',
  fast: 'Speak at a brisk, slightly fast pace.',
} as const;

export const PAUSE_OPTIONS = [
  { value: 0.15, label: '짧게' },
  { value: 0.35, label: '보통' },
  { value: 0.6, label: '여유' },
];

export const TTS_MODELS = {
  flash: 'gemini-2.5-flash-preview-tts',
  pro: 'gemini-2.5-pro-preview-tts',
} as const;

export const ASPECT_RATIOS = [
  { id: AspectRatio.Shorts, label: 'Shorts (9:16)', width: 360, height: 640 },
  { id: AspectRatio.Landscape, label: 'YouTube (16:9)', width: 640, height: 360 },
  { id: AspectRatio.Square, label: 'Instagram (1:1)', width: 500, height: 500 },
];