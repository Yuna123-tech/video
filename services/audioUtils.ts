// Post-processing for raw Gemini TTS output (16-bit mono PCM).
// Each scene is synthesized separately, so without this step clips have uneven
// leading/trailing silence and volume, which makes the narration sound choppy.

export interface ProcessedAudio {
  wav: Blob;
  duration: number; // Total seconds, including lead-in and pause
  speechOffset: number; // Seconds before speech starts
  speechDuration: number; // Seconds of speech
}

interface ProcessOptions {
  sampleRate: number;
  leadIn?: number; // Seconds of silence before speech
  pauseAfter?: number; // Seconds of silence after speech
}

const SILENCE_THRESHOLD = 0.015; // ~ -36 dBFS
const TARGET_RMS = 0.1; // ~ -20 dBFS, typical spoken-word loudness
const PEAK_LIMIT = 0.95;
const FADE_SECONDS = 0.012;

export const base64ToInt16 = (base64: string): Int16Array => {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length - (bin.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
};

// "audio/L16;codec=pcm;rate=24000" -> 24000
export const parseSampleRate = (mimeType: string | undefined, fallback = 24000): number => {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? parseInt(match[1], 10) : fallback;
};

const findSpeechBounds = (samples: Float32Array, sampleRate: number): [number, number] => {
  // Use a short moving window so isolated clicks don't count as speech.
  const win = Math.max(1, Math.floor(sampleRate * 0.01));
  const isLoud = (center: number) => {
    let sum = 0;
    const from = Math.max(0, center - win);
    const to = Math.min(samples.length, center + win);
    for (let i = from; i < to; i++) sum += Math.abs(samples[i]);
    return sum / (to - from) > SILENCE_THRESHOLD * 0.5;
  };

  let start = 0;
  while (start < samples.length && !(Math.abs(samples[start]) > SILENCE_THRESHOLD && isLoud(start))) start += win;
  let end = samples.length - 1;
  while (end > start && !(Math.abs(samples[end]) > SILENCE_THRESHOLD && isLoud(end))) end -= win;

  if (start >= end) return [0, samples.length];
  // Keep a little room so word onsets and breaths aren't clipped.
  const margin = Math.floor(sampleRate * 0.04);
  return [Math.max(0, start - margin), Math.min(samples.length, end + margin)];
};

export const processSpeech = (pcm: Int16Array, opts: ProcessOptions): ProcessedAudio => {
  const { sampleRate, leadIn = 0.08, pauseAfter = 0.35 } = opts;

  const floats = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 32768;

  const [start, end] = findSpeechBounds(floats, sampleRate);
  const speech = floats.subarray(start, end);

  // Loudness normalization on voiced samples only
  let sumSq = 0;
  let voiced = 0;
  let peak = 0;
  for (let i = 0; i < speech.length; i++) {
    const a = Math.abs(speech[i]);
    if (a > peak) peak = a;
    if (a > SILENCE_THRESHOLD) {
      sumSq += speech[i] * speech[i];
      voiced++;
    }
  }
  const rms = voiced ? Math.sqrt(sumSq / voiced) : 0;
  let gain = rms > 0 ? TARGET_RMS / rms : 1;
  gain = Math.min(gain, peak > 0 ? PEAK_LIMIT / peak : gain, 4);
  gain = Math.max(gain, 0.5);

  const leadSamples = Math.floor(leadIn * sampleRate);
  const pauseSamples = Math.floor(pauseAfter * sampleRate);
  const fadeSamples = Math.min(Math.floor(FADE_SECONDS * sampleRate), Math.floor(speech.length / 2));
  const out = new Int16Array(leadSamples + speech.length + pauseSamples);

  for (let i = 0; i < speech.length; i++) {
    let v = speech[i] * gain;
    if (i < fadeSamples) v *= i / fadeSamples;
    else if (i >= speech.length - fadeSamples) v *= (speech.length - i) / fadeSamples;
    out[leadSamples + i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }

  return {
    wav: int16ToWav(out, sampleRate),
    duration: out.length / sampleRate,
    speechOffset: leadSamples / sampleRate,
    speechDuration: speech.length / sampleRate,
  };
};

export const int16ToWav = (pcm: Int16Array, sampleRate: number): Blob => {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
};

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// "GPT=지피티" lines -> replacements applied before TTS
export const applyPronunciationDict = (text: string, dict: string): string => {
  let result = text;
  dict
    .split('\n')
    .map(line => line.split('='))
    .filter(parts => parts.length === 2 && parts[0].trim())
    .sort((a, b) => b[0].trim().length - a[0].trim().length) // longest match first
    .forEach(([from, to]) => {
      const escaped = from.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), to.trim());
    });
  return result;
};
