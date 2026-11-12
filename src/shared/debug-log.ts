// Local diagnostic log for the extension service worker.
// Entries stay in the service worker console and chrome.storage.local.

export type DebugLevel = 'info' | 'warn' | 'error';

export interface DebugEntry {
  t: string;
  level: DebugLevel;
  event: string;
  [key: string]: unknown;
}

const MAX_LINES = 400;
const MAX_STRING = 500;
const lines: string[] = [];
let sink: ((text: string) => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function installDebugLogSink(next: (text: string) => void): void {
  sink = next;
  if (lines.length) next(lines.join('\n'));
}

export function debugLog(level: DebugLevel, event: string, data: Record<string, unknown> = {}): void {
  const entry: DebugEntry = {
    t: new Date().toISOString(),
    level,
    event,
    ...sanitize(data) as Record<string, unknown>,
  };
  lines.push(JSON.stringify(entry));
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  const consoleMethod = level === 'info' ? 'info' : level;
  console[consoleMethod]('[Doc Copilot]', event, entry);
  scheduleFlush(level !== 'info');
}

export function summarizeApiBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') return { bodyChars: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { bodyChars: body.length };
  }
  if (!parsed || typeof parsed !== 'object') return { bodyChars: body.length };
  const record = parsed as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const byRole: Record<string, { count: number; chars: number; images: number; imageChars: number }> = {};
  let userPreview = '';
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const item = message as Record<string, unknown>;
    const role = typeof item.role === 'string' ? item.role : 'unknown';
    const bucket = byRole[role] ?? { count: 0, chars: 0, images: 0, imageChars: 0 };
    bucket.count += 1;
    const measured = measureContent(item.content);
    bucket.chars += measured.chars;
    bucket.images += measured.images;
    bucket.imageChars += measured.imageChars;
    if (role === 'user' && measured.preview) userPreview = measured.preview;
    byRole[role] = bucket;
  }
  return {
    bodyChars: body.length,
    model: typeof record.model === 'string' ? record.model : undefined,
    maxTokens: typeof record.max_tokens === 'number' ? record.max_tokens : undefined,
    stream: record.stream === true,
    toolCount: Array.isArray(record.tools) ? record.tools.length : 0,
    messages: byRole,
    userPreview,
  };
}

export function safeUrl(input: RequestInfo | URL): string {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split('?')[0].slice(0, 180);
  }
}

function scheduleFlush(immediate: boolean): void {
  if (!sink) return;
  if (immediate) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    sink(lines.join('\n'));
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    sink?.(lines.join('\n'));
  }, 1500);
}

function measureContent(content: unknown): { chars: number; images: number; imageChars: number; preview: string } {
  if (typeof content === 'string') {
    return { chars: content.length, images: 0, imageChars: 0, preview: clip(stripSecrets(content), 80) };
  }
  if (!Array.isArray(content)) return { chars: 0, images: 0, imageChars: 0, preview: '' };
  let chars = 0;
  let images = 0;
  let imageChars = 0;
  let preview = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const item = part as Record<string, unknown>;
    if (typeof item.text === 'string') {
      chars += item.text.length;
      if (!preview) preview = clip(stripSecrets(item.text), 80);
    }
    const imageUrl = item.image_url && typeof item.image_url === 'object'
      ? (item.image_url as Record<string, unknown>).url
      : undefined;
    if (typeof imageUrl === 'string') {
      images += 1;
      imageChars += imageUrl.length;
    }
  }
  return { chars, images, imageChars, preview };
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[nested]';
  if (typeof value === 'string') return clip(stripSecrets(value), MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/api[-_]?key|authorization|secret|password|token/i.test(key) && !/request id|maxTokens|totalTokens/i.test(key)) {
        output[key] = '[redacted]';
        continue;
      }
      output[key] = sanitize(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function stripSecrets(value: string): string {
  return value
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[image-data]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_\-]{8,}\b/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer [redacted]');
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
