// ============================================================
// Background Service Worker - Chrome Extension
// Handles API calls, settings, message routing
// ============================================================

import { ExtensionMessage, DocumentContext, AppSettings, ChatImageInput, ChatMessage, ToolCallResultMessage, AgentMessage, ReferenceContext } from '../shared/types/index';
import { settingsStorage } from '../shared/storage/settings';
import { chatHistoryStorage } from '../shared/storage/chat-history';
import { pinnedReferenceStorage } from '../shared/storage/pinned-references';
import { autocompleteEngine } from '../core/autocomplete/engine';
import { reviewEngine } from '../core/review/engine';
import { agentSystem } from '../core/agent/system';
import { modelProvider } from '../core/models/provider';
import { debugLog, installDebugLogSink } from '../shared/debug-log';
import { copyImageToClipboard } from './image-clipboard';
import { ScopedRequestRegistry, throwIfRequestAborted } from '../shared/utils/request-cancellation';

const selectionRequests = new ScopedRequestRegistry();

const ALL_SITES_SCRIPT_ID = 'doc-copilot-all-sites';
const DEBUG_LOG_STORAGE_KEY = 'doc_copilot_debug_log';

installDebugLogSink((text) => {
  void chrome.storage.local.set({ [DEBUG_LOG_STORAGE_KEY]: text }).catch(() => undefined);
});

debugLog('info', 'background.ready', { version: chrome.runtime.getManifest().version });

const ALL_SITES_ORIGINS = ['https://*/*'];

async function hasAllSitesPermission(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ALL_SITES_ORIGINS });
}

async function registerAllSitesScript(): Promise<void> {
  if (!(await hasAllSitesPermission())) return;
  await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_SCRIPT_ID] }).catch(() => undefined);
  await chrome.scripting.registerContentScripts([{
    id: ALL_SITES_SCRIPT_ID,
    matches: ALL_SITES_ORIGINS,
    excludeMatches: [
      'https://chromewebstore.google.com/*',
      'https://accounts.google.com/*',
      'https://*/login*',
      'https://*/signin*',
      'https://*/sign-in*',
      'https://*/signup*',
      'https://*/register*',
      'https://*/passport*',
      'https://*/oauth*',
      'https://*/checkout*',
      'https://*/payment*',
    ],
    js: ['content.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
}

async function unregisterAllSitesScript(): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_SCRIPT_ID] }).catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => { registerAllSitesScript().catch(console.warn); });
chrome.runtime.onStartup.addListener(() => { registerAllSitesScript().catch(console.warn); });
chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.origins?.includes(ALL_SITES_ORIGINS[0])) {
    registerAllSitesScript().catch(console.warn);
  }
});
chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions.origins?.includes(ALL_SITES_ORIGINS[0])) {
    unregisterAllSitesScript().catch(console.warn);
  }
});

// --- Message Handler ---

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    if ((message as { target?: string } | undefined)?.target === 'offscreen') return;
    const tabId = sender.tab?.id;
    handleMessage(message, tabId, sender.frameId ?? 0)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // async response
  },
);

