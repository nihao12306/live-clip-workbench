export type TextRange = [start: number, end: number];
export type TextUnit = { id: string; startMs: number; endMs: number; text: string };
export type TextPick = { id: string; ranges: TextRange[] };
export type TextReview = { summary: string; issues: { from: number; to: number; why: string; suggestion: string }[] };
export type TextEdit = { title: string; hook: TextPick | null; repeatHook: boolean; body: TextPick[] };
export type TextTopicVerdict = 'good' | 'bad' | 'incomplete' | 'duplicate' | 'deferred';
export const topicVerdictLabels: Record<TextTopicVerdict, string> = { good: '选题值得做', bad: '选题不合适', incomplete: '题目好，原话不完整', duplicate: '已做过或重复', deferred: '暂时不采用' };
export type TextFinalVersion = { revision: number; edit: TextEdit; teacher: string; confirmedAt: string; note: string; status: 'confirmed' | 'outdated' | 'withdrawn' };
export type TextBodyComparison = { before: Array<{ id: string; text: string }>; after: Array<{ id: string; text: string }>;
  changes: Array<{ id: string; sourceText: string; before: string; after: string; removed: string[]; added: string[]; toHook?: string[]; fromHook?: string[]; moved: boolean }> };
export type TextClip = TextEdit & {
  id: string;
  name: string;
  topicValue: string;
  completeness: string;
  units: TextUnit[];
  titles: string[];
  hooks: TextPick[];
  notes: string[];
  topicFeedback?: { verdict: TextTopicVerdict; reason: string; teacher: string; updatedAt: string };
  topicFeedbackHistory?: Array<{ verdict: TextTopicVerdict | 'cleared'; reason: string; teacher: string; updatedAt: string }>;
  confirmedFinal?: TextFinalVersion;
  finalHistory?: TextFinalVersion[];
  lastExport?: { edit: TextEdit; teacher: string; savedAt: string; documentId: string };
  review?: TextReview;
  initialEdit?: TextEdit;
  learning?: { edit: TextEdit; teacher: string; exportedAt: string };
};
export type TextSourceKind = 'tingwu' | 'qianwen' | 'feishu';
export const textSourceLabels: Record<TextSourceKind, string> = {
  tingwu: '通义听悟', qianwen: '通义千问', feishu: '飞书妙记',
};
export type TextDelivery = {
  clipId: string; teacher: string; title: string; documentId: string; url?: string; exportedAt: string;
  syncError?: string; syncedAt?: string;
  cutNumber?: number; importDate?: string; formatVersion?: number;
};
export type TextLearningChange = { before: string; after: string };
export type TextLearningExample = { topic: string; hook?: TextLearningChange; title?: TextLearningChange; body?: TextBodyComparison; bodySummary?: string; confirmation?: string; note?: string };
export type TextLearningSummary = {
  replays: number;
  confirmedFinals?: number;
  general: { teachers: number; replays: number; rules: string[] };
  teachers: Array<{ teacher: string; replays: number; rules: string[]; examples: TextLearningExample[] }>;
};
export type TextJobInput = { url: string; name?: string; teacher?: string };
export type TextJob = {
  id: string;
  /** Normalized address used to fetch and deduplicate sources. */
  url: string;
  /** The full share address as provided, including query and fragment. */
  originalUrl?: string;
  name?: string;
  createdAt: string;
  status: 'running' | 'ready' | 'failed';
  message: string;
  clips: TextClip[];
  source?: TextSourceKind;
  transcriptCount?: number;
  transcriptSavedAt?: string;
  teacher?: string;
  deliveries?: TextDelivery[];
  qualityAudit?: { proposed: number; approved: number; extraReview: boolean; qualified?: number; outputLimit?: number; reused?: boolean; policyVersion?: string; model?: string; thinking?: string; decisions: Array<{ name: string; approved: boolean; reason: string; round?: string; watchReason?: string; valueType?: string }> };
  failureStage?: '读取逐字稿' | '筛选话题' | '整理候选';
};

export function originalTextSource(job: TextJob): string { return job.originalUrl ?? job.url; }

export function textOf(unit: TextUnit, pick: TextPick): string {
  return pick.ranges.map(([start, end]) => unit.text.slice(start, end)).join('');
}

export function readingOrder(clip: TextClip) {
  const units = new Map(clip.units.map(unit => [unit.id, unit]));
  const picks = clip.hook ? [clip.hook, ...clip.body] : clip.body;
  return picks.map((pick, i) => ({ position: i + 1, id: pick.id, text: textOf(units.get(pick.id)!, pick) }));
}

export function editRanges(ranges: TextRange[], [start, end]: TextRange, include: boolean): TextRange[] {
  if (!include) return ranges.flatMap(([a, b]) => {
    if (a >= end || b <= start) return [[a, b] as TextRange];
    return ([[a, start], [end, b]] as TextRange[]).filter(([lo, hi]) => lo < hi);
  });
  const merged: TextRange[] = [];
  for (const [a, b] of [...ranges, [start, end] as TextRange].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(b, last[1]);
    else merged.push([a, b]);
  }
  return merged;
}

// Preserve the longest group already in source order. The other picks are moves.
export function movedTextIds(clip: TextClip): Set<string> {
  const positions = new Map(clip.units.map((unit, i) => [unit.id, i]));
  const ordered: string[][] = [];
  let longest: string[] = [];
  for (const [i, pick] of clip.body.entries()) {
    let previous: string[] = [];
    for (let j = 0; j < i; j++) {
      if (positions.get(clip.body[j].id)! < positions.get(pick.id)! && ordered[j].length > previous.length) previous = ordered[j];
    }
    const chain = [...previous, pick.id];
    ordered.push(chain);
    if (chain.length > longest.length) longest = chain;
  }
  const inPlace = new Set(longest);
  return new Set(clip.body.filter(pick => !inPlace.has(pick.id)).map(pick => pick.id));
}

export function originalMarks(unit: TextUnit, clip: TextClip, moved: Set<string>) {
  const body = clip.body.find(pick => pick.id === unit.id);
  const hook = clip.hook?.id === unit.id ? clip.hook : null;
  const bounds = [...new Set([0, unit.text.length, ...(body?.ranges.flat() ?? []), ...(hook?.ranges.flat() ?? [])])].sort((a, b) => a - b);
  return bounds.slice(1).map((end, i) => {
    const start = bounds[i];
    const isHook = hook?.ranges.some(([a, b]) => a <= start && b >= end);
    const isBody = body?.ranges.some(([a, b]) => a <= start && b >= end);
    return { text: unit.text.slice(start, end), className: isHook ? (clip.repeatHook ? 'text-green text-underline' : 'text-green')
      : isBody ? (moved.has(unit.id) ? 'text-yellow text-underline' : 'text-purple') : '' };
  });
}

export function clipTime(ms: number, end = false) {
  const seconds = (end ? Math.ceil : Math.floor)(ms / 1000);
  const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
  if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
  return parts.map(value => String(value).padStart(2, '0')).join(':');
}
