import { CharacterPresence, PresenterAsset, PresenterPose, PresenterSettings, Scene } from '../types';
import { loadImage } from './imageUtils';

// The presenter is generated on a solid green screen and keyed out here, so the
// same character can stand in front of any scene (AI image, photo or video).

const MAX_PRESENTER_DIM = 900;

const toCanvas = (img: HTMLImageElement, maxDim = MAX_PRESENTER_DIM) => {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
};

// WebP keeps transparency at a fraction of PNG size (browsers without WebP encoding fall back to PNG)
const exportCanvas = (c: HTMLCanvasElement) => c.toDataURL('image/webp', 0.92);

const cornerSamples = (data: Uint8ClampedArray, w: number, h: number) => {
  const pts: number[] = [];
  const m = Math.max(2, Math.floor(Math.min(w, h) * 0.03));
  for (const [x, y] of [[m, m], [w - m, m], [m, h - m], [w - m, h - m], [w / 2, m], [m, h / 2], [w - m, h / 2]]) {
    pts.push((Math.floor(y) * w + Math.floor(x)) * 4);
  }
  return pts;
};

const isGreen = (r: number, g: number, b: number) => g > 90 && g - Math.max(r, b) > 50;

// Crop to the visible pixels so the character sits flush on the frame edge
const cropToContent = (c: HTMLCanvasElement): HTMLCanvasElement => {
  const ctx = c.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return c;
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
};

const chromaKey = (c: HTMLCanvasElement) => {
  const ctx = c.getContext('2d')!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const spill = g - Math.max(r, b);
    if (g > 70 && spill > 70) {
      d[i + 3] = 0;
    } else if (g > 60 && spill > 25) {
      // Soft edge: partial transparency and remove the green tint
      d[i + 3] = Math.round(d[i + 3] * (1 - (spill - 25) / 45));
      d[i + 1] = Math.max(r, b);
    }
  }
  ctx.putImageData(img, 0, 0);
};

/**
 * Turn any character image into a presenter asset:
 * transparent PNG -> used as is; green screen -> keyed out; anything else -> shown in a framed card.
 */
export const preparePresenterImage = async (dataUrl: string): Promise<{ url: string; isCutout: boolean }> => {
  const c = toCanvas(await loadImage(dataUrl));
  const ctx = c.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  const corners = cornerSamples(data, c.width, c.height);

  if (corners.filter(i => data[i + 3] < 20).length >= 5) {
    return { url: exportCanvas(cropToContent(c)), isCutout: true };
  }
  if (corners.filter(i => isGreen(data[i], data[i + 1], data[i + 2])).length >= 5) {
    chromaKey(c);
    return { url: exportCanvas(cropToContent(c)), isCutout: true };
  }
  return { url: exportCanvas(c), isCutout: false };
};

export const presenterSignature = (characterId: string, description: string) => `${characterId}|${description.trim()}`;

export const POSE_LABELS: Record<PresenterPose, string> = {
  explain: '설명',
  point: '가리키기',
  surprised: '놀람',
  happy: '기쁨',
};

// Does this scene get the corner presenter?
export const showsPresenter = (scene: Scene, settings: PresenterSettings) => {
  if (!settings.asset || settings.presence === 'none') return false;
  if (settings.presence === 'overlay') return true;
  // in_scene: the character is drawn inside AI images, so only photos/videos need the overlay
  return scene.photoIndex !== undefined || !!scene.videoUrl;
};

export const poseUrl = (asset: PresenterAsset, pose?: PresenterPose) =>
  (pose && asset.poses[pose]) || asset.base;

export interface PresenterBox { x: number; y: number; w: number; h: number }

