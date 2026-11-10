import fs from 'node:fs/promises';
import path from 'node:path';
import { feishuMinuteTokenFromUrl, parseTingwuParagraphs, providerFromUrl } from './source-adapters';
import type { CookieProvider, TingwuSourceAdapter } from './source-adapters';
import type { FeishuDriveService } from './feishu-drive';
import { parseSrtOrVtt } from './transcript';
import type { TextSourceKind } from '../shared/text-selection';
import type { SourceFetch } from './source-http';

export type TimedSourcePart = { startMs: number; endMs: number; text: string };
export type TextSource = { url: string; kind: TextSourceKind };

export function identifyTextSource(input: string): TextSource {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new Error('请输入完整的 HTTPS 回放分享链接'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('请输入完整的 HTTPS 回放分享链接');
  }
  const kind = providerFromUrl(url.href);
  if (kind === 'unknown' || kind === 'feishu' && !feishuMinuteTokenFromUrl(url.href)
    || kind === 'tingwu' && !/^\/doc\/transcripts\/[^/]+/i.test(url.pathname)
    || kind === 'qianwen' && url.pathname === '/' && !url.search && !url.hash) {
    throw new Error('请复制通义听悟、通义千问录音转写或飞书妙记的回放分享链接');
  }
  // 千问的部分页面会在 URL 片段中保存路由。发 HTTP 请求时再去掉片段。
  if (kind !== 'qianwen') url.hash = '';
  return { kind, url: url.href };
}

export function subtitleParts(text: string): TimedSourcePart[] {
  return parseSrtOrVtt(text, true).map(part => ({
    startMs: Math.round(part.start * 1000), endMs: Math.round(part.end * 1000), text: part.text,
  }));
}

function alibabaResource(url: URL) {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && (providerFromUrl(url.href) === 'qianwen' || providerFromUrl(url.href) === 'tingwu'
      || /(^|\.)(?:aliyuncs\.com|alicdn\.com|aliyun\.com|alibabausercontent\.com)$/i.test(url.hostname));
}

export class TextSources {
  constructor(private readonly tingwu: Pick<TingwuSourceAdapter, 'readTranscript'>,
    private readonly feishu: Pick<FeishuDriveService, 'readMinutesTranscript'>,
    private readonly cookies: CookieProvider,
    private readonly request: SourceFetch = (input, options) => fetch(input, options)) {}

  identify = identifyTextSource;

  async readTranscript(url: string, subtitleFile?: string, onProgress?: (message: string) => void): Promise<{ parts: TimedSourcePart[]; cues: boolean }> {
    const source = this.identify(url);
    if (subtitleFile) {
      if (!/\.(srt|vtt)$/i.test(path.extname(subtitleFile))) throw new Error('请选择带时间码的 SRT 或 VTT 字幕文件');
      if ((await fs.stat(subtitleFile)).size > 20 * 1024 * 1024) throw new Error('字幕文件不能超过 20 MB');
      const parts = subtitleParts(await fs.readFile(subtitleFile, 'utf8'));
      if (!parts.length) throw new Error('字幕文件没有可用的起止时间和原话，请确认是 UTF-8 编码的 SRT 或 VTT');
      return { parts, cues: true };
    }
    if (source.kind === 'tingwu') return { parts: await this.tingwu.readTranscript(source.url, onProgress), cues: false };
    if (source.kind === 'feishu') {
      const raw = await this.feishu.readMinutesTranscript(feishuMinuteTokenFromUrl(source.url)!, 'srt', AbortSignal.timeout(45_000));
      const parts = subtitleParts(raw);
      if (!parts.length) throw new Error('飞书妙记没有返回带起止时间的逐字稿。请确认转写已完成，或补传 SRT 字幕。');
      return { parts, cues: true };
    }
    return this.readQianwen(source.url);
  }

  private async readQianwen(input: string): Promise<{ parts: TimedSourcePart[]; cues: boolean }> {
    const signal = AbortSignal.timeout(30_000);
    const failed = '千问回放未提供可读取的带时间码逐字稿。请确认链接是录音转写分享、拥有访问权限，或导出 SRT/VTT 字幕后补传。';
    let url = new URL(input);
    url.hash = '';
    for (let hops = 0; hops < 5; hops++) {
      if (providerFromUrl(url.href) === 'tingwu') {
        return { parts: await this.tingwu.readTranscript(identifyTextSource(url.href).url), cues: false };
      }
      if (!alibabaResource(url) || providerFromUrl(url.href) !== 'qianwen') throw new Error(failed);
      const cookie = await this.cookies(url.href);
      const response = await this.request(url, { redirect: 'manual', signal, headers: cookie ? { Cookie: cookie } : {} });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(failed);
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`千问回放读取失败（HTTP ${response.status}）。${failed}`);
      const page = await response.text();
      const asset = page.replaceAll('\\/', '/').match(
        /["'](?:transcriptUrl|subtitleUrl|transcript_url|subtitle_url)["']\s*:\s*["']([^"'\s]+)["']/i,
      )?.[1];
      let raw = page;
      if (asset) {
        const assetUrl = new URL(asset.replaceAll('&amp;', '&').replaceAll('\\u0026', '&'), url);
        if (!alibabaResource(assetUrl)) throw new Error(failed);
        const subtitle = await this.request(assetUrl, { redirect: 'error', signal });
        if (!subtitle.ok) throw new Error(failed);
        raw = await subtitle.text();
      }
      const parts = subtitleParts(raw);
      if (parts.length) return { parts, cues: true };
      if (raw.trim().startsWith('{')) {
        const original = parseTingwuParagraphs(raw);
        if (original.length) return { parts: original, cues: false };
      }
      throw new Error(failed);
    }
    throw new Error(failed);
  }
}
