import { createHash, randomUUID } from 'node:crypto';
import { clipTime, movedTextIds, originalMarks, originalTextSource } from '../shared/text-selection';
import type { TextClip, TextJob } from '../shared/text-selection';
import type { TextFeishuExport } from '../shared/types';
import type { DatabaseService } from './database';
import { extractFeishuFolderToken, isFeishuDocUrl } from './feishu-drive';
import type { FeishuDocumentBlock, FeishuDriveService, FeishuTextBlock, FeishuTextStyle } from './feishu-drive';

const run = (content: string, style?: FeishuTextStyle) => ({ text_run: { content, ...(style ? { text_element_style: style } : {}) } });
const paragraph = (content: string): FeishuTextBlock => ({ block_type: 2, text: { elements: [run(content)] } });
const elements = (block: FeishuTextBlock) => block.block_type === 2 ? block.text.elements
  : block.block_type === 3 ? block.heading1.elements : block.heading2.elements;
export const blockText = (block: FeishuTextBlock) => elements(block)?.map(element => element.text_run?.content ?? '').join('') ?? '';
export function importDate(job: TextJob) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(job.createdAt));
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return { key: `${part('year')}-${part('month')}-${part('day')}`, label: `${Number(part('month'))}.${Number(part('day'))}` };
}

export function formattedCut(job: TextJob, clip: TextClip, number: number): FeishuTextBlock[] {
  const moved = movedTextIds(clip);
  const selected = new Set([...clip.body, ...(clip.hook ? [clip.hook] : [])].map(pick => pick.id));
  const spans: Array<{ first: number; last: number; index: number }> = [];
  clip.units.forEach((unit, index) => {
    if (!selected.has(unit.id)) return;
    const previous = spans.at(-1);
    if (previous && previous.index + 1 === index && unit.startMs - previous.last <= 2500) {
      previous.last = unit.endMs; previous.index = index;
    } else spans.push({ first: unit.startMs, last: unit.endMs, index });
  });
  if (!spans.length) throw new Error('请先选好正文或开头');
  const source = originalTextSource(job);
  const unitMap = new Map(clip.units.map(unit => [unit.id, unit]));
  const movedAfter = new Map<string, typeof clip.body>();
  let anchor = '';
  for (const pick of clip.body) {
    if (moved.has(pick.id)) movedAfter.set(anchor, [...(movedAfter.get(anchor) ?? []), pick]);
    else anchor = pick.id;
  }
  const insertions = (id: string) => (movedAfter.get(id) ?? []).flatMap(pick => [
    run('\n'), ...pick.ranges.map(([start, end]) => run(unitMap.get(pick.id)!.text.slice(start, end), { background_color: 3 })),
  ]);
  const body = clip.units.map((unit, index): FeishuTextBlock => {
    const original = originalMarks(unit, clip, moved).map(mark => {
      const style: FeishuTextStyle = {};
      if (mark.className.includes('text-green')) style.background_color = 4;
      if (mark.className.includes('text-purple')) style.background_color = 6;
      if (mark.className.includes('text-yellow')) style.background_color = 3;
      if (mark.className.includes('text-underline')) style.underline = true;
      return run(mark.text, Object.keys(style).length ? style : undefined);
    });
    return { block_type: 2, text: { elements: [...(index === 0 ? insertions('') : []), ...original, ...insertions(unit.id)] } };
  });
  return [
    { block_type: 4, heading2: { elements: [run(`切片${number}：${clip.title}`)] } },
    { block_type: 2, text: { elements: [run('回放链接：'), run(source, { link: { url: encodeURIComponent(source) } })] } },
    { block_type: 2, text: { elements: [run(spans.map(span => `${clipTime(span.first)}-${clipTime(span.last, true)}`).join('、'), { bold: true })] } },
    ...body,
  ];
}

