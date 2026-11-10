export function formatDuration(totalSeconds?: number): string {
  if (totalSeconds === undefined || Number.isNaN(totalSeconds)) return "--:--";
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function toFileUrl(filePath?: string, revision?: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const baseUrl = encodeURI(`local-media://${normalized.replace(/^([A-Za-z]):/, "$1")}`);
  return revision
    ? `${baseUrl}?v=${encodeURIComponent(revision)}`
    : baseUrl;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
