import { describe, expect, it, vi } from 'vitest';
import { chooseTopSix } from '../src/main/text-candidate-limit';
const candidates = Array.from({ length: 23 }, (_, i) => ({ name: '话题' + (i + 1), startId: 'S' + i, endId: 'S' + (i + 1), topicValue: '观看价值', completeness: '原文支持' }));
describe('编稿前最多选择六个最好选题', () => {
  it('23个候选先相对择优，保留排序而不是截取前六条', async () => {
    const call = vi.fn(async (_p, input: any) => {
      expect(input.candidates).toHaveLength(23);
      return { selected: [23, 21, 14, 7, 5, 2] };
    });
    const selected = await chooseTopSix(candidates, call);
    expect(selected.map(c => c.name)).toEqual(['话题23', '话题21', '话题14', '话题7', '话题5', '话题2']);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('允许少于六条，已合格不超过六条时不增加一次模型调用', async () => {
    expect(await chooseTopSix(candidates, async () => ({ selected: [18, 4] }))).toHaveLength(2);
    const call = vi.fn();
    expect(await chooseTopSix(candidates.slice(0, 3), call)).toHaveLength(3);
    expect(call).not.toHaveBeenCalled();
  });
  it('超过六个、重复或越界编号不能进入编稿，也不默认取前六', async () => {
    for (const selected of [[1, 2, 3, 4, 5, 6, 7], [1, 1], [24]]) {
      const call = vi.fn(async () => ({ selected }));
      await expect(chooseTopSix(candidates, call)).rejects.toThrow('已停止编稿');
      expect(call).toHaveBeenCalledTimes(2);
    }
  });
  it('缓存复用择优结果，模型/老师上下文变化后重新比较', async () => {
    const saved = new Map<string, unknown>();
    const cache = { get: (k: string) => saved.get(k), set: (k: string, v: unknown) => { saved.set(k, v); } };
    const call = vi.fn(async () => ({ selected: [23, 15] }));
    await chooseTopSix(candidates, call, cache, { model: 'one' });
    await chooseTopSix(candidates, call, cache, { model: 'one' });
    expect(call).toHaveBeenCalledTimes(1);
    await chooseTopSix(candidates, call, cache, { model: 'two' });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
