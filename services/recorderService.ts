import { Scene, AspectRatio, SubtitleMode, BgmSettings, PresenterSettings } from '../types';
import { buildTimeline, findCue, TimelineScene } from './subtitleUtils';
import { drawCover } from './thumbnailService';
import { audioEnvelope, drawPresenter, poseUrl, presenterBox, PresenterBox, showsPresenter } from './presenterService';

// Helper to load image
const loadImage = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
};

// Helper to load audio
const loadAudio = async (url: string, ctx: AudioContext): Promise<AudioBuffer> => {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return await ctx.decodeAudioData(arrayBuffer);
};

// Helper to format SRT timestamp: 00:00:00,000
const formatSrtTime = (seconds: number): string => {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

/**
 * Generate YouTube-ready SRT Subtitle string.
 * Uses the same short, speech-timed cues as the rendered video instead of one block per scene.
 */
export const generateSrtContent = (scenes: Scene[], mode: 'dual' | 'en' | 'ko' = 'en', aspectRatio: string = AspectRatio.Landscape): string => {
  const blocks: string[] = [];
  buildTimeline(scenes, aspectRatio).forEach(entry => {
    if (mode === 'en') {
      // English reads better as one block per scene than split mid-sentence
      const en = entry.cues.map(c => c.en).filter(Boolean).join(' ') || entry.cues.map(c => c.ko).join(' ');
      const speechStart = entry.start + (entry.scene.speechOffset ?? 0);
      if (en) blocks.push(`${formatSrtTime(speechStart)} --> ${formatSrtTime(entry.end)}\n${en}`);
      return;
    }
    entry.cues.forEach(cue => {
      const text = mode === 'dual' && cue.en ? `${cue.ko}\n${cue.en}` : cue.ko;
      if (text) blocks.push(`${formatSrtTime(entry.start + cue.start)} --> ${formatSrtTime(entry.start + cue.end)}\n${text}`);
    });
  });
  return blocks.map((b, i) => `${i + 1}\n${b}\n`).join('\n');
};

/**
 * Download SRT file for YouTube upload
 */
export const downloadSrtFile = (scenes: Scene[], mode: 'dual' | 'en' | 'ko' = 'en', filename?: string, aspectRatio?: string) => {
  const defaultName = mode === 'en' ? 'youtube_english_subtitles.srt' : mode === 'dual' ? 'youtube_bilingual_subtitles.srt' : 'youtube_korean_subtitles.srt';
  const content = generateSrtContent(scenes, mode, aspectRatio);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || defaultName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

// Ensure fonts are loaded
const loadFonts = async () => {
  if (document.fonts) {
    await document.fonts.ready;
  }
};

const TRANSITION_SECONDS = 0.5;
const KEN_BURNS_ZOOM = 0.08;

interface PreparedScene {
  entry: TimelineScene;
  visual: HTMLImageElement | HTMLVideoElement | null;
  isVideo: boolean;
  audio: AudioBuffer | null;
  backdrop: HTMLCanvasElement | null; // Blurred fill for photos whose ratio doesn't match the frame
  presenterImg: HTMLImageElement | null; // Corner presenter for this scene (pose-specific)
  envelope: Float32Array | null; // Narration loudness, drives the presenter's talking motion
}

const pickMimeType = () => {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
};

// A portrait photo in a 16:9 video (or vice versa) loses too much when cropped.
export const needsLetterbox = (visualAspect: number, frameAspect: number) =>
  Math.abs(Math.log(visualAspect / frameAspect)) > Math.log(1.35);

// Tiny, blurred, darkened copy of the image; scaled up it makes a soft background
const makeBackdrop = (img: HTMLImageElement, width: number, height: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = Math.max(8, Math.round(width / 12));
  c.height = Math.max(8, Math.round(height / 12));
  const bctx = c.getContext('2d')!;
  bctx.filter = 'blur(2px) brightness(0.6)';
  drawCover(bctx, img, 0, 0, c.width, c.height);
  return c;
};

// Cover-fit with a slow zoom/pan ("Ken Burns") toward the subject so still images feel alive
const drawVisual = (
  ctx: CanvasRenderingContext2D,
  prepared: PreparedScene,
  progress: number,
  width: number,
  height: number
) => {
  const el = prepared.visual;
  if (!el) return;
  const scene = prepared.entry.scene;

  if (prepared.isVideo) {
    drawCover(ctx, el, 0, 0, width, height);
    return;
  }

  const p = Math.min(1, Math.max(0, progress));
  const eased = p * p * (3 - 2 * p);
  const zoomIn = prepared.entry.index % 2 === 0;
  const kb = KEN_BURNS_ZOOM * (zoomIn ? eased : 1 - eased);

  if (prepared.backdrop) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(prepared.backdrop, 0, 0, width, height);
    // Whole photo visible, with a gentler zoom
    const img = el as HTMLImageElement;
    const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight) * (1 + kb * 0.5);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 40;
    ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }

  // Drift slightly toward the subject while zooming
  const fx = scene.focusX ?? 0.5;
  const fy = scene.focusY ?? 0.5;
  const drift = prepared.entry.index % 4 < 2 ? 1 : -1;
  const focusX = fx + (scene.focusX === undefined ? drift * (eased - 0.5) * 0.06 : 0);
  const focusY = fy + (scene.focusY === undefined ? (eased - 0.5) * 0.04 : 0);
  drawCover(ctx, el, 0, 0, width, height, focusX, focusY, 1 + kb);
};

