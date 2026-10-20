import { Scene, AspectRatio } from '../types';

export interface SubtitleCue {
  start: number; // Seconds, relative to the scene start
  end: number;
  ko: string;
  en: string;
}

export interface TimelineScene {
  scene: Scene;
  index: number;
  start: number; // Absolute seconds in the video
  end: number;
  cues: SubtitleCue[];
}

export const stripMarkup = (text: string) =>
  (text || '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1').trim();

export const maxCharsForRatio = (aspectRatio: string) =>
  aspectRatio === AspectRatio.Shorts ? 16 : aspectRatio === AspectRatio.Square ? 20 : 28;

const SENTENCE_RE = /[^.!?。？！]+[.!?。？！]*["'”’)]*\s*/g;

const splitSentences = (text: string): string[] =>
  (stripMarkup(text).replace(/\s+/g, ' ').match(SENTENCE_RE) || []).map(s => s.trim()).filter(Boolean);

// Split text into exactly `n` groups of words with roughly equal length.
const splitIntoN = (text: string, n: number): string[] => {
  const words = stripMarkup(text).split(/\s+/).filter(Boolean);
  if (n <= 1 || words.length <= 1) return [words.join(' ')];
  const total = words.join(' ').length;
  const groups: string[] = [];
  let current: string[] = [];
  let consumed = 0;
  words.forEach((word, i) => {
    current.push(word);
    consumed += word.length + 1;
    const remainingGroups = n - groups.length - 1;
    const remainingWords = words.length - i - 1;
    if (remainingGroups > 0 && remainingWords >= remainingGroups && consumed >= (total * (groups.length + 1)) / n) {
      groups.push(current.join(' '));
      current = [];
    }
  });
  if (current.length) groups.push(current.join(' '));
  return groups;
};

// Split one sentence into balanced lines, preferring comma boundaries.
const splitSentence = (sentence: string, maxChars: number): string[] => {
  if (sentence.length <= maxChars) return [sentence];
  const clauses = sentence.split(/(?<=[,，、])\s*/).filter(Boolean);
  const merged: string[] = [];
  clauses.forEach(clause => {
    const last = merged[merged.length - 1];
    if (last && `${last} ${clause}`.length <= maxChars) merged[merged.length - 1] = `${last} ${clause}`;
    else merged.push(clause);
  });
  return merged.flatMap(part =>
    part.length <= maxChars ? [part] : splitIntoN(part, Math.ceil(part.length / maxChars))
  );
};

interface Chunk {
  text: string;
  sentence: number;
}

const chunkWithSentences = (text: string, maxChars: number): Chunk[] =>
  splitSentences(text).flatMap((sentence, idx) =>
    splitSentence(sentence, maxChars).map(t => ({ text: t, sentence: idx }))
  );

// Split narration into readable on-screen chunks: sentence > clause > balanced word groups.
export const splitIntoChunks = (text: string, maxChars: number): string[] =>
  chunkWithSentences(text, maxChars).map(c => c.text);

// English line per Korean chunk. When sentence counts match, English follows Korean sentence by sentence.
const alignEnglish = (koChunks: Chunk[], enText: string, maxChars: number): string[] => {
  if (!enText || !koChunks.length) return koChunks.map(() => '');
  const enSentences = splitSentences(enText);
  const koSentenceCount = koChunks[koChunks.length - 1].sentence + 1;

  if (enSentences.length !== koSentenceCount) {
    return splitIntoN(enText, Math.min(koChunks.length, Math.max(1, Math.ceil(enText.length / (maxChars * 2.4)))))
      .flatMap((group, i, groups) => {
        // Stretch groups over the Korean chunks proportionally
        const from = Math.round((i * koChunks.length) / groups.length);
        const to = Math.round(((i + 1) * koChunks.length) / groups.length);
        return Array(to - from).fill(group);
      });
  }

  const result: string[] = [];
  enSentences.forEach((enSentence, sIdx) => {
    const koCount = koChunks.filter(c => c.sentence === sIdx).length;
    // Keep the English sentence whole unless it's too long for one subtitle line
    const pieces = Math.min(koCount, Math.max(1, Math.ceil(enSentence.length / (maxChars * 2.4))));
    const groups = splitIntoN(enSentence, pieces);
    for (let k = 0; k < koCount; k++) result.push(groups[Math.floor((k * groups.length) / koCount)]);
  });
  return result;
};

// Time subtitle chunks across the spoken part of the scene, weighted by length.
export const buildSceneCues = (scene: Scene, maxChars: number): SubtitleCue[] => {
  const koChunks = chunkWithSentences(scene.text, maxChars);
  const enText = stripMarkup(scene.textEn || '');
  const enLines = alignEnglish(koChunks, enText, maxChars);

  const offset = scene.speechOffset ?? 0;
  const speech = scene.speechDuration ?? Math.max(0.5, (scene.duration || 4) - offset);
  // Sentence ends get a little extra weight because speakers pause there
  const weights = koChunks.length
    ? koChunks.map((c, i) => c.text.replace(/\s/g, '').length + 2 + (koChunks[i + 1]?.sentence !== c.sentence ? 2 : 0))
    : [1];
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let t = offset;
  return weights.map((w, i) => {
    const start = t;
    t += (w / totalWeight) * speech;
    const isLast = i === weights.length - 1;
    return {
      start: i === 0 ? 0 : start,
      // Last cue stays visible through the trailing pause
      end: isLast ? scene.duration || t : t,
      ko: koChunks[i]?.text || '',
      en: enLines[i] || (koChunks.length ? '' : enText),
    };
  });
};

export const buildTimeline = (scenes: Scene[], aspectRatio: string): TimelineScene[] => {
  const maxChars = maxCharsForRatio(aspectRatio);
  let t = 0;
  return scenes.map((scene, index) => {
    const start = t;
    t += scene.duration || 4;
    return { scene, index, start, end: t, cues: buildSceneCues(scene, maxChars) };
  });
};

export const findCue = (cues: SubtitleCue[], localTime: number): SubtitleCue | undefined =>
  cues.find(c => localTime >= c.start && localTime < c.end) || cues[cues.length - 1];
