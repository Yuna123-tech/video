import React, { useRef, useState } from 'react';
import { Image as ImageIcon, X, ChevronLeft, ChevronRight, Loader2, Trash2 } from 'lucide-react';
import { PhotoPlacement } from '../types';
import { readPhotoFile } from '../services/imageUtils';

interface PhotoManagerProps {
  photos: string[];
  onChange: (photos: string[]) => void;
  label: string;
  hint: string;
  placement?: PhotoPlacement;
  onPlacementChange?: (placement: PhotoPlacement) => void;
  maxPhotos?: number;
}

export const readPhotoFiles = async (files: FileList | File[]) => {
  const results = await Promise.allSettled(Array.from(files).filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)).map(f => readPhotoFile(f)));
  const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map(r => r.value);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason?.message || String(r.reason));
  return { ok, failed };
};

export const PhotoManager: React.FC<PhotoManagerProps> = ({
  photos, onChange, label, hint, placement, onPlacementChange, maxPhotos = 40
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [isDropping, setIsDropping] = useState(false);

  const addFiles = async (files: FileList | File[]) => {
    setLoading(true);
    try {
      const { ok, failed } = await readPhotoFiles(files);
      const room = maxPhotos - photos.length;
      onChange([...photos, ...ok.slice(0, room)]);
      const notes = [...failed];
      if (ok.length > room) notes.push(`사진은 최대 ${maxPhotos}장까지 사용할 수 있어 ${ok.length - room}장은 제외했습니다.`);
      if (notes.length) alert(notes.join('\n'));
    } finally {
      setLoading(false);
    }
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= photos.length || from === to) return;
    const next = [...photos];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-400">{label}</label>
        {photos.length > 0 && (
          <button onClick={() => onChange([])} className="text-[10px] text-gray-500 hover:text-red-400 flex items-center gap-1">
            <Trash2 size={10} /> 모두 지우기
          </button>
        )}
      </div>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setIsDropping(true); } }}
        onDragLeave={() => setIsDropping(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDropping(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        className={`border-2 border-dashed rounded-lg p-4 flex flex-col items-center justify-center gap-1.5 cursor-pointer transition ${
          isDropping ? 'border-primary-500 bg-primary-600/10' : 'border-gray-700 bg-gray-900/50 hover:border-primary-500 hover:bg-gray-800/50'
        }`}
      >
        {loading ? <Loader2 className="w-6 h-6 text-primary-500 animate-spin" /> : <ImageIcon className="w-6 h-6 text-gray-500" />}
        <span className="text-xs text-gray-400">클릭하거나 사진을 끌어다 놓으세요 ({photos.length}/{maxPhotos})</span>
        <span className="text-[10px] text-gray-500 text-center">{hint}</span>
      </div>
      <input
        type="file"
        ref={inputRef}
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
        accept="image/*"
        multiple
        className="hidden"
      />

      {photos.length > 0 && (
        <>
          <div className="grid grid-cols-4 gap-2">
            {photos.map((img, idx) => (
              <div
                key={`${idx}-${img.length}`}
                draggable
                onDragStart={() => setDragIndex(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (dragIndex !== null) move(dragIndex, idx);
                  setDragIndex(null);
                }}
                className={`relative group aspect-square rounded-md overflow-hidden border cursor-move ${dragIndex === idx ? 'border-primary-500 opacity-50' : 'border-gray-700'}`}
              >
                <img src={img} className="w-full h-full object-cover pointer-events-none" />
                <button
                  onClick={() => onChange(photos.filter((_, i) => i !== idx))}
                  className="absolute top-0 right-0 bg-red-600 p-1 text-white opacity-0 group-hover:opacity-100 transition"
                  title="삭제"
                >
                  <X size={12} />
                </button>
                <div className="absolute bottom-0 inset-x-0 flex items-center justify-between bg-black/60 text-white text-[10px]">
                  <button onClick={() => move(idx, idx - 1)} className="px-1 opacity-0 group-hover:opacity-100 disabled:hidden" disabled={idx === 0}><ChevronLeft size={11} /></button>
                  <span className="px-1">{idx + 1}</span>
                  <button onClick={() => move(idx, idx + 1)} className="px-1 opacity-0 group-hover:opacity-100 disabled:hidden" disabled={idx === photos.length - 1}><ChevronRight size={11} /></button>
                </div>
              </div>
            ))}
          </div>

          {onPlacementChange && (
            <div className="bg-gray-800 p-1 rounded-lg flex border border-gray-700 text-[11px]">
              <button
                onClick={() => onPlacementChange('auto')}
                className={`flex-1 py-1.5 rounded-md transition ${placement === 'auto' ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
                title="AI가 사진을 보고 이야기 흐름에 맞게 순서를 정합니다"
              >
                AI가 이야기 순서로 배치
              </button>
              <button
                onClick={() => onPlacementChange('ordered')}
                className={`flex-1 py-1.5 rounded-md transition ${placement === 'ordered' ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
                title="위 순서대로 사진 1장 = 장면 1개"
              >
                내가 정한 순서대로
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
