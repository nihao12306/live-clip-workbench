import { describe, expect, it, vi } from 'vitest';
import { blockText, FormattedTextExporter, planCut } from '../src/main/text-feishu-format';
import type { FeishuDocumentBlock, FeishuTextBlock } from '../src/main/feishu-drive';
import type { TextClip, TextJob } from '../src/shared/text-selection';

describe('formatted Feishu delivery', () => {
  it('places a new date according to the document existing date order', () => {
    const blocks: FeishuDocumentBlock[] = ['10.30', '10.28', '9.8'].map((content, i) => ({
      block_id: String(i), block_type: 3, heading1: { elements: [{ text_run: { content } }] },
    }));
    expect(planCut(blocks, '11.7')).toMatchObject({ index: 0, addDate: true, number: 1 });
    expect(planCut(blocks, '10.29')).toMatchObject({ index: 1, addDate: true });
    expect(planCut([...blocks].reverse(), '11.7')).toMatchObject({ index: 3, addDate: true });
  });
  it('appends to an existing day, continues numbering, reuses the same cut and preserves a claim name on sync', async () => {
    const rows = new Map<string, unknown>();
    const database = { getSetting: <T>(key: string, fallback: T) => structuredClone(rows.get(key) ?? fallback) as T,
      setSetting: (key: string, value: unknown) => { rows.set(key, structuredClone(value)); } };
    const elements = (content: string) => [{ text_run: { content } }];
    let blocks: FeishuDocumentBlock[] = [
      { block_id: 'date', block_type: 3, heading1: { elements: elements('10.30') } },
      { block_id: 'old', block_type: 4, heading2: { elements: elements('切片6：旧标题（剪辑申领）') } },
    ];
    let count = 0;
    let interrupt = true;
    const accepted = new Map<string, string[]>();
    const client = {
      createTextDocument: vi.fn(),
      resolveTextDocument: vi.fn(async () => ({ documentId: 'document', url: 'https://test.feishu.cn/wiki/wikiA' })),
      textDocumentChildren: vi.fn(async () => structuredClone(blocks)),
      insertTextDocumentBlocks: vi.fn(async (_doc, children: FeishuTextBlock[], token: string, index: number) => {
        if (accepted.has(token)) return accepted.get(token)!;
        const added = children.map(block => ({ ...structuredClone(block), block_id: 'new' + (++count) }));
        blocks.splice(index, 0, ...added);
        const ids = added.map(block => block.block_id);
        accepted.set(token, ids);
        if (interrupt) { interrupt = false; throw new Error('写入后连接中断'); }
        return ids;
      }),
      updateTextDocumentBlocks: vi.fn(async (_doc, updates: Array<{ id: string; block: FeishuTextBlock }>) => {
        for (const update of updates) blocks[blocks.findIndex(block => block.block_id === update.id)] = { ...update.block, block_id: update.id };
      }),
      textDocumentUrl: vi.fn(),
    };
    const exporter = new FormattedTextExporter(database, client);
    const job: TextJob = { id: 'job', url: 'https://tingwu.aliyun.com/doc/transcripts/source?sl=1',
      originalUrl: 'https://tingwu.aliyun.com/doc/transcripts/source?sl=1#原文', createdAt: '2026-10-29T16:30:00Z',
      status: 'ready', message: '', clips: [] };
    const clip: TextClip = { id: 'clip', title: '跨专业先看条件', name: '跨专业', topicValue: '', completeness: '',
      titles: [], hooks: [], notes: [], repeatHook: false, hook: { id: 'S1', ranges: [[0, 5]] },
      body: [{ id: 'S2', ranges: [[0, 5]] }],
      units: [{ id: 'S1', text: '先看报考条件。', startMs: 1000, endMs: 5000 },
        { id: 'S2', text: '各校不一样。对吧', startMs: 5000, endMs: 10000 }] };
    const target = 'https://test.feishu.cn/wiki/wikiA';
    await expect(exporter.export(job, clip, target, '示例讲师乙')).rejects.toThrow('写入后连接中断');
    const first = await exporter.export(job, clip, target, '示例讲师乙');
    expect(first).toMatchObject({ cutNumber: 7, importDate: '2026-10-30', formatVersion: 2 });
    expect(blocks.filter(block => block.block_type === 3)).toHaveLength(1);
    expect(blockText(blocks[2])).toBe('切片7：跨专业先看条件');
    expect(blockText(blocks[3])).toBe('回放链接：' + job.originalUrl);
    expect(blockText(blocks[4])).toBe('00:01-00:10');
    await exporter.export(job, clip, target, '示例讲师乙');
    expect(client.insertTextDocumentBlocks).toHaveBeenCalledTimes(2);
    const heading = blocks[2];
    if (heading.block_type === 4) heading.heading2.elements[0].text_run.content += '（张三）';
    await exporter.sync(job, { ...clip, title: '新标题' }, first.documentId);
    expect(blockText(blocks[2])).toBe('切片7：新标题（张三）');
    const currentHeading = blocks[2];
    if (currentHeading.block_type === 4) currentHeading.heading2.elements[0].text_run.content = '切片7：新标题（李四）';
    await exporter.sync(job, { ...clip, title: '再改标题' }, first.documentId);
    expect(blockText(blocks[2])).toBe('切片7：再改标题（李四）');
    const second = await exporter.export(job, { ...clip, id: 'next' }, target, '示例讲师乙');
    expect(second.cutNumber).toBe(8);
    expect(exporter.destinations()).toEqual({ 示例讲师乙: target });
    expect(client.createTextDocument).not.toHaveBeenCalled();
  });
});