export function planCut(blocks: FeishuDocumentBlock[], date: string) {
  const [month, day] = date.split('.').map(Number);
  let inDate = false;
  let index = blocks.length;
  let hasDate = false;
  let number = 0;
  const dates: Array<{ value: number; index: number }> = [];
  blocks.forEach((block, position) => {
    if (block.block_type === 3) {
      if (inDate) index = position;
      const match = blockText(block).trim().match(/^(?:\d{4}[./-])?(\d{1,2})[./-](\d{1,2})$/);
      if (match) dates.push({ value: Number(match[1]) * 100 + Number(match[2]), index: position });
      inDate = Boolean(match && Number(match[1]) === month && Number(match[2]) === day);
      if (inDate) { hasDate = true; index = blocks.length; }
    } else if (inDate && block.block_type === 4) {
      const match = blockText(block).match(/^切片\s*(\d+)/);
      number = Math.max(number, Number(match?.[1] ?? 0));
    }
  });
  if (!hasDate && dates.length) {
    const descending = dates.length < 2 || dates[0].value > dates[1].value;
    const value = month * 100 + day;
    index = dates.find(item => descending ? value > item.value : value < item.value)?.index ?? blocks.length;
  }
  return { index, number: number + 1, addDate: !hasDate };
}

function signature(block: FeishuTextBlock) {
  return JSON.stringify([block.block_type, elements(block).map(element => {
    const style = element.text_run?.text_element_style;
    const link = style?.link?.url ?? '';
    const url = /^https?%3a/i.test(link) ? decodeURIComponent(link) : link;
    return [element.text_run?.content, style?.background_color ?? 0, Boolean(style?.underline),
      block.block_type === 2 && Boolean(style?.bold), url];
  })]);
}

type Checkpoint = TextFeishuExport & {
  formatVersion: 2; cutNumber: number; importDate: string; index: number; skipDate: number;
  planned: FeishuTextBlock[]; ids: string[]; pendingToken?: string; signatures?: string[];
};
type Client = Pick<FeishuDriveService, 'createTextDocument' | 'resolveTextDocument' | 'textDocumentChildren' |
  'insertTextDocumentBlocks' | 'updateTextDocumentBlocks' | 'textDocumentUrl'>;

