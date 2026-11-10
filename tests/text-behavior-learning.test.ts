import { describe, expect, it, vi } from 'vitest';
import { compareTextBody } from '../src/shared/text-behavior';
import { buildTextLearning } from '../src/main/text-learning';
import { buildSelectionLearning } from '../src/main/text-selection-learning';
import { identifyTextSource } from '../src/main/text-sources';
import { TextWorkbench } from '../src/main/text-workbench';
import type { TextClip, TextJob } from '../src/shared/text-selection';
const units = [{ id: 'S1', startMs: 0, endMs: 1000, text: '开头问题要直接说。' },
  { id: 'S2', startMs: 1000, endMs: 2000, text: '案例解释为什么。' }, { id: 'S3', startMs: 2000, endMs: 3000, text: '必须保留这个条件。' }];
function setup(model: any = {}, source: any = {}) {
  const state = new Map<string, unknown>();
  const initial = { title: '模型标题', hook: { id: 'S1', ranges: [[0, 9] as [number, number]] }, repeatHook: false,
    body: [{ id: 'S2', ranges: [[0, 8] as [number, number]] }] };
  const clip: TextClip = { ...structuredClone(initial), id: 'c', name: '解释清楚选择依据', topicValue: '共同困惑', completeness: '理由清楚', units,
    titles: ['模型标题'], hooks: [], notes: [], initialEdit: structuredClone(initial) };
  const job: TextJob = { id: 'j', name: '直播', teacher: '示例讲师甲', url: 'https://tingwu.aliyun.com/doc/transcripts/behavior', source: 'tingwu', status: 'ready', createdAt: '', message: '', clips: [clip] };
  state.set('text-selection-jobs-v1', [job]);
  const database = { getSetting: <T>(k: string, fallback: T) => structuredClone(state.get(k)) as T ?? fallback,
    setSetting: (k: string, v: unknown) => { state.set(k, structuredClone(v)); } };
  const app = new TextWorkbench(database, source, model);
  return { app, clip, job, state };
}
describe('完整正文行为与定稿版本', () => {
  it('记录保留、删除、补回、顺序；完整前后正文不截断', () => {
    const { clip } = setup();
    const after = { ...clip, body: [{ id: 'S3', ranges: [[0, 9] as [number, number]] }, { id: 'S2', ranges: [[0, 4] as [number, number]] }] };
    const diff = compareTextBody(clip, clip.initialEdit!, after);
    expect(diff.before).toEqual([{ id: 'S2', text: '案例解释为什么。' }]);
    expect(diff.after.map(p => p.id)).toEqual(['S3', 'S2']);
    expect(diff.changes.find(c => c.id === 'S2')?.removed).toEqual(['为什么。']);
    expect(diff.changes.find(c => c.id === 'S3')?.added).toEqual(['必须保留这个条件。']);
  });
  it('确认后整份正文立即成为样例；保存新稿使旧确认失效，重新确认保留版本', () => {
    const { app, clip } = setup();
    app.save('j', 'c', { ...clip, title: '用户标题', body: [...clip.body, { id: 'S3', ranges: [[0, 9]] }] });
    expect(app.learningSummary().confirmedFinals).toBe(0);
    app.confirmFinal('j', 'c', '补回条件才能支撑结论');
    let job = app.list()[0];
    expect(job.clips[0].confirmedFinal?.revision).toBe(1);
    const context = buildTextLearning([job], job).context;
    expect(context?.teacherExperience?.examples[0].body?.after).toHaveLength(2);
    expect(context?.teacherExperience?.examples[0].note).toBe('补回条件才能支撑结论');
    app.save('j', 'c', { ...job.clips[0], title: '又改标题' });
    expect(app.list()[0].clips[0].confirmedFinal?.status).toBe('outdated');
    expect(app.learningSummary().confirmedFinals).toBe(0);
    app.confirmFinal('j', 'c', '第二版');
    job = app.list()[0];
    expect(job.clips[0].confirmedFinal?.revision).toBe(2);
    expect(job.clips[0].finalHistory).toHaveLength(2);
    expect(job.clips[0].finalHistory?.[0].edit.title).toBe('用户标题');
    app.withdrawFinal('j', 'c');
    expect(app.learningSummary().confirmedFinals).toBe(0);
    expect(app.list()[0].clips[0].finalHistory).toHaveLength(2);
  });
  it('导出不冒充明确定稿；同步记录传出的实际快照，失败不覆盖成功快照', () => {
    const { app, clip } = setup();
    app.recordDelivery('j', 'c', '示例讲师甲', clip, { documentId: 'doc' });
    expect(app.list()[0].clips[0].confirmedFinal).toBeUndefined();
    expect(app.list()[0].clips[0].lastExport?.edit.title).toBe('模型标题');
    app.confirmFinal('j', 'c', '无需修改也认可');
    const sent = structuredClone(app.list()[0].clips[0]);
    app.save('j', 'c', { ...sent, title: '新草稿' });
    app.recordSync('j', 'doc', sent.title, undefined, sent);
    expect(app.list()[0].clips[0].lastExport?.edit.title).toBe('模型标题');
    expect(app.list()[0].clips[0].confirmedFinal?.status).toBe('outdated');
    app.recordSync('j', 'doc', '失败版本', '网络错误', { ...sent, title: '失败版本' });
    expect(app.list()[0].clips[0].lastExport?.edit.title).toBe('模型标题');
  });
  it('更换老师后必须重新确认，避免将前一位老师的定稿套到新老师', () => {
    const { app } = setup();
    app.confirmFinal('j', 'c');
    app.rename('j', '直播', '示例讲师乙');
    expect(app.list()[0].clips[0].confirmedFinal?.status).toBe('outdated');
  });
});
describe('采用与未采用的原因分开学习', () => {
  it('暂不采用和重复不进入质量学习，原文不完整不等同选题差，撤销留痕', () => {
    const { app } = setup();
    app.rateTopic('j', 'c', 'deferred', '本期排期不需要');
    expect(buildSelectionLearning(app.list(), app.list()[0])).toBeUndefined();
    app.rateTopic('j', 'c', 'duplicate', '上周做过');
    expect(buildSelectionLearning(app.list(), app.list()[0])).toBeUndefined();
    app.rateTopic('j', 'c', 'incomplete', '题目好，但缺少结论');
    const context = buildSelectionLearning(app.list(), app.list()[0]);
    expect(context?.selectionFeedback?.teacherExamples[0]).toMatchObject({ verdict: 'incomplete', scope: expect.stringContaining('不得当作题材负评') });
    app.clearTopicFeedback('j', 'c');
    expect(buildSelectionLearning(app.list(), app.list()[0])).toBeUndefined();
    expect(app.list()[0].clips[0].topicFeedbackHistory).toHaveLength(4);
  });
  it('曾导出只作为弱采用事实，明确反馈优先；无导出无反馈时不推断负评', () => {
    const { app, clip } = setup();
    expect(buildSelectionLearning(app.list(), app.list()[0])).toBeUndefined();
    app.recordDelivery('j', 'c', '示例讲师甲', clip, { documentId: 'doc' });
    expect(buildSelectionLearning(app.list(), app.list()[0])?.selectionFeedback?.teacherExamples[0]).toMatchObject({ verdict: 'adopted', scope: expect.stringContaining('不是明确质量认可') });
    app.rateTopic('j', 'c', 'bad', '后来发现选题价值不足');
    expect(buildSelectionLearning(app.list(), app.list()[0])?.selectionFeedback?.teacherExamples[0]).toMatchObject({ verdict: 'bad' });
  });
});

