// ============================================================
// Model Provider - OpenAI Chat Completions, Anthropic Messages,
// and OpenAI Responses API client.
// Claude uses /messages without /v1. GPT and Grok use /v1 OpenAI paths.
// ============================================================

import {
  ModelConfig,
  ModelRole,
  AppSettings,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ChatMessage,
  ToolCall,
} from '../../shared/types/index';
import { settingsStorage } from '../../shared/storage/settings';
import { chatContentToText } from '../../shared/utils/index';
import { debugLog, safeUrl, summarizeApiBody } from '../../shared/debug-log';

/** 可重试的状态码 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_REQUEST_TIMEOUT_MS = 300000;
const IMAGE_REQUEST_TIMEOUT_MS = 120000;

function dedupeRequestId(message: string): string {
  return message.replace(/(\(request id:\s*[^)]+\))(?:\s+\1)+/gi, '$1');
}

function requestIdOf(message: string): string {
  const match = message.match(/\(request id:\s*([^)]+)\)/i);
  return match?.[1]?.trim() || '';
}

/** 网关无法把当前请求转换成上游协议时，会返回 not implemented。 */
function isProtocolNotImplemented(message: string): boolean {
  return /not implemented|convert_request_failed|not supported model for image generation|only imagen models are supported/i.test(message);
}

function isEndpointMissMessage(message: string): boolean {
  return /返回了 HTML 页面|不是模型接口|被重定向到登录页|不是模型响应/.test(message);
}

function shouldTryNextTextEndpoint(status: number, message: string): boolean {
  if (status === 404 || status === 405 || status === 0 || (status >= 300 && status < 400)) return true;
  return isEndpointMissMessage(message) || isProtocolNotImplemented(message);
}

async function readApiFailure(response: Response, endpoint: string): Promise<string> {
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return `Chat API endpoint ${endpoint} 被重定向到登录页，不是模型接口。`;
  }
  const message = await parseApiError(response);
  if (/<!doctype html|<html|text\/html/i.test(message)) {
    return `Chat API endpoint ${endpoint} 返回了 HTML 页面，不是模型响应。请确认 API Base URL 是否需要 /v1。`;
  }
  return message;
}

function rememberError(previous: string, next: string): string {
  const cleaned = dedupeRequestId(String(next || '')).trim();
  if (!cleaned) return previous;
  if (!previous.trim()) return cleaned;
  const nextMiss = isEndpointMissMessage(cleaned);
  const previousMiss = isEndpointMissMessage(previous);
  if (nextMiss && !previousMiss) return previous;
  if (isProtocolNotImplemented(cleaned) && !isProtocolNotImplemented(previous) && !previousMiss) return previous;
  return cleaned;
}