export class FormattedTextExporter {
  private readonly queue = new Map<string, Promise<unknown>>();
  constructor(private readonly database: Pick<DatabaseService, 'getSetting' | 'setSetting'>, private readonly client: Client) {}
  destinations(): Record<string, string> { return this.database.getSetting('text-feishu-destinations-v1', {}); }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(action);
    this.queue.set(key, work);
    try { return await work; }
    finally { if (this.queue.get(key) === work) this.queue.delete(key); }
  }

  async export(job: TextJob, clip: TextClip, target: string, teacherInput: string): Promise<TextFeishuExport> {
    const teacher = teacherInput.trim();
    if (!teacher || teacher.length > 40 || /[\r\n\t]/.test(teacher)) throw new Error('请填写 1 到 40 字的直播老师姓名');
    let document: { documentId: string; url?: string };
    if (isFeishuDocUrl(target.trim())) document = await this.client.resolveTextDocument(target.trim());
    else {
      const folder = extractFeishuFolderToken(target);
      const key = 'text-feishu-created:' + createHash('sha256').update(JSON.stringify([clip.id, teacher, folder])).digest('hex');
      document = await this.serial(key, async () => {
        const existing = this.database.getSetting<{ documentId: string } | undefined>(key, undefined);
        if (existing) return existing;
        const created = { documentId: await this.client.createTextDocument(`${teacher}｜${clip.title}`, folder) };
        this.database.setSetting(key, created);
        return created;
      });
    }
    return this.serial(document.documentId, async () => {
      const key = `text-feishu-formatted:${document.documentId}:${clip.id}`;
      let state = this.database.getSetting<Checkpoint | undefined>(key, undefined);
      if (!state) {
        const date = importDate(job);
        const plan = planCut(await this.client.textDocumentChildren(document.documentId), date.label);
        const sequenceKey = `text-feishu-sequence:${document.documentId}:${date.key}`;
        plan.number = Math.max(plan.number, this.database.getSetting(sequenceKey, 0) + 1);
        this.database.setSetting(sequenceKey, plan.number);
        const planned = formattedCut(job, clip, plan.number);
        if (plan.addDate) planned.unshift({ block_type: 3, heading1: { elements: [run(date.label)] } });
        state = { ...document, formatVersion: 2, cutNumber: plan.number, importDate: date.key, index: plan.index,
          skipDate: plan.addDate ? 1 : 0, planned, ids: [] };
        this.database.setSetting(key, state);
      }
      while (state.ids.length < state.planned.length) {
        state.pendingToken ??= randomUUID();
        this.database.setSetting(key, state);
        const batch = state.planned.slice(state.ids.length, state.ids.length + 40);
        const ids = await this.client.insertTextDocumentBlocks(state.documentId, batch, state.pendingToken, state.index + state.ids.length);
        state.ids.push(...ids);
        delete state.pendingToken;
        this.database.setSetting(key, state);
      }
      state.signatures ??= state.planned.slice(state.skipDate).map(signature);
      this.database.setSetting(key, state);
      await this.update(job, clip, state, key);
      state.url ??= document.url ?? await this.client.textDocumentUrl(state.documentId).catch(() => undefined);
      this.database.setSetting(key, state);
      if (state.url) this.database.setSetting('text-feishu-destinations-v1', { ...this.destinations(), [teacher]: state.url });
      return { documentId: state.documentId, url: state.url, cutNumber: state.cutNumber, importDate: state.importDate, formatVersion: 2 };
    });
  }

  async sync(job: TextJob, clip: TextClip, documentId: string) {
    return this.serial(documentId, async () => {
      const key = `text-feishu-formatted:${documentId}:${clip.id}`;
      const state = this.database.getSetting<Checkpoint | undefined>(key, undefined);
      if (!state?.signatures) throw new Error('飞书切片尚未写完，请先再次导出');
      await this.update(job, clip, state, key);
    });
  }

  private async update(job: TextJob, clip: TextClip, state: Checkpoint, key: string) {
    const planned = formattedCut(job, clip, state.cutNumber);
    if (planned.map(signature).every((value, index) => value === state.signatures?.[index])) return;
    const remote = new Map((await this.client.textDocumentChildren(state.documentId)).map(block => [block.block_id, block]));
    const ids = state.ids.slice(state.skipDate);
    if (ids.length !== planned.length) throw new Error('稿件段落结构有变，请检查原文后重新导出');
    const updates = ids.map((id, index) => {
      const block = remote.get(id);
      if (!block) throw new Error('飞书中这条切片的段落已被移动或删除，请先检查文档');
      if (index === 0) {
        const claim = blockText(block).match(/\s*[（(][^()（）]*[）)]\s*$/)?.[0];
        if (claim && planned[0].block_type === 4) planned[0].heading2.elements[0].text_run.content += claim;
      }
      const actual = signature(block);
      const original = state.signatures![index];
      const headingWithoutClaim = (text: string) => text.replace(/\s*[（(][^()（）]*[）)]\s*$/, '');
      const originalHeading = index === 0 ? (JSON.parse(original)[1] as Array<[string]>).map(row => row[0]).join('') : '';
      const onlyClaimChanged = index === 0 && block.block_type === 4
        && headingWithoutClaim(blockText(block)) === headingWithoutClaim(originalHeading);
      if (actual !== original && actual !== signature(planned[index]) && !onlyClaimChanged) {
        throw new Error('飞书中的这条切片已被人工修改，自动同步已停止。请核对飞书内容后再交付。');
      }
      return { id, block: planned[index] };
    });
    for (let index = 0; index < updates.length; index += 40) {
      await this.client.updateTextDocumentBlocks(state.documentId, updates.slice(index, index + 40));
    }
    state.signatures = planned.map(signature);
    this.database.setSetting(key, state);
  }
}
