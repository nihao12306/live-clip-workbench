import { afterEach, describe, expect, it, vi } from 'vitest';
import { identifyTextSource, TextSources } from '../src/main/text-sources';
import { TextWorkbench } from '../src/main/text-workbench';

// These tests isolate caching, editing and learning. Real quality decisions and
// the no-edit-on-rejection pipeline are covered in text-quality-gate.test.ts.
vi.mock('../src/main/text-quality-gate', () => ({ qualityPrompt: 'isolated-quality-policy', screenTextCandidates: async (candidates: unknown[]) =>
  ({ candidates, decisions: [], reviewed: candidates.length, extraReview: false }) }));

const tingwu = 'https://tingwu.aliyun.com/doc/transcripts/';
const minutes = 'https://team.feishu.cn/minutes/obcnTest';
const qianwen = 'https://www.qianwen.com/share/record-test';
const srt = '1\n00:00:05,000 --> 00:00:08,500\n这个条件要先看。再解释一下。\n\n2\n00:00:11,000 --> 00:00:19,000\n如果跨专业，口径是不一样的。';

afterEach(() => vi.unstubAllGlobals());

describe('回放逐字稿', () => {
  it('取妙记带时间码原文，不下载媒体，不为句子编造时间', async () => {
    const readMinutesTranscript = vi.fn(async () => srt);
    const source = new TextSources({ readTranscript: vi.fn() }, { readMinutesTranscript }, async () => undefined);
    await expect(source.readTranscript(minutes)).resolves.toEqual({
      cues: true,
      parts: [
        { startMs: 5000, endMs: 8500, text: '这个条件要先看。再解释一下。' },
        { startMs: 11000, endMs: 19000, text: '如果跨专业，口径是不一样的。' },
      ],
    });
    expect(readMinutesTranscript).toHaveBeenCalledWith('obcnTest', 'srt', expect.any(AbortSignal));
    readMinutesTranscript.mockResolvedValueOnce('只有一篇摘要，没有时间码。');
    await expect(source.readTranscript(minutes)).rejects.toThrow('带起止时间');
  });

  it('读千问链接跳转的听悟记录，或分享页面公开的字幕；不把摘要当原话', async () => {
    const original = [{ startMs: 0, endMs: 7000, text: '这里有完整原话。' }];
    const readTranscript = vi.fn(async () => original);
    const source = new TextSources({ readTranscript }, { readMinutesTranscript: vi.fn() }, async () => undefined);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: new URL(`${tingwu}example#标题`).href } }))
      .mockResolvedValueOnce(new Response('<script>{"transcriptUrl":"https://example.oss-cn-hangzhou.aliyuncs.com/record.srt"}</script>'))
      .mockResolvedValueOnce(new Response(srt)).mockResolvedValueOnce(new Response('<h1>AI 生成的纪要</h1>'));
    vi.stubGlobal('fetch', fetcher);
    await expect(source.readTranscript(qianwen)).resolves.toEqual({ cues: false, parts: original });
    expect(readTranscript).toHaveBeenCalledWith(`${tingwu}example`);
    await expect(source.readTranscript(qianwen)).resolves.toMatchObject({ cues: true, parts: [{ startMs: 5000 }, { startMs: 11000 }] });
    await expect(source.readTranscript(qianwen)).rejects.toThrow('未提供可读取');
    expect(() => identifyTextSource('https://www.qianwen.com.example.org/share/record-test')).toThrow();
    expect(() => identifyTextSource('https://team.feishu.cn/wiki/something')).toThrow();
  });
});

