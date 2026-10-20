import React, { useRef } from 'react';
import { Loader2, Sparkles, Upload, Trash2, UserRound, AlertTriangle } from 'lucide-react';
import { CharacterPresence, PresenterPose, PresenterSettings } from '../types';
import { POSE_LABELS } from '../services/presenterService';

interface PresenterPanelProps {
  settings: PresenterSettings;
  onChange: (patch: Partial<PresenterSettings>) => void;
  isOutdated: boolean; // Character settings changed since the AI presenter was made
  busy: string | null; // Current presenter task message
  onGenerate: () => void;
  onUpload: (file: File) => void;
  onGeneratePoses: () => void;
}

const PRESENCE_OPTIONS: { id: CharacterPresence; title: string; desc: string }[] = [
  { id: 'overlay', title: '캐릭터가 진행 (추천)', desc: '모든 장면 구석에 캐릭터가 서서 말하며 설명' },
  { id: 'in_scene', title: '장면 속 등장', desc: 'AI 그림 안에 캐릭터를 그려 넣음 (사진 장면은 진행자로 표시)' },
  { id: 'none', title: '캐릭터 없음', desc: '내레이션만' },
];

const CHECKERBOARD = 'repeating-conic-gradient(#374151 0% 25%, #1f2937 0% 50%) 50% / 16px 16px';

export const PresenterPanel: React.FC<PresenterPanelProps> = ({
  settings, onChange, isOutdated, busy, onGenerate, onUpload, onGeneratePoses
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const asset = settings.asset;
  const poseKeys = Object.keys(POSE_LABELS) as PresenterPose[];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-1.5">
        {PRESENCE_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => onChange({ presence: opt.id })}
            className={`p-2 rounded-lg border text-left transition ${
              settings.presence === opt.id ? 'bg-primary-600/20 border-primary-500 text-white' : 'bg-gray-800/50 border-gray-700 text-gray-400 hover:bg-gray-750'
            }`}
          >
            <div className="text-xs font-semibold">{opt.title}</div>
            <div className="text-[10px] text-gray-400">{opt.desc}</div>
          </button>
        ))}
      </div>

      {settings.presence !== 'none' && (
        <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-primary-300 flex items-center gap-1.5"><UserRound size={13} /> 내 진행자 캐릭터</span>
            <div className="flex bg-gray-800 rounded-md p-0.5 text-[10px] border border-gray-700">
              {(['left', 'right'] as const).map(pos => (
                <button
                  key={pos}
                  onClick={() => onChange({ position: pos })}
                  className={`px-2 py-0.5 rounded ${settings.position === pos ? 'bg-gray-600 text-white' : 'text-gray-400'}`}
                >
                  {pos === 'left' ? '왼쪽' : '오른쪽'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <div
              className="w-24 h-32 rounded-lg overflow-hidden border border-gray-700 shrink-0 flex items-end justify-center"
              style={{ background: CHECKERBOARD }}
            >
              {busy && !asset ? (
                <Loader2 className="animate-spin text-primary-400 m-auto" />
              ) : asset ? (
                <img src={asset.base} className={`max-w-full max-h-full ${asset.isCutout ? 'object-contain' : 'object-cover w-full h-full'}`} />
              ) : (
                <span className="text-[10px] text-gray-500 m-auto text-center px-1">아직 없음<br />(생성 시 자동 제작)</span>
              )}
            </div>
            <div className="flex-1 min-w-0 space-y-1.5">
              <button
                onClick={onGenerate}
                disabled={!!busy}
                className="w-full flex items-center justify-center gap-1.5 text-[11px] bg-primary-600 hover:bg-primary-500 disabled:opacity-50 text-white px-2 py-1.5 rounded-md"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} {asset ? 'AI로 다시 만들기' : 'AI로 캐릭터 만들기'}
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={!!busy}
                className="w-full flex items-center justify-center gap-1.5 text-[11px] bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-750 disabled:opacity-50 px-2 py-1.5 rounded-md"
                title="배경이 투명한 PNG나 초록 배경 이미지가 가장 자연스럽습니다"
              >
                <Upload size={12} /> 내 캐릭터 이미지 올리기
              </button>
              {asset && (
                <button
                  onClick={() => onChange({ asset: null })}
                  disabled={!!busy}
                  className="w-full flex items-center justify-center gap-1 text-[10px] text-gray-500 hover:text-red-400"
                >
                  <Trash2 size={10} /> 지우기
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/webp,image/jpeg"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
              />
            </div>
          </div>

          {busy && <p className="text-[10px] text-primary-300">{busy}</p>}
          {isOutdated && !busy && (
            <p className="text-[10px] text-amber-300 flex items-start gap-1">
              <AlertTriangle size={11} className="shrink-0 mt-0.5" /> 캐릭터 스타일/설명이 바뀌었어요. 다음 영상 생성 때 새 캐릭터로 다시 만듭니다.
            </p>
          )}
          {asset && !asset.isCutout && (
            <p className="text-[10px] text-gray-500">배경을 지우지 못해 카드 형태로 표시됩니다. 투명 PNG를 올리면 캐릭터만 깔끔하게 서 있어요.</p>
          )}

          {asset && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500">장면별 포즈 (대본 분위기에 맞춰 자동 선택)</span>
                {poseKeys.some(p => p !== 'explain' && !asset.poses[p]) && (
                  <button onClick={onGeneratePoses} disabled={!!busy} className="text-[10px] text-primary-300 hover:text-primary-200 disabled:opacity-50">
                    포즈 미리 만들기
                  </button>
                )}
              </div>
              <div className="flex gap-1.5">
                {poseKeys.map(pose => {
                  const url = pose === 'explain' ? asset.base : asset.poses[pose];
                  return (
                    <div key={pose} className="w-12 text-center">
                      <div className="w-12 h-14 rounded border border-gray-700 overflow-hidden flex items-end justify-center" style={{ background: CHECKERBOARD }}>
                        {url ? <img src={url} className="max-w-full max-h-full object-contain" /> : <span className="text-[9px] text-gray-600 m-auto">필요 시<br />생성</span>}
                      </div>
                      <span className="text-[9px] text-gray-400">{POSE_LABELS[pose]}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
