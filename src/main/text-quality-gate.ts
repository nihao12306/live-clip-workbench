import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TextUnit } from '../shared/text-selection';

export type QualityCandidate = { name: string; startId: string; endId: string; topicValue: string; completeness: string };
type Call = (prompt: string, input: unknown) => Promise<unknown>;
export type QualityDecision = { name: string; approved: boolean; reason: string; round: string; watchReason?: string; valueType?: string };
export type QualityResult = { candidates: QualityCandidate[]; decisions: QualityDecision[]; reviewed: number; extraReview: boolean };
const schema = z.object({ decisions: z.array(z.object({
  number: z.number().int().positive(), watchValue: z.boolean().default(false), standalone: z.boolean().default(false), complete: z.boolean().default(false),
  promise: z.string().trim().min(1), watchReason: z.string().trim().min(1),
  valueType: z.enum(['decision', 'insight', 'story', 'emotion', 'usefulFact']),
  coreQuestion: z.string().trim().min(1), conclusion: z.string().trim().min(1), reason: z.string().trim().min(1),
  duplicateOf: z.number().int().positive().nullable(),
  evidence: z.array(z.object({ id: z.string(), quote: z.string().trim().min(1) })),
})) });
export const qualityPrompt = `你是直播短视频选题主编，负责在逐条生成文字稿前选择值得观众看的内容。输入提名是待审材料，不是质量证明。必须阅读 units 原文，并参考 selectionLearning 中用户明确反馈；模型自己通过的题目不属于人工认可样例。选题反馈帮助初选；textExperience中的标题、开头文字偏好只帮助文字表达，不得作为话题价值的否决理由。此流程不承担视频剪辑。
判断顺序：先看传播与受众价值，再看承诺是否可兑现。watchValue必须有明确理由：谁遇到什么真实困惑、反常识冲突、情绪共鸣或故事悬念，为什么愿意听完，本场哪部分原话带来有分量的判断/解释/体验/实用信息。信息齐全、几个数字和学校名不是充分理由；也不能把复杂、长篇、多条路径当作好片的必要条件。
内容可以是单一强观点、具体故事、问答、院校比较、经验分享或有影响的实用事实。答疑或常见题并不天然低价值，一个短而有分量的回答也可通过；反过来，满篇条件齐全但只是泛泛罗列同样不通过。不要固定偏好分数定位/学校比较，也不要固定偏好故事/反常识。不同价值类型用相应标准判断，而不是统一要求一条讲透所有问题。
分别给出 watchValue（值得看）、standalone（核心对象与指代可理解）、complete（本条promise有足够支撑和自然落点）。complete只相对于这个核心承诺，不要求完整政策指南、万能行动方案或研究论文。未明确的边界会改变核心结论时才阻断；外围插话夸张、无关的绝对化结尾，可通过收窄promise、取舍本场原话避开时，不要因此否决整条。若保证就业/录取等就是核心论证且无足够支持，则不通过。不能仅因“缺更详细建议”或“题目常见”否决完整有分量的内容；也不能因“原话这样说”就放行无依据的保证。
校准例：只报学校排名或一句“可以报”通常无足够观看价值；讲明城市产业、培养差异如何改变取舍则可值得看。围绕大众焦虑的具体校招见闻可有故事与解释价值，不能因为没有覆盖全部岗位而自动否决。短政策对比若关键适用条件缺失则不完整；若改变受众决策的条件已清楚，也不能仅因短而否决。
同一论证被拆多个标题、子段完全包含于母题且没有独立观看承诺与论据，应合并；来源重叠但观点和论证独立则可以分别保留。结合previousAccepted和本批原文去重。duplicateOf引用本批或previousAccepted编号，不得自指。
surrounding仅帮助识别缺失背景，不可假装这些内容已经在候选内。用户样例事实不可移入本场。数量由内容决定，不设上限、保底或比例淘汰；三小时三四条很好内容、超过十条要复查仅是经验信号，不改变质量门槛。
每条给明确决定、watchReason和reason；通过项引用至少两处不同连续原话作为证据，分别支撑观看承诺和论证，不能改字。没有足够证据不得默认通过。仅返回JSON {"decisions":[{"number":1,"promise":"本条真正能兑现的观看承诺/话题名","watchReason":"谁为什么会点开并继续看，原话中具体吸引力是什么","valueType":"decision/insight/story/emotion/usefulFact中一个","watchValue":false,"standalone":false,"complete":false,"coreQuestion":"核心问题","conclusion":"实际结论或缺失","reason":"对照原文说明承诺是否成立、必要背景与去重依据；不得用泛泛的完整或有价值代替","duplicateOf":null,"evidence":[{"id":"S1","quote":"连续原文"}]}]}。`;