function explainImageGenerationError(message: string): string {
  const requestId = requestIdOf(message);
  const suffix = requestId ? `（request id: ${requestId}）` : '';
  if (isProtocolNotImplemented(message)) {
    return `当前网关没有实现这个生图协议。已依次尝试 /images/generations 和对话生图，仍然失败。请把图像模型 ID 改成该网关实际支持的生图模型。${suffix}`;
  }
  if (/API 错误 401\b|unauthorized|invalid api key|API Key 无效/i.test(message)) {
    return `图像模型的 API Key 无效或无权限。请检查图像设置；留空时会复用通用 API Key。${suffix}`;
  }
  if (/API 错误 403\b|\bforbidden\b|拒绝访问/i.test(message)) {
    return `图像服务拒绝访问。请检查 API Key 权限，或确认这个模型已经开通生图。${suffix}`;
  }
  if (/没有返回图片/.test(message)) {
    return `接口已连通，但没有返回图片。请确认图像模型 ID 是生图模型，而不是普通文本模型。${suffix}`;
  }
  if (/超时|timed out|abort/i.test(message)) {
    return `图像请求超时。请稍后重试。${suffix}`;
  }
  return dedupeRequestId(message).trim() || '图像生成失败';
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  return 'image/png';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function imageDataUrl(base64: string, mime = 'image/png'): string | null {
  const compact = base64.replace(/\s+/g, '');
  if (compact.length < 32 || !/^[a-z0-9+/=]+$/i.test(compact)) return null;
  const normalizedMime = /^image\//i.test(mime) ? mime : 'image/png';
  return `data:${normalizedMime};base64,${compact}`;
}

function imageFromString(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dataUrl = trimmed.match(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/i);
  if (dataUrl) return dataUrl[0].replace(/\s+/g, '');
  const markdown = trimmed.match(/!\[[^\]]*\]\((data:image\/[^)\s]+|https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/i);
  if (markdown?.[1]) return markdown[1];
  if (/^https?:\/\/\S+$/i.test(trimmed) && trimmed.length < 4000) return trimmed;
  return null;
}

function extractGeneratedImage(payload: unknown, depth = 0): string | null {
  if (depth > 8 || payload == null) return null;
  if (typeof payload === 'string') return imageFromString(payload);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractGeneratedImage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  for (const key of ['b64_json', 'image_base64', 'b64']) {
    if (typeof record[key] === 'string') {
      const mime = typeof record.mime_type === 'string' ? record.mime_type : 'image/png';
      const url = imageDataUrl(record[key] as string, mime);
      if (url) return url;
    }
  }
  const inline = record.inline_data;
  if (inline && typeof inline === 'object') {
    const data = inline as Record<string, unknown>;
    if (typeof data.data === 'string') {
      const mime = typeof data.mime_type === 'string' ? data.mime_type : 'image/png';
      const url = imageDataUrl(data.data, mime);
      if (url) return url;
    }
  }

  const preferred = ['image_url', 'url', 'image', 'images', 'content', 'message', 'output', 'data'];
  for (const key of preferred) {
    if (!(key in record)) continue;
    const found = extractGeneratedImage(record[key], depth + 1);
    if (found) return found;
  }
  for (const [key, value] of Object.entries(record)) {
    if (preferred.includes(key) || key === 'error' || key === 'usage' || key === 'model') continue;
    const found = extractGeneratedImage(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 解析 API 错误响应，返回可读信息 */
async function parseApiError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    const msg: string = json?.error?.message || json?.message || text;
    if (response.status === 429) {
      return dedupeRequestId(`请求过于频繁或超时（${msg}），请稍后重试`);
    }
    return dedupeRequestId(`API 错误 ${response.status}: ${msg}`);
  } catch {
    return dedupeRequestId(`API 错误 ${response.status}: ${text || response.statusText}`);
  }
}

/** 带指数退避的 fetch，对 429/5xx 自动重试 */
async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.log(`[Doc Copilot] API retry attempt ${attempt}/${maxRetries}, waiting ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    const startedAt = Date.now();
    const requestSummary = {
      url: safeUrl(input),
      attempt,
      ...summarizeApiBody(init.body),
    };
    try {
      const response = await fetch(input, { redirect: 'manual', ...init });
      const elapsedMs = Date.now() - startedAt;
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) {
        if (!response.ok) {
          const errorText = await response.clone().text().catch(() => '');
          debugLog('error', 'api.response', { ...requestSummary, status: response.status, elapsedMs, error: errorText.slice(0, 500) });
        } else {
          debugLog('info', 'api.response', { ...requestSummary, status: response.status, elapsedMs });
        }
        return response; // 成功或不可重试或已达最大重试次数
      }
      const errMsg = await parseApiError(response.clone());
      debugLog('warn', 'api.retry', { ...requestSummary, status: response.status, elapsedMs, error: errMsg });
      if (isProtocolNotImplemented(errMsg)) {
        return response;
      }
      lastError = new Error(errMsg);
      console.warn(`[Doc Copilot] ${errMsg}, retrying...`);
    } catch (err) {
      // AbortError 等不重试
      if ((err as Error).name === 'AbortError') throw err;
      const message = (err as Error).message || String(err);
      debugLog('error', 'api.fetch_failed', { ...requestSummary, elapsedMs: Date.now() - startedAt, error: message });
      lastError = new Error(`无法访问 AI 服务：${message}`);
    }
  }
  throw lastError!;
}

function createTimeoutSignal(controller: AbortController, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): ReturnType<typeof setTimeout> {
  return setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
}

function isAbortError(error: unknown): boolean {
  return (error as Error)?.name === 'AbortError';
}

function normalizeRequestError(error: unknown): Error {
  const err = error as Error;
  if (err?.name === 'AbortError') return new Error('AI 请求超时，请稍后重试或检查服务状态。');
  const message = err?.message || String(error);
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return new Error('无法访问 AI 服务，请检查 API Base URL、网络或服务是否可用。');
  }
  return err instanceof Error ? err : new Error(message);
}

/** Token usage stats per model role */
export interface TokenUsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  requests: number;
}

type UsageRecord = Record<ModelRole, TokenUsageStats>;

const MODEL_ROLES: ModelRole[] = ['smart', 'image'];

function emptyUsage(): UsageRecord {
  return {
    smart: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, requests: 0 },
    image: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, requests: 0 },
  };
}

function cloneUsage(usage: UsageRecord): UsageRecord {
  return JSON.parse(JSON.stringify(usage));
}

function safeUsageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizeUsage(stored: unknown): UsageRecord {
  const normalized = emptyUsage();
  if (!stored || typeof stored !== 'object') return normalized;

  for (const role of MODEL_ROLES) {
    const stats = (stored as Partial<Record<ModelRole, Partial<TokenUsageStats>>>)[role];
    if (!stats || typeof stats !== 'object') continue;

    normalized[role] = {
      promptTokens: safeUsageNumber(stats.promptTokens),
      completionTokens: safeUsageNumber(stats.completionTokens),
      totalTokens: safeUsageNumber(stats.totalTokens),
      cachedTokens: safeUsageNumber(stats.cachedTokens),
      reasoningTokens: safeUsageNumber(stats.reasoningTokens),
      requests: safeUsageNumber(stats.requests),
    };
  }

  return normalized;
}

export class ModelProvider {
  private readonly usageStorageKey = 'doc_copilot_usage';
  private usageLoaded: Promise<void> | null = null;
  private usageSaveQueue: Promise<void> = Promise.resolve();
  private abortControllers = new Map<string, AbortController>();

  /** Token usage tracking by role */
  private _usage: UsageRecord = emptyUsage();

  /** Get usage stats (read-only copy) */
  get usage(): UsageRecord {
    return cloneUsage(this._usage);
  }

  /** Get usage stats after restoring from extension session storage. */
  async getUsage(): Promise<UsageRecord> {
    await this.ensureUsageLoaded();
    return cloneUsage(this._usage);
  }

  /** Reset usage stats */
  async resetUsage(): Promise<void> {
    await this.ensureUsageLoaded();
    this._usage = emptyUsage();
    await this.saveUsage();
  }

  private async ensureUsageLoaded(): Promise<void> {
    if (!this.usageLoaded) {
      this.usageLoaded = (async () => {
        const stored = await this.readUsageFromStorage();
        this._usage = stored ? normalizeUsage(stored) : normalizeUsage(this._usage);
      })();
    }
    await this.usageLoaded;
  }

  private getUsageStorageArea(): {
    get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  } | null {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return null;
      const storage = chrome.storage as unknown as {
        session?: {
          get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
          set: (items: Record<string, unknown>) => Promise<void>;
        };
        local?: {
          get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
          set: (items: Record<string, unknown>) => Promise<void>;
        };
      };
      return storage.session ?? storage.local ?? null;
    } catch {
      return null;
    }
  }

  private async readUsageFromStorage(): Promise<unknown | null> {
    const storageArea = this.getUsageStorageArea();
    if (storageArea) {
      try {
        const result = await storageArea.get(this.usageStorageKey);
        return result[this.usageStorageKey] ?? null;
      } catch (error) {
        console.warn('[Doc Copilot] Failed to read token usage from storage', error);
      }
    }

    try {
      const local = (globalThis as { localStorage?: Storage }).localStorage;
      const stored = local?.getItem(this.usageStorageKey);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }

  private async saveUsage(): Promise<void> {
    this.usageSaveQueue = this.usageSaveQueue
      .catch(() => undefined)
      .then(async () => {
        const snapshot = cloneUsage(this._usage);
        const storageArea = this.getUsageStorageArea();
        if (storageArea) {
          try {
            await storageArea.set({ [this.usageStorageKey]: snapshot });
            return;
          } catch (error) {
            console.warn('[Doc Copilot] Failed to persist token usage to storage', error);
          }
        }

        try {
          const local = (globalThis as { localStorage?: Storage }).localStorage;
          local?.setItem(this.usageStorageKey, JSON.stringify(snapshot));
        } catch {
          // Ignore fallback storage errors.
        }
      });

    await this.usageSaveQueue;
  }

  private async trackUsage(role: ModelRole, response: CompletionResponse): Promise<void> {
    await this.ensureUsageLoaded();
    const u = response.usage;
    if (u) {
      this._usage[role].promptTokens += u.prompt_tokens || 0;
      this._usage[role].completionTokens += u.completion_tokens || 0;
      this._usage[role].totalTokens += u.total_tokens || 0;
      this._usage[role].cachedTokens += u.prompt_tokens_details?.cached_tokens || 0;
      this._usage[role].reasoningTokens += u.completion_tokens_details?.reasoning_tokens || 0;
    }
    this._usage[role].requests += 1;
    await this.saveUsage();
  }

  /** Estimate tokens for streaming (no usage from API) */
  private async estimateStreamTokens(role: ModelRole, promptChars: number, completionChars: number): Promise<void> {
    await this.ensureUsageLoaded();
    // Rough estimate: ~4 chars per token for English, ~2 for Chinese, use ~3 as average
    const promptTokens = Math.ceil(promptChars / 3);
    const completionTokens = Math.ceil(completionChars / 3);
    this._usage[role].promptTokens += promptTokens;
    this._usage[role].completionTokens += completionTokens;
    this._usage[role].totalTokens += promptTokens + completionTokens;
    this._usage[role].requests += 1;
    await this.saveUsage();
  }

  /** Get the model config for a given role */
  async getConfig(role: ModelRole): Promise<ModelConfig> {
    const settings = await settingsStorage.get();
    return settings.models[role];
  }

  /** Non-streaming completion */
  async complete(
    role: ModelRole,
    messages: ChatMessage[],
    options: Partial<CompletionRequest> = {},
  ): Promise<CompletionResponse> {
    const config = await this.getConfig(role);
    this.validateConfig(config);

    const requestId = `${role}-${Date.now()}`;
    const controller = new AbortController();
    const timeout = createTimeoutSignal(controller);
    this.abortControllers.set(requestId, controller);

    try {
      const body: CompletionRequest = {
        messages,
        model: config.modelId,
        temperature: options.temperature ?? config.temperature,
        max_tokens: options.max_tokens ?? config.maxTokens,
        ...options,
        stream: false,
      };

      let lastError = '';
      const plan = this.textRequestPlan(config);
      const { preferMessages } = plan;
      if (preferMessages) {
        try {
          const data = await this.requestMessagesCompletion(
            config,
            messages,
            body.max_tokens,
            body.temperature,
            controller.signal,
            undefined,
            body.stop,
            plan.messagesEndpoints,
          );
          await this.trackUsage(role, data);
          return data;
        } catch (error) {
          lastError = rememberError(lastError, normalizeRequestError(error).message);
          if (plan.claudeOnly) throw new Error(lastError || 'Messages API 请求失败。');
        }
      }

      for (const endpoint of plan.chatEndpoints) {
        let response: Response;
        try {
          response = await fetchWithRetry(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          lastError = rememberError(lastError, normalizeRequestError(error).message);
          continue;
        }

        if (!response.ok) {
          const failure = await readApiFailure(response, endpoint);
          lastError = rememberError(lastError, failure);
          if (!shouldTryNextTextEndpoint(response.status, failure)) throw new Error(lastError);
          continue;
        }

        const text = await response.text();
        if (!this.isJsonLikeResponse(response, text)) {
          lastError = rememberError(lastError, this.formatUnexpectedContentTypeError(endpoint, response, text));
          continue;
        }

        try {
          const data = JSON.parse(text) as CompletionResponse;
          await this.trackUsage(role, data);
          return data;
        } catch {
          lastError = rememberError(lastError, `Chat API 返回了无法解析的 JSON：${text.slice(0, 160)}`);
        }
      }

      if (!preferMessages && !plan.openAiV1Only) {
        try {
          const data = await this.requestMessagesCompletion(
            config,
            messages,
            body.max_tokens,
            body.temperature,
            controller.signal,
            undefined,
            body.stop,
            plan.messagesEndpoints,
          );
          await this.trackUsage(role, data);
          return data;
        } catch (error) {
          lastError = rememberError(lastError, normalizeRequestError(error).message);
        }
      }

      try {
        const data = await this.requestResponsesCompletion(
          config,
          messages,
          body.max_tokens,
          controller.signal,
          undefined,
          plan.responsesEndpoints,
        );
        await this.trackUsage(role, data);
        return data;
      } catch (error) {
        lastError = rememberError(lastError, normalizeRequestError(error).message);
      }

      throw new Error(lastError || 'Chat API 请求失败，请检查 API Base URL。');
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(requestId);
    }
  }

  /** Streaming completion - yields chunks */
  async *stream(
    role: ModelRole,
    messages: ChatMessage[],
    options: Partial<CompletionRequest> = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const config = await this.getConfig(role);
    this.validateConfig(config);

    const requestId = `${role}-${Date.now()}`;
    const controller = new AbortController();
    const timeout = createTimeoutSignal(controller, timeoutMs);
    this.abortControllers.set(requestId, controller);

    try {
      const body: CompletionRequest = {
        messages,
        model: config.modelId,
        temperature: options.temperature ?? config.temperature,
        max_tokens: options.max_tokens ?? config.maxTokens,
        ...options,
        stream: true,
      };

      let lastError = '';
      const plan = this.textRequestPlan(config);
      const { preferMessages } = plan;
      if (preferMessages) {
        const messagesResult = yield* this.pipeMessagesStream(
          config,
          messages,
          body.max_tokens,
          body.temperature,
          controller.signal,
          body.stop,
          plan.messagesEndpoints,
        );
        if (messagesResult.started) return;
        lastError = rememberError(lastError, messagesResult.error);
        if (plan.claudeOnly) throw new Error(lastError || 'Messages API 请求失败。');
      }

      for (const endpoint of plan.chatEndpoints) {
        let response: Response;
        try {
          response = await fetchWithRetry(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          lastError = rememberError(lastError, normalizeRequestError(error).message);
          continue;
        }

        if (!response.ok) {
          const failure = await readApiFailure(response, endpoint);
          lastError = rememberError(lastError, failure);
          if (!shouldTryNextTextEndpoint(response.status, failure)) throw new Error(lastError);
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        if (/text\/html/i.test(contentType)) {
          const text = await response.text().catch(() => '');
          lastError = rememberError(lastError, this.formatUnexpectedContentTypeError(endpoint, response, text));
          continue;
        }

        if (/application\/json/i.test(contentType)) {
          const text = await response.text();
          try {
            const data = JSON.parse(text) as CompletionResponse;
            yield this.completionToStreamChunk(role, data);
            return;
          } catch {
            lastError = rememberError(lastError, `Chat API 返回了无法解析的 JSON：${text.slice(0, 160)}`);
            continue;
          }
        }

        const reader = response.body?.getReader();
        if (!reader) {
          lastError = rememberError(lastError, 'Chat API 没有返回响应体。');
          continue;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let sawSseFrame = false;
        let emittedChunk = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            sawSseFrame = true;
            const data = trimmed.slice(5).trimStart();
            if (data === '[DONE]') return;

            try {
              const chunk: StreamChunk = JSON.parse(data);
              emittedChunk = true;
              yield chunk;
            } catch {
              // Skip malformed chunks
            }
          }
        }

        if (sawSseFrame || emittedChunk) return;

        if (buffer.trim()) {
          try {
            const data = JSON.parse(buffer.trim()) as CompletionResponse;
            yield this.completionToStreamChunk(role, data);
            return;
          } catch {
            lastError = rememberError(lastError, this.formatUnexpectedContentTypeError(endpoint, response, buffer));
            continue;
          }
        }
      }

      if (!preferMessages && !plan.openAiV1Only) {
        const messagesResult = yield* this.pipeMessagesStream(
          config,
          messages,
          body.max_tokens,
          body.temperature,
          controller.signal,
          body.stop,
          plan.messagesEndpoints,
        );
        if (messagesResult.started) return;
        if (messagesResult.error) lastError = rememberError(lastError, messagesResult.error);
      }

      try {
        const data = await this.requestResponsesCompletion(
          config,
          messages,
          body.max_tokens,
          controller.signal,
          undefined,
          plan.responsesEndpoints,
        );
        yield this.completionToStreamChunk(role, data);
        return;
      } catch (error) {
        lastError = rememberError(lastError, normalizeRequestError(error).message);
      }

      throw new Error(lastError || 'Chat API 请求失败，请检查 API Base URL。');
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(requestId);
    }
  }

  /** Collect full streaming response into a string */
  async streamToString(
    role: ModelRole,
    messages: ChatMessage[],
    options: Partial<CompletionRequest> = {},
    onChunk?: (text: string, fullText: string) => void,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<string> {
    let fullText = '';
    const promptChars = messages.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + m.content.length;
      if (Array.isArray(m.content)) {
        return sum + m.content.reduce((partSum, part) => partSum + (part.text?.length || 0) + (part.image_url?.url.length || 0), 0);
      }
      return sum;
    }, 0);

    let trackedApiUsage = false;
    for await (const chunk of this.stream(role, messages, options, timeoutMs)) {
      if (chunk.usage) {
        await this.trackUsage(role, chunk as CompletionResponse);
        trackedApiUsage = true;
      }
      const delta = this.extractStreamChunkText(chunk);
      if (delta) {
        fullText += delta;
        onChunk?.(delta, fullText);
      }
    }

    if (!fullText.trim()) {
      console.warn('[Doc Copilot] Streaming response was empty; retrying without stream.');
      try {
        const fallback = await this.complete(role, messages, {
          ...options,
          stream: false,
        });
        const fallbackText = this.extractCompletionText(fallback);
        if (fallbackText.trim()) {
          onChunk?.(fallbackText, fallbackText);
          return fallbackText;
        }
        if (this.hasReasoningOnlyContent(fallback)) {
          console.warn('[Doc Copilot] Model returned reasoning content but no final answer.');
        }
      } catch (error) {
        console.warn('[Doc Copilot] Non-stream fallback failed:', error);
      }
    }

    // Estimate tokens for streaming (API doesn't return usage for streams)
    if (!trackedApiUsage) {
      await this.estimateStreamTokens(role, promptChars, fullText.length);
    }

    return fullText;
  }

  private extractStreamChunkText(chunk: StreamChunk): string {
    const raw = chunk as unknown as Record<string, unknown>;
    const choice = chunk.choices?.[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    const message = choice?.message as ChatMessage | undefined;

    return this.toText(delta?.content)
      || this.toText(delta?.text)
      || chatContentToText(message?.content)
      || this.toText(choice?.text)
      || this.toText(raw.content)
      || this.toText(raw.text)
      || this.toText(raw.answer)
      || this.toText(raw.result)
      || '';
  }

  private extractCompletionText(response: CompletionResponse): string {
    const raw = response as unknown as Record<string, unknown>;
    const choice = response.choices?.[0] as unknown as Record<string, unknown> | undefined;
    const message = choice?.message as ChatMessage | undefined;

    return chatContentToText(message?.content)
      || this.toText(choice?.text)
      || this.toText(raw.output_text)
      || this.toText(raw.content)
      || this.toText(raw.answer)
      || this.toText(raw.result)
      || '';
  }

  private hasReasoningOnlyContent(response: CompletionResponse): boolean {
    const choice = response.choices?.[0] as unknown as Record<string, unknown> | undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    return Boolean(
      !this.extractCompletionText(response).trim()
      && (
        this.toText(message?.reasoning_content).trim()
        || this.toText(message?.reasoning).trim()
        || this.toText(choice?.reasoning_content).trim()
      ),
    );
  }

  private toText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return chatContentToText(value);
    return '';
  }

  private completionToStreamChunk(role: ModelRole, data: CompletionResponse): StreamChunk {
    return {
      id: data.id || `${role}-non-stream`,
      usage: data.usage,
      choices: (data.choices ?? []).map(choice => ({
        index: choice.index,
        delta: {
          role: choice.message?.role,
          content: chatContentToText(choice.message?.content),
        },
        message: choice.message,
        finish_reason: choice.finish_reason,
      })),
    };
  }

  private completionToToolResult(data: CompletionResponse): {
    content: string | null;
    tool_calls?: ToolCall[];
    finish_reason: string;
  } {
    const choice = data.choices[0];
    return {
      content: chatContentToText(choice?.message?.content) || null,
      tool_calls: choice?.message?.tool_calls,
      finish_reason: choice?.finish_reason ?? 'stop',
    };
  }

  private resolveBuiltinTextProtocol(modelId: string): 'anthropic-messages' | 'openai-v1' | 'compatible' {
    const id = modelId.trim().toLowerCase();
    if (!id) return 'compatible';
    if (id.includes('claude')) return 'anthropic-messages';
    if (id.includes('gpt') || id.includes('grok') || /(?:^|[/:._-])o[1-4](?:$|[/:._-])/.test(id)) {
      return 'openai-v1';
    }
    return 'compatible';
  }

  private textRequestPlan(config: ModelConfig): {
    claudeOnly: boolean;
    openAiV1Only: boolean;
    preferMessages: boolean;
    messagesEndpoints?: string[];
    chatEndpoints: string[];
    responsesEndpoints?: string[];
  } {
    const protocol = this.resolveBuiltinTextProtocol(config.modelId);
    const claudeOnly = protocol === 'anthropic-messages';
    const openAiV1Only = protocol === 'openai-v1';
    const openAiRoot = openAiV1Only ? this.openAiV1Root(config.baseUrl) : '';
    return {
      claudeOnly,
      openAiV1Only,
      preferMessages: claudeOnly || (!openAiV1Only && this.prefersMessagesProtocol(config.baseUrl)),
      messagesEndpoints: claudeOnly ? this.claudeMessagesEndpointCandidates(config.baseUrl) : undefined,
      chatEndpoints: claudeOnly
        ? []
        : openAiV1Only
          ? [`${openAiRoot}/chat/completions`]
          : this.getChatCompletionEndpointCandidates(config.baseUrl),
      responsesEndpoints: openAiV1Only ? [`${openAiRoot}/responses`] : undefined,
    };
  }

  private stripKnownApiSuffix(baseUrl: string): string {
    return baseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/i, '')
      .replace(/\/(?:completions|responses|messages)$/i, '')
      .replace(/\/+$/, '');
  }

  /** Claude gateways expose /messages on the host root, never under /v1. */
  private claudeMessagesEndpoint(baseUrl: string): string {
    const explicit = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1\/messages$/i, '/messages');
    if (/\/messages$/i.test(explicit)) return explicit;
    const root = this.stripKnownApiSuffix(baseUrl).replace(/\/v1$/i, '').replace(/\/+$/, '');
    return `${root}/messages`;
  }

  /** GPT and Grok gateways mount OpenAI routes under /v1. */
  private openAiV1Root(baseUrl: string): string {
    const root = this.stripKnownApiSuffix(baseUrl);
    return /\/v1$/i.test(root) ? root : `${root}/v1`;
  }

  private prefersMessagesProtocol(baseUrl: string): boolean {
    return /\/messages$/i.test(baseUrl.trim().replace(/\/+$/, ''));
  }

  private getMessagesEndpointCandidates(baseUrl: string): string[] {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');
    if (/\/messages$/i.test(trimmed)) return [trimmed];
    const root = trimmed.replace(/\/(chat\/completions|completions|responses)$/i, '');
    if (/\/v1$/i.test(root)) return [`${root}/messages`];
    // Bare /messages on OneAPI-style gateways is the web console and redirects to login.
    return Array.from(new Set([`${root}/v1/messages`, `${root}/messages`]));
  }

  private claudeMessagesEndpointCandidates(baseUrl: string): string[] {
    const primary = this.claudeMessagesEndpoint(baseUrl);
    const withV1 = primary.replace(/\/messages$/i, '/v1/messages');
    return withV1 === primary ? [primary] : [primary, withV1];
  }

  private anthropicHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  private async requestMessagesCompletion(
    config: ModelConfig,
    messages: ChatMessage[],
    maxTokens: number | undefined,
    temperature: number | undefined,
    signal: AbortSignal,
    tools?: object[],
    stop?: string[],
    endpoints?: string[],
  ): Promise<CompletionResponse> {
    const body = this.buildAnthropicBody(config, messages, maxTokens, temperature, false, tools, stop);
    let lastError = '';

    for (const endpoint of endpoints ?? this.getMessagesEndpointCandidates(config.baseUrl)) {
      let response: Response;
      try {
        response = await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: this.anthropicHeaders(config.apiKey),
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        lastError = rememberError(lastError, normalizeRequestError(error).message);
        continue;
      }

      if (!response.ok) {
        const failure = await readApiFailure(response, endpoint);
          lastError = rememberError(lastError, failure);
          if (!shouldTryNextTextEndpoint(response.status, failure)) throw new Error(lastError);
        continue;
      }

      const text = await response.text();
      if (!this.isJsonLikeResponse(response, text)) {
        lastError = rememberError(lastError, this.formatUnexpectedContentTypeError(endpoint, response, text));
        continue;
      }

      try {
        const raw = JSON.parse(text) as Record<string, unknown>;
        this.throwIfMessagesError(raw);
        if (Array.isArray(raw.choices)) return raw as unknown as CompletionResponse;
        return this.anthropicToCompletion(raw);
      } catch (error) {
        lastError = error instanceof SyntaxError
          ? `Messages API 返回了无法解析的 JSON：${text.slice(0, 160)}`
          : normalizeRequestError(error).message;
      }
    }

    throw new Error(lastError || 'Messages API 请求失败。');
  }

  private async *pipeMessagesStream(
    config: ModelConfig,
    messages: ChatMessage[],
    maxTokens: number | undefined,
    temperature: number | undefined,
    signal: AbortSignal,
    stop?: string[],
    endpoints?: string[],
  ): AsyncGenerator<StreamChunk, { started: boolean; error: string }, undefined> {
    let started = false;
    try {
      for await (const chunk of this.streamMessagesCompletion(config, messages, maxTokens, temperature, signal, stop, endpoints)) {
        started = true;
        yield chunk;
      }
      return { started, error: started ? '' : 'Messages API 返回了空响应。' };
    } catch (error) {
      if (started) throw error;
      return { started: false, error: normalizeRequestError(error).message };
    }
  }

  private async *streamMessagesCompletion(
    config: ModelConfig,
    messages: ChatMessage[],
    maxTokens: number | undefined,
    temperature: number | undefined,
    signal: AbortSignal,
    stop?: string[],
    endpoints?: string[],
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const body = this.buildAnthropicBody(config, messages, maxTokens, temperature, true, undefined, stop);
    let lastError = '';

    for (const endpoint of endpoints ?? this.getMessagesEndpointCandidates(config.baseUrl)) {
      let yielded = false;
      try {
        const response = await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: this.anthropicHeaders(config.apiKey),
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          const failure = await readApiFailure(response, endpoint);
          lastError = rememberError(lastError, failure);
          if (!shouldTryNextTextEndpoint(response.status, failure)) throw new Error(lastError);
          continue;
        }

        for await (const chunk of this.readMessagesResponse(response, endpoint)) {
          yielded = true;
          yield chunk;
        }
        if (yielded) return;
        lastError = `Messages API endpoint ${endpoint} 返回了空响应。`;
      } catch (error) {
        if (yielded) throw error;
        lastError = rememberError(lastError, normalizeRequestError(error).message);
      }
    }

    throw new Error(lastError || 'Messages API 请求失败。');
  }

  private async *readMessagesResponse(response: Response, endpoint: string): AsyncGenerator<StreamChunk> {
    const contentType = response.headers.get('content-type') || '';
    if (/text\/html/i.test(contentType)) {
      const text = await response.text().catch(() => '');
      throw new Error(this.formatUnexpectedContentTypeError(endpoint, response, text));
    }

    if (/application\/json/i.test(contentType)) {
      const text = await response.text();
      yield this.messagesPayloadToChunk(text);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Messages API 没有返回响应体。');

    const decoder = new TextDecoder();
    let buffer = '';
    let messageId = 'messages-stream';
    let sawFrame = false;
    let pendingUsage: CompletionResponse['usage'] | undefined;
    let emittedUsage = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trimStart();
        if (!data || data === '[DONE]') continue;
        sawFrame = true;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.throwIfMessagesError(event);
        if (Array.isArray(event.choices)) {
          const chunk = event as unknown as StreamChunk;
          if (chunk.id) messageId = chunk.id;
          yield chunk;
          continue;
        }

        const type = this.toText(event.type);
        if (type === 'message_start') {
          const message = event.message as Record<string, unknown> | undefined;
          messageId = this.toText(message?.id) || messageId;
          pendingUsage = this.mergeUsage(pendingUsage, this.anthropicUsage(message?.usage));
        } else if (type === 'content_block_start') {
          const block = event.content_block as Record<string, unknown> | undefined;
          const text = block?.type === 'text' ? this.toText(block.text) : '';
          if (text) yield this.messagesTextChunk(messageId, text);
        } else if (type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined;
          const deltaType = this.toText(delta?.type);
          if (deltaType === 'thinking_delta' || deltaType === 'signature_delta' || deltaType === 'input_json_delta') continue;
          const text = this.toText(delta?.text);
          if (text) yield this.messagesTextChunk(messageId, text);
        } else if (type === 'message_delta') {
          const delta = event.delta as Record<string, unknown> | undefined;
          pendingUsage = this.mergeUsage(pendingUsage, this.anthropicUsage(event.usage));
          emittedUsage = true;
          yield {
            id: messageId,
            usage: pendingUsage,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: this.mapAnthropicStopReason(this.toText(delta?.stop_reason)),
            }],
          };
        } else if (!type && (typeof event.content === 'string' || Array.isArray(event.content))) {
          yield this.completionToStreamChunk('smart', this.anthropicToCompletion(event));
        }
      }
    }

    if (!sawFrame && buffer.trim()) {
      yield this.messagesPayloadToChunk(buffer.trim());
      return;
    }
    if (pendingUsage && !emittedUsage) {
      yield {
        id: messageId,
        usage: pendingUsage,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
    }
  }

  private messagesPayloadToChunk(text: string): StreamChunk {
    const raw = JSON.parse(text) as Record<string, unknown>;
    this.throwIfMessagesError(raw);
    if (Array.isArray(raw.choices)) return raw as unknown as StreamChunk;
    return this.completionToStreamChunk('smart', this.anthropicToCompletion(raw));
  }

  private messagesTextChunk(id: string, text: string): StreamChunk {
    return {
      id,
      choices: [{
        index: 0,
        delta: { content: text },
        finish_reason: null,
      }],
    };
  }

  private buildAnthropicBody(
    config: ModelConfig,
    messages: ChatMessage[],
    maxTokens: number | undefined,
    temperature: number | undefined,
    stream: boolean,
    tools?: object[],
    stop?: string[],
  ): Record<string, unknown> {
    const converted = this.toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: config.modelId,
      max_tokens: Math.max(1, Math.floor(maxTokens ?? config.maxTokens ?? 1024)),
      messages: converted.messages,
      stream,
    };
    if (converted.system) body.system = converted.system;
    if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature;
    if (stop?.length) body.stop_sequences = stop;
    if (tools?.length) {
      body.tools = this.toolsToAnthropicFormat(tools);
      body.tool_choice = { type: 'auto' };
    }
    return body;
  }

  private toAnthropicMessages(messages: ChatMessage[]): {
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }>;
  } {
    const systemParts: string[] = [];
    const turns: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

    for (const message of messages) {
      if (message.role === 'system') {
        const text = chatContentToText(message.content).trim();
        if (text) systemParts.push(text);
        continue;
      }

      if (message.role === 'tool') {
        const block = {
          type: 'tool_result',
          tool_use_id: message.tool_call_id || '',
          content: chatContentToText(message.content),
        };
        const last = turns[turns.length - 1];
        if (last?.role === 'user') last.content.push(block);
        else turns.push({ role: 'user', content: [block] });
        continue;
      }

      const blocks = this.toAnthropicBlocks(message);
      if (!blocks.length) continue;
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const last = turns[turns.length - 1];
      if (last?.role === role) last.content.push(...blocks);
      else turns.push({ role, content: blocks });
    }

    if (!turns.length) {
      turns.push({
        role: 'user',
        content: [{ type: 'text', text: systemParts.join('\n\n') || '请继续。' }],
      });
    } else if (turns[0].role !== 'user') {
      turns.unshift({ role: 'user', content: [{ type: 'text', text: '请根据以上内容继续。' }] });
    }

    const normalized = turns
      .map(turn => {
        const textOnly = turn.content.every(block => block.type === 'text' && typeof block.text === 'string');
        if (!textOnly) return { role: turn.role, content: turn.content };
        return {
          role: turn.role,
          content: turn.content.map(block => String(block.text)).join('\n'),
        };
      })
      .filter(turn => typeof turn.content === 'string' ? turn.content.trim().length > 0 : turn.content.length > 0);

    if (!normalized.length || normalized[0].role !== 'user') {
      normalized.unshift({ role: 'user', content: '请继续。' });
    }

    return {
      system: systemParts.join('\n\n') || undefined,
      messages: normalized,
    };
  }

  private toAnthropicBlocks(message: ChatMessage): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    if (typeof message.content === 'string') {
      if (message.content) blocks.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const image = this.toAnthropicImageBlock(part.image_url.url);
          if (image) blocks.push(image);
        }
      }
    }

    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: this.parseToolInput(call.function.arguments),
      });
    }
    return blocks;
  }

  private toAnthropicImageBlock(url: string): Record<string, unknown> | null {
    const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
    if (dataUrl) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: dataUrl[1] || 'image/png',
          data: dataUrl[2],
        },
      };
    }
    if (/^https?:\/\//i.test(url)) {
      return { type: 'image', source: { type: 'url', url } };
    }
    return null;
  }

  private parseToolInput(raw: string | undefined): unknown {
    if (!raw?.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }

  private toolsToAnthropicFormat(tools: object[]): object[] {
    return tools.map(tool => {
      const value = tool as { type?: string; function?: { name?: string; description?: string; parameters?: object } };
      if (value.type === 'function' && value.function?.name) {
        return {
          name: value.function.name,
          description: value.function.description || '',
          input_schema: value.function.parameters || { type: 'object', properties: {} },
        };
      }
      return tool;
    });
  }

  private anthropicToCompletion(raw: Record<string, unknown>): CompletionResponse {
    const contentBlocks = Array.isArray(raw.content) ? raw.content as Array<Record<string, unknown>> : [];
    const text = contentBlocks
      .filter(part => part.type === 'text')
      .map(part => this.toText(part.text))
      .filter(Boolean)
      .join('')
      || (typeof raw.content === 'string' ? raw.content : '');
    const toolCalls = contentBlocks
      .filter(part => part.type === 'tool_use' && typeof part.name === 'string')
      .map(part => ({
        id: this.toText(part.id) || `messages-tool-${Date.now()}`,
        type: 'function' as const,
        function: {
          name: this.toText(part.name),
          arguments: this.toolInputToArguments(part.input),
        },
      }));
    return {
      id: this.toText(raw.id) || 'messages-fallback',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.length ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length
          ? 'tool_calls'
          : this.mapAnthropicStopReason(this.toText(raw.stop_reason)),
      }],
      usage: this.anthropicUsage(raw.usage),
    };
  }

  private toolInputToArguments(input: unknown): string {
    if (typeof input === 'string' && input.trim()) return input;
    if (input && typeof input === 'object') return JSON.stringify(input);
    return '{}';
  }

  private mergeUsage(
    base: CompletionResponse['usage'] | undefined,
    extra: CompletionResponse['usage'] | undefined,
  ): CompletionResponse['usage'] | undefined {
    if (!base) return extra;
    if (!extra) return base;
    const promptTokens = extra.prompt_tokens || base.prompt_tokens;
    const completionTokens = extra.completion_tokens || base.completion_tokens;
    const cachedTokens = extra.prompt_tokens_details?.cached_tokens || base.prompt_tokens_details?.cached_tokens || 0;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: extra.total_tokens || base.total_tokens || promptTokens + completionTokens,
      ...(cachedTokens ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    };
  }

  private anthropicUsage(raw: unknown): CompletionResponse['usage'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const usage = raw as Record<string, unknown>;
    const promptTokens = safeUsageNumber(usage.input_tokens ?? usage.prompt_tokens);
    const completionTokens = safeUsageNumber(usage.output_tokens ?? usage.completion_tokens);
    const totalTokens = safeUsageNumber(usage.total_tokens) || promptTokens + completionTokens;
    if (!promptTokens && !completionTokens && !totalTokens) return undefined;
    const cachedTokens = safeUsageNumber(usage.cache_read_input_tokens ?? usage.cached_tokens);
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      ...(cachedTokens ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    };
  }

  private mapAnthropicStopReason(stopReason: string): string {
    if (stopReason === 'tool_use') return 'tool_calls';
    if (stopReason === 'max_tokens') return 'length';
    if (!stopReason || stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'stop';
    return stopReason;
  }

  private throwIfMessagesError(raw: Record<string, unknown>): void {
    if (this.toText(raw.type) !== 'error') return;
    const error = raw.error as Record<string, unknown> | undefined;
    throw new Error(this.toText(error?.message) || this.toText(raw.message) || 'Messages API 请求失败。');
  }

  private getChatCompletionEndpointCandidates(baseUrl: string): string[] {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(trimmed)) return [trimmed];
    if (/\/v1$/i.test(trimmed)) return [`${trimmed}/chat/completions`];
    return [`${trimmed}/v1/chat/completions`, `${trimmed}/chat/completions`];
  }

  private getResponsesEndpointCandidates(baseUrl: string): string[] {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');
    if (/\/responses$/i.test(trimmed)) return [trimmed];
    const root = trimmed.replace(/\/(chat\/completions|completions|messages)$/i, '');
    if (/\/v1$/i.test(root)) return [`${root}/responses`];
    // host/responses is the OneAPI console and returns a login page. The API is /v1/responses.
    return [`${root}/v1/responses`];
  }

  private async requestResponsesCompletion(
    config: ModelConfig,
    messages: ChatMessage[],
    maxOutputTokens: number | undefined,
    signal: AbortSignal,
    tools?: object[],
    endpoints?: string[],
  ): Promise<CompletionResponse> {
    const body = {
      model: config.modelId,
      input: this.messagesToResponsesInput(messages),
      max_output_tokens: maxOutputTokens ?? config.maxTokens,
      ...(tools?.length ? { tools: this.toolsToResponsesFormat(tools) } : {}),
    };
    let lastError = '';

    for (const endpoint of endpoints ?? this.getResponsesEndpointCandidates(config.baseUrl)) {
      let response: Response;
      try {
        response = await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        lastError = rememberError(lastError, normalizeRequestError(error).message);
        continue;
      }
      if (!response.ok) {
        const failure = await readApiFailure(response, endpoint);
          lastError = rememberError(lastError, failure);
          if (!shouldTryNextTextEndpoint(response.status, failure)) throw new Error(lastError);
        continue;
      }
      const text = await response.text();
      if (!this.isJsonLikeResponse(response, text)) {
        lastError = rememberError(lastError, this.formatUnexpectedContentTypeError(endpoint, response, text));
        continue;
      }
      try {
        return this.responsesToCompletion(JSON.parse(text));
      } catch {
        lastError = `Responses API 返回了无法解析的 JSON：${text.slice(0, 160)}`;
      }
    }
    throw new Error(lastError || 'Responses API 请求失败。');
  }

  private messagesToResponsesInput(messages: ChatMessage[]): string {
    return messages.map(message => {
      const role = message.role.toUpperCase();
      const text = chatContentToText(message.content);
      const imageNotes = Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'image_url').map(part => `[图片: ${part.image_url?.url || ''}]`).join('\n')
        : '';
      return `[${role}]\n${[text, imageNotes].filter(Boolean).join('\n')}`;
    }).join('\n\n');
  }

  private responsesToCompletion(raw: Record<string, unknown>): CompletionResponse {
    const output = Array.isArray(raw.output) ? raw.output as Array<Record<string, unknown>> : [];
    const content = output.flatMap(item => Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []);
    const text = content.map(part => this.toText(part.text)).filter(Boolean).join('');
    const toolCalls = output
      .filter(item => item.type === 'function_call' && typeof item.name === 'string')
      .map(item => ({
        id: this.toText(item.call_id) || this.toText(item.id) || `responses-tool-${Date.now()}`,
        type: 'function' as const,
        function: {
          name: this.toText(item.name),
          arguments: this.toText(item.arguments) || '{}',
        },
      }));
    const usage = raw.usage as Record<string, unknown> | undefined;
    return {
      id: this.toText(raw.id) || 'responses-fallback',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined },
        finish_reason: toolCalls.length ? 'tool_calls' : (this.toText(raw.status) === 'completed' ? 'stop' : this.toText(raw.status) || 'stop'),
      }],
      usage: usage ? {
        prompt_tokens: safeUsageNumber(usage.input_tokens),
        completion_tokens: safeUsageNumber(usage.output_tokens),
        total_tokens: safeUsageNumber(usage.total_tokens),
      } : undefined,
    };
  }

  private toolsToResponsesFormat(tools: object[]): object[] {
    return tools.map(tool => {
      const value = tool as { type?: string; function?: { name?: string; description?: string; parameters?: object } };
      if (value.type === 'function' && value.function?.name) {
        return {
          type: 'function',
          name: value.function.name,
          description: value.function.description || '',
          parameters: value.function.parameters || { type: 'object', properties: {} },
        };
      }
      return tool;
    });
  }

  private isJsonLikeResponse(response: Response, text: string): boolean {
    const contentType = response.headers.get('content-type') || '';
    const trimmed = text.trim();
    return /application\/json/i.test(contentType)
      || trimmed.startsWith('{')
      || trimmed.startsWith('[');
  }

  private formatUnexpectedContentTypeError(endpoint: string, response: Response, text: string): string {
    const contentType = response.headers.get('content-type') || 'unknown';
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (/text\/html/i.test(contentType) || /^<!doctype html/i.test(preview) || /^<html/i.test(preview)) {
      return `Chat API endpoint ${endpoint} 返回了 HTML 页面，不是模型响应。请确认 API Base URL 是否需要 /v1。`;
    }
    return `Chat API endpoint ${endpoint} 返回了非 JSON/SSE 响应（${contentType}）：${preview || response.statusText}`;
  }

  /**
   * Non-streaming completion with tool/function calling support.
   * Returns content (may be null when finish_reason is 'tool_calls'),
   * any tool_calls the model wants to make, and the finish_reason.
   */
  async completeWithTools(
    role: ModelRole,
    messages: ChatMessage[],
    tools: object[],
    options: Partial<CompletionRequest> = {},
  ): Promise<{
    content: string | null;
    tool_calls?: ToolCall[];
    finish_reason: string;
  }> {
    const config = await this.getConfig(role);
    this.validateConfig(config);

    const requestId = `${role}-tools-${Date.now()}`;
    const controller = new AbortController();
    const timeout = createTimeoutSignal(controller);
    this.abortControllers.set(requestId, controller);

    try {
      const body = {
        messages,
        model: config.modelId,
        temperature: options.temperature ?? config.temperature,
        max_tokens: options.max_tokens ?? config.maxTokens,
        stream: false,
        tools,
        tool_choice: 'auto',
      };

      let lastError = '';
      const plan = this.textRequestPlan(config);
      const { preferMessages } = plan;
      const maxTokens = options.max_tokens ?? config.maxTokens;
      const temperature = options.temperature ?? config.temperature;
      if (preferMessages) {
        try {
          const data = await this.requestMessagesCompletion(
            config,
            messages,
            maxTokens,
            temperature,
            controller.signal,
            tools,
            options.stop,
            plan.messagesEndpoints,
          );
          await this.trackUsage(role, data);
          return this.completionToToolResult(data);
        } catch (error) {
          lastError = rememberError(lastError, normalizeRequestError(error).message);
          if (plan.claudeOnly) throw new Error(lastError || 'Messages API 请求失败。');
        }
      }

      for (const endpoint of plan.chatEndpoints) {
        let response: Response;
        try {
          response = await fetchWithRetry(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          lastError = rememberError(lastError, normalizeRequestError(error).message);
          continue;
        }

        if (!response.ok) {
          const failure = await readApiFailure(response, endpoint);
          lastError = rememberError(lastError, failure);
          if (!shouldTryNextTextEndpoint(response.status, failure)) throw new Error(lastError);
          continue;
        }

        const text = await response.text();
        if (!this.isJsonLikeResponse(response, text)) {
          lastError = rememberError(lastError, this.formatUnexpectedContentTypeError(endpoint, response, text));
          continue;
        }

        try {
          const data = JSON.parse(text) as CompletionResponse;
          await this.trackUsage(role, data);
          return this.completionToToolResult(data);
        } catch {
          lastError = rememberError(lastError, `Chat API 返回了无法解析的 JSON：${text.slice(0, 160)}`);
        }
      }

      if (!preferMessages && !plan.openAiV1Only) {
        try {
          const data = await this.requestMessagesCompletion(
            config,
            messages,
            maxTokens,
            temperature,
            controller.signal,
            tools,
            options.stop,
            plan.messagesEndpoints,
          );
          await this.trackUsage(role, data);
          return this.completionToToolResult(data);
        } catch (error) {
          lastError = rememberError(lastError, normalizeRequestError(error).message);
        }
      }

      try {
        const data = await this.requestResponsesCompletion(
          config,
          messages,
          options.max_tokens ?? config.maxTokens,
          controller.signal,
          tools,
          plan.responsesEndpoints,
        );
        await this.trackUsage(role, data);
        const choice = data.choices[0];
        return {
          content: chatContentToText(choice?.message?.content) || null,
          tool_calls: choice?.message?.tool_calls,
          finish_reason: choice?.finish_reason ?? 'stop',
        };
      } catch (error) {
        lastError = rememberError(lastError, normalizeRequestError(error).message);
      }

      throw new Error(lastError || 'Chat API 请求失败，请检查 API Base URL。');
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(requestId);
    }
  }

  /** Abort all pending requests for a role */
  abort(role?: ModelRole): void {
    for (const [key, controller] of this.abortControllers) {
      if (!role || key.startsWith(role)) {
        controller.abort();
        this.abortControllers.delete(key);
      }
    }
  }

  /** Abort all requests */
  abortAll(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  /**
   * Call OpenAI-compatible image generations endpoint.
   * Returns the URL of the generated image.
   */
  async generateImage(prompt: string, options: { n?: number; size?: string } = {}): Promise<string> {
    const settings = await settingsStorage.get();
    const config = this.resolveImageConfig(settings);
    this.validateConfig(config);
    const size = options.size ?? settings.imageGenerationSize ?? '1024x1024';

    let lastError = '';
    let fatalError = '';
    let produced: string | null = null;
    endpointLoop:
    for (const endpoint of this.getImageEndpointCandidates(config.baseUrl)) {
      for (const requestBase64 of [true, false]) {
      const controller = new AbortController();
      const timeout = createTimeoutSignal(controller, IMAGE_REQUEST_TIMEOUT_MS);
      try {
        const body: Record<string, unknown> = {
          model: config.modelId,
          prompt,
          n: options.n ?? 1,
          size,
        };
        if (requestBase64) body.response_format = 'b64_json';
        const response = await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) {
          const message = await parseApiError(response);
          if (response.status === 401 || response.status === 403) {
            fatalError = message;
            break endpointLoop;
          }
          lastError = rememberError(lastError, message);
          if (requestBase64 && response.status === 400 && /response_format|unknown|unexpected|unrecognized|invalid/i.test(message)) {
            continue;
          }
          break;
        }

        const text = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          lastError = rememberError(lastError, '图像接口返回了无法解析的内容');
          continue;
        }
        const image = extractGeneratedImage(data);
        if (!image) {
          lastError = rememberError(lastError, '图像接口没有返回图片');
          break;
        }
        await this.trackImageUsage((data as { usage?: unknown }).usage);
        produced = image;
        break endpointLoop;
      } catch (error) {
        if (isAbortError(error)) {
          throw new Error('图像接口超过 2 分钟没有返回，已停止等待。请稍后重试。');
        }
        lastError = rememberError(lastError, normalizeRequestError(error).message);
      } finally {
        clearTimeout(timeout);
      }
      }
    }

    if (produced) return this.materializeGeneratedImage(produced, config.apiKey);
    if (fatalError) throw new Error(explainImageGenerationError(fatalError));

    try {
      return await this.generateImageViaChat(config, prompt, size);
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error('图像接口超过 2 分钟没有返回，已停止等待。请稍后重试。');
      }
      const merged = rememberError(lastError, normalizeRequestError(error).message);
      throw new Error(explainImageGenerationError(merged));
    }
  }

  private async generateImageViaChat(config: ModelConfig, prompt: string, size: string): Promise<string> {
    const body = {
      model: config.modelId,
      messages: [{
        role: 'user',
        content: `请根据下面的描述生成一张图片，直接返回图片。\n图片尺寸：${size}。\n\n${prompt}`,
      }],
      stream: false,
    };
    let lastError = '';
    for (const endpoint of this.getChatCompletionEndpointCandidates(config.baseUrl)) {
      const controller = new AbortController();
      const timeout = createTimeoutSignal(controller, IMAGE_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetchWithRetry(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const message = await parseApiError(response);
          if (response.status === 401 || response.status === 403) {
            throw new Error(message);
          }
          lastError = rememberError(lastError, message);
          continue;
        }
        const text = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          lastError = rememberError(lastError, '对话生图接口返回了无法解析的内容');
          continue;
        }
        const image = extractGeneratedImage(data);
        if (!image) {
          lastError = rememberError(lastError, '对话接口没有返回图片');
          continue;
        }
        await this.trackImageUsage((data as { usage?: unknown }).usage);
        return this.materializeGeneratedImage(image, config.apiKey);
      } catch (error) {
        if (isAbortError(error) || /^API 错误 40[13]\b/.test((error as Error).message || '')) throw error;
        lastError = rememberError(lastError, normalizeRequestError(error).message);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(lastError || '对话接口没有返回图片');
  }

  private async materializeGeneratedImage(image: string, apiKey: string): Promise<string> {
    if (image.startsWith('data:image/')) {
      debugLog('info', 'image.materialized', { kind: 'data', chars: image.length });
      return image;
    }
    if (!/^https?:\/\//i.test(image)) {
      throw new Error('图像接口返回的不是可显示的图片');
    }
    let host = '';
    try { host = new URL(image).host; } catch { host = ''; }
    const headers: Record<string, string> = { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' };
    let response = await fetch(image, { headers });
    if (response.status === 401 || response.status === 403) {
      response = await fetch(image, {
        headers: { ...headers, Authorization: `Bearer ${apiKey}` },
      });
    }
    if (!response.ok) {
      throw new Error(`图片下载失败：HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type && !type.startsWith('image/') && type !== 'application/octet-stream') {
      throw new Error(`图片下载结果不是图片（${type || 'unknown'}）`);
    }
    const mime = type.startsWith('image/') ? type : sniffImageMime(bytes);
    debugLog('info', 'image.materialized', { kind: 'url', host, chars: bytes.length, mime });
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }

  private async getImageConfig(): Promise<ModelConfig> {
    const settings = await settingsStorage.get();
    return this.resolveImageConfig(settings);
  }

  private resolveImageConfig(settings: AppSettings): ModelConfig {
    const image = settings.models.image;
    const smart = settings.models.smart;
    return {
      ...image,
      baseUrl: image.baseUrl.trim() || smart.baseUrl,
      apiKey: image.apiKey.trim() || smart.apiKey,
      modelId: image.modelId.trim() || 'gpt-image-2',
    };
  }

  private getImageEndpointCandidates(baseUrl: string): string[] {
    const trimmed = baseUrl.replace(/\/+$/, '');
    if (/\/v1$/i.test(trimmed)) return [`${trimmed}/images/generations`];
    // Gateways like oneapi mount the OpenAI API under /v1. Trying the bare
    // path first follows a login redirect and can spend the whole timeout.
    return [
      `${trimmed}/v1/images/generations`,
      `${trimmed}/images/generations`,
    ];
  }

  private async trackImageUsage(rawUsage: unknown): Promise<void> {
    await this.ensureUsageLoaded();
    const usage = rawUsage as {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    } | null;
    if (usage && typeof usage === 'object') {
      const promptTokens = safeUsageNumber(usage.input_tokens ?? usage.prompt_tokens);
      const completionTokens = safeUsageNumber(usage.output_tokens ?? usage.completion_tokens);
      const totalTokens = safeUsageNumber(usage.total_tokens) || promptTokens + completionTokens;
      this._usage.image.promptTokens += promptTokens;
      this._usage.image.completionTokens += completionTokens;
      this._usage.image.totalTokens += totalTokens;
    }
    this._usage.image.requests += 1;
    await this.saveUsage();
  }

  private validateConfig(config: ModelConfig): void {
    const missing: string[] = [];
    if (!config.baseUrl.trim()) missing.push('API Base URL');
    if (!config.apiKey.trim()) missing.push('API Key');
    if (!config.modelId.trim()) missing.push('Model ID');
    if (missing.length) {
      throw new Error(`AI 配置未完成（${config.name} 缺少 ${missing.join('、')}）。请打开 Doc Copilot 设置完成配置。`);
    }
  }
}

export const modelProvider = new ModelProvider();
