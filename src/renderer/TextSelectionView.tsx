import { useEffect, useRef, useState } from 'react';
import { clipTime, editRanges, movedTextIds, originalMarks, readingOrder, textOf, textSourceLabels, topicVerdictLabels } from '../shared/text-selection';
import type { TextClip, TextEdit, TextJob, TextJobInput, TextLearningSummary, TextPick, TextRange, TextUnit, TextTopicVerdict } from '../shared/text-selection';
import { compareTextBody, finalVersionMatches } from '../shared/text-behavior';
import { originalTextSource } from '../shared/text-selection';
import type { TextFeishuExport } from '../shared/types';

function changeBody(clip: TextClip, id: string, ranges: TextRange[]): TextPick[] {
  const index = clip.body.findIndex(pick => pick.id === id);
  if (index >= 0) return clip.body.flatMap(pick => pick.id !== id ? [pick] : ranges.length ? [{ id, ranges }] : []);
  if (!ranges.length) return clip.body;
  const sourceIndex = clip.units.findIndex(unit => unit.id === id);
  const body = [...clip.body];
  const next = body.findIndex(pick => clip.units.findIndex(unit => unit.id === pick.id) > sourceIndex);
  body.splice(next < 0 ? body.length : next, 0, { id, ranges });
  return body;
}

function selectionIn(paragraph: HTMLElement): TextRange | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!paragraph.contains(range.startContainer) || !paragraph.contains(range.endContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(paragraph);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  return [start, start + range.toString().length];
}

function inputTime(value: string) {
  if (!/^(?:\d+:)?[0-5]?\d:[0-5]\d$/.test(value.trim())) throw new Error('请按 分:秒 或 时:分:秒 输入时间');
  return value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}

function sourceLabel(job: TextJob) { return textSourceLabels[job.source ?? 'tingwu']; }

function pastedLink(line: string): TextJobInput {
  const markdown = line.match(/^\[([^\]]+)\]\((https:\/\/[^\s]+)\)$/i);
  if (markdown) return { name: markdown[1], url: markdown[2] };
  const named = line.match(/^(.+?)\s*(?:[｜|]\s*|\s+)(https:\/\/[^\s]+)$/i);
  return named ? { name: named[1], url: named[2] } : { url: line };
}

