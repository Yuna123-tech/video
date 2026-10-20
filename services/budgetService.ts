// Keeps API usage inside what the user is willing to spend:
// daily call limits per kind, a "quota exhausted" stop flag, and a saving mode that skips optional calls.

export type CallKind = 'text' | 'image' | 'tts' | 'video';

export interface BudgetSettings {
  enabled: boolean; // Enforce daily limits
  savingMode: boolean; // Skip optional calls (AI thumbnail background, extra poses, Pro TTS, Veo)
  limits: Record<CallKind, number>; // Max successful calls per day (0 = blocked)
}

export interface DailyUsage {
  date: string; // Local date YYYY-MM-DD
  counts: Record<CallKind, number>;
  exhausted: Partial<Record<CallKind, string>>; // Google reported the quota is used up
}

export const CALL_LABELS: Record<CallKind, string> = {
  text: '대본·분석',
  image: '이미지',
  tts: '음성',
  video: 'Veo 영상',
};

const SETTINGS_KEY = 'budgetSettings';
const DAILY_KEY = 'budgetDailyUsage';

const DEFAULT_SETTINGS: BudgetSettings = {
  enabled: true,
  savingMode: true,
  limits: { text: 50, image: 40, tts: 80, video: 0 },
};

const emptyCounts = (): Record<CallKind, number> => ({ text: 0, image: 0, tts: 0, video: 0 });

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
};

let settings: BudgetSettings = read(SETTINGS_KEY, DEFAULT_SETTINGS);
settings = { ...settings, limits: { ...DEFAULT_SETTINGS.limits, ...settings.limits } };
let daily: DailyUsage = read(DAILY_KEY, { date: today(), counts: emptyCounts(), exhausted: {} });

const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

// New day: counters and "exhausted" flags start over (Google's free quotas also reset daily)
const rollover = () => {
  if (daily.date !== today()) {
    daily = { date: today(), counts: emptyCounts(), exhausted: {} };
    write(DAILY_KEY, daily);
  }
};

export const subscribeBudget = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const getBudgetSettings = () => settings;

export const updateBudgetSettings = (patch: Partial<BudgetSettings>) => {
  settings = { ...settings, ...patch, limits: { ...settings.limits, ...(patch.limits || {}) } };
  write(SETTINGS_KEY, settings);
  notify();
};

export const getDailyUsage = (): DailyUsage => {
  rollover();
  return daily;
};

export const remainingCalls = (kind: CallKind): number => {
  rollover();
  if (daily.exhausted[kind]) return 0;
  if (!settings.enabled) return Infinity;
  return Math.max(0, settings.limits[kind] - daily.counts[kind]);
};

export class BudgetError extends Error {
  constructor(public kind: CallKind, message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

// Call before every API request
export const checkBudget = (kind: CallKind) => {
  rollover();
  if (daily.exhausted[kind]) {
    throw new BudgetError(kind, `${CALL_LABELS[kind]} 한도가 소진되어 더 호출하지 않습니다. (${daily.exhausted[kind]})`);
  }
  if (settings.enabled && daily.counts[kind] >= settings.limits[kind]) {
    throw new BudgetError(kind, `오늘 정한 ${CALL_LABELS[kind]} 한도(${settings.limits[kind]}회)에 도달했습니다.`);
  }
};

// Call after every successful request
export const recordCall = (kind: CallKind) => {
  rollover();
  daily = { ...daily, counts: { ...daily.counts, [kind]: daily.counts[kind] + 1 } };
  write(DAILY_KEY, daily);
  notify();
};

export const markExhausted = (kind: CallKind, reason: string) => {
  rollover();
  daily = { ...daily, exhausted: { ...daily.exhausted, [kind]: reason } };
  write(DAILY_KEY, daily);
  notify();
};

export const clearExhausted = () => {
  daily = { ...daily, exhausted: {} };
  write(DAILY_KEY, daily);
  notify();
};

// 429s come in two flavours: per-minute (wait and retry, costs nothing) and
// daily / spending-cap / not-available-on-free-tier (retrying only burns time, so stop).
export const isHardQuotaError = (message: string) =>
  // Note: Google's ordinary per-minute 429 also says "check your plan and billing details", so "billing" alone is not a signal
  /PerDay|per day|daily limit|spending cap|spend cap|limit:\s*0\b/i.test(message);

export const isRateLimitError = (message: string) =>
  /429|RESOURCE_EXHAUSTED|quota/i.test(message);