it('最新撤销或暂不用决定会覆盖同源旧副本的负评，不使旧标签重新冒出', () => {
  const { job } = setup();
  const old = structuredClone(job);
  old.id = 'old';
  old.clips[0].topicFeedback = { verdict: 'bad', reason: '旧的负评', teacher: '示例讲师甲', updatedAt: '2026-01-01' };
  const current = structuredClone(job);
  current.clips[0].topicFeedbackHistory = [{ verdict: 'cleared', reason: '撤销', teacher: '示例讲师甲', updatedAt: '2026-02-01' }];
  expect(buildSelectionLearning([old, current], current)).toBeUndefined();
  current.clips[0].topicFeedback = { verdict: 'deferred', reason: '本期不用，不是不好', teacher: '示例讲师甲', updatedAt: '2026-03-01' };
  expect(buildSelectionLearning([old, current], current)).toBeUndefined();
});

it('确认时校验用户看到的版本，避免另一窗口改稿后误确认新内容', () => {
  const { app, clip } = setup();
  const expected = structuredClone(clip.initialEdit!);
  app.save('j', 'c', { ...clip, title: '其他窗口的新稿' });
  expect(() => app.confirmFinal('j', 'c', '', expected)).toThrow('其他位置更新');
  expect(app.list()[0].clips[0].confirmedFinal).toBeUndefined();
});


it('完整确认案例实际进入下一次文字初稿请求，模型合理调序不会被强制还原', async () => {
  const source = { identify: identifyTextSource, readTranscript: vi.fn(async () => ({ parts: units, cues: true })) };
  const model = { textSelection: vi.fn(async (prompt: string, input: any) => {
    if (prompt.startsWith('你是直播短视频选题编辑')) return { candidates: [{ name: '解释取舍', startId: 'S1', endId: 'S3', topicValue: '选择困惑', completeness: '理由与条件' }] };
    if (prompt.startsWith('你是直播短视频选题主编')) return { decisions: input.candidates.map((c: any) => ({ number: c.number,
      promise: c.name, watchReason: '先揭示真实问题再给取舍依据', valueType: 'decision', watchValue: true, standalone: true, complete: true,
      coreQuestion: '怎样取舍', conclusion: '保留前提', reason: '理由和条件都在原文中', duplicateOf: null,
      evidence: [{ id: 'S2', quote: '案例解释为什么' }, { id: 'S3', quote: '必须保留这个条件' }] })) };
    expect(input.editorialLearning.teacherExperience.examples[0]).toMatchObject({ note: '保留条件解释完整', body: { after: expect.any(Array) } });
    return { titles: [{ text: '先看条件再看理由' }], hooks: [{ id: 'S1' }], selectedHook: 0, body: [{ id: 'S3' }, { id: 'S2' }] };
  }) };
  const { app, clip } = setup(model, source);
  app.save('j', 'c', { ...clip, body: [...clip.body, { id: 'S3', ranges: [[0, 9]] }] });
  app.confirmFinal('j', 'c', '保留条件解释完整');
  const [next] = app.start([{ url: 'https://tingwu.aliyun.com/doc/transcripts/next-behavior', teacher: '示例讲师甲' }]);
  await vi.waitFor(() => expect(app.list().find(j => j.id === next.id)?.status).toBe('ready'));
  expect(app.list().find(j => j.id === next.id)?.clips[0].body.map(p => p.id)).toEqual(['S3', 'S2']);
});

it('把正文提到开头不会被误记成删除这个观点', () => {
  const { clip } = setup();
  const after = { ...clip, hook: { id: 'S2', ranges: [[0, 8] as [number, number]] }, body: [{ id: 'S3', ranges: [[0, 9] as [number, number]] }] };
  const row = compareTextBody(clip, clip.initialEdit!, after).changes.find(c => c.id === 'S2');
  expect(row?.removed).toEqual([]);
  expect(row?.toHook).toEqual(['案例解释为什么。']);
});
