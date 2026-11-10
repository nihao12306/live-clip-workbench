import { describe, expect, it, vi } from 'vitest';
import { buildSelectionLearning } from '../src/main/text-selection-learning';
import { TextWorkbench } from '../src/main/text-workbench';
import { identifyTextSource } from '../src/main/text-sources';
import type { TextJob } from '../src/shared/text-selection';
const units = [{ id: 'S1', startMs: 0, endMs: 4000, text: '很多家长只看学校名气。' },
  { id: 'S2', startMs: 4000, endMs: 10000, text: '先看孩子的目标，再判断专业与城市的取舍。' }];
function sample(teacher: string, id: string, feedback?: 'good' | 'bad'): TextJob {
  return { id, teacher, url: 'https://tingwu.aliyun.com/doc/transcripts/' + id, source: 'tingwu',
    status: 'ready', createdAt: '2026-11-08', message: '', clips: [{ id: 'clip', name: '名气与目标的取舍', title: '先看目标',
      topicValue: '真实选择矛盾', completeness: '有理由', units, titles: ['先看目标'], hook: { id: 'S1', ranges: [[0, 12]] },
      hooks: [], repeatHook: false, body: [{ id: 'S2', ranges: [[0, 10]] }], notes: [],
      topicFeedback: feedback ? { verdict: feedback, reason: '有大众共同的选择冲突，不是只报分数', teacher, updatedAt: '2026-11-08T00:00:00Z' } : undefined }] };
}
describe('选题经验必须来自明确的人类反馈', () => {
  it('导出只表示采用事实，不成为明确的选题质量认可', () => {
    const j = sample('示例讲师甲', 'one');
    j.deliveries = [{ clipId: 'clip', teacher: '示例讲师甲', title: '已导出', documentId: 'doc' }];
    const context = buildSelectionLearning([j], sample('示例讲师甲', 'current'));
    expect(context?.selectionFeedback?.teacherExamples).toMatchObject([{ verdict: 'adopted', scope: expect.stringContaining('不是明确质量认可') }]);
  });
  it('同一老师的明确理由可用于同场重生成；不同老师不套用个人偏好', () => {
    const j = sample('示例讲师甲', 'same', 'bad');
    expect(buildSelectionLearning([j], j)?.selectionFeedback?.teacherExamples).toMatchObject([{ verdict: 'bad' }]);
    expect(buildSelectionLearning([j], sample('示例讲师乙', 'other'))).toBeUndefined();
  });
  it('跨老师仅提供来自至少两位老师、两场回放的明确案例', () => {
    const context = buildSelectionLearning([sample('甲', 'one', 'good'), sample('乙', 'two', 'bad')], sample('丙', 'current'));
    expect(context?.selectionFeedback?.teacherExamples).toHaveLength(0);
    expect(context?.selectionFeedback?.crossTeacherExamples).toHaveLength(2);
  });
});

