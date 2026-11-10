import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { qualityPrompt, screenTextCandidates } from './text-quality-gate';
import { editRanges, originalTextSource, readingOrder } from '../shared/text-selection';
import type { TextClip, TextEdit, TextJob, TextJobInput, TextPick, TextRange, TextUnit, TextTopicVerdict } from '../shared/text-selection';
import type { DatabaseService } from './database';
import type { DeepSeekModelAdapter } from './model-adapter';
import type { TextSources } from './text-sources';
import { chooseTopSix, MAX_TEXT_CANDIDATES } from './text-candidate-limit';
import { finalVersionMatches } from '../shared/text-behavior';
import { buildSelectionLearning } from './text-selection-learning';
import { buildTextLearning, editSnapshot } from './text-learning';
import type { TextFeishuExport } from '../shared/types';

const key = 'text-selection-jobs-v1';
const pendingKey = 'text-selection-pending-v1';
const candidateRangeError = '模型返回了无效的候选起止位置';
type SourceCache = { savedAt: string; units: TextUnit[] };

function sourceCacheKey(url: string) {
  const source = new URL(url);
  if (!/qianwen|tongyi/.test(source.hostname)) source.hash = '';
  return 'text-source-cache:' + createHash('sha256').update(source.href).digest('hex');
}
const candidateSchema = z.object({ name: z.string().min(1), startId: z.string(), endId: z.string(),
  topicValue: z.string().min(1), completeness: z.string().min(1) });
type Candidate = z.infer<typeof candidateSchema>;
const quotation = z.object({ id: z.string(), keep: z.array(z.string().min(1)).min(1).optional() });
const modelPlan = z.object({ titles: z.array(z.object({ text: z.string().trim().min(1) })).min(1).max(4),
  hooks: z.array(quotation).min(1).max(3), selectedHook: z.number().int().nonnegative(),
  body: z.array(quotation).min(1), notes: z.array(z.string()).optional() });
const reviewSchema = z.object({ summary: z.string(), issues: z.array(z.object({
  from: z.number().int().positive(), to: z.number().int().positive(), why: z.string(), suggestion: z.string(),
})).max(4) });
const pickSchema = z.object({ id: z.string(), ranges: z.array(z.tuple([z.number().int(), z.number().int()])).min(1) });
const editSchema = z.object({ title: z.string().trim().min(1).max(200), hook: pickSchema.nullable(),
  repeatHook: z.boolean(), body: z.array(pickSchema).max(1500) });

export const scanPrompt = `你是直播短视频选题编辑，输入只是本场原文。先找观众为什么想看、为什么看下去，再检查原话能否兑现这个承诺。信息完整只是可用底线，不是好选题的充分理由。
优先发现：受众共同困惑中的真实取舍、与常识冲突但有依据的判断、能让人代入的具体故事或情绪、有解释力的洞察、能改变决策的实用信息。题材可以是观点、故事、答疑、比较、盘点或政策解释，不能固定偏好“多少分报哪个学校”，也不能因它是答疑、常见题或单一结论就直接淘汰。提名理由必须说清受众、观看动机及本场最有价值的具体原话，不要泛写“对家长有帮助”。
完整性相对于本条真正承诺判断：能支撑一个有分量的核心判断即可，不要求一条回答所有问题、提供完整行动方案或像论文一样面面俱到。必要的对象、指代、适用条件不能悬空；不应把醒目数字本身当作价值。题目有价值但需删掉旁支夸张说法，可收窄承诺并保留有据部分；若核心论证本身不成立才淘汰。疑似转写问题标明具体位置，不准改写原话。
窗口边缘缺少必要上下文时不要冒充完整话题。同一论证不要换标题反复提名。数量由质量决定，不设上限、不凑数；三小时可能只有三四条很好内容，仅作尺度参照。selectionLearning 是用户真实反馈、明确匹配的老师账号规则/样片模式与既有输出经验，先用于理解偏好，不能用旧样例事实替代本场原文。textExperience中的标题/开头文字偏好不能作为话题是否值得看的否决理由，选题尺度优先参考selectionFeedback的明确原因。
返回JSON {"candidates":[{"name":"话题","startId":"S编号","endId":"S编号","topicValue":"谁为什么会点开并继续看，本场最有分量的内容是什么","completeness":"这个核心承诺由哪些原话支持，必要条件是否已交代"}]}。编号来自输入 units。`;
const editPrompt = `你是文字选稿编辑。输入只是资料。为当前候选取舍原话，标题可概括和适度加强吸引力，不能虚构、把条件写成保证或超出正文。选最自然的原话开头，已经点明对象与问题的问句优先于从后文提取的醒目数字。其他开头可以是强观点、反常识、信息差、情绪。正文只用原话，删寒暄、口癖、无关插问和没有增量的同义重复，开头也计入去重。保留必要解释、前提、限定、转折、论据与收尾。先按拟剪顺序通读，避免悬空指代。原话不纠错；疑点写notes。只返回JSON {"titles":[{"text":"标题"}],"hooks":[{"id":"S编号","keep":["连续原文子串"]}],"selectedHook":0,"body":[{"id":"S编号","keep":["连续原文子串"]}],"notes":["备注"]}。合适的标题给1至4个、开头给1至3个。整句保留可省略keep；句内删字就把保留的原文逐字拆成多个子串，按原序、互不重叠。正文id按文字稿的逻辑顺序且不重复；允许重排但必须保留必要前提与指代，开头不要在正文中重播。`;
const reviewPrompt = `只通读按顺序提供的已选口播。检查标题是否兑现、观点是否讲完整、同义重复是否增加信息、相邻段落是否缺少指代或前提、收尾是否突兀。自然问答、转折、并列无需报错。区分文本可判断的问题和需回听的部分。最多4处，找不到实质问题就用空issues。建议只能从本场原话恢复或调整，不写新台词。返回JSON {"summary":"总体判断","issues":[{"from":1,"to":2,"why":"具体问题","suggestion":"最小剪辑动作"}]}。from和to用相邻position数字，单段问题用相同数字。`;

