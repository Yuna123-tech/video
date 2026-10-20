import React, { useEffect, useMemo, useState } from 'react';
import { Download, Loader2, Sparkles, Wand2, Image as ImageIcon, Camera } from 'lucide-react';
import { AspectRatio, Scene, ThumbnailDesign, ThumbnailLayout, ThumbnailSourceKind, VideoMetadata } from '../types';
import { composeThumbnail, downloadDataUrl } from '../services/thumbnailService';
import { generateThumbnailImage, enhancePhotoForThumbnail } from '../services/geminiService';

interface ThumbnailStudioProps {
  metadata: VideoMetadata;
  scenes: Scene[];
  photos: string[];
  aspectRatio: AspectRatio;
  styleReferenceImage: string | null;
  fileTitle: string;
  onAiThumbnailChange: (url: string) => void;
}

interface Candidate {
  url: string;
  kind: ThumbnailSourceKind;
  label: string;
  focus?: { x: number; y: number };
}

const LAYOUTS: { id: ThumbnailLayout; name: string }[] = [
  { id: 'bold', name: '굵은 외곽선' },
  { id: 'box', name: '색 띠 강조' },
  { id: 'clean', name: '중앙 깔끔' },
];

const COLORS = ['#FFE500', '#FF3B30', '#34C759', '#00C2FF', '#FFFFFF'];

