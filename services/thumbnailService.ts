import { AspectRatio, ThumbnailDesign } from '../types';
import { loadImage } from './imageUtils';

const THUMB_FONT = '"Black Han Sans", "Noto Sans KR", sans-serif';

export const thumbnailSize = (aspectRatio: string) => {
  if (aspectRatio === AspectRatio.Shorts) return { width: 1080, height: 1920 };
  if (aspectRatio === AspectRatio.Square) return { width: 1080, height: 1080 };
  return { width: 1280, height: 720 }; // YouTube recommended thumbnail size
};

const ensureFonts = async () => {
  if (!document.fonts) return;
  await Promise.all([
    document.fonts.load(`100px "Black Han Sans"`),
    document.fonts.load(`900 100px "Noto Sans KR"`),
  ]).catch(() => {});
  await document.fonts.ready;
};

// Cover-fit, keeping the given focus point (0..1) as close to center as possible
export const drawCover = (
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number },
  x: number, y: number, w: number, h: number,
  focusX = 0.5, focusY = 0.5, zoom = 1
) => {
  const iw = img.naturalWidth || img.videoWidth || 0;
  const ih = img.naturalHeight || img.videoHeight || 0;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih) * zoom;
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = Math.min(0, Math.max(w - dw, w / 2 - focusX * dw));
  const dy = Math.min(0, Math.max(h - dh, h / 2 - focusY * dh));
  ctx.drawImage(img, x + dx, y + dy, dw, dh);
};

// Split into lines: explicit '\n' first, then wrap words that overflow
const layoutLines = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] =>
  text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .flatMap(line => {
      const words = line.split(' ');
      const lines: string[] = [];
      let current = '';
      words.forEach(word => {
        const candidate = current ? `${current} ${word}` : word;
        if (current && ctx.measureText(candidate).width > maxWidth) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      });
      if (current) lines.push(current);
      return lines;
    });

// Largest font size where every line fits the box
const fitText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxHeight: number, startSize: number) => {
  let size = startSize;
  let lines: string[] = [];
  while (size > 24) {
    ctx.font = `${size}px ${THUMB_FONT}`;
    lines = layoutLines(ctx, text, maxWidth);
    const widest = Math.max(...lines.map(l => ctx.measureText(l).width), 0);
    if (widest <= maxWidth && lines.length * size * 1.15 <= maxHeight) break;
    size -= 4;
  }
  return { size, lines };
};

export const composeThumbnail = async (
  design: ThumbnailDesign,
  aspectRatio: string,
  focus?: { x: number; y: number }
): Promise<string> => {
  await ensureFonts();
  const { width, height } = thumbnailSize(aspectRatio);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not available');

  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);
  if (design.baseUrl) {
    const img = await loadImage(design.baseUrl);
    drawCover(ctx, img, 0, 0, width, height, focus?.x, focus?.y);
  }

  const text = design.text.trim();
  if (!text) return canvas.toDataURL('image/jpeg', 0.92);

  const isTall = height > width;
  const pad = width * 0.05;
  ctx.lineJoin = 'round';
  ctx.textBaseline = 'top';

  if (design.layout === 'bold') {
    // Dark gradient from the bottom, huge outlined text bottom-left
    const g = ctx.createLinearGradient(0, height * 0.35, 0, height);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    const { size, lines } = fitText(ctx, text, width - pad * 2, height * (isTall ? 0.38 : 0.55), height * (isTall ? 0.09 : 0.2));
    const lineH = size * 1.12;
    let y = height - pad * (isTall ? 3 : 1) - lines.length * lineH;
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      ctx.font = `${size}px ${THUMB_FONT}`;
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = size * 0.25;
      ctx.lineWidth = size * 0.16;
      ctx.strokeStyle = '#000';
      ctx.strokeText(line, pad, y);
      ctx.shadowBlur = 0;
      ctx.fillStyle = i === lines.length - 1 && lines.length > 1 ? design.highlightColor : '#FFFFFF';
      ctx.fillText(line, pad, y);
      y += lineH;
    });
  } else if (design.layout === 'box') {
    // Each line on its own solid bar, top-left — the classic Korean YouTube look
    const { size, lines } = fitText(ctx, text, width - pad * 3, height * (isTall ? 0.35 : 0.6), height * (isTall ? 0.08 : 0.15));
    const barPadX = size * 0.3;
    const barPadY = size * 0.14;
    let y = pad * (isTall ? 3 : 1);
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      ctx.font = `${size}px ${THUMB_FONT}`;
      const w = ctx.measureText(line).width;
      const highlighted = i % 2 === 0;
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = size * 0.2;
      ctx.fillStyle = highlighted ? design.highlightColor : '#111111';
      ctx.fillRect(pad, y, w + barPadX * 2, size + barPadY * 2);
      ctx.shadowBlur = 0;
      ctx.fillStyle = highlighted ? '#111111' : '#FFFFFF';
      ctx.fillText(line, pad + barPadX, y + barPadY + size * 0.04);
      y += size + barPadY * 2 + size * 0.12;
    });
  } else {
    // Clean: vignette + centered white text with soft shadow
    const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.2, width / 2, height / 2, Math.max(width, height) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0.15)');
    g.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    const { size, lines } = fitText(ctx, text, width - pad * 2, height * 0.45, height * (isTall ? 0.08 : 0.16));
    const lineH = size * 1.15;
    let y = (height - lines.length * lineH) / 2;
    ctx.textAlign = 'center';
    lines.forEach((line, i) => {
      ctx.font = `${size}px ${THUMB_FONT}`;
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = size * 0.35;
      ctx.fillStyle = i === 0 && lines.length > 1 ? design.highlightColor : '#FFFFFF';
      ctx.fillText(line, width / 2, y);
      y += lineH;
    });
    ctx.shadowBlur = 0;
  }

  return canvas.toDataURL('image/jpeg', 0.92);
};

export const downloadDataUrl = (dataUrl: string, filename: string) => {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};