async function handleMessage(message: ExtensionMessage, tabId?: number, frameId = 0): Promise<unknown> {
  switch (message.type) {
    case 'ENABLE_ALL_SITES': {
      await registerAllSitesScript();
      const activeTabId = (message.payload as { activeTabId?: number } | undefined)?.activeTabId;
      if (activeTabId) {
        await chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ['content.js'] }).catch(() => undefined);
      }
      return { success: true };
    }

    case 'DISABLE_ALL_SITES':
      await unregisterAllSitesScript();
      return { success: true };

    case 'AUTOCOMPLETE_REQUEST':
      return handleAutocomplete(message.payload as DocumentContext);

    case 'AUTOCOMPLETE_CLEAR_CACHE':
      autocompleteEngine.clearCache();
      return { success: true };

    case 'PARAGRAPH_OPTIMIZE_REQUEST':
      return handleParagraphOptimize(
        message.payload as { text: string; title?: string; textBefore?: string; textAfter?: string },
      );

    case 'REVIEW_REQUEST':
      return handleReview(message.payload as {
        context: DocumentContext;
        mode: 'correct' | 'rewrite' | 'polish';
      });

    case 'AGENT_MESSAGE':
      return handleAgentMessage(message.payload as {
        message: string;
        context: DocumentContext | null;
        images?: ChatImageInput[];
        history?: AgentMessage[];
        references?: ReferenceContext[];
      }, tabId);

    case 'TOOL_CALL_RESULT': {
      const msg = message as unknown as ToolCallResultMessage;
      agentSystem.resolveToolCall(msg.callId, msg.success, msg.result);
      return { ok: true };
    }

    case 'FETCH_IMAGE_DATA_URL':
      return handleFetchImageDataUrl(message.payload as { url: string });

    case 'COPY_IMAGE_TO_CLIPBOARD':
      return copyImageToClipboard((message.payload as { dataUrl?: string }).dataUrl || '');

    case 'HISTORY_CLEANUP_EXPIRED':
      return { deleted: await chatHistoryStorage.cleanupExpired() };

    case 'HISTORY_LIST_SESSIONS': {
      const settings = await settingsStorage.get();
      const payload = message.payload as { pageKey: string; limit?: number };
      await chatHistoryStorage.cleanupExpired();
      const sessions = await chatHistoryStorage.listSessions(
        payload.pageKey,
        payload.limit ?? settings.chatHistoryMaxSessionsPerPage,
      );
      return { sessions };
    }

    case 'HISTORY_LOAD_SESSION': {
      const payload = message.payload as { sessionId: string };
      return chatHistoryStorage.loadSession(payload.sessionId);
    }

    case 'HISTORY_SAVE_MESSAGES': {
      const settings = await settingsStorage.get();
      if (!settings.chatHistoryEnabled) return { skipped: true };
      const payload = message.payload as {
        sessionId: string;
        pageKey: string;
        pageUrl: string;
        title: string;
        messages: AgentMessage[];
      };
      const session = await chatHistoryStorage.saveMessages({
        ...payload,
        ttlDays: settings.chatHistoryTtlDays,
      });
      return { session };
    }

    case 'HISTORY_DELETE_SESSION': {
      const payload = message.payload as { sessionId: string };
      await chatHistoryStorage.deleteSession(payload.sessionId);
      return { success: true };
    }

    case 'REFERENCE_PIN_PAGE': {
      const payload = message.payload as {
        url: string;
        title: string;
        fullText: string;
        selectedText?: string;
      };
      const reference = await pinnedReferenceStorage.pinPage(payload);
      return { reference };
    }

    case 'REFERENCE_LIST': {
      return { references: await pinnedReferenceStorage.listReferences() };
    }

    case 'REFERENCE_DELETE': {
      const payload = message.payload as { referenceId: string };
      await pinnedReferenceStorage.deleteReference(payload.referenceId);
      return { success: true };
    }

    case 'REFERENCE_GET_BINDING': {
      const payload = message.payload as { pageKey: string };
      return { binding: await pinnedReferenceStorage.getBinding(payload.pageKey) };
    }

    case 'REFERENCE_SET_BINDING': {
      const payload = message.payload as { pageKey: string; referenceIds: string[] };
      return { binding: await pinnedReferenceStorage.setBinding(payload.pageKey, payload.referenceIds) };
    }

    case 'REFERENCE_SEARCH_CONTEXT': {
      const payload = message.payload as { referenceIds: string[]; query: string; limit?: number };
      return { contexts: await pinnedReferenceStorage.searchContext(payload) };
    }

    case 'SELECTION_ACTION_REQUEST':
      return handleSelectionAction(message.payload as SelectionImagePayload, tabId, frameId);

    case 'SELECTION_ACTION_CANCEL': {
      const { requestId } = message.payload as { requestId: string };
      return { cancelled: selectionRequests.cancel(`${tabId}:${frameId}`, requestId) };
    }

    case 'SAVE_PDF':
      return handleSavePdf(tabId);

    case 'GET_SETTINGS':
      return settingsStorage.get();

    case 'GET_USAGE':
      return { usage: await modelProvider.getUsage() };

    case 'UPDATE_SETTINGS':
      await settingsStorage.set(message.payload as Partial<AppSettings>);
      // Broadcast settings change to all tabs
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              type: 'SETTINGS_CHANGED',
              payload: message.payload,
            }).catch(() => {/* tab might not have content script */});
          }
        });
      });
      return { success: true };

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

async function handleFetchImageDataUrl(payload: { url: string }) {
  try {
    const url = payload.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      return { error: 'Invalid image URL' };
    }

    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!response.ok) {
      return { error: `Image fetch failed: HTTP ${response.status}` };
    }

    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) {
      return { error: `Image fetch returned non-image content: ${blob.type || 'unknown'}` };
    }

    const dataUrl = await blobToDataUrl(blob);
    return {
      dataUrl,
      mimeType: blob.type || 'image/png',
      size: blob.size,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image blob'));
    reader.readAsDataURL(blob);
  });
}

