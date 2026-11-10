import type { AccountProfile } from '../shared/types';
import { buildTextLearning } from './text-learning';
import type { TextJob } from '../shared/text-selection';

/** Human topic judgements are examples, never inferred from model approvals or exports. */
export function buildSelectionLearning(jobs: TextJob[], job: TextJob, topic = '', accounts: AccountProfile[] = []) {
  const fullTextExperience = buildTextLearning(jobs, job, topic).context;
  const textExperience = fullTextExperience ? { ...fullTextExperience, teacherExperience: fullTextExperience.teacherExperience ? {
    ...fullTextExperience.teacherExperience, examples: fullTextExperience.teacherExperience.examples.map(example => ({
      ...example, body: undefined, bodySummary: example.body ? '用户确认的正文取舍：初稿' + example.body.before.length + '段，定稿' + example.body.after.length + '段；删选' + example.body.changes.filter(c => c.removed.length).length + '段，补回' + example.body.changes.filter(c => c.added.length).length + '段，调序' + example.body.changes.filter(c => c.moved).length + '段。完整对比用于文字初稿生成；选题阶段不重复携带长正文。' : example.bodySummary,
    })),
  } : undefined } : undefined;
  const normalize = (text: string) => text.trim().normalize();
  const teacher = normalize(job.teacher ?? '');
  const matching = teacher ? accounts.filter(account => normalize(account.name) === teacher) : [];
  const account = matching.length === 1 ? matching[0] : undefined;
  const profile = account?.sampleLearning?.profile;
  const accountReference = account && (account.selectionPrinciples?.trim() || account.preferenceSummary?.trim() || profile) ? {
    teacher: account.name, audience: account.audience, preferenceSummary: account.preferenceSummary,
    selectionPrinciples: account.selectionPrinciples,
    samplePatterns: profile ? { summary: profile.summary, audienceSignals: profile.audienceSignals,
      evidenceSignals: profile.evidenceSignals, hookPatterns: profile.hookPatterns, avoidPatterns: profile.avoidPatterns,
      recommendationPatterns: profile.recommendationPatterns } : undefined,
    boundary: '来自明确匹配的老师账号规则与样片模式，不代表用户认可了当前候选；只参考模式与偏好，不能复用旧事实，不能跨老师套用。',
  } : undefined;
  const candidates = jobs.flatMap(item => item.clips.flatMap(clip => {
    const explicit = clip.topicFeedback;
    // Planning decisions are recorded, but never treated as negative topic quality.
    const exported = item.deliveries?.filter(delivery => delivery.clipId === clip.id).sort((a, b) => (b.exportedAt ?? '').localeCompare(a.exportedAt ?? ''))[0];
    const cleared = clip.topicFeedbackHistory?.at(-1);
    const feedback = explicit ?? (cleared?.verdict === 'cleared' && (!exported?.exportedAt || cleared.updatedAt >= exported.exportedAt) ? cleared : exported ? { verdict: 'adopted' as const, reason: '用户曾导出采用，仅记录采用事实，不等于明确评价选题优质',
      teacher: exported.teacher, updatedAt: exported.exportedAt ?? '1970-01-01T00:00:00Z' } : undefined);
    if (!feedback?.reason.trim()) return [];
    const source = new URL(item.url);
    const replay = source.origin + source.pathname;
    return [{ teacher: normalize(feedback.teacher), replay,
      key: replay + ':' + clip.units[0]?.startMs + ':' + clip.units.at(-1)?.endMs,
      topic: clip.name, title: clip.title, verdict: feedback.verdict, reason: feedback.reason,
      updatedAt: feedback.updatedAt }];
  })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const seen = new Set<string>();
  const unique = candidates.filter(item => {
    const key = item.teacher + ':' + item.key;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).filter(sample => !['duplicate', 'deferred', 'cleared'].includes(sample.verdict));
  const grams = (text: string) => new Set([...text].slice(1).map((char, i) => text[i] + char));
  const query = grams(topic);
  const rank = (items: typeof unique) => items.map(sample => ({ sample,
    score: [...grams(sample.topic + sample.reason)].filter(g => query.has(g)).length }))
    .sort((a, b) => b.score - a.score).map(({ sample }) => sample);
  const example = (sample: typeof unique[number]) => ({ teacher: sample.teacher, topic: sample.topic,
    title: sample.title, verdict: sample.verdict, reason: sample.reason,
    scope: sample.verdict === 'incomplete' ? '本场原文完整性；题目本身可有价值，不得当作题材负评' : sample.verdict === 'adopted' ? '采用事实，弱参考，不是明确质量认可' : '选题质量的明确反馈' });
  const currentSource = new URL(job.url);
  const currentReplay = currentSource.origin + currentSource.pathname;
  const personal = rank(unique.filter(s => teacher ? s.teacher === teacher : !s.teacher && s.replay === currentReplay)).slice(0, 6).map(example);
  const otherTeachers = unique.filter(s => s.teacher && s.teacher !== teacher);
  const crossTeacher = new Set(otherTeachers.map(s => s.teacher)).size >= 2
    && new Set(otherTeachers.map(s => s.replay)).size >= 2
    ? rank(otherTeachers).slice(0, 4).map(example) : [];
  const selectionFeedback = personal.length || crossTeacher.length ? {
    teacherExamples: personal, crossTeacherExamples: crossTeacher,
    boundary: '区分明确的选题好坏、原文完整性反馈与曾采用事实；不完整不等于选题不好，曾导出也不等于优质。未采用的排期/重复原因不参与质量学习。这些记录不是模型自评。例子用于理解受众价值与不合适的原因，不可照抄其中事实；不同老师不得直接套用个人偏好。没有反馈不表示认可。',
  } : undefined;
  return textExperience || selectionFeedback || accountReference ? { textExperience, selectionFeedback, accountReference } : undefined;
}
