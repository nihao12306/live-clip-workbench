import { compareTextBody, finalVersionMatches } from '../shared/text-behavior';
import { readingOrder } from '../shared/text-selection';
import type { TextClip, TextEdit, TextJob, TextLearningExample, TextLearningSummary, TextPick } from '../shared/text-selection';

export function editSnapshot({ title, hook, repeatHook, body }: TextEdit): TextEdit {
  return structuredClone({ title, hook, repeatHook, body });
}

const rules = {
  hook: '开头直接说清对象和问题，删去点题前的寒暄或铺垫。',
  filler: '可去掉不影响语义的口癖和称呼，保留疑问、语气和限定。',
  repeat: '同义重复只留能补充条件、理由或例子的一处。',
};

type Rule = keyof typeof rules;
const normalize = (value: string) => value.replace(/[\p{P}\p{Z}\s]/gu, '');
const filler = /^(?:家长朋友们|各位家长|朋友们|大家好|对吧|是吧|对不对|是不是|就是说|然后呢|嗯|啊|呃)+$/;

function removedText(clip: TextClip, before: TextEdit, after: TextEdit): string[] {
  const afterRanges = new Map<string, TextPick['ranges']>();
  for (const pick of [...after.body, ...(after.hook ? [after.hook] : [])]) {
    afterRanges.set(pick.id, [...(afterRanges.get(pick.id) ?? []), ...pick.ranges]);
  }
  const units = new Map(clip.units.map(unit => [unit.id, unit.text]));
  return [...before.body, ...(before.hook ? [before.hook] : [])].flatMap(pick => {
    const text = units.get(pick.id) ?? '';
    const kept = (afterRanges.get(pick.id) ?? []).sort((a, b) => a[0] - b[0]);
    return pick.ranges.flatMap(([start, end]) => {
      const removed: string[] = [];
      let cursor = start;
      for (const [left, right] of kept) {
        if (right <= cursor || left >= end) continue;
        if (left > cursor) removed.push(text.slice(cursor, left));
        cursor = Math.min(end, right);
      }
      if (cursor < end) removed.push(text.slice(cursor, end));
      return removed.map(normalize).filter(Boolean);
    });
  });
}

function sameReplay(job: TextJob) {
  const parsed = new URL(job.url);
  return job.source === 'qianwen' ? parsed.href : parsed.origin + parsed.pathname;
}

function sampleFor(job: TextJob, clip: TextClip) {
  if (!clip.initialEdit) return undefined;
  const explicitFinal = clip.confirmedFinal;
  if (explicitFinal && !finalVersionMatches(clip)) return undefined;
  const final = explicitFinal ? { edit: explicitFinal.edit, teacher: explicitFinal.teacher, exportedAt: explicitFinal.confirmedAt } : clip.learning;
  if (!final || (!explicitFinal && JSON.stringify(clip.initialEdit) === JSON.stringify(final.edit))) return undefined;
  const before = clip.initialEdit;
  const after = final.edit;
  const original = readingOrder({ ...clip, ...before });
  const delivered = readingOrder({ ...clip, ...after });
  const beforeHook = before.hook ? original[0]?.text ?? '' : '';
  const afterHook = after.hook ? delivered[0]?.text ?? '' : '';
  const removed = removedText(clip, before, after);
  const kept = delivered.map(part => normalize(part.text));
  const signals: Rule[] = [];
  const hookBody = normalize(afterHook);
  const originalHook = normalize(beforeHook);
  if (hookBody.length >= 6 && originalHook.endsWith(hookBody) && filler.test(originalHook.slice(0, -hookBody.length))) signals.push('hook');
  if (removed.some(text => filler.test(text))) signals.push('filler');
  if (removed.some(text => text.length >= 8 && kept.some(other => other.includes(text)))) signals.push('repeat');
  return {
    replay: sameReplay(job), teacher: final.teacher.trim().normalize(), exportedAt: final.exportedAt,
    topic: clip.name, signals,
    key: sameReplay(job) + ':' + clip.units[0]?.startMs + ':' + clip.units.at(-1)?.endMs,
    body: explicitFinal ? compareTextBody(clip, before, after) : undefined,
    confirmation: explicitFinal ? `用户确认定稿 v${explicitFinal.revision}` : undefined,
    note: explicitFinal?.note,
    fillers: [...new Set(removed.filter(text => text.length <= 8 && filler.test(text)))],
    hook: beforeHook !== afterHook ? { before: beforeHook, after: afterHook } : undefined,
    title: before.title !== after.title ? { before: before.title, after: after.title } : undefined,
  };
}

function grams(text: string) {
  const characters = [...normalize(text)];
  return new Set(characters.slice(1).map((char, index) => characters[index] + char));
}

type Sample = NonNullable<ReturnType<typeof sampleFor>>;
const replayCount = (samples: Sample[]) => new Set(samples.map(sample => sample.replay)).size;
const teacherCount = (samples: Sample[]) => new Set(samples.map(sample => sample.teacher)).size;
const allRules = Object.keys(rules) as Rule[];