async function handleParagraphOptimize(payload: {
  text: string;
  html?: string;
  title?: string;
  textBefore?: string;
  textAfter?: string;
}) {
  try {
    const settings = await settingsStorage.get();
    const maxChars = settings.agentMaxContextChars;
    const messages = buildOptimizePrompt(payload.text, payload.html, payload.title, payload.textBefore, payload.textAfter, maxChars);
    const result = await modelProvider.streamToString('smart', messages, {
      max_tokens: 2048,
      temperature: 0.7,
    });

    // If input had HTML formatting, the result is also HTML; extract plain text from it
    if (payload.html) {
      const plain = result.replace(/<[^>]+>/g, '');
      return { result: plain.trim(), resultHtml: result.trim() };
    }
    return { result };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function buildOptimizePrompt(
  text: string,
  html?: string,
  title?: string,
  textBefore?: string,
  textAfter?: string,
  maxChars = 8192,
): ChatMessage[] {
  const halfChars = Math.floor(maxChars / 2);
  const ctxBefore = textBefore ? textBefore.slice(-halfChars) : '';
  const ctxAfter = textAfter ? textAfter.slice(0, halfChars) : '';

  const hasHtml = !!html;

  const systemPrompt = hasHtml
    ? `你是一位专业的文档编辑助手。对给定的内容进行优化改写，要求：
1. 保持原有的核心含义和信息不变
2. 使语言更加清晰、流畅、专业
3. 修正语法错误、用词不当、表述冗余等问题
4. 保持与前后文一致的语气和风格
5. 【格式要求】输入使用 HTML 标签标注格式（<strong>加粗</strong>、<em>斜体</em>、<code>行内代码</code>等）。必须在语义等价的内容上保留这些标签，不要添加新标签，不要去掉原有标签。
6. 只输出优化后的 HTML 内容本身，不要任何解释、前缀或后缀。`
    : `你是一位专业的文档编辑助手。你的任务是对给定的段落进行优化改写。

【核心要求】
1. 保持原有的核心含义和信息不变
2. 使语言更加清晰、流畅、专业
3. 修正语法错误、用词不当、表述冗余等问题
4. 保持与前后文一致的语气和风格

【格式要求 - 最重要】
- **严格保持原文的所有格式特征**：
  * 原文有换行就必须在相同位置换行
  * 原文有空行就必须保留空行
  * 原文有列表（-、*、数字、字母序号）就必须保留列表格式
  * 原文有标题格式（#、##等Markdown标记）就必须保留
  * 原文有代码块、引用块等特殊格式就必须保留
  * 原文有缩进就必须保留缩进
- **禁止合并段落**：不要将多行内容合并为一行
- **禁止改变结构**：不要改变段落数量和布局

【输出要求】
- 只输出优化后的内容本身
- 不要添加任何解释、标注、前缀或后缀
- 不要在开头写"优化后："之类的话`;

  let userContent = '';
  if (title) userContent += `文档标题：${title}\n\n`;
  if (ctxBefore) userContent += `[前文]\n${ctxBefore}\n\n`;
  userContent += `[需要优化的段落]\n${hasHtml ? html : text}`;
  if (ctxAfter) userContent += `\n\n[后文]\n${ctxAfter}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

async function handleAutocomplete(context: DocumentContext) {
  try {
    const result = await autocompleteEngine.suggest(context);
    return { result };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function handleReview(payload: {
  context: DocumentContext;
  mode: 'correct' | 'rewrite' | 'polish';
}) {
  try {
    const session = await reviewEngine.analyze(payload.context, payload.mode);
    return { session };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function handleAgentMessage(payload: {
  message: string;
  context: DocumentContext | null;
  images?: ChatImageInput[];
  history?: AgentMessage[];
  references?: ReferenceContext[];
}, tabId?: number) {
  let didStream = false;
  const pushChunk = (messageId: string, delta: string, fullText: string) => {
    if (!tabId) return;
    didStream = true;
    chrome.tabs.sendMessage(tabId, {
      type: 'AGENT_STREAM_CHUNK',
      payload: { messageId, delta, fullText },
    }).catch(() => { /* tab may have navigated away */ });
  };

  const pushEnd = (result: { response?: unknown; error?: string; streamed: boolean }) => {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, {
      type: 'AGENT_STREAM_END',
      payload: result,
    }).catch(() => {});
  };

  try {
    const response = await agentSystem.chat(payload.message, payload.context, {
      tabId,
      images: payload.images,
      history: payload.history,
      references: payload.references,
      onChunk: ({ messageId, delta, fullText }) => pushChunk(messageId, delta, fullText),
    });
    pushEnd({ response, streamed: didStream });
    return { response, streamed: didStream };
  } catch (error) {
    const message = (error as Error).message;
    pushEnd({ error: message, streamed: didStream });
    return { error: message, streamed: didStream };
  }
}

/**
 * Unified handler for the selection floating toolbar.
 * Handles both text edits and selected-text illustration generation.
 */
interface SelectionImagePayload {
  requestId: string;
  prompt: string;
  selectedText: string;
  selectedHtml?: string;
  title?: string;
  textBefore?: string;
  textAfter?: string;
  fullText?: string | null;
  documentImages?: ChatImageInput[];
}

interface ImagePlaceholderSpec {
  id: string;
  prompt: string;
  rawText: string;
  /** The placeholder text is a drawing brief, not copy to render inside the image. */
  instructionOnly?: boolean;
}

interface SelectionActionEndResult {
  action?: string;
  result?: string;
  resultHtml?: string;
  imageUrl?: string;
  replaceSelection?: boolean;
  generatedPrompt?: string;
  error?: string;
}

async function handleSelectionAction(payload: SelectionImagePayload, tabId?: number, frameId = 0) {
  if (!payload.requestId || tabId === undefined) return { error: '请求缺少标识，请刷新页面重试' };
  const scope = `${tabId}:${frameId}`;
  const controller = selectionRequests.start(scope, payload.requestId);
  const { signal } = controller;
  const deadline = setTimeout(() => controller.abort(), isImageSelectionPrompt(payload.prompt) ? 180_000 : 300_000);
  /** Push a stream chunk to the originating tab */
  const pushChunk = (delta: string, fullText: string) => {
    if (signal.aborted) return;
    chrome.tabs.sendMessage(tabId, {
      type: 'SELECTION_ACTION_STREAM_CHUNK',
      payload: { delta, fullText, requestId: payload.requestId },
    }, { frameId }).catch(() => { /* tab may have navigated away */ });
  };

  /** Signal stream end to the originating tab */
  const pushEnd = (result: SelectionActionEndResult) => {
    if (signal.aborted) return;
    chrome.tabs.sendMessage(tabId, {
      type: 'SELECTION_ACTION_STREAM_END',
      payload: { ...result, requestId: payload.requestId },
    }, { frameId }).catch(() => {});
  };

  try {
    const settings = await settingsStorage.get();
    throwIfRequestAborted(signal);
    const maxChars = settings.agentMaxContextChars;

    if (isImageSelectionPrompt(payload.prompt)) {
      const placeholder = parseImagePlaceholder(payload.selectedText);
      pushChunk('', placeholder
        ? '正在根据图片占位符和上下文补全配图 prompt...'
        : '正在根据选中文本和上下文整理配图 prompt...');
      const imagePrompt = await buildImageGenerationPrompt(payload, maxChars, placeholder, signal);
      throwIfRequestAborted(signal);
      pushChunk('', '配图 prompt 已生成，正在调用图像模型，通常需要 20-60 秒...');
      const imageUrl = await modelProvider.generateImage(imagePrompt, {
        size: settings.imageGenerationSize,
      }, signal);
      throwIfRequestAborted(signal);
      const finalResult: SelectionActionEndResult = {
        action: 'image',
        imageUrl,
        replaceSelection: !!placeholder,
        generatedPrompt: imagePrompt,
      };
      pushEnd(finalResult);
      return finalResult;
    }

    // Edit — stream chunks to the content script for live preview
    const editMessages = buildSelectionEditPrompt(
      payload.prompt,
      payload.selectedText,
      payload.selectedHtml,
      payload.title,
      maxChars,
    );
    const rawResult = await modelProvider.streamToString('smart', editMessages, {
      max_tokens: 4096,
      temperature: 0.35,
    }, (delta, fullText) => {
      pushChunk(delta, fullText);
    }, 300_000, signal);
    throwIfRequestAborted(signal);

    const resultHtml = ensureHtmlFragment(rawResult);
    const resultText = htmlToPlainText(resultHtml);
    const finalResult = { action: 'edit', result: resultText.trim(), resultHtml: resultHtml.trim() };
    pushEnd(finalResult);
    return finalResult;
  } catch (error) {
    if (signal.aborted) return { cancelled: true, requestId: payload.requestId };
    const errResult = { error: (error as Error).message };
    pushEnd(errResult);
    return errResult;
  } finally {
    clearTimeout(deadline);
    selectionRequests.finish(scope, controller);
  }
}

function isTimeoutError(error: unknown): boolean {
  const err = error as Error;
  return err?.name === 'AbortError' || /超时|aborted/i.test(err?.message || '');
}

function isImageSelectionPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return false;
  return /^(?:配图|插图|生成图片|生图|画图|图片)(?:\s|$|[:：,，。.!！?？])/.test(normalized)
    || /^(?:image|img|illustration|draw)(?:\s|$|[:：,，。.!！?？])/.test(normalized);
}

async function buildImageGenerationPrompt(
  payload: SelectionImagePayload,
  maxChars = 8192,
  placeholder: ImagePlaceholderSpec | null = null,
  signal?: AbortSignal,
): Promise<string> {
  const fallback = buildSelectionImagePrompt(payload, maxChars, placeholder);
  const messages = buildImagePromptRefinementMessages(payload, maxChars, placeholder, true);
  const forbidden = [
    placeholder?.instructionOnly ? placeholder.prompt.trim() : '',
    stripImageCommandPrefix(payload.prompt),
  ].filter(Boolean).join(' / ');
  const finish = (prompt: string) => guardImagePrompt(prompt, forbidden);

  try {
    const refined = await modelProvider.streamToString('smart', messages, {
      max_tokens: 1200,
      temperature: 0.25,
    }, undefined, 45_000, signal);
    return finish(normalizeImagePrompt(refined) || fallback);
  } catch (error) {
    throwIfRequestAborted(signal);
    if (isTimeoutError(error)) {
      console.warn('[Doc Copilot] Image prompt refinement timed out; using fallback prompt.');
      return finish(fallback);
    }
    console.warn('[Doc Copilot] Image prompt refinement failed; retrying without reference image payloads.', error);
    if (getReadableDocumentImages(payload.documentImages).length) {
      try {
        const textOnlyMessages = buildImagePromptRefinementMessages(payload, maxChars, placeholder, false);
        const refined = await modelProvider.streamToString('smart', textOnlyMessages, {
          max_tokens: 1200,
          temperature: 0.25,
        }, undefined, 45_000, signal);
        return finish(normalizeImagePrompt(refined) || fallback);
      } catch (textOnlyError) {
        throwIfRequestAborted(signal);
        console.warn('[Doc Copilot] Text-only image prompt refinement failed; using fallback prompt.', textOnlyError);
      }
    }
    return finish(fallback);
  }
}

function buildImagePromptRefinementMessages(
  payload: SelectionImagePayload,
  maxChars = 8192,
  placeholder: ImagePlaceholderSpec | null = null,
  includeReferenceImages = true,
): ChatMessage[] {
  const extraInstruction = stripImageCommandPrefix(payload.prompt);
  const userInstruction = placeholder?.prompt
    ? [placeholder.prompt, extraInstruction].filter(Boolean).join('\n')
    : extraInstruction;
  const selected = payload.selectedText.trim();
  const context = buildImagePromptContext(
    payload,
    maxChars,
    placeholder?.instructionOnly ? '图片占位。画图要求已单独给出，不要把要求原文画进图片。' : undefined,
  );
  const imageHints = buildDocumentImageStyleHints(payload.documentImages);
  const readableImages = includeReferenceImages ? getReadableDocumentImages(payload.documentImages).slice(0, 4) : [];

  const systemPrompt = `你是一位中文技术文档的信息图导演。你的任务是把文档中的选中文本或图片占位符，转写成稳定、可复现、可直接发送给图像生成模型的英文 prompt。

输出要求：
- 只输出最终 image prompt，不要解释、不要 Markdown、不要 JSON。
- 结合文档标题、当前位置上下文和全文主题，补全画面主体、结构、风格、配色、标签、留白和禁止项。
- 如果提供了视觉参考图片，必须先观察它们的主色、辅色、背景色、线条粗细、圆角/阴影、构图、信息密度和中文标签风格，并把这些风格约束明确写入最终英文 prompt。
- 如果存在图片占位符，必须让图片服务于占位符所在章节，而不是画出占位符文本本身。
- 【图 N：...】冒号后的内容，以及用户补充的画图要求，只说明要表现的对比、结构和重点。它们不是图内文案。
- 禁止把画图要求、占位符原文、图号、章节标题，或把这些内容改写后的完整句子，画成标题、标题栏、图注或段落。
- 如果占位符或用户指令里已有构图要求，保留其核心构图，只补足上下文、约束和风格。
- 默认生成专业、清晰、适合知识库正文插入的扁平信息图或技术文档插画。
- 尽量少用文字；只有图示节点必须标注时才使用短标签，每个标签不超过 8 个汉字，不要用一句话当标题。
- 不要生成截图、浏览器界面、代码编辑器界面、真实公司 Logo、水印或不可读的小字。`;

  const userContent = [
    payload.title ? `文档标题：${payload.title}` : '',
    placeholder ? `图片占位符：${placeholder.id}` : '模式：为选中文本生成正文配图',
    userInstruction ? (placeholder?.instructionOnly ? `画图要求（不要画进图片）：${userInstruction}` : `用户/占位符提示：${userInstruction}`) : '',
    '',
    placeholder?.instructionOnly ? '[画图要求不是图内文字]' : (placeholder ? '[图片占位符原文]' : '[选中文本]'),
    placeholder?.instructionOnly
      ? '下面这句话只决定画什么，禁止原样、翻译或改写后出现在画面里。'
      : selected,
    placeholder?.instructionOnly ? selected : '',
    '',
    '[上下文]',
    context,
    '',
    imageHints,
    readableImages.length
      ? `\n[视觉参考图片]\n已随本消息附上 ${readableImages.length} 张当前文档正文图片。请提取并复用其视觉风格，但不要复制图片内容本身。`
      : '',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: readableImages.length
        ? [
          { type: 'text', text: userContent },
          ...readableImages.map(image => ({
            type: 'image_url' as const,
            image_url: {
              url: image.dataUrl || image.sourceUrl || '',
              detail: 'auto' as const,
            },
          })),
        ]
        : userContent,
    },
  ];
}

function buildSelectionImagePrompt(
  payload: SelectionImagePayload,
  maxChars = 8192,
  placeholder: ImagePlaceholderSpec | null = null,
): string {
  const instruction = placeholder?.prompt || stripImageCommandPrefix(payload.prompt);

  const fullText = (payload.fullText || '').trim();
  const contextSource = fullText || [
    payload.textBefore || '',
    payload.selectedText,
    payload.textAfter || '',
  ].join('\n');
  const context = truncateMiddle(contextSource, maxChars);
  const selected = payload.selectedText.trim();
  const imageHints = buildDocumentImageStyleHints(payload.documentImages);
  const isPlaceholder = !!placeholder;

  return [
    isPlaceholder
      ? '请为一篇中文文档中的图片占位符生成一张可直接替换占位符的配图。'
      : '请为一篇中文文档生成一张可直接插入正文的配图。',
    '',
    '要求：',
    isPlaceholder
      ? '- 图片必须服务于占位符前后段落和所在章节，帮助读者理解该处要表达的观点。'
      : '- 图片必须服务于选中文本表达，帮助读者理解当前段落或章节。',
    '- 不要生成截图、浏览器界面、代码编辑器界面、真实公司 Logo 或带有水印的图片。',
    '- 如果文档里已有图片，请尽量保持相近的视觉风格、构图复杂度、配色、线条粗细和信息密度。',
    '- 如果没有明确风格，优先生成简洁、专业、适合技术文档/知识库的扁平插画或信息图。',
    '- 尽量少用文字；必须出现文字时只使用不超过 8 个汉字的短标签，不要画标题栏、图注或完整说明句。',
    '- 画图要求只决定画面内容，禁止把要求原文或改写后的长句画进图片。',
    '- 画面要完整，不要裁切主体，留出适合嵌入文档的边距。',
    '',
    payload.title ? `文档标题：${payload.title}` : '',
    placeholder?.id ? `图片占位符：${placeholder.id}` : '',
    instruction
      ? (placeholder?.instructionOnly ? `画图要求（不要画进图片）：${instruction}` : `用户/占位符提示：${instruction}`)
      : '',
    '',
    placeholder?.instructionOnly ? '[画图要求不是图内文字]' : (isPlaceholder ? '[图片占位符原文]' : '[选中文本]'),
    selected,
    '',
    '[上下文]',
    context,
    '',
    imageHints,
  ].filter(Boolean).join('\n');
}

function stripImageCommandPrefix(prompt: string): string {
  return prompt
    .replace(/^(配图|插图|生成图片|生图|画图|图片|image|img|illustration|draw)\s*[:：]?\s*/i, '')
    .trim();
}

function parseImagePlaceholder(text: string): ImagePlaceholderSpec | null {
  const rawText = text.trim();
  if (!rawText) return null;

  const caption = parseFigureCaption(rawText);
  if (caption) return { ...caption, rawText, instructionOnly: true };

  const comment = /<!--([\s\S]*?)-->/.exec(rawText);
  const body = (comment?.[1] ?? rawText).trim();
  const hasImageMarker = /(?:^|\b)(?:IMAGE|IMG|FIGURE)[\s_-]*\d*/i.test(body) || /(?:配图|插图|图片)[\s_-]*\d*/.test(body);
  const hasPromptMarker = /(?:^|\n)\s*(?:PROMPT|提示词|图像提示词|图片提示词)\s*[:：]/i.test(body);
  if (!hasImageMarker && !hasPromptMarker) return null;

  const idMatch = /(?:^|\b)((?:IMAGE|IMG|FIGURE)[\s_-]*\d*)/i.exec(body)
    || /((?:配图|插图|图片)[\s_-]*\d*)/.exec(body);
  const id = (idMatch?.[1] || 'IMAGE')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/-+/g, '_')
    .toUpperCase();

  const promptMatch = /(?:^|\n)\s*(?:PROMPT|提示词|图像提示词|图片提示词)\s*[:：]\s*([\s\S]*)$/i.exec(body);
  let prompt = (promptMatch?.[1] || '').trim();
  if (!prompt) {
    prompt = body
      .split('\n')
      .filter(line => !/(?:^|\b)(?:IMAGE|IMG|FIGURE)[\s_-]*\d*/i.test(line))
      .filter(line => !/(?:配图|插图|图片)[\s_-]*\d*/.test(line))
      .join('\n')
      .trim();
  }
  prompt = prompt.replace(/\s*-->\s*$/g, '').trim();

  return { id, prompt, rawText };
}

function parseFigureCaption(rawText: string): { id: string; prompt: string } | null {
  let text = rawText.trim();
  if (
    (text.startsWith('【') && text.endsWith('】'))
    || (text.startsWith('[') && text.endsWith(']'))
    || (text.startsWith('（') && text.endsWith('）'))
    || (text.startsWith('(') && text.endsWith(')'))
  ) {
    text = text.slice(1, -1).trim();
  }

  const match = /^(?:图|配图|插图|图片|figure|fig\.?|image|img)\s*[-_ ]*(\d+)?\s*[:：]\s*([\s\S]+)$/i.exec(text);
  if (!match) return null;
  const prompt = match[2].trim();
  if (prompt.length < 2) return null;
  return { id: match[1] ? `图${match[1]}` : '图', prompt };
}

function guardImagePrompt(prompt: string, forbiddenText = ''): string {
  const brief = forbiddenText.trim();
  const guard = [
    'Negative constraints:',
    '- Do not draw a title banner, caption bar, figure number, or paragraph that restates the drawing brief or the section summary.',
    '- The drawing brief controls composition only and must not appear as visible text, even if paraphrased or translated.',
    brief ? `- Never render this instruction or a paraphrase of it: "${brief.slice(0, 220)}".` : '',
    '- Visible writing is limited to short diagram labels of at most 8 Chinese characters each.',
  ].filter(Boolean).join('\n');
  if (prompt.includes('Do not draw a title banner')) return prompt;
  const room = Math.max(0, 3500 - guard.length - 2);
  const body = prompt.length > room ? prompt.slice(0, room).trim() : prompt;
  return `${body}\n\n${guard}`;
}

function buildImagePromptContext(
  payload: SelectionImagePayload,
  maxChars: number,
  currentText?: string,
): string {
  const before = takeTail(payload.textBefore || '', Math.floor(maxChars * 0.25));
  const after = takeHead(payload.textAfter || '', Math.floor(maxChars * 0.25));
  const fullText = (payload.fullText || '').trim();
  const nearby = [
    before ? `[前文]\n${before}` : '',
    `[当前位置]\n${currentText ?? payload.selectedText.trim()}`,
    after ? `[后文]\n${after}` : '',
  ].filter(Boolean).join('\n\n');

  const parts = [
    nearby,
    fullText ? `[全文]\n${truncateMiddle(fullText, Math.floor(maxChars * 0.65))}` : '',
  ].filter(Boolean).join('\n\n');

  return truncateMiddle(parts, maxChars);
}

function takeHead(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars);
}

function takeTail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(-maxChars);
}

function normalizeImagePrompt(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:text|prompt|markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();

  if (/^\{[\s\S]*\}$/.test(text)) {
    try {
      const parsed = JSON.parse(text) as { prompt?: unknown; imagePrompt?: unknown };
      const prompt = typeof parsed.prompt === 'string'
        ? parsed.prompt
        : typeof parsed.imagePrompt === 'string'
          ? parsed.imagePrompt
          : '';
      text = prompt.trim() || text;
    } catch {
      // Keep the raw text when it is not valid JSON.
    }
  }

  text = text
    .replace(/^(?:PROMPT|IMAGE PROMPT|FINAL PROMPT)\s*[:：]\s*/i, '')
    .trim();

  if (text.length < 20) return '';
  return text.length > 3500 ? text.slice(0, 3500).trim() : text;
}

function buildDocumentImageStyleHints(images?: ChatImageInput[]): string {
  const visible = (images ?? []).filter(image => image.origin === 'document').slice(0, 6);
  if (!visible.length) {
    return '[已有图片风格]\n当前上下文未提取到已加载的正文图片。';
  }

  const lines = visible.map((image, index) => {
    const size = image.width && image.height ? `${image.width}x${image.height}` : '尺寸未知';
    const name = image.name?.trim() || `文档图片 ${index + 1}`;
    const readable = image.dataUrl?.startsWith('data:') ? '已作为视觉参考图提供' : '仅有图片 URL/元信息';
    return `- ${name}，${size}，类型 ${image.mimeType || 'image'}，${readable}。`;
  });

  return [
    '[已有图片风格]',
    '当前文档已加载图片如下；如果图片本体已随消息提供，请优先直接观察其配色和风格：',
    ...lines,
  ].join('\n');
}

function getReadableDocumentImages(images?: ChatImageInput[]): ChatImageInput[] {
  return (images ?? [])
    .filter(image => image.origin === 'document')
    .map(image => ({
      ...image,
      dataUrl: image.dataUrl || image.sourceUrl || '',
    }))
    .filter(image => Boolean(image.dataUrl));
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 80) / 2);
  return `${text.slice(0, half)}\n\n...[中间内容已截断]...\n\n${text.slice(-half)}`;
}

function buildSelectionEditPrompt(
  userPrompt: string,
  selectedText: string,
  selectedHtml?: string,
  title?: string,
  maxChars = 8192,
): ChatMessage[] {
  const hasHtml = !!selectedHtml;
  const systemPrompt = `你是一位严谨的文档编辑助手。根据用户指令改写【选中内容】。

核心原则：
- 默认做最小必要修改：不新增事实、不编造数据、不改变原意；除非用户明确要求扩写、总结、翻译或改写结构。
- 保持原文语气、术语、专名、数字、代码标识、英文大小写和中英文混排习惯。
- “优化/润色”表示提升清晰度、流畅度、专业度，去掉冗余和病句，但不要把短句扩成大段。
- “纠错/修正”只改错别字、语法、标点和明显病句。
- “翻译”要忠实、自然，保留专名、链接、代码、数字和列表结构。
- 如原文是列表、标题、引用或多段文字，必须保留对应结构；不要无故合并段落。
- 用户要求“要点/列表/步骤/分条”时，必须使用 ul/ol + li 输出真正的列表结构。
- 用户要求“表述更清晰”时，优先梳理逻辑和句式，不要引入文档外背景。

输出格式：
- 只输出可直接插入文档的安全 HTML 片段，不要解释、前缀、后缀、Markdown 代码围栏。
- 允许标签：p, br, strong, em, u, s, code, pre, ul, ol, li, blockquote, h1, h2, h3, h4, a。
- 不要输出 script/style/class/id/style/on* 属性。
- 如果只是行内短语，直接输出行内 HTML 文本，不要强行包 p。`;

  let userContent = '';
  if (title) userContent += `文档标题：${title}\n\n`;
  userContent += `最大参考字符数：${maxChars}\n\n`;
  userContent += `用户指令：${userPrompt}\n\n`;
  if (hasHtml) {
    userContent += `[选中内容 HTML]\n${selectedHtml}\n\n[选中内容纯文本]\n${selectedText}`;
  } else {
    userContent += `[选中内容纯文本]\n${selectedText}`;
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

function ensureHtmlFragment(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:html|markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  return markdownToHtmlFragment(text);
}

function markdownToHtmlFragment(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(line => renderInlineMarkdown(line)).join('<br>')}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeParagraph();
      closeList();
      const level = Math.min(heading[1].length, 4);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const quote = /^>\s+(.+)$/.exec(trimmed);
    if (quote) {
      closeParagraph();
      closeList();
      html.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      closeParagraph();
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (ordered) {
      closeParagraph();
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeParagraph();
  closeList();

  if (html.length === 1 && html[0].startsWith('<p>') && !normalized.includes('\n')) {
    return html[0].replace(/^<p>|<\/p>$/g, '');
  }
  return html.join('');
}

function renderInlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return html;
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Context Menu ---

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'doc-copilot-optimize-selection',
    title: 'Doc Copilot: 优化选中内容',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'doc-copilot-fix',
    title: 'Doc Copilot: Fix Text',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'doc-copilot-rewrite',
    title: 'Doc Copilot: Rewrite',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'doc-copilot-review',
    title: 'Doc Copilot: Review Document',
    contexts: ['selection', 'page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  const commandMap: Record<string, string> = {
    'doc-copilot-optimize-selection': 'command:optimize-selection',
    'doc-copilot-fix': 'command:fix',
    'doc-copilot-rewrite': 'command:rewrite',
    'doc-copilot-review': 'command:review',
  };

  const command = commandMap[info.menuItemId];
  if (command) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'CONTEXT_MENU_ACTION',
      payload: { action: command, selectedText: info.selectionText },
    });
  }
});

// --- Keyboard Shortcuts ---

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'COMMAND',
        payload: { command },
      });
    }
  });
});

console.log('[Doc Copilot] Background service worker started');

// ================================================================
// Save PDF via Chrome Debugger API (Page.printToPDF)
// ================================================================

async function handleSavePdf(tabId?: number): Promise<{ success: boolean; error?: string }> {
  if (!tabId) return { success: false, error: 'No active tab' };

  const target = { tabId };
  const tab = await chrome.tabs.get(tabId);
  const tabUrl = tab.url || '';
  const isWeixinArticle = /^https:\/\/mp\.weixin\.qq\.com\/s\//.test(tabUrl);

  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    // Already attached or attach failed
    return { success: false, error: `Debugger attach failed: ${(e as Error).message}` };
  }

  try {
    // Ask the content script to hide the floating panel before printing
    await chrome.tabs.sendMessage(tabId, { type: 'HIDE_FOR_PRINT' }).catch(() => {});
    await sleep(isWeixinArticle ? 300 : 100);

    await chrome.debugger.sendCommand(target, 'Page.enable').catch(() => {});
    await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', {
      media: 'print',
    }).catch(() => {});

    const result = await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true,
      displayHeaderFooter: false,
      paperWidth: 8.27,   // A4 width in inches
      paperHeight: 11.69, // A4 height in inches
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
      scale: isWeixinArticle ? 0.92 : 1,
      preferCSSPageSize: false,
    }) as { data: string };

    // Restore floating panel
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_AFTER_PRINT' }).catch(() => {});

    // Decode base64 → Uint8Array → Blob → download
    const binary = atob(result.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Build a data URL and trigger download via chrome.downloads
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve) => {
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });

    const filename = (tab.title || 'document').replace(/[\\/:*?"<>|]/g, '_') + '.pdf';

    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });

    return { success: true };
  } catch (e) {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_AFTER_PRINT' }).catch(() => {});
    return { success: false, error: (e as Error).message };
  } finally {
    chrome.debugger.detach(target).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
