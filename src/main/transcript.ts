import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import type { TranscriptSegment } from "../shared/types";

function parseTimestamp(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}

function splitReadableText(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n{2,}|(?<=[。！？!?；;])\s*/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function splitTimedContent(
  content: string,
  start: number,
  end: number,
): Array<{ text: string; start: number; end: number; timingPrecision: "word" | "sentence" | "estimated" }> {
  const pieces = content
    .match(/[^。！？!?；;]+[。！？!?；;]?/gu)
    ?.map((item) => item.trim())
    .filter(Boolean);
  if (!pieces || pieces.length <= 1) {
    const spokenLength = content.replace(/[^\p{L}\p{N}\u3400-\u9fff]/gu, "").length;
    return [{
      text: content,
      start,
      end,
      timingPrecision: spokenLength <= 6 ? "word" : "sentence",
    }];
  }
  const totalWeight = pieces.reduce((sum, item) => sum + item.length, 0) || 1;
  const duration = Math.max(0, end - start);
  let cursor = start;
  return pieces.map((text, index) => {
    const pieceEnd =
      index === pieces.length - 1
        ? end
        : cursor + (duration * text.length) / totalWeight;
    const result = { text, start: cursor, end: pieceEnd, timingPrecision: "estimated" as const };
    cursor = pieceEnd;
    return result;
  });
}

export function parseSrtOrVtt(text: string, preserveCue = false): TranscriptSegment[] {
  const blocks = text
    .replace(/^\uFEFF/, "")
    .replace(/^WEBVTT[^\n]*\n/i, "")
    .trim()
    .split(/\n\s*\n/);
  const segments: TranscriptSegment[] = [];
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startRaw, endRawWithSettings] = lines[timeIndex]
      .split("-->")
      .map((value) => value.trim());
    if (!endRawWithSettings) continue;
    const endRaw = endRawWithSettings.split(/\s+/)[0];
    const content = lines
      .slice(timeIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!content) continue;
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    const cueTime = /^(?:\d+:)?[0-5]?\d:[0-5]\d[.,]\d{3}$/;
    if (preserveCue && (!cueTime.test(startRaw) || !cueTime.test(endRaw) || end <= start)) continue;
    const pieces = preserveCue ? [{ text: content, start, end, timingPrecision: "sentence" as const }]
      : splitTimedContent(content, start, end);
    for (const piece of pieces) {
      segments.push({
        id: crypto.randomUUID(),
        start: piece.start,
        end: piece.end,
        text: piece.text,
        confidence: "source",
        timingPrecision: piece.timingPrecision,
      });
    }
  }
  return segments;
}

export function parseTimecodedText(text: string): TranscriptSegment[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const items: TranscriptSegment[] = [];
  const pattern =
    /^\s*(?:\[|【|\()?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?)(?:\]|】|\))?\s*(?:-|–|—|:)?\s*(.+)$/;
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;
    const start = parseTimestamp(match[1]);
    items.push({
      id: crypto.randomUUID(),
      start,
      end: start,
      text: match[2].trim(),
      confidence: "source",
      timingPrecision: "estimated",
    });
  }
  for (let index = 0; index < items.length; index += 1) {
    items[index].end =
      items[index + 1]?.start ??
      items[index].start + Math.max(2, items[index].text.length / 4.5);
  }
  return items;
}

export function estimatePlainText(
  text: string,
  duration: number,
): TranscriptSegment[] {
  const chunks = splitReadableText(text);
  const totalWeight =
    chunks.reduce((sum, chunk) => sum + Math.max(chunk.length, 8), 0) || 1;
  let cursor = 0;
  return chunks.map((chunk) => {
    const segmentDuration =
      (Math.max(chunk.length, 8) / totalWeight) * duration;
    const item: TranscriptSegment = {
      id: crypto.randomUUID(),
      start: cursor,
      end: Math.min(duration, cursor + segmentDuration),
      text: chunk,
      confidence: "estimated",
      timingPrecision: "estimated",
    };
    cursor = item.end;
    return item;
  });
}

export async function parseTranscriptFile(
  filePath: string,
  duration: number,
): Promise<TranscriptSegment[]> {
  const extension = path.extname(filePath).toLowerCase();
  let text: string;
  if (extension === ".docx") {
    text = (await mammoth.extractRawText({ path: filePath })).value;
  } else {
    text = await fs.readFile(filePath, "utf8");
  }
  if ([".srt", ".vtt"].includes(extension)) {
    const parsed = parseSrtOrVtt(text);
    if (parsed.length) return parsed;
  }
  const timecoded = parseTimecodedText(text);
  if (timecoded.length >= 2) return timecoded;
  return estimatePlainText(text, duration);
}

export function transcriptWindow(
  segments: TranscriptSegment[],
  start: number,
  end: number,
  paddingSeconds = 20,
): string {
  return segments
    .filter(
      (segment) =>
        segment.end >= start - paddingSeconds &&
        segment.start <= end + paddingSeconds,
    )
    .map((segment) => segment.text)
    .join(" ");
}