function groupSource(words: { startMs: number; endMs: number; text: string }[]): TextUnit[] {
  const units: TextUnit[] = [];
  let pending: Omit<TextUnit, 'id'> | undefined;
  const flush = () => {
    if (pending?.text.trim()) units.push({ id: `S${units.length + 1}`, ...pending });
    pending = undefined;
  };
  for (const word of words) {
    if (!word.text) continue;
    if (pending && word.startMs - pending.endMs > 2500) flush();
    pending ??= { startMs: word.startMs, endMs: word.endMs, text: '' };
    pending.text += word.text;
    pending.endMs = word.endMs;
    if (/[。！？?!；;]$/u.test(word.text) || pending.text.length >= 110 && /[，、,：:]$/u.test(word.text) || pending.text.length >= 170) flush();
  }
  flush();
  return units;
}

function candidateUnits(units: TextUnit[], candidate: Candidate) {
  const first = units.findIndex(unit => unit.id === candidate.startId);
  const last = units.findIndex(unit => unit.id === candidate.endId);
  if (first < 0 || last < first) throw new Error(candidateRangeError);
  return units.slice(first, last + 1);
}

function resolveQuote(quote: z.infer<typeof quotation>, units: Map<string, TextUnit>): TextPick {
  const unit = units.get(quote.id);
  if (!unit) throw new Error(`引用不在候选原文内 ${quote.id}`);
  let cursor = 0;
  const ranges = (quote.keep ?? [unit.text]).map((text): TextRange => {
    const start = unit.text.indexOf(text, cursor);
    if (start < 0 || !text.trim()) throw new Error(`引用不是逐字原话 ${quote.id}「${text}」`);
    cursor = start + text.length;
    return [start, cursor];
  });
  return { id: quote.id, ranges };
}

export function validateTextEdit(input: unknown, units: TextUnit[]): TextEdit {
  const edit = editSchema.parse(input);
  const lengths = new Map(units.map(unit => [unit.id, unit.text.length]));
  const seen = new Set<string>();
  for (const pick of edit.body) {
    if (seen.has(pick.id)) throw new Error('同一段正文不能重复保留');
    seen.add(pick.id);
  }
  for (const pick of [...edit.body, ...(edit.hook ? [edit.hook] : [])]) {
    const length = lengths.get(pick.id);
    let cursor = 0;
    for (const [start, end] of pick.ranges) {
      if (length === undefined || start < cursor || end <= start || end > length) throw new Error('选中文字超出原文范围或重叠');
      cursor = end;
    }
  }
  const hook = edit.hook;
  if (!hook) edit.repeatHook = false;
  else if (edit.repeatHook) {
    const index = edit.body.findIndex(pick => pick.id === hook.id);
    if (index >= 0) {
      edit.body[index].ranges = hook.ranges.reduce((ranges, range) => editRanges(ranges, range, true), edit.body[index].ranges);
    } else {
      const sourceIndex = units.findIndex(unit => unit.id === hook.id);
      const next = edit.body.findIndex(pick => units.findIndex(unit => unit.id === pick.id) > sourceIndex);
      edit.body.splice(next < 0 ? edit.body.length : next, 0, hook);
    }
  } else {
    edit.body = edit.body.flatMap(pick => {
      if (pick.id !== hook.id) return [pick];
      const ranges = hook.ranges.reduce((remaining, range) => editRanges(remaining, range, false), pick.ranges);
      return ranges.length ? [{ ...pick, ranges }] : [];
    });
  }
  return edit;
}