const drawSubtitle = (
  ctx: CanvasRenderingContext2D,
  ko: string,
  en: string,
  subtitleMode: SubtitleMode,
  aspectRatio: string,
  width: number,
  height: number,
  avoid?: PresenterBox | null // Keep the subtitle clear of the presenter character
) => {
  const showKo = (subtitleMode === 'dual' || subtitleMode === 'ko') && !!ko;
  const showEn = (subtitleMode === 'dual' || subtitleMode === 'en') && !!(en || (!showKo && ko));
  if (!showKo && !showEn) return;
  const enLine = en || ko;

  const isShorts = aspectRatio === AspectRatio.Shorts;
  const fontKo = isShorts ? height * 0.034 : height * 0.045;
  const fontEn = fontKo * 0.72;
  const fontKoCss = `700 ${fontKo}px "Noto Sans KR", sans-serif`;
  const fontEnCss = `600 ${showKo ? fontEn : fontKo}px "Noto Sans KR", sans-serif`;

  ctx.save();
  ctx.font = fontKoCss;
  const wKo = showKo ? ctx.measureText(ko).width : 0;
  ctx.font = fontEnCss;
  const wEn = showEn ? ctx.measureText(enLine).width : 0;

  const padX = fontKo * 0.8;
  const padY = fontKo * 0.4;
  const gap = fontKo * 0.25;
  const hKo = showKo ? fontKo * 1.2 : 0;
  const hEn = showEn ? (showKo ? fontEn : fontKo) * 1.2 : 0;
  const rectH = hKo + hEn + (showKo && showEn ? gap : 0) + padY * 2;
  // Free horizontal band next to the presenter (landscape) or above it (portrait)
  let areaLeft = width * 0.03;
  let areaRight = width * 0.97;
  let centerY = height * (1 - (isShorts ? 0.22 : 0.12));
  if (avoid) {
    if (height > width) {
      centerY = Math.min(centerY, avoid.y - rectH / 2 - height * 0.015);
    } else if (avoid.x < width / 2) {
      areaLeft = avoid.x + avoid.w + width * 0.01;
    } else {
      areaRight = avoid.x - width * 0.01;
    }
  }
  const rectW = Math.min(areaRight - areaLeft, Math.max(wKo, wEn) + padX * 2);
  const cx = (areaLeft + areaRight) / 2;
  const top = centerY - rectH / 2;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
  ctx.beginPath();
  ctx.roundRect(cx - rectW / 2, top, rectW, rectH, 14);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxTextW = rectW - padX * 2;
  let y = top + padY;
  if (showKo) {
    ctx.font = fontKoCss;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(ko, cx, y + hKo / 2, maxTextW);
    y += hKo + gap;
  }
  if (showEn) {
    ctx.font = fontEnCss;
    ctx.fillStyle = '#FDE047';
    ctx.fillText(enLine, cx, y + hEn / 2, maxTextW);
  }
  ctx.restore();
};

