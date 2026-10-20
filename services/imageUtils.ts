// Phone photos are often 4000px+ and several MB. Keep a reasonably sized copy for
// rendering, and an even smaller one for sending to the vision model.

export const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });

const drawScaled = (img: HTMLImageElement, maxDim: number, quality: number): string => {
  // naturalWidth/Height already reflect EXIF orientation in modern browsers
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not available');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
};

export const readPhotoFile = async (file: File, maxDim = 1920): Promise<string> => {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    return drawScaled(img, maxDim, 0.9);
  } catch {
    throw new Error(`${file.name}: 이 브라우저에서 열 수 없는 형식입니다. (iPhone HEIC 사진은 JPG로 변환 후 올려주세요)`);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

export const downscaleDataUrl = async (dataUrl: string, maxDim = 768): Promise<string> =>
  drawScaled(await loadImage(dataUrl), maxDim, 0.8);

export const dataUrlToInlineData = (dataUrl: string) => ({
  inlineData: {
    mimeType: dataUrl.substring(dataUrl.indexOf(':') + 1, dataUrl.indexOf(';')),
    data: dataUrl.split(',')[1],
  },
});

export const imageAspect = async (url: string): Promise<number> => {
  const img = await loadImage(url);
  return img.naturalWidth / img.naturalHeight;
};