export class TextWorkbench {
  private readonly active = new Set<string>();
  private readonly pendingTranscripts = new Map<string, Promise<TextUnit[]>>();
  private readonly current = new Map<string, TextJob>();
  private readonly currentTranscripts = new Map<string, TextUnit[]>();
  private readonly subtitleFiles = new Map<string, string>();

  constructor(private readonly database: Pick<DatabaseService, 'getSetting' | 'setSetting'> & Partial<Pick<DatabaseService, 'listAccounts'>>,
    private readonly source: Pick<TextSources, 'identify' | 'readTranscript'>,
    private readonly model: Pick<DeepSeekModelAdapter, 'textSelection'> & Partial<Pick<DeepSeekModelAdapter, 'getSelectionIdentity'>>) {
    const pending = database.getSetting<Array<{ job: TextJob; subtitleFile?: string }>>(pendingKey, []);
    for (const { job, subtitleFile } of pending) {
      if (this.stored().some(saved => saved.id === job.id && saved.status === 'ready')) continue;
      if (job.status === 'running') {
        job.status = 'failed';
        job.message = '上次处理已中断，可直接重试';
      }
      job.transcriptCount = database.getSetting<TextUnit[] | undefined>(`text-source:${job.id}`, undefined)?.length;
      this.current.set(job.id, job);
      if (subtitleFile) this.subtitleFiles.set(job.id, subtitleFile);
    }
  }

  private stored(): TextJob[] { return this.database.getSetting<TextJob[]>(key, []); }

  private savePending() {
    this.database.setSetting(pendingKey, [...this.current.values()].map(job => ({
      job: { ...job, clips: [] },
      subtitleFile: this.subtitleFiles.get(job.id),
    })));
  }

  list(): TextJob[] {
    return [...this.current.values(), ...this.stored().filter(job => job.status === 'ready')]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private persist(job: TextJob) {
    if (job.status !== 'ready') {
      this.current.set(job.id, job);
      return;
    }
    const transcript = this.currentTranscripts.get(job.id);
    if (transcript) this.database.setSetting(`text-source:${job.id}`, transcript);
    this.database.setSetting(key, [job, ...this.stored().filter(item => item.id !== job.id)]);
    this.current.delete(job.id);
    this.currentTranscripts.delete(job.id);
    this.subtitleFiles.delete(job.id);
    this.savePending();
  }

  start(inputs: TextJobInput[], subtitleFile?: string): TextJob[] {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 3) throw new Error('每次可提交 1 到 3 条回放链接');
    if (inputs.length + this.active.size > 3) throw new Error(`最多同时处理 3 场，目前还可提交 ${3 - this.active.size} 场`);
    if (subtitleFile && inputs.length !== 1) throw new Error('每个字幕文件只对应一场直播');
    const sources = inputs.map(input => {
      const originalUrl = input.url.trim();
      return { ...this.source.identify(originalUrl), originalUrl, name: this.cleanName(input.name), teacher: this.cleanTeacher(input.teacher) };
    });
    const activeUrls = new Set([...this.current.values()].filter(job => this.active.has(job.id)).map(job => job.url));
    for (const source of sources) {
      if (activeUrls.has(source.url)) throw new Error('有重复链接，或同一个链接正在处理');
      activeUrls.add(source.url);
    }
    return sources.map(source => {
      for (const previous of this.current.values()) {
        if (previous.status === 'failed' && previous.url === source.url) this.dismiss(previous.id);
      }
      return this.launch({ id: randomUUID(), url: source.url, originalUrl: source.originalUrl, name: source.name,
        source: source.kind, teacher: source.teacher, createdAt: new Date().toISOString(), status: 'running', message: '', clips: [] }, subtitleFile);
    });
  }

