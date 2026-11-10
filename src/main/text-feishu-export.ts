import { createHash, randomUUID } from 'node:crypto';
import { clipTime, movedTextIds, originalMarks, originalTextSource, readingOrder, textOf } from '../shared/text-selection';
import type { TextClip, TextDelivery, TextJob, TextPick } from '../shared/text-selection';
import type { TextFeishuExport } from '../shared/types';
import type { DatabaseService } from './database';
import { extractFeishuFolderToken } from './feishu-drive';
import type { FeishuDriveService, FeishuTextBlock, FeishuTextStyle } from './feishu-drive';
import { FormattedTextExporter } from './text-feishu-format';

const colors = { green: 4, purple: 6, yellow: 3 };
const batchSize = 40;

function run(content: string, text_element_style?: FeishuTextStyle) {
  return { text_run: { content, ...(text_element_style ? { text_element_style } : {}) } };
}

function paragraph(...elements: ReturnType<typeof run>[]): FeishuTextBlock {
  return { block_type: 2, text: { elements } };
}

function heading(content: string): FeishuTextBlock {
  return { block_type: 4, heading2: { elements: [run(content)] } };
}

export function buildTextDocumentBlocks(job: TextJob, clip: TextClip, teacher?: string): FeishuTextBlock[] {
  const sequence = readingOrder(clip);
  if (!sequence.length) throw new Error('请先选好开头或正文');
  const moved = movedTextIds(clip);
  const byId = new Map(clip.units.map(unit => [unit.id, unit]));
  const sourceIndex = new Map(clip.units.map((unit, index) => [unit.id, index]));
  const ranges: Array<{ startMs: number; endMs: number; last: string; text: string }> = [];
  for (const part of sequence) {
    const unit = byId.get(part.id)!;
    const previous = ranges.at(-1);
    if (previous && sourceIndex.get(unit.id) === sourceIndex.get(previous.last)! + 1 && unit.startMs - previous.endMs <= 2500) {
      previous.endMs = Math.max(previous.endMs, unit.endMs);
      previous.last = unit.id;
      previous.text += part.text;
    } else {
      ranges.push({ startMs: unit.startMs, endMs: unit.endMs, last: unit.id, text: part.text });
    }
  }
  const movedAfter = new Map<string, TextPick[]>();
  let anchor = '';
  for (const pick of clip.body) {
    if (moved.has(pick.id)) movedAfter.set(anchor, [...(movedAfter.get(anchor) ?? []), pick]);
    else anchor = pick.id;
  }
  const insertions = (id: string) => (movedAfter.get(id) ?? []).map(pick => {
    const unit = byId.get(pick.id)!;
    return paragraph(run(textOf(unit, pick), { background_color: colors.yellow }),
      run(`（移入 · 来源 ${clipTime(unit.startMs)}–${clipTime(unit.endMs, true)}）`));
  });
  const original = clip.units.flatMap(unit => {
    const elements = originalMarks(unit, clip, moved).map(mark => {
      const style: FeishuTextStyle = {};
      for (const color of ['green', 'purple', 'yellow'] as const) {
        if (mark.className.includes(`text-${color}`)) style.background_color = colors[color];
      }
      if (mark.className.includes('text-underline')) style.underline = true;
      return run(mark.text, Object.keys(style).length ? style : undefined);
    });
    return [paragraph(...elements), ...insertions(unit.id)];
  });
  const time = `${clipTime(clip.units[0].startMs)}–${clipTime(clip.units.at(-1)!.endMs, true)}`;
  const source = originalTextSource(job);
  const sourceLink = { link: { url: encodeURIComponent(source) } };
  return [
    ...(teacher ? [paragraph(run(`直播老师：${teacher}`))] : []),
    paragraph(run(`原直播 ${time} · `), run(job.name || '打开原回放', sourceLink)),
    paragraph(run('原始回放链接：'), run(source, sourceLink)),
    paragraph(run('绿色为开头，绿色加下划线表示原位置也保留。紫色为保留正文，黄色加下划线为移出，黄色为移入。无高亮为不选用。')),
    heading('原文标注'), ...insertions(''), ...original,
    heading('通读拟剪稿'), ...ranges.flatMap(part => [
      paragraph(run(`${clipTime(part.startMs)}–${clipTime(part.endMs, true)}`)), paragraph(run(part.text)),
    ]),
    ...(clip.review ? [heading('衔接复核'), paragraph(run(clip.review.summary)), ...clip.review.issues.map(issue =>
      paragraph(run(`第 ${issue.from}–${issue.to} 段 · ${issue.why} ${issue.suggestion}`)))] : []),
    ...(clip.notes.length ? [heading('转写备注'), ...clip.notes.map(note => paragraph(run(note)))] : []),
  ];
}

type ExportCheckpoint = TextFeishuExport & { written: number; pendingToken?: string };
type SyncCheckpoint = { revision: string; written: number; label: string; pendingToken?: string };
function revisionOf(blocks: FeishuTextBlock[]) {
  return createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
}

export class LegacyTextFeishuExporter {
  private readonly active = new Set<string>();
  private readonly syncing = new Map<string, Promise<void>>();

  constructor(private readonly database: Pick<DatabaseService, 'getSetting' | 'setSetting'>,
    private readonly feishu: Pick<FeishuDriveService, 'createTextDocument' | 'appendTextDocumentBlocks' | 'textDocumentUrl'>) {}

