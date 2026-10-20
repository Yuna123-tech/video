import React, { useEffect, useState } from 'react';
import { KeyRound, ExternalLink, RotateCcw, ShieldCheck, PiggyBank } from 'lucide-react';
import { getApiKeySource, getUserApiKey, setUserApiKey, subscribeUsage, resetUsage, UsageStats } from '../services/geminiService';
import {
  CALL_LABELS, CallKind, clearExhausted, getBudgetSettings, getDailyUsage, subscribeBudget, updateBudgetSettings,
} from '../services/budgetService';

const KINDS: CallKind[] = ['text', 'image', 'tts', 'video'];

// Which Google API key the app bills against, today's usage vs. the user's limits, and the saving switches
export const ApiUsagePanel: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [draft, setDraft] = useState(getUserApiKey());
  const [source, setSource] = useState(getApiKeySource());
  const [budget, setBudget] = useState(getBudgetSettings());
  const [daily, setDaily] = useState(getDailyUsage());

  useEffect(() => subscribeUsage(setUsage), []);
  useEffect(() => subscribeBudget(() => {
    setBudget(getBudgetSettings());
    setDaily(getDailyUsage());
  }), []);

  const save = () => {
    setUserApiKey(draft);
    setSource(getApiKeySource());
  };

  const sourceLabel = source === 'user'
    ? '직접 입력한 키'
    : source === 'env'
    ? 'AI Studio / .env.local 키'
    : 'API 키 없음';
  const exhaustedKinds = KINDS.filter(k => daily.exhausted[k]);
  const anyExhausted = exhaustedKinds.length > 0;

  return (
    <div className={`rounded-lg border text-xs ${source === 'none' || anyExhausted ? 'border-amber-500/50 bg-amber-900/10' : 'border-gray-700 bg-gray-800/30'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between p-2.5 gap-2">
        <span className="flex items-center gap-1.5 text-gray-300 shrink-0"><KeyRound size={13} className="text-primary-400" /> API 키 · 사용량 · 한도</span>
        <span className="text-[10px] text-gray-500 truncate">
          {budget.savingMode && <span className="text-emerald-400 mr-1">절약모드</span>}
          {anyExhausted ? <span className="text-amber-300">한도 소진</span> : `오늘 이미지 ${daily.counts.image}/${budget.enabled ? budget.limits.image : '∞'}`} {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 space-y-3">
          {/* No-charge guidance */}
          <div className="bg-emerald-900/20 border border-emerald-500/30 rounded p-2 text-[10px] text-emerald-100/90 leading-relaxed space-y-1">
            <p className="flex items-center gap-1 font-semibold text-emerald-300"><ShieldCheck size={12} /> 추가 요금이 절대 나가지 않게 하려면</p>
            <p>① <b>결제(billing)를 연결하지 않은 무료 프로젝트</b>의 키를 쓰세요. 무료 등급 키는 한도를 다 쓰면 오류만 날 뿐 요금이 청구되지 않습니다.</p>
            <p>② 결제를 연결했다면 Google 쪽에서 <b>지출 한도(spend cap)</b>를 낮게 걸어 두세요. 이 프로그램의 한도는 이 브라우저에서만 지켜지는 보조 장치입니다.</p>
          </div>

          {/* Key */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-gray-400">사용 중인 키: <b className="text-gray-200">{sourceLabel}</b></div>
            <div className="flex gap-1.5">
              <input
                type="password"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="내 Gemini API 키 (비우면 기본 키 사용)"
                className="flex-1 min-w-0 bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-[11px] focus:ring-1 focus:ring-primary-500 focus:outline-none"
              />
              <button onClick={save} className="bg-primary-600 hover:bg-primary-500 text-white px-2.5 rounded text-[11px]">저장</button>
            </div>
            <p className="text-[10px] text-gray-500">입력한 키는 이 브라우저에만 저장됩니다.</p>
          </div>

          {/* Saving mode */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={budget.savingMode}
              onChange={(e) => updateBudgetSettings({ savingMode: e.target.checked })}
              className="mt-0.5 accent-emerald-500"
            />
            <span>
              <span className="flex items-center gap-1 text-gray-200 font-medium"><PiggyBank size={12} className="text-emerald-400" /> 절약 모드</span>
              <span className="block text-[10px] text-gray-500 leading-relaxed">
                꼭 필요한 호출만 합니다: Veo 끄기, 음성은 Flash 모델, 썸네일 AI 배경은 버튼 누를 때만, 캐릭터 포즈는 기본 1장, 같은 대본은 이전 분석 재사용
              </span>
            </span>
          </label>

          {/* Daily limits */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={budget.enabled}
                onChange={(e) => updateBudgetSettings({ enabled: e.target.checked })}
                className="accent-primary-500"
              />
              <span className="text-gray-200 font-medium">하루 호출 한도 지키기</span>
              <span className="text-[10px] text-gray-500 ml-auto">{daily.date} 기준</span>
            </label>
            <div className="space-y-1">
              {KINDS.map(kind => {
                const limit = budget.limits[kind];
                const used = daily.counts[kind];
                const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : used > 0 ? 100 : 0;
                return (
                  <div key={kind} className="flex items-center gap-2">
                    <span className="w-14 text-[10px] text-gray-400 shrink-0">{CALL_LABELS[kind]}</span>
                    <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${daily.exhausted[kind] || pct >= 100 ? 'bg-amber-500' : pct > 75 ? 'bg-yellow-500' : 'bg-emerald-500'}`}
                        style={{ width: `${daily.exhausted[kind] ? 100 : pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-400 w-8 text-right">{used}/</span>
                    <input
                      type="number"
                      min={0}
                      value={limit}
                      disabled={!budget.enabled}
                      onChange={(e) => updateBudgetSettings({ limits: { ...budget.limits, [kind]: Math.max(0, parseInt(e.target.value || '0', 10)) } })}
                      className="w-12 bg-gray-900 border border-gray-600 rounded px-1 py-0.5 text-[10px] text-right disabled:opacity-40"
                      title="하루 최대 호출 수 (0 = 사용 안 함)"
                    />
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-500">0으로 두면 그 기능은 호출하지 않습니다. 실제 Google 무료 한도는 모델·계정마다 달라서 아래 링크에서 확인하고 그보다 낮게 맞추세요.</p>
          </div>

          {anyExhausted && (
            <div className="bg-amber-900/30 border border-amber-500/40 rounded p-2 text-[10px] text-amber-100 space-y-1">
              <p>Google이 한도 소진을 알려와 오늘은 <b>{exhaustedKinds.map(k => CALL_LABELS[k]).join(', ')}</b> 호출을 막아 두었습니다. 날짜가 바뀌면 자동으로 풀립니다.</p>
              <button onClick={clearExhausted} className="text-amber-300 hover:underline">한도를 늘렸다면 지금 다시 시도 허용</button>
            </div>
          )}

          {usage && (
            <div className="flex items-center justify-between text-[10px] text-gray-500">
              <span>이번 세션 토큰: 입력 {usage.inputTokens.toLocaleString()} · 출력 {usage.outputTokens.toLocaleString()}</span>
              <button onClick={resetUsage} className="flex items-center gap-1 hover:text-gray-300"><RotateCcw size={9} /> 초기화</button>
            </div>
          )}

          <div className="flex gap-3 text-[10px]">
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-primary-300 hover:underline flex items-center gap-0.5">키·결제 상태 확인 <ExternalLink size={9} /></a>
            <a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noreferrer" className="text-primary-300 hover:underline flex items-center gap-0.5">무료 한도 <ExternalLink size={9} /></a>
            <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer" className="text-primary-300 hover:underline flex items-center gap-0.5">요금표 <ExternalLink size={9} /></a>
          </div>
        </div>
      )}
    </div>
  );
};