  private launch(job: TextJob, subtitleFile?: string) {
    job.status = 'running';
    job.clips = [];
    job.qualityAudit = undefined;
    job.failureStage = '读取逐字稿';
    job.message = '正在获取带时间码的逐字稿';
    if (subtitleFile) {
      this.currentTranscripts.delete(job.id);
      this.database.setSetting(`text-source:${job.id}`, null);
      job.transcriptCount = undefined;
      job.transcriptSavedAt = undefined;
      this.subtitleFiles.set(job.id, subtitleFile);
    }
    this.persist(job);
    this.savePending();
    this.active.add(job.id);
    void this.run(job).catch(error => {
      job.status = 'failed';
      const detail = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
      const code = cause?.code?.match(/^[A-Z0-9_]+$/)?.[0];
      job.message = /fetch failed|net::ERR_|terminated/i.test(detail)
        ? (job.failureStage === '读取逐字稿' ? '获取原文的网络请求失败' : 'AI 分析的网络请求失败') + '：' + detail + (code ? '（' + code + '）' : '') + '。已保存的原文会保留，可重试。'
        : detail;
      this.persist(job);
      this.savePending();
    }).finally(() => { this.active.delete(job.id); });
    return job;
  }

  private cleanName(input?: string) {
    const name = input?.trim();
    if (name && (name.length > 100 || /[\r\n]/.test(name))) throw new Error('回放名称请填写一行，最多 100 字');
    return name || undefined;
  }

  private cleanTeacher(input?: string) {
    const teacher = input?.trim().normalize();
    if (teacher && (teacher.length > 40 || /[\r\n\t]/.test(teacher))) throw new Error('老师姓名请填写一行，最多 40 字');
    return teacher || undefined;
  }

  rename(jobId: string, name: string, teacher?: string): TextJob {
    const job = this.find(jobId);
    const nextName = this.cleanName(name);
    const nextTeacher = teacher === undefined ? job.teacher : this.cleanTeacher(teacher);
    job.name = nextName;
    job.teacher = nextTeacher;
    for (const clip of job.clips) if (clip.confirmedFinal?.status === 'confirmed' && clip.confirmedFinal.teacher !== nextTeacher) clip.confirmedFinal = { ...clip.confirmedFinal, status: 'outdated' };
    this.persist(job);
    if (job.status !== 'ready') this.savePending();
    return job;
  }

  dismiss(jobId: string) {
    if (this.current.get(jobId)?.status !== 'failed') throw new Error('只可清除本次未完成的记录');
    this.current.delete(jobId);
    this.currentTranscripts.delete(jobId);
    this.subtitleFiles.delete(jobId);
    this.savePending();
  }

  retry(jobId: string, subtitleFile?: string) {
    const job = this.find(jobId);
    if (job.status === 'running') throw new Error('请先等待这场直播处理完成');
    if (job.status === 'ready') return this.start([{ url: originalTextSource(job), name: job.name, teacher: job.teacher }], subtitleFile)[0];
    if (this.active.size >= 3) throw new Error('最多同时处理 3 场，请等一场完成后重试');
    return this.launch(job, subtitleFile);
  }

  private find(jobId: string): TextJob {
    const job = this.list().find(item => item.id === jobId);
    if (!job) throw new Error('找不到这场直播的历史记录');
    return job;
  }

  private async loadUnits(job: TextJob, subtitleFile?: string) {
    if (!subtitleFile) {
      let cache = this.database.getSetting<SourceCache | undefined>(sourceCacheKey(job.url), undefined);
      if (!cache) {
        const earlier = this.stored().find(item => item.url === job.url && item.status === 'ready');
        const units = earlier && this.database.getSetting<TextUnit[] | undefined>(`text-source:${earlier.id}`, undefined);
        if (earlier && units?.length) cache = { units, savedAt: earlier.transcriptSavedAt ?? earlier.createdAt };
      }
      if (cache?.units.length) {
        job.message = '正在读取已保存的整场原文';
        return this.saveSource(job, cache);
      }
    }
    const { parts, cues } = await this.source.readTranscript(job.url, subtitleFile, message => {
      job.message = message;
      this.persist(job);
    });
    const valid = parts.filter(part => part.text.trim() && Number.isFinite(part.startMs) && Number.isFinite(part.endMs)
      && part.startMs >= 0 && part.endMs >= part.startMs).sort((a, b) => a.startMs - b.startMs);
    const units = cues ? valid.map((part, i) => ({ ...part, id: `S${i + 1}` })) : groupSource(valid);
    if (!units.length) throw new Error('没有可分析的带时间码原话');
    return this.saveSource(job, { units, savedAt: new Date().toISOString() });
  }