  async export(job: TextJob, clip: TextClip, folder: string, teacherInput: string): Promise<TextFeishuExport> {
    const teacher = teacherInput.trim();
    if (!teacher || teacher.length > 40 || /[\r\n\t]/.test(teacher)) throw new Error('请填写 1 到 40 字的直播老师姓名');
    const folderToken = extractFeishuFolderToken(folder);
    const title = `${teacher}｜${clip.title}`;
    const blocks = buildTextDocumentBlocks(job, clip, teacher);
    const signature = createHash('sha256').update(JSON.stringify([folderToken, title, blocks])).digest('hex');
    const key = `text-feishu-export:${clip.id}:${signature}`;
    if (this.active.has(clip.id)) throw new Error('这条稿件正在导出，请稍候');
    this.active.add(clip.id);
    let checkpoint = this.database.getSetting<ExportCheckpoint | undefined>(key, undefined);
    try {
      if (!checkpoint) {
        const documentId = await this.feishu.createTextDocument(title, folderToken);
        checkpoint = { documentId, written: 0 };
        this.database.setSetting(key, checkpoint);
      }
      while (checkpoint.written < blocks.length) {
        checkpoint.pendingToken ??= randomUUID();
        this.database.setSetting(key, checkpoint);
        const batch = blocks.slice(checkpoint.written, checkpoint.written + batchSize);
        await this.feishu.appendTextDocumentBlocks(checkpoint.documentId, batch, checkpoint.pendingToken);
        checkpoint.written += batch.length;
        delete checkpoint.pendingToken;
        this.database.setSetting(key, checkpoint);
      }
      if (!checkpoint.url) {
        checkpoint.url = await this.feishu.textDocumentUrl(checkpoint.documentId).catch(() => undefined);
        if (checkpoint.url) this.database.setSetting(key, checkpoint);
      }
      const currentKey = `text-feishu-current:${checkpoint.documentId}`;
      if (!this.database.getSetting(currentKey, '')) this.database.setSetting(currentKey, revisionOf([heading(clip.title), ...blocks]));
      return { documentId: checkpoint.documentId, url: checkpoint.url };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const permission = /99991679|docx:document|scope/i.test(detail)
        ? '请在飞书开放平台开通「创建新版文档」和「编辑新版文档」权限并发布，然后点「授权飞书文档」。' : '';
      const resume = checkpoint ? `飞书文档已创建（${checkpoint.documentId}），稿件和目标文件夹保持原样再次导出可继续写入。` : '';
      throw new Error([detail, permission, resume].filter(Boolean).join(' '));
    } finally {
      this.active.delete(clip.id);
    }
  }

  sync(job: TextJob, clip: TextClip, delivery: TextDelivery): Promise<void> {
    const documentId = delivery.documentId;
    const work = (this.syncing.get(documentId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const blocks = [heading(clip.title), ...buildTextDocumentBlocks(job, clip, delivery.teacher)];
      const revision = revisionOf(blocks);
      const currentKey = `text-feishu-current:${documentId}`;
      if (this.database.getSetting(currentKey, '') === revision) return;
      const key = `text-feishu-sync:${documentId}`;
      let state = this.database.getSetting<SyncCheckpoint | null>(key, null);
      if (state?.revision !== revision) state = { revision, written: 0, label: new Date().toLocaleString('zh-CN') };
      // New versions go at the top. Earlier versions and manual Feishu annotations stay in place.
      blocks.unshift(heading('工作台同步稿 · ' + state.label));
      while (state.written < blocks.length) {
        state.pendingToken ??= randomUUID();
        this.database.setSetting(key, state);
        await this.feishu.appendTextDocumentBlocks(documentId, blocks.slice(state.written, state.written + batchSize), state.pendingToken, state.written);
        state.written = Math.min(state.written + batchSize, blocks.length);
        delete state.pendingToken;
        this.database.setSetting(key, state);
      }
      this.database.setSetting(currentKey, revision);
      this.database.setSetting(key, null);
    }).finally(() => { if (this.syncing.get(documentId) === work) this.syncing.delete(documentId); });
    this.syncing.set(documentId, work);
    return work;
  }
}

export class TextFeishuExporter {
  private readonly formatted: FormattedTextExporter;
  private readonly legacy: LegacyTextFeishuExporter;
  constructor(database: Pick<DatabaseService, 'getSetting' | 'setSetting'>, feishu: FeishuDriveService) {
    this.formatted = new FormattedTextExporter(database, feishu);
    this.legacy = new LegacyTextFeishuExporter(database, feishu);
  }
  destinations() { return this.formatted.destinations(); }
  async export(job: TextJob, clip: TextClip, target: string, teacher: string) {
    try { return await this.formatted.export(job, clip, target, teacher); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/99991679|wiki:wiki|docx:document:readonly/.test(message)) {
        throw new Error('飞书尚未授权读取或编辑这份交付文档。请点「授权飞书文档」补充授权；如果飞书提示应用未开通权限，需要在开放平台开通知识库读取和新版文档读取、编辑权限并发布。');
      }
      throw error;
    }
  }
  sync(job: TextJob, clip: TextClip, delivery: TextDelivery) {
    return delivery.formatVersion === 2 ? this.formatted.sync(job, clip, delivery.documentId) : this.legacy.sync(job, clip, delivery);
  }
}
