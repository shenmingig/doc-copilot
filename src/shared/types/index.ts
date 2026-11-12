// ============================================================
// Core Types - Shared across all modules
// ============================================================

// --- Position & Range ---

export interface Position {
  /** Zero-based line number */
  line: number;
  /** Zero-based character offset within the line */
  character: number;
  /** Absolute offset from document start */
  offset: number;
}

export interface Range {
  start: Position;
  end: Position;
}

// --- Document Context ---

export interface DocumentContext {
  /** Text before cursor (up to windowSize chars) */
  textBefore: string;
  /** Text after cursor (up to windowSize chars) */
  textAfter: string;
  /** Currently selected text, if any */
  selectedText: string;
  /** Full document text (for small docs) or null */
  fullText: string | null;
  /** Cursor position */
  cursorPosition: Position;
  /** Document language (detected or configured) */
  language: string;
  /** Document title or filename if available */
  title?: string;
  /** Images extracted from the current document body, when available */
  documentImages?: ChatImageInput[];
  /** The element type being edited */
  elementType: 'contenteditable' | 'textarea' | 'input' | 'unknown';
}

// --- Content Change ---

export interface ContentChange {
  range: Range;
  text: string;
  /** Timestamp of the change */
  timestamp: number;
}

// --- Disposable (for event listeners) ---

export interface Disposable {
  dispose(): void;
}

// --- Model Provider ---

export type ModelRole = 'smart' | 'image';

export interface ModelConfig {
  role: ModelRole;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /** Max tokens for completion */
  maxTokens: number;
  /** Temperature (0-2) */
  temperature: number;
  /** Whether this model supports streaming */
  supportsStreaming: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string[];
}

export interface CompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface CompletionResponse {
  id: string;
  choices: CompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      audio_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
      audio_tokens?: number;
      accepted_prediction_tokens?: number;
      rejected_prediction_tokens?: number;
    };
  };
}

export interface StreamDelta {
  role?: string;
  content?: string;
  text?: string;
  tool_calls?: Partial<ToolCall>[];
}

export interface StreamChunk {
  id: string;
  usage?: CompletionResponse['usage'];
  choices: Array<{
    index: number;
    delta: StreamDelta;
    message?: ChatMessage;
    text?: string;
    finish_reason: string | null;
  }>;
}

// --- Autocomplete ---

export interface AutocompleteResult {
  /** The suggested completion text */
  text: string;
  /** Position where the completion should be inserted */
  insertPosition: Position;
  /** Confidence score 0-1 */
  confidence: number;
  /** Source model */
  model: string;
}

// --- Review Mode ---

export type ReviewPointStatus = 'pending' | 'accepted' | 'rejected';

export interface ReviewPoint {
  id: string;
  /** Original text range */
  originalRange: Range;
  /** Original text */
  originalText: string;
  /** Suggested replacement */
  suggestedText: string;
  /** Reason / explanation */
  reason: string;
  /** Category: grammar, style, clarity, structure, etc. */
  category: ReviewCategory;
  /** Current status */
  status: ReviewPointStatus;
}

export type ReviewCategory =
  | 'grammar'
  | 'spelling'
  | 'punctuation'
  | 'style'
  | 'clarity'
  | 'structure'
  | 'word-choice'
  | 'redundancy'
  | 'other';

export interface ReviewSession {
  id: string;
  points: ReviewPoint[];
  /** Index of currently focused review point */
  currentIndex: number;
  /** Timestamp when review started */
  startedAt: number;
}

// --- Agent ---

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: DocumentContext) => Promise<string>;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolName?: string;
  isStreaming?: boolean;
  images?: ChatImageInput[];
  /** Structured plan shown above a full-document answer. */
  thinking?: string;
}

export interface ChatImageInput {
  id?: string;
  name?: string;
  mimeType: string;
  dataUrl: string;
  sourceUrl?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  origin?: 'upload' | 'document' | 'generated';
}

export interface AgentSession {
  id: string;
  messages: AgentMessage[];
  createdAt: number;
}

// --- Chat History ---

export interface ChatHistorySession {
  sessionId: string;
  pageKey: string;
  pageUrl: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  messageCount: number;
  preview: string;
}

export interface ChatHistoryMessage {
  messageId: string;
  sessionId: string;
  pageKey: string;
  role: AgentMessage['role'];
  content: string;
  timestamp: number;
  images?: ChatImageInput[];
  thinking?: string;
}

// --- Pinned References ---