  private saveSource(job: TextJob, cache: SourceCache) {
    this.database.setSetting(sourceCacheKey(job.url), cache);
    this.database.setSetting(`text-source:${job.id}`, cache.units);
    if (job.status !== 'ready') this.currentTranscripts.set(job.id, cache.units);
    job.transcriptCount = cache.units.length;
    job.transcriptSavedAt = cache.savedAt;
    this.persist(job);
    if (job.status !== 'ready') this.savePending();
    return cache.units;
  }

  async transcript(jobId: string): Promise<TextUnit[]> {
    const job = this.find(jobId);
    const cached = this.currentTranscripts.get(jobId) ?? this.database.getSetting<TextUnit[] | undefined>(`text-source:${jobId}`, undefined);
    if (cached) return cached;
    if (job.status === 'running') throw new Error('逐字稿正在获取，请稍等');
    const pending = this.pendingTranscripts.get(jobId);
    if (pending) return pending;
    const work = this.loadUnits(job).then(units => {
      this.persist({ ...this.find(jobId), transcriptCount: units.length });
      return units;
    }).finally(() => this.pendingTranscripts.delete(jobId));
    this.pendingTranscripts.set(jobId, work);
    return work;
  }

  async supplement(jobId: string, startMs: number, endMs: number): Promise<TextClip> {
    const job = this.find(jobId);
    if (job.clips.length >= MAX_TEXT_CANDIDATES) throw new Error('每场最多6条文字候选，当前已达上限；可重新生成以重新择优');
    if (job.status === 'running') throw new Error('请等待这场直播处理完成');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs - startMs > 30 * 60000) {
      throw new Error('请选择有效的起止时间，单次补选不超过 30 分钟');
    }
    const units = (await this.transcript(jobId)).filter(unit => unit.endMs > startMs && unit.startMs < endMs);
    if (!units.length) throw new Error('该范围内没有原话');
    const response = await this.model.textSelection(`${scanPrompt}\n只在给定时间范围内选最好的一个完整话题。可以返回空数组。`, units, 'analysis');
    const [candidate] = z.object({ candidates: z.array(candidateSchema).max(1) }).parse(response).candidates;
    if (!candidate) throw new Error('这段没有讲完整的话题，可调整时间范围再试');
    const clip = await this.selectClip(candidate, candidateUnits(units, candidate), job);
    const current = this.find(jobId);
    this.persist({ ...current, status: 'ready', clips: [...current.clips, clip], message: `已补选 1 条，现有 ${current.clips.length + 1} 条候选` });
    return clip;
  }

  recordDelivery(jobId: string, clipId: string, teacher: string, delivered: TextClip, result: TextFeishuExport) {
    const job = this.find(jobId);
    const clip = job.clips.find(item => item.id === clipId);
    const exportedAt = new Date().toISOString();
    teacher = this.cleanTeacher(teacher) ?? teacher;
    for (const item of job.clips) if (item.confirmedFinal?.status === 'confirmed' && item.confirmedFinal.teacher !== teacher) item.confirmedFinal = { ...item.confirmedFinal, status: 'outdated' };
    if (clip?.initialEdit) clip.learning = { edit: editSnapshot(delivered), teacher, exportedAt };
    if (clip) clip.lastExport = { edit: editSnapshot(delivered), teacher, savedAt: exportedAt, documentId: result.documentId };
    this.persist({ ...job, teacher, deliveries: [
      { ...result, teacher, clipId, title: delivered.title, exportedAt },
      ...(job.deliveries ?? []).filter(item => item.documentId !== result.documentId),
    ] });
  }

  recordSync(jobId: string, documentId: string, title: string, error?: string, syncedClip?: TextClip) {
    const job = this.find(jobId);
    if (!error && syncedClip) {
      const clip = job.clips.find(c => c.id === syncedClip.id);
      const delivery = job.deliveries?.find(d => d.documentId === documentId);
      if (clip && delivery) clip.lastExport = { edit: editSnapshot(syncedClip), teacher: delivery.teacher, savedAt: new Date().toISOString(), documentId };
    }
    this.persist({ ...job, deliveries: job.deliveries?.map(delivery => delivery.documentId !== documentId ? delivery :
      error ? { ...delivery, syncError: error } : { ...delivery, title, syncedAt: new Date().toISOString(), syncError: undefined }) });
  }

  learningSummary() { return buildTextLearning(this.list()).summary; }

  private async run(job: TextJob) {
    let units = this.currentTranscripts.get(job.id)
      ?? this.database.getSetting<TextUnit[] | undefined>(`text-source:${job.id}`, undefined);
    if (!units) {
      try {
        units = await this.loadUnits(job, this.subtitleFiles.get(job.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/已自动重试|已尝试 \d+ 次/.test(message) || !/fetch failed|terminated|ECONNRESET|ETIMEDOUT|timed? ?out|HTTP (?:429|5\d\d)/i.test(message)) throw error;
        job.message = '连接暂时失败，正在重新读取逐字稿';
        await new Promise(resolve => setTimeout(resolve, 1500));
        units = await this.loadUnits(job, this.subtitleFiles.get(job.id));
      }
    }
    job.transcriptCount = units.length;
    const qualified = await this.chooseCandidates(job, units);
    if (qualified.length > MAX_TEXT_CANDIDATES) { job.message = '正在从合格话题中择优，最多生成6条文字初稿'; this.persist(job); }
    const rankingContext = { teacher: job.teacher, model: await this.model.getSelectionIdentity?.(),
      selectionLearning: buildSelectionLearning(this.stored(), job, '', this.database.listAccounts?.() ?? []) };
    const candidates = (await chooseTopSix(qualified, (prompt, input) => this.model.textSelection(prompt, input, 'analysis', 'high'), {
      get: hash => this.database.getSetting('text-top-six:' + hash, undefined),
      set: (hash, value) => this.database.setSetting('text-top-six:' + hash, value),
    }, rankingContext)).slice(0, MAX_TEXT_CANDIDATES);
    if (job.qualityAudit) job.qualityAudit = { ...job.qualityAudit, qualified: qualified.length, approved: candidates.length, outputLimit: MAX_TEXT_CANDIDATES };
    const failures: string[] = [];
    job.failureStage = '整理候选';
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      job.message = `正在生成文字初稿 · ${i + 1}/${candidates.length}`;
      this.persist(job);
      try {
        job.clips.push(await this.selectClip(candidate, candidateUnits(units, candidate), job));
      } catch (error) {
        failures.push(`${candidate.name}（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
    job.status = failures.length && !job.clips.length ? 'failed' : 'ready';
    if (job.status === 'ready') delete job.failureStage;
    job.message = job.clips.length ? `已生成 ${job.clips.length} 条候选${failures.length ? `，${failures.length} 条未通过原话校验` : ''}`
      : failures.length ? `候选处理未完成：${failures.join('；')}` : '本场提名未通过严格质量复审，未继续逐条编稿；整场原文已保留' ;
    this.persist(job);
    if (job.status === 'failed') this.savePending();
  }

  private async chooseCandidates(job: TextJob, units: TextUnit[]): Promise<Candidate[]> {
    const selectionLearning = buildSelectionLearning(this.stored(), job, '', this.database.listAccounts?.() ?? []);
    const modelIdentity = await this.model.getSelectionIdentity?.() ?? { model: 'test-model', baseUrl: '' };
    const fingerprint = createHash('sha256').update(JSON.stringify({ policy: 'audience-value-v2', scanPrompt, qualityPrompt,
      units, source: new URL(job.url).origin + new URL(job.url).pathname, teacher: job.teacher?.trim().normalize() ?? '', selectionLearning, modelIdentity, thinking: 'scan-low-review-high' })).digest('hex');
    const checkpointKey = 'text-selection-cache:' + fingerprint;
    const checkpoint = this.database.getSetting<{ fingerprint: string; candidates: Candidate[]; audit: NonNullable<TextJob['qualityAudit']> } | undefined>(checkpointKey, undefined);
    if (checkpoint?.fingerprint === fingerprint) {
      job.qualityAudit = { ...checkpoint.audit, reused: true };
      return checkpoint.candidates;
    }
    job.failureStage = '筛选话题';
    const size = 30 * 60000;
    const overlap = 90000;
    const duration = units.at(-1)!.endMs;
    const windows = duration <= 45 * 60000 ? [units] : Array.from({ length: Math.ceil(duration / size) }, (_, i) =>
      units.filter(unit => unit.endMs >= i * size - overlap && unit.startMs < (i + 1) * size + overlap)).filter(window => window.length);
    const shortlist: Candidate[] = [];
    for (let i = 0; i < windows.length; i++) {
      job.message = `正在筛选话题 · 已扫描 ${i}/${windows.length} 段`;
      this.persist(job);
      const window = windows[i];
      const scanKey = `text-scan-checkpoint:${fingerprint}:${i}`;
      const candidates = this.database.getSetting<Candidate[] | undefined>(scanKey, undefined)
        ?? await this.validatedSelection(job, scanPrompt, { units: window, selectionLearning }, raw => {
        const items = z.object({ candidates: z.array(candidateSchema) }).parse(raw).candidates;
        for (const candidate of items) candidateUnits(window, candidate);
        return items;
      });
      this.database.setSetting(scanKey, candidates);
      shortlist.push(...candidates);
    }

    const screened = await screenTextCandidates(shortlist, units,
      (prompt, input) => this.model.textSelection(prompt, input, 'analysis', 'high'),
      message => { job.message = message; this.persist(job); }, {
        get: hash => this.database.getSetting(`text-quality-batch:${fingerprint}:${hash}`, undefined)
          ?? this.database.getSetting(`text-quality-batch:${job.id}:${hash}`, undefined),
        set: (hash, value) => this.database.setSetting(`text-quality-batch:${fingerprint}:${hash}`, value),
      }, selectionLearning);
    job.qualityAudit = { proposed: shortlist.length, approved: screened.candidates.length,
      extraReview: screened.extraReview, policyVersion: 'audience-value-v2', model: modelIdentity.model, thinking: '初选低强度思考 · 复审高强度思考', decisions: screened.decisions };
    this.database.setSetting(checkpointKey, { fingerprint, candidates: screened.candidates, audit: job.qualityAudit });
    this.persist(job);
    return screened.candidates;
  }

  private async validatedSelection<T>(job: TextJob, prompt: string, input: unknown, validate: (raw: unknown) => T): Promise<T> {
    let previousOutput: unknown;
    try {
      previousOutput = await this.model.textSelection(prompt, input, 'analysis', 'low');
      return validate(previousOutput);
    } catch (error) {
      if (!(error instanceof z.ZodError || error instanceof SyntaxError || error instanceof Error && error.message === candidateRangeError)) throw error;
      const detail = error instanceof z.ZodError ? error.issues.slice(0, 5).map(issue => issue.path.join('.')).join('、') : 'JSON 格式或原文位置';
      job.message = '模型输出缺字段或时间范围有误，正在重试当前阶段';
      try {
        return validate(await this.model.textSelection(
          `${prompt}\n请修复上一份输出。每条候选都必须有 name、startId、endId、topicValue、completeness，其中 completeness 必须引用本场证据说明讲完整了什么。不设数量配额；只保留值得制作且完整的题。只返回符合当前任务要求的完整 JSON。`,
          { source: input, previousOutput, requiredCorrections: detail }, 'analysis'));
      } catch (retryError) {
        if (retryError instanceof z.ZodError || retryError instanceof SyntaxError || retryError instanceof Error && retryError.message === candidateRangeError) {
          throw new Error(`DeepSeek 两次返回的选题格式不符合要求，请重试。检查项：${detail}`);
        }
        throw retryError;
      }
    }
  }

  private async selectClip(candidate: Candidate, units: TextUnit[], job: TextJob): Promise<TextClip> {
    const map = new Map(units.map(unit => [unit.id, unit]));
    const editorialLearning = buildTextLearning(this.stored(), job, candidate.name).context;
    const learnedSelection = buildSelectionLearning(this.stored(), job, candidate.name, this.database.listAccounts?.() ?? []);
    const selectionLearning = learnedSelection && (learnedSelection.selectionFeedback || learnedSelection.accountReference)
      ? { selectionFeedback: learnedSelection.selectionFeedback, accountReference: learnedSelection.accountReference } : undefined;
    let feedback: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.model.textSelection(editPrompt + (editorialLearning ? '\n过往改稿经验只用于判断取舍。generalRules 是跨老师的通用经验，teacherExperience 只属于当前老师。以本场内容是否完整为先，仅引用当前 units 的原话。' : ''),
          { candidate, units, feedback, editorialLearning, selectionLearning }, 'analysis');
        const plan = modelPlan.parse(raw);
        const hooks = plan.hooks.map(hook => resolveQuote(hook, map));
        const hook = hooks[plan.selectedHook];
        if (!hook) throw new Error('开头编号不合法');
        const body = plan.body.map(part => resolveQuote(part, map));
        const titles = [...new Set(plan.titles.map(title => title.text))];
        const edit = validateTextEdit({ title: titles[0], hook, repeatHook: false, body }, units);
        if (!edit.body.length) throw new Error('候选缺少正文');
        return { ...edit, initialEdit: editSnapshot(edit), id: randomUUID(), name: candidate.name, topicValue: candidate.topicValue,
          completeness: candidate.completeness, units, titles, hooks, notes: plan.notes ?? [] };
      } catch (error) {
        feedback = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(feedback);
  }

  get(jobId: string, clipId: string) {
    const job = this.list().find(item => item.id === jobId);
    const clip = job?.clips.find(item => item.id === clipId);
    if (!job || !clip || job.status === 'running') throw new Error('请等待候选生成完成');
    return { job, clip };
  }

  rateTopic(jobId: string, clipId: string, verdict: TextTopicVerdict, reason: string) {
    const { job, clip } = this.get(jobId, clipId);
    if (!['good', 'bad', 'incomplete', 'duplicate', 'deferred'].includes(verdict)) throw new Error('请选择有效的采用或未采用原因');
    reason = reason.trim();
    if (!reason || reason.length > 800) throw new Error('请填写选题判断的具体原因，最多800字');
    clip.topicFeedback = { verdict, reason, teacher: job.teacher?.trim().normalize() ?? '', updatedAt: new Date().toISOString() };
    clip.topicFeedbackHistory = [...(clip.topicFeedbackHistory ?? []), { ...clip.topicFeedback }];
    this.persist(job);
    return clip;
  }

  clearTopicFeedback(jobId: string, clipId: string) {
    const { job, clip } = this.get(jobId, clipId);
    clip.topicFeedbackHistory = [...(clip.topicFeedbackHistory ?? []), { verdict: 'cleared', reason: '用户撤销选题反馈', teacher: clip.topicFeedback?.teacher ?? job.teacher ?? '', updatedAt: new Date().toISOString() }];
    delete clip.topicFeedback;
    this.persist(job);
    return clip;
  }

  confirmFinal(jobId: string, clipId: string, note = '', expectedEdit?: TextEdit) {
    const { job, clip } = this.get(jobId, clipId);
    if (expectedEdit && JSON.stringify(expectedEdit) !== JSON.stringify(editSnapshot(clip))) throw new Error('稿件已在其他位置更新，请刷新后确认当前版本');
    if (typeof note !== 'string' || note.length > 800) throw new Error('定稿备注最多800字');
    if (!clip.body.length) throw new Error('请先完成正文');
    if (!clip.initialEdit) throw new Error('这条旧记录缺少模型初稿，请先重新生成，才能确认完整对比学习');
    const teacher = job.teacher?.trim().normalize();
    if (!teacher) throw new Error('请先填写老师姓名，以免把不同老师的偏好混用');
    if (finalVersionMatches(clip) && clip.confirmedFinal?.note === note.trim()) return clip;
    const version = { revision: (clip.confirmedFinal?.revision ?? 0) + 1, edit: editSnapshot(clip), teacher,
      confirmedAt: new Date().toISOString(), note: note.trim(), status: 'confirmed' as const };
    clip.confirmedFinal = version;
    clip.finalHistory = [...(clip.finalHistory ?? []), structuredClone(version)];
    this.persist(job);
    return clip;
  }

  withdrawFinal(jobId: string, clipId: string) {
    const { job, clip } = this.get(jobId, clipId);
    if (clip.confirmedFinal) clip.confirmedFinal = { ...clip.confirmedFinal, status: 'withdrawn' };
    this.persist(job);
    return clip;
  }

  save(jobId: string, clipId: string, input: unknown): TextClip {
    const { job, clip } = this.get(jobId, clipId);
    const edit = validateTextEdit(input, clip.units);
    const changed = JSON.stringify(edit) !== JSON.stringify({ title: clip.title, hook: clip.hook, repeatHook: clip.repeatHook, body: clip.body });
    if (changed && !clip.initialEdit) clip.initialEdit = editSnapshot(clip);
    Object.assign(clip, edit);
    if (changed && clip.confirmedFinal?.status === 'confirmed') clip.confirmedFinal = { ...clip.confirmedFinal, status: 'outdated' };
    if (changed) delete clip.review;
    this.persist(job);
    return clip;
  }

  async review(jobId: string, clipId: string): Promise<TextClip> {
    const { clip } = this.get(jobId, clipId);
    const sequence = readingOrder(clip);
    if (!sequence.length) throw new Error('请先选择开头或正文');
    const revision = JSON.stringify({ title: clip.title, sequence });
    const raw = await this.model.textSelection(reviewPrompt, { title: clip.title, sequence }, 'analysis');
    const review = reviewSchema.parse(raw);
    if (review.issues.some(issue => issue.to > sequence.length || issue.from > issue.to || issue.to - issue.from > 1)) {
      throw new Error('模型返回的通读位置有误，请重试');
    }
    const current = this.get(jobId, clipId);
    if (JSON.stringify({ title: current.clip.title, sequence: readingOrder(current.clip) }) !== revision) {
      throw new Error('通读期间稿件有变更，请按最新稿重新检查');
    }
    current.clip.review = review;
    this.persist(current.job);
    return current.clip;
  }
}
