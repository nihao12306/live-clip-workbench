import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { QualityCandidate } from './text-quality-gate';
export const MAX_TEXT_CANDIDATES = 6;
export const topSixPrompt = `你负责最终文字选稿的相对择优排序。以下候选已通过原文复审；不要再次逐条编稿。每场最终最多生成6条，按观看价值、观点/故事的分量、论证、受众共鸣与彼此独立性，从中挑最值得做的最多6条，按优先级返回编号。先判断选题本身是否值得做，不能用漂亮标题或流畅稿件代替选题价值。不是取前6条，也不为凑满而保留弱题；可以少于6。不要把同一论证的不同标题占满名额，题材不同不是保留的充分理由。输入中的topicValue与completeness是之前对照原文的评审依据，只作比较，不可补造新事实。context为老师规则与用户反馈，只参考选题尺度，不可搬用旧例事实。只返回JSON {"selected":[1,2]}，编号必须来自输入，互不重复。`;
export async function chooseTopSix<T extends QualityCandidate>(candidates: T[],
  call: (prompt: string, input: unknown) => Promise<unknown>,
  cache?: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
  context?: unknown): Promise<T[]> {
  if (candidates.length <= MAX_TEXT_CANDIDATES) return candidates;
  const key = createHash('sha256').update(JSON.stringify({ policy: topSixPrompt, candidates, context })).digest('hex');
  const schema = z.object({ selected: z.array(z.number().int().min(1).max(candidates.length)).max(MAX_TEXT_CANDIDATES) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = (attempt === 0 ? cache?.get(key) : undefined) ?? await call(topSixPrompt + (attempt ? '\n上次编号或数量不合格，必须最多6个且不重复。' : ''),
      { candidates: candidates.map((candidate, i) => ({ number: i + 1, ...candidate })), context });
    try {
      const { selected } = schema.parse(raw);
      if (new Set(selected).size !== selected.length) throw new Error('重复编号');
      cache?.set(key, { selected });
      return selected.map(id => candidates[id - 1]);
    } catch (error) {
      if (attempt === 1) throw new Error('最终择优排序未返回最多6个有效编号，已停止编稿，避免继续消耗', { cause: error });
    }
  }
  return [];
}