export const ThumbnailStudio: React.FC<ThumbnailStudioProps> = ({
  metadata, scenes, photos, aspectRatio, styleReferenceImage, fileTitle, onAiThumbnailChange
}) => {
  const [enhanced, setEnhanced] = useState<string[]>([]);
  const [busy, setBusy] = useState<'ai' | 'enhance' | null>(null);
  const [composed, setComposed] = useState<string | null>(null);

  // Focus point for a photo, taken from a scene that uses it
  const focusFor = (url: string) => {
    const scene = scenes.find(s => s.imageUrl === url && s.focusX !== undefined);
    return scene ? { x: scene.focusX!, y: scene.focusY ?? 0.5 } : undefined;
  };

  const candidates = useMemo<Candidate[]>(() => {
    const list: Candidate[] = [];
    const seen = new Set<string>();
    const add = (c: Candidate) => { if (!seen.has(c.url)) { seen.add(c.url); list.push(c); } };
    enhanced.forEach((url, i) => add({ url, kind: 'photo_ai', label: `AI 보정 ${i + 1}` }));
    if (metadata.thumbnailUrl) add({ url: metadata.thumbnailUrl, kind: 'ai', label: 'AI 생성' });
    photos.forEach((url, i) => add({ url, kind: 'photo', label: `내 사진 ${i + 1}`, focus: focusFor(url) }));
    scenes.forEach((s, i) => { if (s.imageUrl) add({ url: s.imageUrl, kind: 'scene', label: `장면 ${i + 1}`, focus: focusFor(s.imageUrl) }); });
    return list;
  }, [metadata.thumbnailUrl, photos, scenes, enhanced]);

  // Default background: the photo the AI picked > AI thumbnail > first scene
  const defaultBase = () => {
    if (metadata.thumbnailPhotoIndex !== undefined && photos[metadata.thumbnailPhotoIndex]) {
      return { url: photos[metadata.thumbnailPhotoIndex], kind: 'photo' as const };
    }
    if (metadata.thumbnailUrl) return { url: metadata.thumbnailUrl, kind: 'ai' as const };
    const first = scenes.find(s => s.imageUrl);
    return first ? { url: first.imageUrl!, kind: 'scene' as const } : null;
  };

  const [design, setDesign] = useState<ThumbnailDesign>(() => {
    const base = defaultBase();
    return {
      baseUrl: base?.url ?? null,
      source: base?.kind ?? 'ai',
      text: metadata.thumbnailText || metadata.title || '',
      layout: 'bold',
      highlightColor: COLORS[0],
    };
  });

  // Background arrives later (AI thumbnail / first scene image) — pick it up if nothing chosen yet
  useEffect(() => {
    if (design.baseUrl) return;
    const base = defaultBase();
    if (base) setDesign(d => ({ ...d, baseUrl: base.url, source: base.kind }));
  }, [metadata.thumbnailUrl, scenes]);

  // Re-render the real canvas output whenever the design changes (what you see is what you download)
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      composeThumbnail(design, aspectRatio, design.baseUrl ? focusFor(design.baseUrl) : undefined)
        .then(url => { if (!cancelled) setComposed(url); })
        .catch(e => console.warn('Thumbnail compose failed', e));
    }, 150);
    return () => { cancelled = true; clearTimeout(id); };
  }, [design, aspectRatio]);

  const handleGenerateAi = async () => {
    setBusy('ai');
    try {
      const url = await generateThumbnailImage(metadata.thumbnailPrompt, aspectRatio, styleReferenceImage);
      onAiThumbnailChange(url);
      setDesign(d => ({ ...d, baseUrl: url, source: 'ai' }));
    } catch (e: any) {
      alert(`썸네일 배경 생성 실패: ${e.message || e}`);
    } finally {
      setBusy(null);
    }
  };

  const handleEnhancePhoto = async () => {
    if (!design.baseUrl) return;
    setBusy('enhance');
    try {
      const url = await enhancePhotoForThumbnail(design.baseUrl, design.text, aspectRatio);
      setEnhanced(prev => [url, ...prev]);
      setDesign(d => ({ ...d, baseUrl: url, source: 'photo_ai' }));
    } catch (e: any) {
      alert(`사진 보정 실패: ${e.message || e}`);
    } finally {
      setBusy(null);
    }
  };

  const isTall = aspectRatio === AspectRatio.Shorts;
  const canEnhance = design.source === 'photo' || design.source === 'scene';

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <label className="text-xs text-gray-400 font-semibold flex items-center gap-1.5">
          <ImageIcon size={13} className="text-gray-500" /> 썸네일 자동 제작
        </label>
        <button
          onClick={() => composed && downloadDataUrl(composed, `${fileTitle}_thumbnail.jpg`)}
          disabled={!composed}
          className="text-[11px] bg-primary-600 hover:bg-primary-500 disabled:opacity-40 text-white font-bold px-3 py-1.5 rounded-lg flex items-center gap-1"
        >
          <Download size={12} /> 썸네일 저장 (JPG)
        </button>
      </div>

      {/* Live result */}
      <div className={`relative rounded-xl overflow-hidden border border-gray-700 bg-black mx-auto ${isTall ? 'aspect-[9/16] max-w-[200px]' : aspectRatio === AspectRatio.Square ? 'aspect-square max-w-[300px]' : 'aspect-video w-full'}`}>
        {composed ? <img src={composed} className="w-full h-full object-cover" /> : (
          <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">배경 이미지 준비 중...</div>
        )}
        {busy && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-2 text-xs text-gray-200">
            <Loader2 className="animate-spin" size={20} /> {busy === 'ai' ? 'AI 배경 생성 중...' : '사진을 썸네일용으로 보정 중...'}
          </div>
        )}
      </div>

      {/* Hook text */}
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">썸네일 문구 (줄바꿈으로 줄 나누기 · 제목과 다른 짧은 후킹 문구 추천)</label>
        <textarea
          value={design.text}
          onChange={(e) => setDesign(d => ({ ...d, text: e.target.value }))}
          rows={2}
          className="w-full bg-black/60 border border-gray-700 rounded-lg p-2 text-sm font-bold text-white focus:border-primary-500 focus:outline-none resize-none"
        />
      </div>

      {/* Layout & color */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex bg-gray-800 rounded-lg p-0.5 border border-gray-700">
          {LAYOUTS.map(l => (
            <button
              key={l.id}
              onClick={() => setDesign(d => ({ ...d, layout: l.id }))}
              className={`px-2.5 py-1 rounded-md text-[11px] ${design.layout === l.id ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
            >
              {l.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          {COLORS.map(c => (
            <button
              key={c}
              onClick={() => setDesign(d => ({ ...d, highlightColor: c }))}
              className={`w-5 h-5 rounded-full border-2 ${design.highlightColor === c ? 'border-white' : 'border-gray-700'}`}
              style={{ background: c }}
              title="강조 색상"
            />
          ))}
        </div>
      </div>

      {/* Background picker */}
      <div>
        <label className="text-[11px] text-gray-500 mb-1 block">배경 선택</label>
        <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
          {candidates.map(c => (
            <button
              key={c.url.slice(-64) + c.label}
              onClick={() => setDesign(d => ({ ...d, baseUrl: c.url, source: c.kind }))}
              className={`relative shrink-0 rounded-md overflow-hidden border-2 ${design.baseUrl === c.url ? 'border-primary-500' : 'border-transparent opacity-70 hover:opacity-100'} ${isTall ? 'w-12 h-20' : 'w-24 h-14'}`}
              title={c.label}
            >
              <img src={c.url} className="w-full h-full object-cover" />
              <span className="absolute bottom-0 inset-x-0 bg-black/70 text-[9px] text-white truncate px-1">{c.label}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <button
            onClick={handleGenerateAi}
            disabled={!!busy}
            className="flex items-center gap-1.5 text-[11px] bg-gray-800 border border-gray-700 text-gray-300 px-2.5 py-1.5 rounded-lg hover:bg-gray-750 disabled:opacity-50"
          >
            <Sparkles size={12} /> {metadata.thumbnailUrl ? 'AI 배경 다시 만들기' : 'AI 배경 만들기'}
          </button>
          {canEnhance && (
            <button
              onClick={handleEnhancePhoto}
              disabled={!!busy}
              className="flex items-center gap-1.5 text-[11px] bg-gray-800 border border-gray-700 text-gray-300 px-2.5 py-1.5 rounded-lg hover:bg-gray-750 disabled:opacity-50"
              title="선택한 사진 속 인물·대상은 그대로 두고 색감·조명·구도를 썸네일용으로 보정합니다"
            >
              {design.source === 'photo' ? <Camera size={12} /> : <Wand2 size={12} />} 선택한 사진 AI 보정
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