export function TextSelectionView({ active, accounts = [] }: { active: boolean; accounts?: import('../shared/types').AccountProfile[] }) {
  const [jobs, setJobs] = useState<TextJob[]>([]);
  const [learning, setLearning] = useState<TextLearningSummary>();
  const [url, setUrl] = useState('');
  const [linkNames, setLinkNames] = useState<Record<string, string>>({});
  const [linkTeachers, setLinkTeachers] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState<string | null>(null);
  const [topicReason, setTopicReason] = useState('');
  const [topicDisposition, setTopicDisposition] = useState<TextTopicVerdict>('deferred');
  const [finalNote, setFinalNote] = useState('');
  const [newTeacher, setNewTeacher] = useState('');
  const [jobId, setJobId] = useState('');
  const [clipId, setClipId] = useState('');
  const [draft, setDraft] = useState<TextClip | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [exported, setExported] = useState<TextFeishuExport | null>(null);
  const [feishuFolder, setFeishuFolder] = useState('');
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [feishuMessage, setFeishuMessage] = useState('');
  const [teacher, setTeacher] = useState('');
  const exportDialog = useRef<HTMLDialogElement>(null);
  const [historyQuery, setHistoryQuery] = useState('');
  const [transcript, setTranscript] = useState<TextUnit[] | null>(null);
  const [textQuery, setTextQuery] = useState('');
  const [textPage, setTextPage] = useState(0);
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [selection, setSelection] = useState<{ id: string; range: TextRange } | null>(null);
  const job = jobs.find(item => item.id === jobId) ?? jobs[0];
  const saved = job?.clips.find(item => item.id === clipId) ?? job?.clips[0];
  const clip = draft?.id === saved?.id ? draft : saved;
  const delivery = job?.deliveries?.find(item => item.clipId === clip?.id);
  useEffect(() => { setTopicReason(''); setTopicDisposition('deferred'); setFinalNote(''); }, [clip?.id]);
  const comparison = clip?.initialEdit ? compareTextBody(clip, clip.initialEdit, clip) : undefined;

  useEffect(() => {
    if (!active) return;
    let current = true;
    const refresh = async () => {
      try {
        const latest = await window.workbench.listTextJobs();
        if (current) setJobs(latest);
      } catch (err) {
        if (current) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void refresh();
    void window.workbench.getTextLearningSummary().then(result => { if (current) setLearning(result); }).catch(() => {});
    void window.workbench.getTextExportDestinations().then(result => { if (current) setDestinations(result); }).catch(() => {});
    const timer = window.setInterval(() => void refresh(), 1600);
    return () => { current = false; window.clearInterval(timer); };
  }, [active]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  function chooseJob(id: string) {
    setJobId(id);
    setTopicReason('');
    setNewName(null);
    setClipId('');
    setDraft(null);
    setSelection(null);
    setExported(null);
    setTranscript(null);
    setTextPage(0);
    setTextQuery('');
    setStartAt('');
    setEndAt('');
  }

  function addJobs(next: TextJob[]) {
    setJobs(previous => [...next, ...previous.filter(item => !next.some(added =>
      added.id === item.id || item.status === 'failed' && added.url === item.url))]);
    chooseJob(next[0].id);
  }

  async function start(sources: TextJobInput[]) {
    addJobs(await window.workbench.startTextJobs(sources));
    setUrl('');
    setLinkNames({});
    setLinkTeachers({});
  }

  function change(patch: Partial<TextEdit>) {
    if (!clip) return;
    setDraft({ ...clip, ...patch, review: undefined });
    setDirty(true);
    setExported(null);
  }

  function chooseHook(hook: TextPick) {
    if (!clip) return;
    const previous = clip.body.find(pick => pick.id === hook.id)?.ranges ?? [];
    const ranges = hook.ranges.reduce((current, range) => editRanges(current, range, false), previous);
    change({ hook, repeatHook: false, body: changeBody(clip, hook.id, ranges) });
  }

  function setRepeat(include: boolean) {
    if (!clip?.hook) return;
    const hook = clip.hook;
    const prior = clip.body.find(pick => pick.id === hook.id)?.ranges ?? [];
    const ranges = hook.ranges.reduce((current, range) => editRanges(current, range, include), prior);
    change({ repeatHook: include, body: changeBody(clip, hook.id, ranges) });
  }

  function mark(include: boolean) {
    if (!clip || !selection) return;
    const { id, range } = selection;
    const prior = clip.body.find(pick => pick.id === id)?.ranges ?? [];
    let ranges = editRanges(prior, range, include);
    let repeatHook = clip.repeatHook;
    if (clip.hook?.id === id) {
      if (repeatHook && !include && clip.hook.ranges.some(([a, b]) => a < range[1] && b > range[0])) repeatHook = false;
      if (!repeatHook) ranges = clip.hook.ranges.reduce((current, hookRange) => editRanges(current, hookRange, false), ranges);
    }
    change({ body: changeBody(clip, id, ranges), repeatHook });
    setSelection(null);
  }

  function updateSaved(next: TextClip) {
    setDraft(next);
    setDirty(false);
    setJobs(previous => previous.map(item => item.id === job?.id ? { ...item, clips: item.clips.map(c => c.id === next.id ? next : c) } : item));
  }

  async function save() {
    if (!job || !clip || !dirty) return;
    const { title, hook, repeatHook, body } = clip;
    updateSaved(await window.workbench.saveTextClip(job.id, clip.id, { title, hook, repeatHook, body }));
  }

  function move(index: number, offset: number) {
    if (!clip) return;
    const body = [...clip.body];
    const target = index + offset;
    if (target < 0 || target >= body.length) return;
    [body[index], body[target]] = [body[target], body[index]];
    change({ body });
  }

  const moved = clip ? movedTextIds(clip) : new Set<string>();
  const sequence = clip ? readingOrder(clip) : [];
  const running = jobs.filter(item => item.status === 'running').length;
  const links = url.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(pastedLink)
    .map(input => ({ ...input, name: linkNames[input.url] ?? input.name, teacher: linkTeachers[input.url] }));
  const teachers = [...new Set([
    ...(learning?.teachers.map(item => item.teacher) ?? []),
    ...accounts.map(account => account.name),
    ...jobs.flatMap(item => item.teacher ? [item.teacher] : []),
  ])];
  const recent = jobs.filter(item => item.status !== 'ready');
  const successful = jobs.filter(item => item.status === 'ready');
  const history = successful.filter(item => [item.name, sourceLabel(item), item.teacher, originalTextSource(item), new Date(item.createdAt).toLocaleDateString(),
    ...item.clips.flatMap(candidate => [candidate.name, candidate.title])].some(value => value?.toLowerCase().includes(historyQuery.trim().toLowerCase())));
  const filtered = (transcript ?? []).filter(unit => unit.text.includes(textQuery.trim()));
  const pageSize = 60;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const unitFor = (pick: TextPick) => clip!.units.find(unit => unit.id === pick.id)!;
  const label = (unit: TextUnit) => `${clipTime(unit.startMs)}–${clipTime(unit.endMs, true)}`;

  return <section className="text-workbench">
    <datalist id="text-replay-teachers">{teachers.map(name => <option key={name} value={name} />)}</datalist>
    <header className="page-header"><div><h1>文字选稿</h1><p>从整场原文中发现值得剪的话题，完成选稿、标注与通读。先严审话题价值与完整性，通过后才逐条编稿；每场最多生成6条，质量不足可少于6条，不凑数。</p></div></header>
    <form className="panel text-panel text-import" onSubmit={event => { event.preventDefault(); void perform(() => start(links)); }}>
      <div className="text-import-heading"><span className="text-eyebrow">开始选稿</span><h2>导入直播回放</h2><p>粘贴分享链接，先保存整场原文，再按内容规则筛选话题。</p></div>
      <textarea aria-label="回放分享链接" rows={3} placeholder="粘贴通义听悟、通义千问录音转写或飞书妙记链接，每行一条" value={url} onChange={event => setUrl(event.target.value)} />
      {links.length > 0 && links.length <= 3 && <div className="text-source-names">{links.map((input, i) => <div className="text-source-fields" key={i}><label>
        <span>回放 {i + 1} 名称</span><input aria-label={`回放 ${i + 1} 名称`} maxLength={100}
          placeholder="例如：10月14号毛老师直播回放链接" value={input.name ?? ''}
          onChange={event => setLinkNames(previous => ({ ...previous, [input.url]: event.target.value }))} />
      </label><label>
        <span>老师</span><input aria-label={`回放 ${i + 1} 老师`} list="text-replay-teachers" maxLength={40}
          placeholder="选填，填了会参考这位老师的经验" value={input.teacher ?? ''}
          onChange={event => setLinkTeachers(previous => ({ ...previous, [input.url]: event.target.value }))} />
      </label></div>)}</div>}
      <div className="text-import-actions"><button className="button primary" disabled={!links.length || links.length + running > 3 || busy || dirty}>生成文字候选</button>
        <p className="text-status">处理中 {running}/3{links.length + running > 3 ? ' · 超过并行上限' : ''}</p></div>
      <p className="text-status text-source-help">飞书妙记需要授权并允许导出逐字稿；千问链接须能取得带时间码的原文。</p>
    </form>
    {error && <p className="text-error" role="alert">{error}</p>}
    {recent.length > 0 && <section className="panel text-panel">
      <h2>本次处理</h2>
      <div className="text-history">{recent.map(item => <div className="text-pending-row" key={item.id}>
        <button type="button" aria-pressed={job?.id === item.id}
          className={`text-history-row ${job?.id === item.id ? 'selected' : ''}`} disabled={dirty || busy}
          onClick={() => { setError(''); chooseJob(item.id); }}>
          <span><b>{item.name || sourceLabel(item)}</b> · {item.status === 'running' ? '处理中' : `${item.failureStage ?? '处理'}失败`}</span>
          <small title={item.message}>{item.message}</small>
        </button>
        {item.status === 'failed' && <button className="button primary" disabled={running >= 3 || busy || dirty}
          onClick={() => void perform(async () => { addJobs([await window.workbench.retryTextJob(item.id)]); })}>重试</button>}
      </div>)}</div>
    </section>}
    {learning && <details className="panel text-panel">
      <summary>初步输出经验 · {learning.confirmedFinals ?? 0} 份确认定稿 · {learning.replays} 场修改记录</summary>
      <h2>通用经验</h2>
      <p className="text-status">{learning.general.teachers} 位老师 · {learning.general.replays} 场回放。相同改法出现在不同老师的不同回放中，才会成为通用经验。</p>
      {learning.general.rules.length ? <ul>{learning.general.rules.map(rule => <li key={rule}>{rule}</li>)}</ul>
        : <p className="text-status">暂无跨老师反复出现的改法。</p>}
      <h2>各老师的经验</h2>
      <p className="text-status">选择这位老师时，初选、复审和文字初稿会参考其经验。选题好坏请在下方明确反馈，不会把模型自评当作认可。</p>
      {learning.teachers.map(item => <details key={item.teacher} className="text-teacher-learning">
        <summary>{item.teacher} · {item.replays} 场导出改稿</summary>
        {item.rules.length > 0 && <ul>{item.rules.map(rule => <li key={rule}>{rule}</li>)}</ul>}
        {item.examples.map((example, index) => <div key={index} className="text-learning-example">
          <b>{example.topic}</b>
          {example.hook && <p>开头从「{example.hook.before}」改为「{example.hook.after}」</p>}
          {example.title && <p>标题从「{example.title.before}」改为「{example.title.after}」</p>}{example.body && <details><summary>已确认的完整正文前后对比</summary><h4>模型初稿</h4>{example.body.before.map((p, i) => <p key={i}>{p.text}</p>)}<h4>确认定稿</h4>{example.body.after.map((p, i) => <p key={i}>{p.text}</p>)}<p>{example.note}</p></details>}
        </div>)}
        {!item.rules.length && !item.examples.length && <p className="text-status">暂无在两场以上反复出现的专属改法。</p>}
      </details>)}
      {!learning.teachers.length && <p className="text-status">填写回放老师后可在这里查看各自的经验。若使用老师账号的规则与样片模式，请选择该账号的完整名称，避免混用。</p>}
    </details>}
    {successful.length > 0 && <section className="panel text-panel">
      <div className="text-controls"><h2>场次历史</h2><input aria-label="搜索场次历史" placeholder="按回放名称、老师、标题、平台或链接搜索" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></div>
      <p className="text-status">重新生成保留原稿。原文、规则、老师反馈及模型相同时复用选题复审，文字初稿仍会调用模型并产生费用。</p>
      <div className="text-history">{history.map(item => <div className="text-pending-row" key={item.id}>
        <button type="button" aria-pressed={job?.id === item.id}
        className={`text-history-row ${job?.id === item.id ? 'selected' : ''}`} disabled={dirty || busy}
        onClick={() => { setError(''); chooseJob(item.id); }}>
        <span><b>{item.name || item.teacher || sourceLabel(item)}</b> · {new Date(item.createdAt).toLocaleString()} · {item.clips.length} 条候选</span>
        <small>{item.clips.map(candidate => candidate.name).join('、') || item.message}</small>
        </button>
        <button type="button" className="button small" aria-label={'重新生成：' + (item.name || item.teacher || sourceLabel(item))}
          disabled={running >= 3 || busy || dirty || jobs.some(other => other.url === item.url && other.status === 'running')}
          onClick={() => void perform(async () => { addJobs([await window.workbench.retryTextJob(item.id)]); })}>
          {jobs.some(other => other.url === item.url && other.status === 'running') ? '正在生成…' : '重新生成'}
        </button>
      </div>)}
      {!history.length && <p className="text-status">没有匹配的场次</p>}</div>
    </section>}
    {job && <div className="panel text-panel">
      <div className="text-controls">
        <b>{job.name || sourceLabel(job)}</b>
        {job.teacher && <span className="text-status">{job.teacher}</span>}
        <button className="button small" disabled={busy || dirty} onClick={() => { setNewName(job.name ?? ''); setNewTeacher(job.teacher ?? ''); }}>修改回放信息</button>
        <button className="button ghost" disabled={busy} onClick={() => void perform(() => window.workbench.openTextSource(job.id))}>打开原回放</button>
        <button className="button" disabled={busy || job.status === 'running' && !job.transcriptCount} onClick={() => {
          if (transcript) setTranscript(null);
          else void perform(async () => { setTranscript(await window.workbench.readTextTranscript(job.id)); });
        }}>{transcript ? '收起整场逐字稿' : job.transcriptCount ? '查看整场逐字稿' : '获取整场逐字稿'}</button>
        {job.status === 'failed' && <>
          <button className="button" disabled={running >= 3 || busy || dirty} onClick={() => void perform(async () => { addJobs([await window.workbench.retryTextJob(job.id)]); })}>重试此回放</button>
          <button className="button ghost" disabled={busy || dirty} onClick={() => void perform(async () => {
            await window.workbench.dismissTextJob(job.id);
            setJobs(previous => previous.filter(item => item.id !== job.id));
            chooseJob('');
          })}>清除失败记录</button>
          {!job.transcriptCount && <button className="button" disabled={running >= 3 || busy || dirty} onClick={() => void perform(async () => {
            const next = await window.workbench.importTextSubtitle(job.id);
            if (next) addJobs([next]);
          })}>补传 SRT / VTT</button>}
          {job.source === 'feishu' && !job.transcriptCount && <button className="button" disabled={busy} onClick={() => void perform(async () => {
            const result = await window.workbench.connectFeishu();
            setFeishuMessage(result.connected ? '飞书已连接，可以重新生成。' : result.message);
          })}>连接飞书妙记</button>}
        </>}
      </div>
      {newName !== null && <form className="text-controls" onSubmit={event => { event.preventDefault(); void perform(async () => {
        const renamed = await window.workbench.renameTextJob(job.id, newName, newTeacher);
        setJobs(previous => previous.map(item => item.id === renamed.id ? renamed : item));
        setNewName(null);
        setLearning(await window.workbench.getTextLearningSummary());
      }); }}>
        <input autoFocus aria-label="修改回放名称" placeholder="回放名称" maxLength={100} value={newName} onChange={event => setNewName(event.target.value)} />
        <input aria-label="修改回放老师" placeholder="老师姓名" list="text-replay-teachers" maxLength={40} value={newTeacher} onChange={event => setNewTeacher(event.target.value)} />
        <button className="button primary" disabled={busy}>保存回放信息</button>
        <button className="button" type="button" disabled={busy} onClick={() => setNewName(null)}>取消</button>
      </form>}
      <p className="text-status" role="status">{job.message}</p>
      {job.qualityAudit && <details><summary>本场质量复审 · 提名 {job.qualityAudit.proposed} 条，{job.qualityAudit.qualified === undefined ? '通过' : '择优生成'} {job.qualityAudit.approved} 条{job.qualityAudit.extraReview ? ' · 已跨题复核' : ''}{job.qualityAudit.reused ? ' · 复用同条件选题' : ''}</summary>
        <p className="text-status">每场最多6条进入逐条编稿；复审合格超过6条时先择优，避免逐条生成后再筛。通过表示模型初审，仍需人工审核。</p>
        <ul>{job.qualityAudit.decisions.map((item, i) => <li key={i}><b>{item.round ? item.round + ' · ' : ''}{item.approved ? '通过' : '未通过'} · {item.name}</b>：{item.watchReason && <span>观看价值：{item.watchReason}；</span>}{item.reason}</li>)}</ul>
      </details>}
      {job.transcriptSavedAt && <p className="text-status">整场原文已保存在本地 · {new Date(job.transcriptSavedAt).toLocaleString()}</p>}
      {job.source === 'feishu' && feishuMessage && <p className="text-status">{feishuMessage}</p>}
      {!!job.deliveries?.length && <details><summary>飞书交付记录（{job.deliveries.length}）</summary><ul className="text-deliveries">{job.deliveries.map(delivery =>
        <li key={delivery.documentId}>{delivery.teacher}｜{delivery.title} · {new Date(delivery.exportedAt).toLocaleString()}
          {delivery.url ? <button className="button small" disabled={busy} onClick={() => void perform(() => window.workbench.openFeishuDocument(delivery.url!))}>打开文档</button> : <span> · {delivery.documentId}</span>}</li>)}</ul></details>}
      {job.clips.length > 0 && <div className="text-candidates">{job.clips.map(item => <button key={item.id} className={`button ${item.id === clip?.id ? 'primary' : ''}`}
        disabled={job.status === 'running' || dirty || busy} onClick={() => { setClipId(item.id); setDraft(null); setSelection(null); setExported(null); }}>{item.name}</button>)}</div>}
    </div>}
    {job && transcript && <section className="panel text-panel">
      <div className="text-controls"><h2>整场逐字稿</h2><input aria-label="搜索逐字稿" placeholder="查找原文关键词" value={textQuery} onChange={event => { setTextQuery(event.target.value); setTextPage(0); }} /></div>
      <form className="text-controls text-supplement" onSubmit={event => { event.preventDefault(); void perform(async () => {
        const candidate = await window.workbench.supplementTextJob(job.id, inputTime(startAt), inputTime(endAt));
        setJobs(await window.workbench.listTextJobs()); setClipId(candidate.id); setDraft(null); setSelection(null); setExported(null);
      }); }}>
        <label>起点 <input aria-label="补选起点" placeholder="00:00" value={startAt} onChange={event => setStartAt(event.target.value)} /></label>
        <label>终点 <input aria-label="补选终点" placeholder="05:00" value={endAt} onChange={event => setEndAt(event.target.value)} /></label>
        <button className="button" disabled={busy || dirty || job.status === 'running' || !startAt || !endAt}>在此范围补选</button>
        <span className="text-status">单次最多 30 分钟，补选会保留已有候选。</span>
      </form>
      <div className="text-source-lines">{filtered.slice(textPage * pageSize, (textPage + 1) * pageSize).map(unit => <div className="text-source-line" key={unit.id}>
        <span className="text-status">{label(unit)}</span><span>{unit.text}</span>
        <div className="text-controls"><button type="button" className="button small" onClick={() => setStartAt(clipTime(unit.startMs))}>设起点</button>
          <button type="button" className="button small" onClick={() => setEndAt(clipTime(unit.endMs, true))}>设终点</button></div>
      </div>)}</div>
      <div className="text-controls"><button className="button small" disabled={textPage === 0} onClick={() => setTextPage(textPage - 1)}>上一页</button>
        <span className="text-status">{textPage + 1}/{pages} 页 · {filtered.length} 段</span>
        <button className="button small" disabled={textPage + 1 >= pages} onClick={() => setTextPage(textPage + 1)}>下一页</button></div>
    </section>}
    {clip && job?.status !== 'running' && <div className="panel text-panel">
      <details open><summary>选题反馈 · 用于改善下一次初选与复审</summary>
        <p className="text-status">只评价这条题目值不值得做；不是视频剪辑意见。请给具体理由，反馈会作为有依据的样例，不会把一次偏好扩成所有老师的规则。</p>
        {clip.topicFeedback && <p className="text-status">已记录：{topicVerdictLabels[clip.topicFeedback.verdict]} · {clip.topicFeedback.reason}</p>}
        <input aria-label="选题反馈原因" placeholder="例如：有真实就业冲突，值得展开；或只有报分数，没有值得看完的判断" maxLength={800} value={topicReason} onChange={e => setTopicReason(e.target.value)} />
        <div className="text-controls">
          {(['good', 'bad'] as const).map(verdict => <button type="button" className="button small" key={verdict} disabled={busy || dirty || !topicReason.trim()}
            onClick={() => void perform(async () => { const updated = await window.workbench.rateTextTopic(job!.id, clip.id, verdict, topicReason); updateSaved(updated); setTopicReason(''); })}>{verdict === 'good' ? '选题值得做' : '选题不合适'}</button>)}
        </div>
        <div className="text-controls">
          <select aria-label="未采用原因类别" value={topicDisposition} onChange={e => setTopicDisposition(e.target.value as TextTopicVerdict)}>
            <option value="incomplete">题目好，但原话没讲完整</option><option value="duplicate">已做过或重复</option><option value="deferred">暂时不采用</option>
          </select>
          <button type="button" className="button small" disabled={busy || dirty || (topicDisposition === 'incomplete' && !topicReason.trim())}
            onClick={() => void perform(async () => { updateSaved(await window.workbench.rateTextTopic(job!.id, clip.id, topicDisposition, topicReason.trim() || (topicDisposition === 'duplicate' ? '已做过，本期不重复采用' : '暂时不采用，未补充具体原因'))); setTopicReason(''); })}>记录未采用原因</button>
          {clip.topicFeedback && <button type="button" className="button small" disabled={busy || dirty} onClick={() => void perform(async () => { updateSaved(await window.workbench.clearTextTopicFeedback(job!.id, clip.id)); setTopicReason(''); })}>清除反馈／尚未决定</button>}
        </div>
        <p className="text-status">未导出和未查看不算负评。“原话不完整”不否定题目本身；重复和暂不采用只记录用途，不参与选题质量学习。</p>
      </details>
      <details><summary>模型初稿与当前稿 · 完整正文对比</summary>
        <p className="text-status">逐段保留初稿与当前稿，标明删选、补回和顺序变化。记录行为，不凭空判断你的修改动机。</p>
        {comparison && <>
          <div className="text-comparison-grid">
            <div><h3>模型初稿</h3><p><b>{clip.initialEdit?.title}</b></p><p>开头：{clip.initialEdit?.hook ? textOf(clip.units.find(u => u.id === clip.initialEdit!.hook!.id)!, clip.initialEdit.hook) : '无单独开头'}</p>{comparison.before.map((p, i) => <p key={i}><small>{p.id}</small> {p.text}</p>)}</div>
            <div><h3>当前文字稿</h3><p><b>{clip.title}</b></p><p>开头：{clip.hook ? textOf(clip.units.find(u => u.id === clip.hook!.id)!, clip.hook) : '无单独开头'}</p>{comparison.after.map((p, i) => <p key={i}><small>{p.id}</small> {p.text}</p>)}</div>
          </div>
          <h3>正文取舍记录</h3>{comparison.changes.map(c => <div key={c.id}><b>{c.id}{c.moved ? ' · 调整顺序' : ''}</b>
            {c.removed.map((t, i) => <p key={'r' + i}>删去：{t}</p>)}{c.added.map((t, i) => <p key={'a' + i}>补回原话：{t}</p>)}
            {c.toHook?.map((t, i) => <p key={'h' + i}>移到开头：{t}</p>)}{c.fromHook?.map((t, i) => <p key={'b' + i}>开头内容加入正文：{t}</p>)}
            {!c.removed.length && !c.added.length && !c.toHook?.length && !c.fromHook?.length && !c.moved && <p>原样保留：{c.after}</p>}
          </div>)}
        </>}
      </details>
      <section className="text-final-confirmation">
        <h3>定稿确认与学习</h3>
        <p className="text-status">{clip.confirmedFinal ? finalVersionMatches(clip) ? '已确认定稿 v' + clip.confirmedFinal.revision + '，这份完整前后对比会用于后续初步输出。' : clip.confirmedFinal.status === 'withdrawn' ? '已撤销定稿确认，不再作为当前学习样例。' : '稿件已修改，需要重新确认定稿；新稿暂不作为完整学习样例。' : '尚未确认。保存是草稿，导出记录采用事实；点击确认才把当前稿作为完整学习样例。'}</p>
        {clip.lastExport && <p className="text-status">{JSON.stringify(clip.lastExport.edit) === JSON.stringify({ title: clip.title, hook: clip.hook, repeatHook: clip.repeatHook, body: clip.body }) ? '工作台最近成功发送的版本与当前稿一致；不读取飞书里的后续手改。' : '工作台最近成功发送的是另一版本；当前稿尚未完成相同版本的交付。'}</p>}
        <input aria-label="定稿学习备注" placeholder="选填：典型取舍原因，例如保留案例是为了支撑观点，不必每句话解释" maxLength={800} value={finalNote} onChange={e => setFinalNote(e.target.value)} />
        <div className="text-controls"><button type="button" className="button primary" disabled={busy || dirty || !job?.teacher || !clip.body.length || !clip.initialEdit}
          onClick={() => void perform(async () => { updateSaved(await window.workbench.confirmTextFinal(job!.id, clip.id, finalNote, { title: clip.title, hook: clip.hook, repeatHook: clip.repeatHook, body: clip.body })); setLearning(await window.workbench.getTextLearningSummary()); })}>确认当前稿为定稿并学习</button>
          {clip.confirmedFinal && clip.confirmedFinal.status !== 'withdrawn' && <button type="button" className="button" disabled={busy || dirty} onClick={() => void perform(async () => { updateSaved(await window.workbench.withdrawTextFinal(job!.id, clip.id)); setLearning(await window.workbench.getTextLearningSummary()); })}>撤销定稿确认</button>}
        </div>
        {dirty && <p className="text-status">请先保存改稿，再确认最终版本。</p>}
        {!clip.initialEdit && <p className="text-status">这条旧记录缺少模型初稿，请重新生成后再使用完整对比学习。</p>}
        {!job?.teacher && <p className="text-status">请先填写老师姓名，以免把不同老师的偏好混用。</p>}
        {!!clip.finalHistory?.length && <details><summary>已确认版本记录（{clip.finalHistory.length}）</summary>{clip.finalHistory.map(v => <details key={v.revision}><summary>v{v.revision} · {new Date(v.confirmedAt).toLocaleString()} · {v.teacher}</summary><p>{v.note || '未填写备注'}</p><b>{v.edit.title}</b>{readingOrder({ ...clip, ...v.edit }).map(p => <p key={p.position}>{p.text}</p>)}</details>)}</details>}
      </section>
      <div className="text-controls"><input aria-label="交付标题" value={clip.title} maxLength={200} disabled={busy} onChange={event => change({ title: event.target.value })} />
        <button className="button primary" disabled={busy || !dirty || !clip.title.trim()} onClick={() => void perform(save)}>保存改稿</button>
        <button className="button ghost" disabled={busy || !dirty} onClick={() => { setDraft(saved ?? null); setDirty(false); setSelection(null); }}>撤销未保存修改</button></div>
      <p className="text-status">原直播 {clipTime(clip.units[0].startMs)}–{clipTime(clip.units.at(-1)!.endMs, true)} · {dirty ? '有未保存修改' : '已保存'}</p>
      <details><summary>标题候选、开头候选与入选理由</summary>
        <p>{clip.topicValue} · {clip.completeness}</p>
        <div className="text-options">{clip.titles.map(title => <button className="button" key={title} disabled={busy} onClick={() => change({ title })}>{title}</button>)}</div>
        <div className="text-options">{clip.hooks.map((hook, i) => <button className="button" key={i} disabled={busy} onClick={() => chooseHook(hook)}>用作开头 · {textOf(unitFor(hook), hook)}</button>)}</div>
      </details>
      <p><b>当前开头</b> {clip.hook ? textOf(unitFor(clip.hook), clip.hook) : '未单独设开头'}</p>
      <label><input type="checkbox" checked={clip.repeatHook} disabled={busy || !clip.hook} onChange={event => setRepeat(event.target.checked)} /> 开头原位置也保留</label>
      <details><summary>文字稿顺序与段落调整</summary><ol className="text-order">{clip.body.map((pick, i) => <li key={pick.id}>
        <span className={moved.has(pick.id) ? 'text-yellow' : ''}>{textOf(unitFor(pick), pick)}</span>
        <button className="button small" aria-label={`上移第 ${i + 1} 段`} disabled={busy || i === 0} onClick={() => move(i, -1)}>上移</button>
        <button className="button small" aria-label={`下移第 ${i + 1} 段`} disabled={busy || i === clip.body.length - 1} onClick={() => move(i, 1)}>下移</button>
      </li>)}</ol></details>
      <details><summary>通读文字初稿与衔接检查</summary>
        <p className="text-read">{sequence.map(part => part.text).join('') || '尚未选中文字'}</p>
        <button className="button" disabled={busy || !sequence.length || !clip.title.trim()} onClick={() => void perform(async () => {
          await save(); updateSaved(await window.workbench.reviewTextClip(job!.id, clip.id));
        })}>用 DeepSeek 检查衔接</button>
        {clip.review && <><p>{clip.review.summary}</p><ol>{clip.review.issues.map((issue, i) => <li key={i}>
          <blockquote>{sequence[issue.from - 1]?.text}{issue.to !== issue.from && ` ｜ ${sequence[issue.to - 1]?.text}`}</blockquote>{issue.why} {issue.suggestion}
        </li>)}</ol></>}
      </details>
      <section className="text-feishu">
        <h2>飞书交付</h2>
        <p className="text-status">填写已有文档或知识库文档链接，会按导入日期追加切片。填写云盘文件夹或留空则新建文档。</p>
        {delivery && <p className="text-status">这条稿件已交付。保存后同步到最近交付文档的对应切片，文档中已有人工改动时会提示核对。</p>}
        {delivery?.syncedAt && !delivery.syncError && <p className="text-status">最近同步：{new Date(delivery.syncedAt).toLocaleString()}</p>}
        {delivery?.syncError && <p className="text-error" role="status">本地稿件已保存，飞书同步失败：{delivery.syncError}{' '}
          <button className="button small" disabled={busy} onClick={() => void perform(() => window.workbench.syncTextClip(job!.id, clip.id))}>重试同步</button></p>}
        <div className="text-controls text-actions">
          <button className="button" disabled={busy} onClick={() => void perform(async () => {
            const status = await window.workbench.connectFeishuDocument();
            setFeishuMessage(status.connected ? '飞书账号已连接，可以导出。' : status.message);
          })}>授权飞书文档</button>
          <button className="button primary" disabled={busy || !sequence.length || !clip.title.trim()} onClick={() => {
            setTeacher(job?.teacher ?? '');
            setFeishuFolder(destinations[job?.teacher ?? ''] ?? '');
            setError('');
            exportDialog.current?.showModal();
          }}>导出到飞书</button>
        </div>
        <dialog ref={exportDialog} className="text-export-dialog" onCancel={event => { if (busy) event.preventDefault(); }}>
          <form onSubmit={event => { event.preventDefault(); void perform(async () => {
            await save();
            setExported(await window.workbench.exportTextClip(job!.id, clip.id, feishuFolder, teacher));
            exportDialog.current?.close();
            setJobs(await window.workbench.listTextJobs());
            setLearning(await window.workbench.getTextLearningSummary());
            setDestinations(await window.workbench.getTextExportDestinations());
          }); }}>
            <h2>导出到飞书</h2>
            <label>直播老师姓名（必填）<input autoFocus aria-label="直播老师姓名" list="text-replay-teachers" required maxLength={40} value={teacher} disabled={busy} onChange={event => {
              setTeacher(event.target.value); setFeishuFolder(destinations[event.target.value.trim()] ?? '');
            }} /></label>
            <label>飞书交付位置（可选）<input aria-label="飞书交付文件夹" placeholder="文档、知识库文档或云盘文件夹链接；留空新建" value={feishuFolder} disabled={busy} onChange={event => setFeishuFolder(event.target.value)} /></label>
            <p className="text-status">{/\/(?:wiki|docx)\//.test(feishuFolder)
              ? '追加到已有文档，按导入日期归档并自动续接切片编号'
              : `新文档：${teacher.trim() || '老师姓名'}｜${clip.title}`}</p>
            {error && <p className="text-error" role="alert">{error}</p>}
            <div className="text-controls"><button type="button" className="button" disabled={busy} onClick={() => { exportDialog.current?.close(); setError(''); }}>取消</button>
              <button className="button primary" disabled={busy || !teacher.trim()}>{busy ? '正在导出…' : '确认导出'}</button></div>
          </form>
        </dialog>
        {feishuMessage && <p className="text-status" role="status">{feishuMessage}</p>}
        {exported && <div className="text-controls">
          <p role="status">飞书文档已生成</p>
          {exported.url ? <>
            <input aria-label="飞书文档链接" readOnly value={exported.url} onFocus={event => event.currentTarget.select()} />
            <button className="button" disabled={busy} onClick={() => void perform(() => window.workbench.openFeishuDocument(exported.url!))}>打开飞书文档</button>
          </> : <p className="text-status">未取到文档链接，可在导出文件夹按标题查找。文档编号 {exported.documentId}</p>}
        </div>}
      </section>
      <h2>原文标注</h2>
      <p className="text-status">选中同一段内的原话再操作。绿色为开头，紫色为正文，黄色加下划线为移出。移动后的正文顺序可在上方查看。</p>
      <div className="text-controls text-marker">
        <span>{selection ? clip.units.find(unit => unit.id === selection.id)?.text.slice(...selection.range) : '尚未选择原话'}</span>
        <button className="button small" disabled={busy || !selection} onClick={() => mark(true)}>正文保留</button>
        <button className="button small" disabled={busy || !selection} onClick={() => mark(false)}>取消正文高亮</button>
        <button className="button small" disabled={busy || !selection} onClick={() => { if (selection) chooseHook({ id: selection.id, ranges: [selection.range] }); setSelection(null); }}>设为开头</button>
        <button className="button small" disabled={busy || !clip.hook} onClick={() => change({ hook: null, repeatHook: false })}>取消开头</button>
      </div>
      <div className="text-original">{clip.units.map(unit => <p key={unit.id} title={label(unit)} onMouseUp={event => {
        const range = selectionIn(event.currentTarget); if (range) setSelection({ id: unit.id, range });
      }} onKeyUp={event => { const range = selectionIn(event.currentTarget); if (range) setSelection({ id: unit.id, range }); }}>
        {originalMarks(unit, clip, moved).map((mark, i) => <span className={mark.className} key={i}>{mark.text}</span>)}
      </p>)}</div>
      {clip.notes.length > 0 && <details><summary>转写备注</summary><ul>{clip.notes.map((note, i) => <li key={i}>{note}</li>)}</ul></details>}
    </div>}
  </section>;
}