export interface ReferenceChunk {
  id: string;
  referenceId: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface PinnedReference {
  id: string;
  url: string;
  normalizedUrl: string;
  title: string;
  fullText: string;
  summary?: string;
  chunks: ReferenceChunk[];
  createdAt: number;
  updatedAt: number;
  pinnedAt: number;
  sourceType: 'page' | 'selection' | 'manual';
}

export interface DocumentReferenceBinding {
  pageKey: string;
  referenceIds: string[];
  updatedAt: number;
}

export interface ReferenceContext {
  referenceId: string;
  title: string;
  url: string;
  chunkId: string;
  text: string;
  score: number;
  index: number;
}

// --- Quick Prompts ---

export interface QuickPrompt {
  /** Unique stable id */
  id: string;
  /** Display label shown in the dropdown */
  label: string;
  /** The prompt text sent to the agent */
  prompt: string;
}

export const DEFAULT_QUICK_PROMPTS: QuickPrompt[] = [
  { id: 'polish', label: '润色', prompt: '在不新增事实、不改变原意的前提下，提升表达的清晰度、流畅度和专业度。' },
  { id: 'fix', label: '纠错', prompt: '只修正错别字、语法、标点和明显病句，尽量保持原句结构和语气。' },
  { id: 'tighten', label: '精简', prompt: '压缩冗余表达，让内容更短、更直接，但保留关键信息。' },
  { id: 'expand', label: '扩写', prompt: '基于原文已有信息适度扩写，让逻辑更完整；不要编造新的事实或数据。' },
  { id: 'translate-en', label: '译英', prompt: '翻译成自然、准确的英文，保留原有术语和格式。' },
  { id: 'translate-zh', label: '译中', prompt: '翻译成自然、准确的中文，保留原有术语和格式。' },
];

// --- Settings ---

export interface ModelSettings {
  smart: ModelConfig;
  image: ModelConfig;
}

export interface FeatureToggles {
  autocomplete: boolean;
  autoCorrection: boolean;
  inlineHints: boolean;
  selectionToolbar: boolean;
}

export interface AppSettings {
  models: ModelSettings;
  features: FeatureToggles;
  autocompleteDebounceMs: number;
  /** Minimum confidence required before showing autocomplete ghost text */
  autocompleteMinConfidence: number;
  contextWindowSize: number;
  /** Max characters of full document text to include in Agent chat context */
  agentMaxContextChars: number;
  /** Model context window used by the chat context meter, in tokens */
  modelContextTokens: number;
  language: 'auto' | 'zh' | 'en';
  theme: 'auto' | 'light' | 'dark';
  /** User-defined quick prompts shown in the selection toolbar */
  quickPrompts: QuickPrompt[];
  /** Whether local per-page chat history is saved */
  chatHistoryEnabled: boolean;
  /** Days before local chat history expires */
  chatHistoryTtlDays: number;
  /** Max saved sessions shown per page */
  chatHistoryMaxSessionsPerPage: number;
  /** Default image generation size for OpenAI-compatible image endpoints */
  imageGenerationSize: string;
}

export function isModelConfigComplete(config: Pick<ModelConfig, 'baseUrl' | 'apiKey' | 'modelId'>): boolean {
  return Boolean(config.baseUrl.trim() && config.apiKey.trim() && config.modelId.trim());
}

export function isAiConfigured(settings: AppSettings, roles: ModelRole[] = ['smart']): boolean {
  return roles.every(role => isModelConfigComplete(settings.models[role]));
}

// --- Messages (Chrome extension messaging) ---

export type MessageType =
  | 'AUTOCOMPLETE_REQUEST'
  | 'AUTOCOMPLETE_RESPONSE'
  | 'AUTOCOMPLETE_CLEAR_CACHE'
  | 'PARAGRAPH_OPTIMIZE_REQUEST'
  | 'REVIEW_REQUEST'
  | 'REVIEW_RESPONSE'
  | 'AGENT_MESSAGE'
  | 'AGENT_RESPONSE'
  | 'AGENT_STREAM_CHUNK'
  | 'AGENT_STREAM_END'
  | 'HISTORY_CLEANUP_EXPIRED'
  | 'HISTORY_LIST_SESSIONS'
  | 'HISTORY_LOAD_SESSION'
  | 'HISTORY_SAVE_MESSAGES'
  | 'HISTORY_DELETE_SESSION'
  | 'REFERENCE_PIN_PAGE'
  | 'REFERENCE_LIST'
  | 'REFERENCE_DELETE'
  | 'REFERENCE_GET_BINDING'
  | 'REFERENCE_SET_BINDING'
  | 'REFERENCE_SEARCH_CONTEXT'
  | 'IMAGE_GENERATE_REQUEST'
  | 'FETCH_IMAGE_DATA_URL'
  | 'COPY_IMAGE_TO_CLIPBOARD'
  | 'SELECTION_ACTION_REQUEST'
  | 'SELECTION_ACTION_STREAM_CHUNK'
  | 'SELECTION_ACTION_STREAM_END'
  | 'GET_SETTINGS'
  | 'GET_USAGE'
  | 'UPDATE_SETTINGS'
  | 'SETTINGS_CHANGED'
  | 'ENABLE_ALL_SITES'
  | 'DISABLE_ALL_SITES'
  | 'COMMAND'
  | 'CONTEXT_MENU_ACTION'
  | 'TOOL_CALL_REQUEST'
  | 'TOOL_CALL_RESULT'
  | 'TOOL_STATUS'
  | 'SAVE_PDF'
  | 'HIDE_FOR_PRINT'
  | 'SHOW_AFTER_PRINT';

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload: T;
  requestId?: string;
}

export interface ToolCallRequestMessage {
  type: 'TOOL_CALL_REQUEST';
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolCallResultMessage {
  type: 'TOOL_CALL_RESULT';
  callId: string;
  success: boolean;
  result: string;
}

// --- Default Settings ---

export const DEFAULT_SETTINGS: AppSettings = {
  models: {
    smart: {
      role: 'smart',
      name: 'Smart (Text)',
      baseUrl: '',
      apiKey: '',
      modelId: '',
      maxTokens: 8192,
      temperature: 0.7,
      supportsStreaming: true,
    },
    image: {
      role: 'image',
      name: 'Image (Generation)',
      baseUrl: '',
      apiKey: '',
      modelId: 'gpt-image-2',
      maxTokens: 1024,
      temperature: 1.0,
      supportsStreaming: false,
    },
  },
  features: {
    autocomplete: true,
    autoCorrection: false,
    inlineHints: true,
    selectionToolbar: true,
  },
  autocompleteDebounceMs: 400,
  autocompleteMinConfidence: 0.5,
  contextWindowSize: 800,
  agentMaxContextChars: 800000,
  modelContextTokens: 1000000,
  language: 'auto',
  theme: 'auto',
  quickPrompts: DEFAULT_QUICK_PROMPTS,
  chatHistoryEnabled: true,
  chatHistoryTtlDays: 7,
  chatHistoryMaxSessionsPerPage: 20,
  imageGenerationSize: '1024x1024',
};
