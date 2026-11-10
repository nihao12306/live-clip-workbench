import { describe, expect, it, vi } from 'vitest';
import { screenTextCandidates, type QualityCandidate } from '../src/main/text-quality-gate';
import { TextWorkbench } from '../src/main/text-workbench';
import { identifyTextSource } from '../src/main/text-sources';
const units = Array.from({ length: 24 }, (_, i) => ({ id: 'S' + (i + 1), startMs: i * 1000,
  endMs: (i + 1) * 1000, text: '问题有具体条件，结论有明确理由。第' + i + '句。' }));
const candidates = (n: number): QualityCandidate[] => Array.from({ length: n }, (_, i) => ({ name: '话题' + i,
  startId: 'S' + (i * 2 + 1), endId: 'S' + (i * 2 + 2), topicValue: '自荐价值', completeness: '自称完整' }));
function pass(entry: any) {
  return { number: entry.number, promise: entry.name, watchReason: '真实取舍冲突有判断增量', valueType: 'decision', watchValue: true, standalone: true, complete: true,
    coreQuestion: entry.name, conclusion: '有条件的结论', reason: '原文同时交代对象条件与推导理由', duplicateOf: null,
    evidence: [{ id: entry.units[0].id, quote: '问题有具体条件' }, { id: entry.units.at(-1).id, quote: '结论有明确理由' }] };
}
describe('生成前的原文质量关', () => {
  it('逐批读完整原文和邻近上下文，弱价值/不完整/重复提名不进入编稿', async () => {
    const call = vi.fn(async (_prompt, input: any) => ({ decisions: input.candidates.map((e: any, i: number) => ({
      ...pass(e), watchValue: i !== 1, complete: i !== 2, duplicateOf: i === 3 ? 1 : null,
    })) }));
    const result = await screenTextCandidates(candidates(4), units, call);
    expect(result.candidates.map(c => c.name)).toEqual(['话题0']);
    expect(call.mock.calls[0][1].candidates[0].units).toEqual(units.slice(0, 2));
    expect(call.mock.calls[0][1].candidates[0].surrounding.after).toEqual(units.slice(2, 4));
    expect(result.decisions.filter(d => !d.approved)).toHaveLength(3);
  });
  it('原文同范围提名只审核一次；不设短片长度下限', async () => {
    const call = vi.fn(async (_p, input: any) => ({ decisions: input.candidates.map(pass) }));
    const list = candidates(1);
    const result = await screenTextCandidates([...list, { ...list[0], name: '另一个标题' }], units, call);
    expect(result.candidates).toHaveLength(1);
    expect(call.mock.calls[0][1].candidates).toHaveLength(1);
  });
  it('没有有效逐字证据、漏项或重复循环时不能默认放行', async () => {
    for (const bad of ['evidence', 'missing', 'cycle']) {
      const call = vi.fn(async (_p, input: any) => ({ decisions: bad === 'missing' ? [] : input.candidates.map((e: any) => ({
        ...pass(e), evidence: bad === 'evidence' ? [{ id: 'S1', quote: '编造的证据' }] : pass(e).evidence,
        duplicateOf: bad === 'cycle' ? e.number : null,
      })) }));
      await expect(screenTextCandidates(candidates(1), units, call)).rejects.toThrow('已停止编稿');
      expect(call).toHaveBeenCalledTimes(2);
    }
  });
  it('超过十条触发原文加严复核而不截断到十条', async () => {
    const call = vi.fn(async (_p, input: any) => ({ decisions: input.candidates.map(pass) }));
    const result = await screenTextCandidates(candidates(12), units, call);
    expect(result.candidates).toHaveLength(12);
    expect(result.extraReview).toBe(true);
    expect(call.mock.calls.filter(([p]) => p.includes('这是候选较多触发的跨题复核'))).toHaveLength(2);
    expect(call.mock.calls[1][1].previousAccepted).toHaveLength(6);
  });
  it('全部否决时只调用扫描和批量复审，不调用逐条编稿，保留审核原因', async () => {
    const state = new Map<string, unknown>();
    const db = { getSetting: <T>(key: string, fallback: T) => structuredClone(state.get(key)) as T ?? fallback,
      setSetting: (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
    const model = { textSelection: vi.fn(async (prompt: string, input: any) => {
      if (prompt.startsWith('你是直播短视频选题编辑')) return { candidates: candidates(4) };
      if (prompt.startsWith('你是直播短视频选题主编')) return { decisions: input.candidates.map((e: any) => ({
        ...pass(e), watchValue: false, reason: '普通单句推荐，原文没有解释选择依据', evidence: [],
      })) };
      throw new Error('不该调用编稿');
    }) };
    const source = { identify: identifyTextSource, readTranscript: vi.fn(async () => ({ parts: units, cues: true })) };
    const app = new TextWorkbench(db, source, model);
    const [job] = app.start([{ url: 'https://tingwu.aliyun.com/doc/transcripts/quality' }]);
    await vi.waitFor(() => expect(app.list()[0].status).toBe('ready'));
    expect(app.list()[0].clips).toHaveLength(0);
    expect(app.list()[0].qualityAudit).toMatchObject({ proposed: 4, approved: 0 });
    expect(model.textSelection).toHaveBeenCalledTimes(2);
    expect([...state.keys()].some(key => key.startsWith('text-selection-cache:'))).toBe(true);
  });
  it('编稿失败后重试复用本场已完成的质量复审，不重复扫描收费', async () => {
    const state = new Map<string, unknown>();
    const db = { getSetting: <T>(key: string, fallback: T) => structuredClone(state.get(key)) as T ?? fallback,
      setSetting: (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
    const model = { textSelection: vi.fn(async (prompt: string, input: any) => {
      if (prompt.startsWith('你是直播短视频选题编辑')) return { candidates: candidates(1) };
      if (prompt.startsWith('你是直播短视频选题主编')) return { decisions: input.candidates.map(pass) };
      throw new Error('模拟编稿接口断线');
    }) };
    const source = { identify: identifyTextSource, readTranscript: vi.fn(async () => ({ parts: units, cues: true })) };
    const app = new TextWorkbench(db, source, model);
    const [job] = app.start([{ url: 'https://tingwu.aliyun.com/doc/transcripts/retry-quality' }]);
    await vi.waitFor(() => expect(app.list()[0].status).toBe('failed'));
    app.retry(job.id);
    await vi.waitFor(() => expect(app.list()[0].status).toBe('failed'));
    expect(model.textSelection.mock.calls.filter(([p]) => p.startsWith('你是直播短视频选题编辑'))).toHaveLength(1);
    expect(model.textSelection.mock.calls.filter(([p]) => p.startsWith('你是直播短视频选题主编'))).toHaveLength(1);
    expect(source.readTranscript).toHaveBeenCalledTimes(1);
  });
});

it('后续复审批次断线时，重试复用前面已完成的批次', async () => {
  const saved = new Map<string, unknown>();
  const cache = { get: (k: string) => saved.get(k), set: (k: string, v: unknown) => { saved.set(k, structuredClone(v)); } };
  let fail = true;
  const call = vi.fn(async (_prompt, input: any) => {
    if (input.candidates[0].number === 7 && fail) { fail = false; throw new Error('网络中断'); }
    return { decisions: input.candidates.map(pass) };
  });
  await expect(screenTextCandidates(candidates(7), units, call, undefined, cache)).rejects.toThrow('网络中断');
  const result = await screenTextCandidates(candidates(7), units, call, undefined, cache);
  expect(result.candidates).toHaveLength(7);
  expect(call).toHaveBeenCalledTimes(3);
  expect(saved.size).toBe(2);
});