export const renderAndDownloadVideo = async (
  scenes: Scene[],
  aspectRatio: string,
  onProgress: (percent: number, message: string) => void,
  subtitleMode: SubtitleMode = 'dual',
  bgm?: BgmSettings,
  filename = 'video',
  presenter?: PresenterSettings
) => {
  await loadFonts();

  let width = 1280;
  let height = 720;
  if (aspectRatio === AspectRatio.Shorts) {
    width = 720;
    height = 1280;
  } else if (aspectRatio === AspectRatio.Square) {
    width = 1080;
    height = 1080;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Could not get canvas context");

  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  const timeline = buildTimeline(scenes, aspectRatio);
  const prepared: PreparedScene[] = [];
  const presenterCache = new Map<string, HTMLImageElement>();

  try {
    // --- Preload ---
    for (let i = 0; i < timeline.length; i++) {
      const entry = timeline[i];
      const scene = entry.scene;
      onProgress((i / timeline.length) * 20, `장면 준비 중 (${i + 1}/${timeline.length})...`);

      let audio: AudioBuffer | null = null;
      if (scene.audioUrl) {
        try { audio = await loadAudio(scene.audioUrl, audioCtx); } catch (e) { console.warn(`Failed to load audio for scene ${i}`, e); }
      }

      let visual: HTMLImageElement | HTMLVideoElement | null = null;
      let isVideo = false;
      if (scene.videoUrl) {
        const vid = document.createElement('video');
        vid.src = scene.videoUrl;
        vid.muted = true;
        vid.playsInline = true;
        vid.loop = true;
        const ok = await new Promise<boolean>(resolve => {
          vid.onloadeddata = () => resolve(true);
          vid.onerror = () => resolve(false);
        });
        if (ok) { visual = vid; isVideo = true; }
      }
      let backdrop: HTMLCanvasElement | null = null;
      if (!visual && scene.imageUrl) {
        try {
          const img = await loadImage(scene.imageUrl);
          visual = img;
          if (needsLetterbox(img.naturalWidth / img.naturalHeight, width / height)) backdrop = makeBackdrop(img, width, height);
        } catch (e) { console.warn(`Failed to load image for scene ${i}`, e); }
      }
      let presenterImg: HTMLImageElement | null = null;
      if (presenter?.asset && showsPresenter(scene, presenter)) {
        const url = poseUrl(presenter.asset, scene.pose);
        try {
          presenterImg = presenterCache.get(url) || await loadImage(url);
          presenterCache.set(url, presenterImg);
        } catch (e) { console.warn('Failed to load presenter', e); }
      }
      prepared.push({ entry, visual, isVideo, audio, backdrop, presenterImg, envelope: audio ? audioEnvelope(audio, 30) : null });
    }

    let bgmBuffer: AudioBuffer | null = null;
    if (bgm?.url) {
      onProgress(20, '배경음악 준비 중...');
      try { bgmBuffer = await loadAudio(bgm.url, audioCtx); } catch (e) { console.warn('Failed to load BGM', e); }
    }

    const totalDuration = timeline.length ? timeline[timeline.length - 1].end : 0;
    if (!totalDuration) throw new Error('렌더링할 장면이 없습니다.');

    const stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });

    // Draw the first frame before recording starts so the video doesn't open on black
    if (prepared[0]) drawVisual(ctx, prepared[0], 0, width, height);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    recorder.start(1000);

    // --- Schedule all audio on the AudioContext clock (sample-accurate, no drift) ---
    const t0 = audioCtx.currentTime + 0.15;
    prepared.forEach(p => {
      if (!p.audio) return;
      const src = audioCtx.createBufferSource();
      src.buffer = p.audio;
      src.connect(dest);
      src.start(t0 + p.entry.start);
    });

    if (bgmBuffer && bgm) {
      const gain = audioCtx.createGain();
      const vol = Math.max(0, Math.min(1, bgm.volume));
      const fadeOut = Math.min(2, totalDuration / 4);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + 1);
      gain.gain.setValueAtTime(vol, t0 + totalDuration - fadeOut);
      gain.gain.linearRampToValueAtTime(0, t0 + totalDuration);
      const src = audioCtx.createBufferSource();
      src.buffer = bgmBuffer;
      src.loop = true;
      src.connect(gain).connect(dest);
      src.start(t0);
      src.stop(t0 + totalDuration + 0.1);
    }

    // --- Frame loop driven by the audio clock ---
    let activeVideo: HTMLVideoElement | null = null;
    while (true) {
      const now = audioCtx.currentTime - t0;
      if (now >= totalDuration) break;
      const t = Math.max(0, now);
      const idx = Math.max(0, timeline.findIndex(e => t < e.end));
      const current = prepared[idx];
      const local = t - current.entry.start;
      const sceneLen = current.entry.end - current.entry.start;

      if (current.isVideo && current.visual !== activeVideo) {
        activeVideo?.pause();
        activeVideo = current.visual as HTMLVideoElement;
        activeVideo.currentTime = 0;
        activeVideo.play().catch(() => {});
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);

      const prev = prepared[idx - 1];
      if (prev && local < TRANSITION_SECONDS) {
        const prevLen = prev.entry.end - prev.entry.start;
        drawVisual(ctx, prev, (prevLen + local) / prevLen, width, height);
        ctx.globalAlpha = local / TRANSITION_SECONDS;
      }
      drawVisual(ctx, current, local / sceneLen, width, height);
      ctx.globalAlpha = 1;

      // Presenter: stays on screen across scenes, bounces with the narration
      let box: PresenterBox | null = null;
      if (current.presenterImg && presenter) {
        const img = current.presenterImg;
        box = presenterBox(width, height, img.naturalWidth / img.naturalHeight, presenter.position, !!presenter.asset?.isCutout);
        const env = current.envelope;
        const amp = env ? env[Math.min(env.length - 1, Math.floor(local * 30))] || 0 : 0;
        // Slide in when the presenter first appears (or reappears after scenes without it)
        const enter = prev?.presenterImg ? 1 : Math.min(1, local / 0.4);
        drawPresenter(ctx, img, !!presenter.asset?.isCutout, box, amp, t, enter);
      }

      if (subtitleMode !== 'none') {
        const cue = findCue(current.entry.cues, local);
        if (cue) drawSubtitle(ctx, cue.ko, cue.en, subtitleMode, aspectRatio, width, height, box);
      }

      onProgress(20 + (t / totalDuration) * 80, `비디오 합성 중... (${idx + 1}/${timeline.length})`);
      await new Promise(r => setTimeout(r, 1000 / 30));
    }
    activeVideo?.pause();

    await new Promise(r => setTimeout(r, 300));
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.${mimeType.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    onProgress(100, '완료');
  } finally {
    audioCtx.close();
  }
};