export async function screenTextCandidates(candidates: QualityCandidate[], units: TextUnit[], call: Call,
  progress: (message: string) => void = () => {},
  cache?: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
  selectionLearning?: unknown): Promise<QualityResult> {
  const positions = new Map(units.map((u, i) => [u.id, i]));
  const seen = new Set<string>();
  const decisions: QualityDecision[] = [];
  const unique = candidates.filter(c => {
    const span = `${c.startId}:${c.endId}`;
    if (seen.has(span)) { decisions.push({ name: c.name, approved: false, round: '去重', reason: '与其他提名的原文范围完全相同，合并重复提名' }); return false; }
    seen.add(span); return true;
  }).sort((a, b) => positions.get(a.startId)! - positions.get(b.startId)!);
  const review = async (items: QualityCandidate[], strict: boolean) => {
    const approved: QualityCandidate[] = [];
    const previousAccepted: Array<{ number: number; name: string; coreQuestion: string; conclusion: string; startId: string; endId: string }> = [];
    const entries = items.map((c, i) => {
      const start = positions.get(c.startId), end = positions.get(c.endId);
      if (start === undefined || end === undefined || end < start) throw new Error('质量复审的候选范围无效');
      return { number: i + 1, ...c, units: units.slice(start, end + 1),
        surrounding: { before: units.slice(Math.max(0, start - 2), start), after: units.slice(end + 1, end + 3) } };
    });
    for (let offset = 0; offset < entries.length;) {
      const batch: typeof entries = []; let chars = 0;
      while (offset < entries.length) {
        const entry = entries[offset], size = JSON.stringify(entry).length;
        if (batch.length && (batch.length >= 6 || chars + size > 24000)) break;
        batch.push(entry); chars += size; offset++;
      }
      progress(`正在按原文${strict ? '跨题复核' : '复审'}话题 · ${offset}/${entries.length}，尚未逐条编稿`);
      const cacheKey = createHash('sha256').update(JSON.stringify({ prompt: qualityPrompt, strict, batch, previousAccepted, selectionLearning })).digest('hex');
      let verdicts: z.infer<typeof schema>['decisions'] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = (attempt === 0 ? cache?.get(cacheKey) : undefined) ?? await call(qualityPrompt + (strict ? '\n这是候选较多触发的跨题复核。保持完全相同的价值与完整性标准，集中核对重复包装和核心承诺是否有原文支持。不能因超过十条提高门槛，不能因缺少完整行动方案否决已有分量的观点。若与初审相反，reason必须指出初审忽略的具体原文问题。' : '')
          + (attempt ? '\n上次结构或证据不合格，请逐项重新核对编号与逐字证据，仍不允许缺项。' : ''), { candidates: batch, previousAccepted: [...previousAccepted], selectionLearning });
        try {
          verdicts = schema.parse(raw).decisions;
          if (verdicts.length !== batch.length || new Set(verdicts.map(v => v.number)).size !== batch.length
            || verdicts.some(v => !batch.some(b => b.number === v.number))) throw new Error('复审漏项或编号错误');
          const passing = (v: typeof verdicts[number]) => v.watchValue && v.standalone && v.complete && v.duplicateOf === null;
          for (const v of verdicts) {
            const entry = batch.find(b => b.number === v.number)!;
            if (v.duplicateOf !== null && (v.duplicateOf === v.number || (!previousAccepted.some(p => p.number === v.duplicateOf)
              && !verdicts.some(other => other.number === v.duplicateOf)))) throw new Error('重复指向无效');
            if (!passing(v)) continue;
            v.evidence = v.evidence.filter(e => entry.units.some(u => u.id === e.id && u.text.includes(e.quote)));
            if (new Set(v.evidence.map(e => e.id + ':' + e.quote)).size < 2) throw new Error('通过项缺少逐字原文证据');
          }
          cache?.set(cacheKey, { decisions: verdicts });
          break;
        } catch (error) {
          if (attempt === 1) throw new Error('质量复审两次未返回完整有效的原文证据，已停止编稿以避免继续消耗', { cause: error });
        }
      }
      for (const entry of batch) {
        const v = verdicts.find(v => v.number === entry.number)!;
        const pass = v.watchValue && v.standalone && v.complete && v.duplicateOf === null;
        decisions.push({ name: entry.name, approved: pass, reason: v.reason, round: strict ? '跨题复核' : '原文复审', watchReason: v.watchReason, valueType: v.valueType });
        if (pass) {
          approved.push({ ...items[entry.number - 1], name: v.promise, topicValue: v.watchReason, completeness: v.reason });
          previousAccepted.push({ number: entry.number, name: v.promise, coreQuestion: v.coreQuestion, conclusion: v.conclusion, startId: entry.startId, endId: entry.endId });
        }
      }
    }
    return approved;
  };
  let approved = await review(unique, false);
  const extraReview = approved.length > 10;
  if (extraReview) approved = await review(approved, true);
  return { candidates: approved, decisions, reviewed: unique.length, extraReview };
}