// Lower corner, sized relative to the frame. Shared by the renderer, preview and subtitle layout.
export const presenterBox = (frameW: number, frameH: number, imgAspect: number, position: 'left' | 'right', isCutout: boolean): PresenterBox => {
  const isTall = frameH > frameW;
  let h = frameH * (isTall ? 0.27 : 0.5);
  let w = h * imgAspect;
  const maxW = frameW * (isTall ? 0.45 : 0.3);
  if (w > maxW) { w = maxW; h = w / imgAspect; }
  const margin = frameW * 0.025;
  const x = position === 'left' ? margin : frameW - w - margin;
  // Cutouts stand on the bottom edge; framed cards float slightly above it
  const y = isCutout ? frameH - h : frameH - h - frameH * 0.04;
  return { x, y, w, h };
};

// Loudness envelope (0..1) at `fps` samples per second, for mouth-flap style motion
export const audioEnvelope = (buffer: AudioBuffer, fps = 30): Float32Array => {
  const ch = buffer.getChannelData(0);
  const win = Math.max(1, Math.floor(buffer.sampleRate / fps));
  const n = Math.ceil(ch.length / win);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const from = i * win;
    const to = Math.min(ch.length, from + win);
    for (let j = from; j < to; j++) sum += ch[j] * ch[j];
    env[i] = Math.sqrt(sum / Math.max(1, to - from));
  }
  const sorted = Array.from(env).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] || 1;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, env[i] / ref);
    prev = v > prev ? prev + (v - prev) * 0.6 : prev + (v - prev) * 0.25; // fast attack, slow release
    env[i] = prev;
  }
  return env;
};

export const drawPresenter = (
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  isCutout: boolean,
  box: PresenterBox,
  amp: number, // current speech loudness 0..1
  t: number, // seconds since video start
  enter: number // 0..1 entrance progress
) => {
  const frameH = ctx.canvas.height;
  // Idle breathing + bounce while speaking + slight sway
  const bob = Math.sin(t * 2.2) * frameH * 0.002 + amp * frameH * 0.01 * (0.6 + 0.4 * Math.abs(Math.sin(t * 9)));
  const scale = 1 + amp * 0.02;
  const tilt = Math.sin(t * 1.3) * 0.012 + amp * Math.sin(t * 7) * 0.012;
  const slide = (1 - enter) * box.h * 0.6;

  ctx.save();
  ctx.globalAlpha *= Math.min(1, enter * 1.5);
  ctx.translate(box.x + box.w / 2, box.y + box.h + slide - bob);
  ctx.rotate(tilt);
  ctx.scale(scale, scale);
  if (isCutout) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = box.h * 0.05;
    ctx.drawImage(img, -box.w / 2, -box.h, box.w, box.h);
  } else {
    const r = box.w * 0.08;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = box.h * 0.06;
    ctx.beginPath();
    ctx.roundRect(-box.w / 2, -box.h, box.w, box.h, r);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.clip();
    const border = Math.max(3, box.w * 0.02);
    ctx.drawImage(img, -box.w / 2 + border, -box.h + border, box.w - border * 2, box.h - border * 2);
    ctx.restore();
  }
  ctx.restore();
};

export const DEFAULT_PRESENCE: CharacterPresence = 'overlay';

// Put a transparent presenter on a solid background (reference images for the image model)
export const flattenImage = async (url: string, color: string): Promise<string> => {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.92);
};

const PRESENTER_STORAGE = 'presenterSettings';

export const loadPresenterSettings = (): PresenterSettings => {
  const fallback: PresenterSettings = { presence: DEFAULT_PRESENCE, position: 'left', asset: null };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(PRESENTER_STORAGE) || '{}') };
  } catch {
    return fallback;
  }
};

// Images can exceed the storage quota; drop poses, then the image, rather than failing
export const savePresenterSettings = (settings: PresenterSettings) => {
  const attempts: PresenterSettings[] = [
    settings,
    { ...settings, asset: settings.asset ? { ...settings.asset, poses: {} } : null },
    { ...settings, asset: null },
  ];
  for (const attempt of attempts) {
    try {
      localStorage.setItem(PRESENTER_STORAGE, JSON.stringify(attempt));
      return;
    } catch { /* try a smaller version */ }
  }
};