it('初选和复审都思考，人工反馈前移；同条件复用，新反馈/模型变化使缓存失效', async () => {
  const state = new Map<string, unknown>();
  const db = { getSetting: <T>(k: string, fallback: T) => structuredClone(state.get(k)) as T ?? fallback,
    setSetting: (k: string, v: unknown) => { state.set(k, structuredClone(v)); } };
  let modelName = 'deepseek-flash';
  const candidate = { name: '学校名气与孩子目标的取舍', startId: 'S1', endId: 'S2', topicValue: '初选理由', completeness: '有理由与结论' };
  const model = { getSelectionIdentity: vi.fn(async () => ({ model: modelName, baseUrl: 'https://api.deepseek.com' })),
    textSelection: vi.fn(async (prompt: string, input: any, operation: string, effort?: string): Promise<unknown> => {
      if (prompt.startsWith('你是直播短视频选题编辑')) {
        expect(operation).toBe('analysis'); expect(effort).toBe('low');
        return { candidates: [candidate] };
      }
      if (prompt.startsWith('你是直播短视频选题主编')) {
        expect(operation).toBe('analysis'); expect(effort).toBe('high');
        return { decisions: input.candidates.map((c: any) => ({ number: c.number, promise: c.name,
          watchReason: '家长共同遇到名气与就业的真实冲突', valueType: 'decision', watchValue: true, standalone: true, complete: true,
          coreQuestion: '怎么取舍', conclusion: '先看目标', reason: '原文提出冲突并给出判断框架', duplicateOf: null,
          evidence: [{ id: 'S1', quote: '只看学校名气' }, { id: 'S2', quote: '先看孩子的目标' }] })) };
      }
      return { titles: [{ text: '选学校前先看目标' }], hooks: [{ id: 'S1' }], selectedHook: 0, body: [{ id: 'S2' }] };
    }) };
  const source = { identify: identifyTextSource, readTranscript: vi.fn(async () => ({ parts: units, cues: true })) };
  const app = new TextWorkbench(db, source, model);
  const [first] = app.start([{ url: 'https://tingwu.aliyun.com/doc/transcripts/stable', teacher: '示例讲师甲' }]);
  await vi.waitFor(() => expect(app.list().find(j => j.id === first.id)?.status).toBe('ready'));
  const second = app.retry(first.id);
  await vi.waitFor(() => expect(app.list().find(j => j.id === second.id)?.status).toBe('ready'));
  expect(app.list().find(j => j.id === second.id)?.qualityAudit?.reused).toBe(true);
  const scans = () => model.textSelection.mock.calls.filter(([p]) => p.startsWith('你是直播短视频选题编辑'));
  expect(scans()).toHaveLength(1);
  const original = app.list().find(j => j.id === first.id)!;
  expect(() => app.rateTopic(first.id, original.clips[0].id, 'bad', '')).toThrow('具体原因');
  app.rateTopic(first.id, original.clips[0].id, 'bad', '题目太泛，只有泛泛建议，没有真正有分量的论证');
  const third = app.retry(first.id);
  await vi.waitFor(() => expect(app.list().find(j => j.id === third.id)?.status).toBe('ready'));
  expect(scans()).toHaveLength(2);
  expect(scans().at(-1)?.[1].selectionLearning.selectionFeedback.teacherExamples).toMatchObject([{ verdict: 'bad' }]);
  const reviewCall = model.textSelection.mock.calls.filter(([p]) => p.startsWith('你是直播短视频选题主编')).at(-1)!;
  expect(reviewCall[1].selectionLearning.selectionFeedback.teacherExamples).toMatchObject([{ verdict: 'bad' }]);
  modelName = 'different-model';
  const fourth = app.retry(first.id);
  await vi.waitFor(() => expect(app.list().find(j => j.id === fourth.id)?.status).toBe('ready'));
  expect(scans()).toHaveLength(3);
  expect(original.clips).toHaveLength(1);
});

it('仅将名称明确匹配的账号规则与样片模式前移，不串用其他老师的账号', () => {
  const account = { name: '示例讲师甲', audience: '江苏家长', preferenceSummary: '重视真实选择冲突', selectionPrinciples: '观点与故事均可，不能只按分数筛选',
    sampleLearning: { profile: { summary: '先给真实冲突再给理由', audienceSignals: ['家长焦虑'], evidenceSignals: ['具体经历'], hookPatterns: ['反差'], avoidPatterns: ['空泛列表'], recommendationPatterns: [] } } } as any;
  const context = buildSelectionLearning([], sample('示例讲师甲', 'current'), '', [account]);
  expect(context?.accountReference).toMatchObject({ teacher: '示例讲师甲', selectionPrinciples: expect.stringContaining('故事'), samplePatterns: { audienceSignals: ['家长焦虑'] } });
  expect(buildSelectionLearning([], sample('示例讲师乙', 'other'), '', [account])).toBeUndefined();
});