function generalRules(samples: Sample[]) {
  return allRules.filter(rule => {
    const supporting = samples.filter(sample => sample.teacher && sample.signals.includes(rule));
    return teacherCount(supporting) >= 2 && replayCount(supporting) >= 2;
  });
}

function teacherExperience(samples: Sample[], general: Rule[], topic = '') {
  const personalRules = allRules
    .filter(rule => !general.includes(rule) && replayCount(samples.filter(sample => sample.signals.includes(rule))) >= 2)
    .map(rule => rules[rule]);
  const habitualFillers = [...new Set(samples.flatMap(sample => sample.fillers))]
    .filter(text => replayCount(samples.filter(sample => sample.fillers.includes(text))) >= 2)
    .slice(0, 4);
  if (habitualFillers.length) {
    personalRules.push(`这位老师的定稿多次删掉「${habitualFillers.join('」「')}」。用作口癖时可以去掉，影响语义时保留。`);
  }
  const useHooks = replayCount(samples.filter(sample => sample.hook)) >= 2;
  const useTitles = replayCount(samples.filter(sample => sample.title)) >= 2;
  const topicGrams = grams(topic);
  const ranked = samples
    .filter(sample => sample.body || (useHooks && sample.hook) || (useTitles && sample.title))
    .map(sample => ({ sample, match: [...grams(sample.topic)].filter(gram => topicGrams.has(gram)).length }))
    .sort((a, b) => b.match - a.match);
  const examples: TextLearningExample[] = ranked
    .filter(({ sample }, index) => ranked.findIndex(item => item.sample.key === sample.key) === index)
    .slice(0, 3)
    .map(({ sample }) => ({ topic: sample.topic, hook: sample.body || useHooks ? sample.hook : undefined, title: sample.body || useTitles ? sample.title : undefined, body: sample.body, confirmation: sample.confirmation, note: sample.note }));
  return { replays: replayCount(samples), rules: personalRules, examples };
}

export function buildTextLearning(jobs: TextJob[], job?: TextJob, topic = '') {
  const samples = jobs.flatMap(item => item.clips.flatMap(clip => {
    const sample = sampleFor(item, clip);
    return sample ? [sample] : [];
  })).sort((a, b) => b.exportedAt.localeCompare(a.exportedAt)).slice(0, 80);
  const history = job ? samples.filter(sample => sample.replay !== sameReplay(job) || sample.confirmation) : samples;
  const knownHistory = history.filter(sample => sample.teacher);
  const general = generalRules(knownHistory);
  const teachers = new Set([
    ...jobs.map(item => item.teacher?.trim().normalize()),
    ...knownHistory.map(sample => sample.teacher),
  ].filter((teacher): teacher is string => Boolean(teacher)));
  const summary: TextLearningSummary = {
    replays: replayCount(history),
    confirmedFinals: knownHistory.filter(sample => sample.confirmation).length,
    general: { teachers: teacherCount(knownHistory), replays: replayCount(knownHistory), rules: general.map(rule => rules[rule]) },
    teachers: [...teachers].map(teacher => ({ teacher,
      ...teacherExperience(knownHistory.filter(sample => sample.teacher === teacher), general),
    })).sort((a, b) => b.replays - a.replays || a.teacher.localeCompare(b.teacher, 'zh-CN')),
  };
  const teacher = job?.teacher?.trim().normalize();
  const personal = teacher ? teacherExperience(knownHistory.filter(sample => sample.teacher === teacher), general, topic) : undefined;
  const teacherExperienceForRequest = teacher && personal && (personal.rules.length || personal.examples.length)
    ? { teacher, rules: personal.rules, examples: personal.examples.reduce<TextLearningExample[]>((kept, example) => {
        const next = [...kept, example];
        if (JSON.stringify(next).length <= 18000) kept.push(example);
        else if (example.body) {
          const body = example.body;
          const compact = { ...example, body: undefined, bodySummary: '超长正文样例节选（完整前后稿保存在本地）：初稿' + body.before.length + '段、定稿' + body.after.length + '段。改动片段：' + JSON.stringify(body.changes.filter(c => c.removed.length || c.added.length || c.toHook?.length || c.fromHook?.length || c.moved).slice(0, 3).map(c => ({ id: c.id, before: c.before.slice(0, 400), after: c.after.slice(0, 400), moved: c.moved }))) };
          if (JSON.stringify([...kept, compact]).length <= 18000) kept.push(compact);
        }
        return kept;
      }, []) } : undefined;
  const context = general.length || teacherExperienceForRequest ? {
    generalRules: summary.general.rules, teacherExperience: teacherExperienceForRequest,
    learningBoundary: '明确确认的定稿包含完整前后行为；改动只证明保留、删除、补回和调序，不凭空假设动机。备注才是明确原因；单次行为只作案例，不自动升为硬规则。未确认旧导出只保留旧版有限经验，不视为完整定稿认可。',
  } : undefined;
  return { summary, context };
}