describe('场次历史', () => {
  it('persists acquired transcripts before analysis succeeds and reuses them after restart and for the same link', async () => {
    const state = new Map<string, unknown>();
    const database = { getSetting: <T>(key: string, fallback: T) => (structuredClone(state.get(key)) as T | undefined) ?? fallback,
      setSetting: (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
    const source = { identify: identifyTextSource, readTranscript: vi.fn(async () => ({
      cues: true, parts: [{ startMs: 1000, endMs: 5000, text: '先看报考条件。' }],
    })) };
    const brokenModel = { textSelection: vi.fn(async () => { throw new Error('模型暂时连接失败'); }) };
    const app = new TextWorkbench(database, source, brokenModel);
    const [job] = app.start([{ url: `${tingwu}cached?sl=1` }]);
    await vi.waitFor(() => expect(app.list().find(item => item.id === job.id)?.status).toBe('failed'));
    expect(source.readTranscript).toHaveBeenCalledTimes(1);
    const model = { textSelection: vi.fn(async () => ({ candidates: [] })) };
    const restart = new TextWorkbench(database, source, model);
    expect(restart.list().find(item => item.id === job.id)?.transcriptCount).toBe(1);
    restart.retry(job.id);
    await vi.waitFor(() => expect(restart.list().find(item => item.id === job.id)?.status).toBe('ready'));
    const [next] = restart.start([{ url: `${tingwu}cached?sl=1#标题` }]);
    await vi.waitFor(() => expect(restart.list().find(item => item.id === next.id)?.status).toBe('ready'));
    expect(source.readTranscript).toHaveBeenCalledTimes(1);
    expect(next.transcriptSavedAt).toBeTruthy();
  });

  it('并行三个场次，保留各自记录和完整转写；一次失败不影响另外两场，并可脱离原链接补选', async () => {
    const state = new Map<string, unknown>();
    const database = { getSetting: <T>(key: string, fallback: T) => (structuredClone(state.get(key)) as T | undefined) ?? fallback,
      setSetting: (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
    const source = {
      identify: identifyTextSource,
      readTranscript: vi.fn(async (url: string) => {
        if (url === minutes) throw new Error('未授权');
        return { cues: true, parts: [{ startMs: 1000, endMs: 5000, text: '先看条件。' },
          { startMs: 5000, endMs: 9000, text: '跨专业的口径不一样。' }] };
      }),
    };
    const model = { textSelection: vi.fn().mockResolvedValue({ candidates: [] }) };
    const app = new TextWorkbench(database, source, model);
    expect(() => app.start([{ url: `${tingwu}one` }, { url: `${tingwu}one#标题` }])).toThrow('重复');
    expect(app.list()).toEqual([]);
    const original = `${tingwu}one?sl=1#原回放`;
    const jobs = app.start([{ url: original, name: '10月14号示例讲师丁直播回放链接' }, { url: minutes, name: '妙记回放' }, { url: qianwen }]);
    expect(source.readTranscript).toHaveBeenCalledTimes(3);
    expect(() => app.start([{ url: `${tingwu}four` }])).toThrow('最多同时处理');
    await vi.waitFor(() => expect(app.list().map(job => job.status)).not.toContain('running'));
    expect(app.list().filter(job => job.status === 'ready')).toHaveLength(2);
    expect(app.list().find(job => job.id === jobs[1].id)?.message).toBe('未授权');
    const restart = new TextWorkbench(database, source, model);
    expect(restart.list().find(job => job.id === jobs[1].id)?.status).toBe('failed');
    const retry = restart.retry(jobs[1].id);
    expect(retry).toMatchObject({ id: jobs[1].id, name: '妙记回放', originalUrl: minutes });
    await vi.waitFor(() => expect(restart.list().find(job => job.id === retry.id)?.status).toBe('failed'));
    restart.dismiss(retry.id);
    expect(restart.list()).toHaveLength(2);
    expect(restart.list().find(job => job.id === jobs[0].id)).toMatchObject({
      url: `${tingwu}one?sl=1`, originalUrl: original, name: '10月14号示例讲师丁直播回放链接',
    });
    restart.rename(jobs[0].id, '示例讲师丁直播回放');
    expect(await restart.transcript(jobs[0].id)).toHaveLength(2);
    expect(source.readTranscript).toHaveBeenCalledTimes(4);
    model.textSelection.mockResolvedValueOnce({ candidates: [{ name: '跨专业', startId: 'S1', endId: 'S2', topicValue: '了解条件', completeness: '讲清条件' }] })
      .mockResolvedValueOnce({ titles: [{ text: '跨专业先看什么' }], hooks: [{ id: 'S1' }], selectedHook: 0, body: [{ id: 'S2' }] });
    const added = await restart.supplement(jobs[0].id, 1000, 9000);
    restart.recordDelivery(jobs[0].id, added.id, '示例讲师丙', added, { documentId: 'docA' });
    expect(restart.list().find(job => job.id === jobs[0].id)).toMatchObject({
      clips: [added], transcriptCount: 2, teacher: '示例讲师丙', name: '示例讲师丁直播回放', deliveries: [{ documentId: 'docA', clipId: added.id }],
    });
  });

  it('筛选缺字段时只重试模型，成功导出的改法要跨回放重复才进入下一次选稿', async () => {
    const state = new Map<string, unknown>();
    const database = { getSetting: <T>(key: string, fallback: T) => (structuredClone(state.get(key)) as T | undefined) ?? fallback,
      setSetting: (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
    const source = {
      identify: identifyTextSource,
      readTranscript: vi.fn(async () => ({ cues: true, parts: [
        { startMs: 1000, endMs: 5000, text: '家长朋友们，跨专业先看报考条件。' },
        { startMs: 5000, endMs: 9000, text: '不同学校的要求不一样。' },
      ] })),
    };
    const candidate = { name: '跨专业报考', startId: 'S1', endId: 'S2', topicValue: '家长想了解门槛', completeness: '原话说明了条件' };
    const model = { textSelection: vi.fn(async (prompt: string, _input: unknown, operation: string): Promise<unknown> => prompt.startsWith('你是直播短视频选题编辑') || prompt.includes('请修复上一份输出')
      ? { candidates: [candidate] } : { titles: [{ text: '跨专业报考先看条件' }], hooks: [{ id: 'S1' }], selectedHook: 0, body: [{ id: 'S2' }] }) };
    model.textSelection.mockResolvedValueOnce({ candidates: [{ ...candidate, completeness: undefined }] });
    const app = new TextWorkbench(database, source, model);
    async function complete(suffix: string, teacher?: string) {
      const [job] = app.start([{ url: `${tingwu}${suffix}`, name: '示例讲师丙直播', teacher }]);
      await vi.waitFor(() => expect(app.list().find(item => item.id === job.id)?.status).toBe('ready'));
      return app.list().find(item => item.id === job.id)!;
    }
    const one = await complete('learning-one', '示例讲师丙');
    expect(source.readTranscript).toHaveBeenCalledTimes(1);
    expect(model.textSelection.mock.calls[1][0]).toContain('completeness');
    expect(model.textSelection.mock.calls[1][2]).toBe('analysis');
    expect(model.textSelection.mock.calls[1][1]).toMatchObject({ previousOutput: { candidates: [expect.any(Object)] } });
    function edit(job: typeof one) {
      const clip = job.clips[0];
      return app.save(job.id, clip.id, { ...clip, hook: { id: 'S1', ranges: [[6, clip.units[0].text.length]] } });
    }
    const editedOne = edit(one);
    expect(app.learningSummary().replays).toBe(0);
    app.recordDelivery(one.id, editedOne.id, '示例讲师丙', editedOne, { documentId: 'one' });
    app.recordDelivery(one.id, editedOne.id, '示例讲师丙', editedOne, { documentId: 'one-again' });
    expect(app.learningSummary().teachers).toMatchObject([{ teacher: '示例讲师丙', replays: 1, rules: [] }]);
    const two = await complete('learning-two', '示例讲师丙');
    const editedTwo = edit(two);
    app.recordDelivery(two.id, editedTwo.id, '示例讲师丙', editedTwo, { documentId: 'two' });
    expect(app.learningSummary().general.rules).toEqual([]);
    expect(app.learningSummary().teachers[0].rules.join('')).toContain('删去点题前的寒暄');
    await complete('learning-three', '示例讲师丙');
    expect(model.textSelection.mock.calls.at(-1)?.[1]).toMatchObject({ editorialLearning: {
      generalRules: [],
      teacherExperience: { teacher: '示例讲师丙', rules: expect.arrayContaining([expect.stringContaining('寒暄')]),
        examples: expect.arrayContaining([expect.objectContaining({
        hook: { before: '家长朋友们，跨专业先看报考条件。', after: '跨专业先看报考条件。' },
      })]) },
    } });
    await complete('learning-unassigned');
    expect(model.textSelection.mock.calls.at(-1)?.[1]).toMatchObject({ editorialLearning: undefined });
    const other = await complete('learning-other', '示例讲师丁');
    expect(model.textSelection.mock.calls.at(-1)?.[1]).toMatchObject({ editorialLearning: undefined });
    const editedOther = edit(other);
    app.recordDelivery(other.id, editedOther.id, '示例讲师丁', editedOther, { documentId: 'other' });
    expect(app.learningSummary().general).toMatchObject({
      teachers: 2, replays: 3, rules: expect.arrayContaining([expect.stringContaining('寒暄')]),
    });
    await complete('learning-other-followup', '示例讲师丁');
    expect(model.textSelection.mock.calls.at(-1)?.[1]).toMatchObject({ editorialLearning: {
      generalRules: expect.arrayContaining([expect.stringContaining('寒暄')]), teacherExperience: undefined,
    } });
  });
});

describe('候选数量按内容决定', () => {
  it.each([10, 65])('保留 %i 分钟回放中超过四个合格话题，分段扫描也不限制两条', async (minutes) => {
    const state = new Map<string, unknown>();
    const database = { getSetting: <T>(key: string, fallback: T) => structuredClone(state.get(key)) as T ?? fallback,
      setSetting: (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
    const parts = Array.from({ length: 14 }, (_, i) => ({ startMs: i * 2000, endMs: (i + 1) * 2000, text: '第' + i + '段独立话题原文。' }));
    parts.push({ startMs: minutes * 60000 - 1000, endMs: minutes * 60000, text: '直播结束。' });
    const candidates = Array.from({ length: 6 }, (_, i) => ({ name: '话题' + i, startId: 'S' + (i * 2 + 1), endId: 'S' + (i * 2 + 2), topicValue: '独立问题有观看价值', completeness: '条件、理由和结论完整' }));
    const source = { identify: identifyTextSource, readTranscript: vi.fn(async () => ({ cues: true, parts })) };
    const model = { textSelection: vi.fn(async (prompt: string, input: any): Promise<unknown> => {
      if (prompt.startsWith('终筛')) return { selected: [1, 2, 3, 4, 5, 6] };
      if (prompt.startsWith('你是直播短视频选题编辑')) return { candidates: (input.units ?? input).some((u: any) => u.id === 'S1') ? candidates : [] };
      return { titles: [{ text: input.candidate.name }], hooks: [{ id: input.units[0].id }], selectedHook: 0, body: [{ id: input.units[1].id }] };
    }) };
    const app = new TextWorkbench(database, source, model);
    const [job] = app.start([{ url: tingwu + 'unlimited-' + minutes }]);
    await vi.waitFor(() => expect(app.list()[0].status).toBe('ready'));
    expect(app.list()[0].clips).toHaveLength(6);
    expect(app.list()[0].id).toBe(job.id);
    expect(model.textSelection.mock.calls.map(call => call[0]).join('')).not.toMatch(/最多[24]条|最多选/);
  });
});

it('23个通过候选只为最终择优的6个生成文字稿', async () => {
  const state = new Map<string, unknown>();
  const database = { getSetting: <T>(k: string, fallback: T) => structuredClone(state.get(k)) as T ?? fallback,
    setSetting: (k: string, v: unknown) => { state.set(k, structuredClone(v)); } };
  const parts = Array.from({ length: 46 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, text: '第' + i + '段原文。' }));
  const candidates = Array.from({ length: 23 }, (_, i) => ({ name: '话题' + (i + 1), startId: 'S' + (i * 2 + 1), endId: 'S' + (i * 2 + 2), topicValue: '独立观看价值', completeness: '原文完整' }));
  const source = { identify: identifyTextSource, readTranscript: vi.fn(async () => ({ parts, cues: true })) };
  const generated: string[] = [];
  const model = { textSelection: vi.fn(async (prompt: string, input: any, operation: string, effort?: string) => {
    if (prompt.startsWith('你是直播短视频选题编辑')) return { candidates };
    if (prompt.startsWith('你负责最终文字选稿')) {
      expect(generated).toHaveLength(0);
      expect(operation).toBe('analysis'); expect(effort).toBe('high');
      return { selected: [23, 21, 14, 7, 5, 2] };
    }
    generated.push(input.candidate.name);
    return { titles: [{ text: input.candidate.name }], hooks: [{ id: input.units[0].id }], selectedHook: 0, body: [{ id: input.units[1].id }] };
  }) };
  const app = new TextWorkbench(database, source, model);
  const [job] = app.start([{ url: tingwu + 'twenty-three-to-six' }]);
  await vi.waitFor(() => expect(app.list()[0].status).toBe('ready'));
  expect(generated).toEqual(['话题23', '话题21', '话题14', '话题7', '话题5', '话题2']);
  expect(app.list()[0].clips).toHaveLength(6);
  await expect(app.supplement(job.id, 0, 2000)).rejects.toThrow('最多6条');
});
