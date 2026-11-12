// ============================================================
// Agent System - Document-focused AI agent with tools
// ============================================================

import {
  AgentMessage,
  AgentSession,
  AgentTool,
  ChatImageInput,
  ChatMessage,
  DocumentContext,
  ReferenceContext,
  ToolCall,
  ToolCallRequestMessage,
  ToolCallResultMessage,
} from '../../shared/types/index';
import { modelProvider } from '../models/provider';
import { generateId, detectLanguage, chatContentToText } from '../../shared/utils/index';
import {
  buildDraftMessages,
  buildPlanMessages,
  completionText,
  ensurePlanImages,
  buildIllustrationPrompt,
  fallbackDocumentPlan,
  formatPlanMarkdown,
  isDirectIllustrationRequest,
  isDocumentPlanRequest,
  parseDocumentPlan,
  placePlanImages,
  previewImageMarkers,
  wantsIllustratedDocument,
  type ResolvedPlanImage,
} from './document-plan';
import { settingsStorage } from '../../shared/storage/settings';
import { debugLog } from '../../shared/debug-log';
import { EventEmitter } from '../../shared/utils/index';

export interface AgentEvents {
  'message:add': AgentMessage;
  'message:update': AgentMessage;
  'message:stream': { messageId: string; chunk: string; fullText: string };
  'message:done': AgentMessage;
  'session:clear': void;
  'tool:call': { name: string; args: Record<string, unknown> };
  'tool:result': { name: string; result: string };
}

export interface AgentChatOptions {
  tabId?: number;
  images?: ChatImageInput[];
  history?: AgentMessage[];
  references?: ReferenceContext[];
  /** Called whenever the assistant emits a streamed text delta. */
  onChunk?: (event: { messageId: string; delta: string; fullText: string }) => void;
}

/** Built-in document editing tools (executed by content script via TOOL_CALL_REQUEST) */
function createBuiltinTools(): AgentTool[] {
  return [
    {
      name: 'insert_at_cursor',
      description: '在用户当前光标位置插入文本内容。适用于续写、追加内容等场景。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要插入的文本内容' },
        },
        required: ['text'],
      },
      execute: async () => '', // actual execution is in content script
    },
    {
      name: 'replace_selection',
      description: '替换用户当前选中的文本。适用于改写、翻译、修正选中内容。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '替换后的文本内容' },
        },
        required: ['text'],
      },
      execute: async () => '',
    },
    {
      name: 'replace_text',
      description: '在文档中查找指定文本片段并替换为新内容。适用于修改文档任意位置，无需用户手动选中。find_text 必须是文档中确实存在的原文。',
      parameters: {
        type: 'object',
        properties: {
          find_text: { type: 'string', description: '要查找的原始文本（精确匹配，建议不超过100字）' },
          replace_text: { type: 'string', description: '替换后的新文本' },
          occurrence: { type: 'number', description: '当 find_text 多次出现时替换第几处（从1开始，默认1）' },
        },
        required: ['find_text', 'replace_text'],
      },
      execute: async () => '',
    },
  ];
}

export class AgentSystem extends EventEmitter<AgentEvents> {
  private session: AgentSession;
  private tools: AgentTool[];
  private customTools: AgentTool[] = [];

  /** Pending cross-process tool calls awaiting resolution from content script */
  private pendingToolCalls = new Map<string, {
    resolve: (result: string) => void;
    reject: (error: Error) => void;
  }>();

  constructor() {
    super();
    this.session = this.createSession();
    this.tools = createBuiltinTools();
  }

  get messages(): AgentMessage[] {
    return this.session.messages;
  }

  /** Register a custom tool */
  registerTool(tool: AgentTool): void {
    this.customTools.push(tool);
  }

  /**
   * Send a user message and get a response.
   * Uses Function Calling loop: AI may call editing tools before giving final reply.
   * tabId is required for cross-process tool execution via content script.
   */
  async chat(
    userMessage: string,
    context: DocumentContext | null = null,
    optionsOrTabId?: number | AgentChatOptions,
  ): Promise<AgentMessage> {
    const options: AgentChatOptions = typeof optionsOrTabId === 'number'
      ? { tabId: optionsOrTabId }
      : optionsOrTabId ?? {};
    const { tabId } = options;
    const images = options.images ?? [];
    this.session.messages = [...(options.history ?? [])];

    // Add user message to session
    const userMsg: AgentMessage = {
      id: generateId(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
      images,
    };
    this.session.messages.push(userMsg);
    this.emit('message:add', userMsg);

    // Create assistant placeholder (isStreaming = true so buildChatMessages filters it out)
    const assistantMsg: AgentMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    this.session.messages.push(assistantMsg);
    this.emit('message:add', assistantMsg);

    try {
      if (isDirectIllustrationRequest(userMessage)) {
        assistantMsg.content = await this.answerWithIllustration(userMessage, context, options, assistantMsg.id);
        assistantMsg.isStreaming = false;
        this.emit('message:done', assistantMsg);
        return assistantMsg;
      }

      const planRequest = isDocumentPlanRequest(userMessage);
      const wantsLongAnswer = planRequest || this.isLongAnswerRequest(userMessage);
      if (planRequest) {
        const planned = await this.answerWithDocumentPlan(userMessage, context, options, assistantMsg);
        if (planned) {
          assistantMsg.content = planned.text;
          assistantMsg.thinking = planned.thinking;
          assistantMsg.isStreaming = false;
          this.emit('message:done', assistantMsg);
          return assistantMsg;
        }
      }

      const useEditingTools = !planRequest && this.shouldEnableEditingTools(userMessage, context, tabId);
      if (!useEditingTools) {
        const response = await this.generateReply(context, options, wantsLongAnswer, (delta, fullText) => {
          assistantMsg.content = fullText;
          this.emit('message:stream', {
            messageId: assistantMsg.id,
            chunk: delta,
            fullText,
          });
          options.onChunk?.({
            messageId: assistantMsg.id,
            delta,
            fullText,
          });
        });

        assistantMsg.content = response.trim() || 'AI 服务在流式与非流式重试后仍返回空内容。请检查文本模型 ID、服务兼容性，或查看日志里的原始响应。';
        assistantMsg.isStreaming = false;
        this.emit('message:done', assistantMsg);
        return assistantMsg;
      }

      const tools = this.buildOpenAITools();

      // Build LLM messages, filtering out the empty streaming placeholder
      let allMessages = await this.buildChatMessages(context, options.references, wantsLongAnswer);

      const MAX_ROUNDS = 5;
      let finalContent = '';

      try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        // Push "thinking" status — label changes on subsequent rounds
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: 'TOOL_STATUS',
            payload: { status: round === 0 ? '思考中...' : '继续思考...', round },
          }).catch(() => {/* ignore */});
        }

        const response = await modelProvider.completeWithTools('smart', allMessages, tools, {
          temperature: 0.7,
          max_tokens: wantsLongAnswer ? 4096 : 900,
        });

        // After the LLM responds, push any thinking text it produced
        if (tabId && response.content) {
          const thinkingText = response.content.trim();
          if (thinkingText) {
            chrome.tabs.sendMessage(tabId, {
              type: 'TOOL_STATUS',
              payload: {
                status: round === 0 ? '思考中...' : '继续思考...',
                round,
                thinkingText,
              },
            }).catch(() => {/* ignore */});
          }
        }

        if (response.tool_calls?.length && response.finish_reason === 'tool_calls') {
          // Add assistant's tool_calls message to the running history
          const assistantToolMsg: ChatMessage = {
            role: 'assistant',
            content: clipHead(response.content || '', 800),
            tool_calls: response.tool_calls.map(toolCall => ({
              ...toolCall,
              function: {
                ...toolCall.function,
                arguments: JSON.stringify({
                  note: `${toolCall.function.name} 已执行，原始参数 ${toolCall.function.arguments.length} 字，此处省略以免撑满上下文`,
                }),
              },
            })),
          };
          allMessages.push(assistantToolMsg);

          // Execute all tool calls (cross-process, via content script)
          const toolResults = await Promise.all(
            response.tool_calls.map(tc => this.executeToolCall(tc, tabId)),
          );

          // Add tool result messages
          for (let i = 0; i < response.tool_calls.length; i++) {
            allMessages.push({
              role: 'tool',
              tool_call_id: response.tool_calls[i].id,
              content: toolResults[i],
            });
          }
          continue;
        }

        // Final text reply
        finalContent = response.content ?? '';
        break;
      }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLog('error', 'agent.tool_round_failed', { message });
        if (!isContextWindowError(error) || finalContent.trim()) throw error;
        debugLog('warn', 'agent.context_compact_retry', { stage: 'tool-round' });
        console.warn('[Doc Copilot] Context window is full during tool round; retrying without tools.');
        finalContent = await this.generateReply(context, options, wantsLongAnswer, (delta, fullText) => {
          assistantMsg.content = fullText;
          this.emit('message:stream', {
            messageId: assistantMsg.id,
            chunk: delta,
            fullText,
          });
          options.onChunk?.({ messageId: assistantMsg.id, delta, fullText });
        }, 'compact');
      }

      assistantMsg.content = finalContent.trim() || 'AI 服务没有返回最终回答。请检查文本模型是否支持工具调用，或查看日志里的原始响应。';
      assistantMsg.isStreaming = false;
      this.emit('message:done', assistantMsg);
      return assistantMsg;

    } catch (error) {
      assistantMsg.content = `Error: ${(error as Error).message}`;
      assistantMsg.isStreaming = false;
      this.emit('message:done', assistantMsg);
      throw error;
    }
  }

  /** Execute a quick command (no conversation, just result) */
  async command(
    command: string,
    context: DocumentContext,
  ): Promise<string> {
    const lang = detectLanguage(context.textBefore || '');
    const isZh = lang === 'zh';

    const commandPrompts: Record<string, string> = {
      fix: isZh ? '修正以下文本中的错误。严格保持原文的所有格式（换行、列表、标题、缩进等），只输出修正后的文本：' : 'Fix errors in the following text. Strictly preserve all formatting (line breaks, lists, headings, indentation, etc.), output only the corrected text:',
      rewrite: isZh ? '重写以下文本，保持原意但改善表达。严格保持原文的所有格式（换行、列表、标题、缩进等）：' : 'Rewrite the following text, keeping the meaning but improving expression. Strictly preserve all formatting (line breaks, lists, headings, indentation, etc.):',
      polish: isZh ? '润色以下文本，提升专业性和可读性。【重要】严格保持原文的所有格式：换行位置、空行、列表格式（-、*、数字）、标题标记（#）、代码块、引用块、缩进等，禁止合并段落或改变结构，只输出润色后的文本：' : 'Polish the following text, improve professionalism and readability. [IMPORTANT] Strictly preserve all formatting: line breaks, blank lines, list formats (-, *, numbers), heading markers (#), code blocks, quote blocks, indentation, etc. Do not merge paragraphs or change structure, output only the polished text:',
      summarize: isZh ? '总结以下文本的要点：' : 'Summarize the key points of the following text:',
      expand: isZh ? '扩展以下文本，添加更多细节和解释：' : 'Expand the following text with more details and explanations:',
      translate_en: '将以下文本翻译为英文。严格保持原文的所有格式（换行、列表、标题、缩进等）：',
      translate_zh: 'Translate the following text to Chinese. Strictly preserve all formatting (line breaks, lists, headings, indentation, etc.):',
      formal: isZh ? '将以下文本改写为正式语气。严格保持原文的所有格式（换行、列表、标题、缩进等）：' : 'Rewrite the following text in formal tone. Strictly preserve all formatting (line breaks, lists, headings, indentation, etc.):',
      casual: isZh ? '将以下文本改写为轻松语气。严格保持原文的所有格式（换行、列表、标题、缩进等）：' : 'Rewrite the following text in casual tone. Strictly preserve all formatting (line breaks, lists, headings, indentation, etc.):',
    };

    const prompt = commandPrompts[command];
    if (!prompt) throw new Error(`Unknown command: ${command}`);

    const text = context.selectedText || context.textBefore.slice(-500);
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt },
      { role: 'user', content: text },
    ];

    const response = await modelProvider.complete('smart', messages, {
      temperature: 0.5,
      max_tokens: 8192,
    });

    return chatContentToText(response.choices[0]?.message?.content) || '';
  }

  /** Clear conversation history */
  clearHistory(): void {
    this.session = this.createSession();
    this.emit('session:clear', undefined);
  }

  /** Stop current generation */
  stop(): void {
    modelProvider.abort('smart');
  }

  /**
   * Resolve a pending tool call from the content script.
   * Called by the background message handler when TOOL_CALL_RESULT arrives.
   */
  resolveToolCall(callId: string, success: boolean, result: string): void {
    const pending = this.pendingToolCalls.get(callId);
    if (!pending) return;
    this.pendingToolCalls.delete(callId);
    pending.resolve(success ? result : `执行失败：${result}`);
  }

  // ================================================================
  // Private Helpers
  // ================================================================

  private createSession(): AgentSession {
    return {
      id: generateId(),
      messages: [],
      createdAt: Date.now(),
    };
  }

  private shouldEnableEditingTools(userMessage: string, context: DocumentContext | null, tabId?: number): boolean {
    if (!tabId || !context) return false;
    if (isDocumentPlanRequest(userMessage)) return false;
    if (!this.looksLikeEditingRequest(userMessage)) return false;
    return (
      context.elementType === 'contenteditable' ||
      context.elementType === 'textarea' ||
      context.elementType === 'input'
    );
  }

  private looksLikeEditingRequest(userMessage: string): boolean {
    const text = userMessage.trim().toLowerCase();
    return /(?:修改|替换|插入|写入|改写|重写|润色|优化|修正|纠错|翻译成|帮我改|直接改|apply|edit|replace|insert|rewrite|polish|fix|correct|translate)/i.test(text);
  }

  private isLongAnswerRequest(userMessage: string): boolean {
    const text = userMessage.trim().toLowerCase();
    return /(?:详细|展开|完整|深入|长文|全面|逐段|逐条解释|完整稿|完整文章|写一篇|生成一篇|越详细越好|more detail|detailed|in depth|comprehensive|full draft|long form|write an article)/i.test(text);
  }

  /** Build the OpenAI-compatible tools array from all registered tools */
  private buildOpenAITools(): object[] {
    return [...this.tools, ...this.customTools].map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Send a tool call request to the content script and wait for the result.
   * Uses a Promise bridge backed by pendingToolCalls map.
   */
  private async executeToolCall(toolCall: ToolCall, tabId?: number): Promise<string> {
    if (!tabId) return '错误：无法获取页面 Tab ID，工具调用跳过';

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      return '错误：工具参数解析失败';
    }

    this.emit('tool:call', { name: toolCall.function.name, args });

    // Push status to content script for UI display
    const toolLabels: Record<string, string> = {
      'insert_at_cursor': '插入文本...',
      'replace_selection': '替换选中内容...',
      'replace_text': '查找并替换...',
    };
    const statusText = toolLabels[toolCall.function.name] || `执行 ${toolCall.function.name}...`;
    chrome.tabs.sendMessage(tabId, {
      type: 'TOOL_STATUS',
      payload: { status: statusText },
    }).catch(() => {/* ignore */});

    const callId = toolCall.id;
    const resultPromise = new Promise<string>((resolve, reject) => {
      this.pendingToolCalls.set(callId, { resolve, reject });
      // 15-second timeout
      setTimeout(() => {
        if (this.pendingToolCalls.has(callId)) {
          this.pendingToolCalls.delete(callId);
          reject(new Error(`工具调用超时: ${toolCall.function.name}`));
        }
      }, 15000);
    });

    try {
      chrome.tabs.sendMessage(tabId, {
        type: 'TOOL_CALL_REQUEST',
        callId,
        toolName: toolCall.function.name,
        args,
      } as ToolCallRequestMessage);
    } catch (_err) {
      this.pendingToolCalls.delete(callId);
      return '错误：无法联系页面';
    }

    return resultPromise.catch(err => `执行失败：${(err as Error).message}`);
  }


  /**
   * Plan a full-document answer before writing it.
   * Returns null when the plan cannot be parsed, so the normal chat path can continue.
   */
  private async answerWithIllustration(
    userMessage: string,
    context: DocumentContext | null,
    options: AgentChatOptions,
    messageId: string,
  ): Promise<string> {
    const { caption, prompt } = buildIllustrationPrompt(userMessage, context?.fullText || '');
    this.pushStatus(options.tabId, '正在调用图像模型...');
    try {
      const url = await modelProvider.generateImage(prompt);
      const text = `已用图像模型生成「${caption}」。\n\n![${caption}](${url})`;
      options.onChunk?.({ messageId, delta: text, fullText: text });
      return text;
    } catch (error) {
      return `图像模型没有生成成功：${(error as Error).message}`;
    }
  }

  private async answerWithDocumentPlan(
    userMessage: string,
    context: DocumentContext | null,
    options: AgentChatOptions,
    assistantMsg: AgentMessage,
  ): Promise<{ text: string; thinking: string } | null> {
    const allowImages = wantsIllustratedDocument(userMessage)
      || /配图|插图|加几张图|配上图|带图/.test(userMessage);
    this.pushStatus(options.tabId, '正在规划结构...');

    const settings = await settingsStorage.get();
    const maxContextChars = settings.agentMaxContextChars || 800000;
    const promptInput = {
      userMessage,
      context,
      references: options.references,
      maxContextChars,
      allowImages,
    };
    let rawPlan = '';
    try {
      const planResponse = await modelProvider.complete('smart', this.withReadableImages(buildPlanMessages(promptInput), options.images), {
        temperature: 0.2,
        max_tokens: 4096,
      });
      rawPlan = completionText(planResponse);
    } catch (error) {
      console.warn('[Doc Copilot] Document plan request failed:', error);
    }
    let plan = parseDocumentPlan(rawPlan, allowImages);
    let planStatus = '已规划结构';
    if (!plan) {
      console.warn('[Doc Copilot] Document plan was not parseable; planning from the document instead.', rawPlan.slice(0, 400));
      plan = fallbackDocumentPlan(userMessage, context?.fullText || '', allowImages);
      planStatus = '已按文档自动规划';
    }

    const planned = ensurePlanImages(plan, allowImages);
    let thinking = formatPlanMarkdown(planned);
    this.pushStatus(options.tabId, planStatus, thinking, true);

    const draft = await modelProvider.streamToString(
      'smart',
      this.withReadableImages(buildDraftMessages({ ...promptInput, plan: planned }), options.images),
      { temperature: 0.7, max_tokens: 4096 },
      (_delta, fullText) => {
        const preview = previewImageMarkers(fullText);
        assistantMsg.content = preview;
        this.emit('message:stream', { messageId: assistantMsg.id, chunk: _delta, fullText: preview });
        options.onChunk?.({ messageId: assistantMsg.id, delta: _delta, fullText: preview });
      },
    );
    const draftText = draft.trim() || planned.sections
      .map(section => `## ${section.title}\n\n${section.note}`)
      .join('\n\n');

    const images: ResolvedPlanImage[] = [];
    for (let index = 0; index < planned.images.length; index++) {
      const image = planned.images[index];
      thinking = formatPlanMarkdown(planned, index);
      this.pushStatus(options.tabId, `正在生成配图 ${index + 1}/${planned.images.length}`, thinking, true);
      try {
        const url = await modelProvider.generateImage(image.prompt);
        images.push({ ...image, url });
      } catch (error) {
        images.push({ ...image, error: (error as Error).message });
      }
    }

    const text = placePlanImages(draftText, images);
    thinking = formatPlanMarkdown(planned);
    assistantMsg.content = text;
    assistantMsg.thinking = thinking;
    this.pushStatus(options.tabId, '结构已完成', thinking, true);
    options.onChunk?.({ messageId: assistantMsg.id, delta: '', fullText: text });
    return { text, thinking };
  }

  private withReadableImages(messages: ChatMessage[], images?: ChatImageInput[]): ChatMessage[] {
    const readableImages = this.getReadableImages(images);
    if (!readableImages.length) return messages;
    const next = messages.map(message => ({ ...message }));
    const last = next[next.length - 1];
    if (last?.role === 'user' && typeof last.content === 'string') {
      last.content = this.buildMultimodalUserContent(last.content, readableImages);
    }
    return next;
  }

  private pushStatus(tabId: number | undefined, status: string, thinkingText?: string, expanded = false): void {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, {
      type: 'TOOL_STATUS',
      payload: { status, thinkingText, expanded },
    }).catch(() => { /* tab may have navigated away */ });
  }

  private async generateReply(
    context: DocumentContext | null,
    options: AgentChatOptions,
    wantsLongAnswer: boolean,
    onChunk: (delta: string, fullText: string) => void,
    startMode: 'normal' | 'compact' = 'normal',
  ): Promise<string> {
    const run = (mode: 'normal' | 'compact') => this.buildChatMessages(context, options.references, wantsLongAnswer, mode)
      .then(messages => modelProvider.streamToString(
        'smart',
        messages,
        {
          temperature: 0.7,
          max_tokens: mode === 'compact' ? (wantsLongAnswer ? 1200 : 600) : (wantsLongAnswer ? 4096 : 900),
        },
        onChunk,
      ));
    try {
      return await run(startMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog('error', 'agent.reply_failed', { mode: startMode, message });
      if (startMode === 'compact' || !isContextWindowError(error)) throw error;
      debugLog('warn', 'agent.context_compact_retry', { stage: 'reply', from: startMode });
      console.warn('[Doc Copilot] Context window is full; retrying with a shorter follow-up prompt.');
      return run('compact');
    }
  }

  private async buildChatMessages(
    context: DocumentContext | null,
    references?: ReferenceContext[],
    wantsLongAnswer = false,
    mode: 'normal' | 'compact' = 'normal',
  ): Promise<ChatMessage[]> {
    const settings = await settingsStorage.get();
    const maxContextChars = settings.agentMaxContextChars || 800000;
    const visibleHistory = this.session.messages.filter(message => !message.isStreaming);
    const hasPriorTurn = visibleHistory.length > 1;
    const docBudget = mode === 'compact' ? Math.min(maxContextChars, 80000) : maxContextChars;

    const toolGuidance = context?.selectedText
      ? `\n用户当前选中了文本："${context.selectedText.slice(0, 200)}"，如需修改选中内容请用 replace_selection 工具。`
      : '';

    let systemContent = `你是 Doc Copilot，一个嵌入文档编辑器的 AI 写作助手。${toolGuidance}

你可以帮助用户：
- 回答关于文档的问题
- 翻译、总结、重新格式化内容
- 提供建议和反馈
- **直接修改文档内容**：如需在文档中插入或替换文字，请直接调用工具完成，然后告知用户已完成

Special commands:
- /summarize-section: The user wants you to summarize the section of the document provided as selectedText. Write a concise summary in the same language as the content, starting directly with the summary text (no preamble, no "Here is a summary:", just the summary itself).

回答格式要求：
- 默认短答：先给结论，再给最多 3-5 个关键点；一般控制在 120-300 字，不要复述整篇文档。
- 如果用户只是问“介绍/总结/怎么看/是什么/帮我理解”，优先输出简洁摘要和最重要信息，避免展开背景和长列表。
- 只有当用户明确要求“详细、展开、完整、长文、逐段、全面”等长回答时，才允许输出更完整的结构化内容。
- 支持 Markdown。涉及文档、资料、官方网站、教程等可引用来源时，如果你知道可靠 URL，请输出为 Markdown 链接，例如：[PyTorch 官方教程](https://pytorch.org/tutorials/)。
- 不要编造 URL；如果当前没有检索能力或不确定链接是否准确，请明确说明，并给出可用于搜索的准确标题或关键词。

如果用户要求修改、替换、改写、插入文档内容，请直接调用相应工具执行，然后简要告知用户已完成什么操作。
`;

    systemContent += wantsLongAnswer
      ? `\n本轮用户明确需要较完整回答，可以适度展开，但仍避免无关铺陈。`
      : `\n本轮按默认短答处理，除非必要不要超过 5 个要点。`;

    if (context) {
      systemContent += `\n当前文档上下文：`;
      if (context.title) systemContent += `\n标题：${context.title}`;

      if (context.fullText) {
        const fullTextTruncated = clipMiddle(context.fullText, docBudget);
        systemContent += `\n\n文档全文：\n"""\n${fullTextTruncated}\n"""`;
      }

      if (context.documentImages?.length) {
        systemContent += `\n\n文档内图片：共 ${context.documentImages.length} 张。`;
        systemContent += '\n可读取的图片会随当前用户消息以多模态 image_url 形式提供；如果只看到图片占位或 URL，请明确说明无法直接读取该图片内容。';
        systemContent += context.documentImages.slice(0, 8).map((image, index) => {
          return `\n- ${describeDocumentImage(image, index)}`;
        }).join('');
      }

      if (context.selectedText) {
        systemContent += `\n\n选中文本："""${context.selectedText.slice(0, 1000)}"""`;
      }

      if (context.textBefore || context.textAfter) {
        systemContent += `\n\n光标附近文本：\n"""${context.textBefore.slice(-500)}[CURSOR]${context.textAfter.slice(0, 500)}"""`;
      }
    }

    if (references?.length) {
      systemContent += `\n\n用户钉住的引用资料（用于理解和撰写当前内容）：`;
      systemContent += `\n- 使用引用时，请在相关结论或改写依据附近标注 [引用 N]。`;
      systemContent += `\n- 不要把引用资料中没有的信息说成事实；如果引用不足，请说明还需要更多资料。`;
      const referenceLimit = mode === 'compact' ? 1500 : 8000;
      const visibleReferences = mode === 'compact' ? references.slice(0, 4) : references;
      systemContent += visibleReferences.map(ref => {
        const text = clipHead(ref.text, referenceLimit);
        return `\n\n[引用 ${ref.index}] ${ref.title}\nURL: ${ref.url}\n片段：\n"""${text}"""`;
      }).join('');
    }

    systemContent = stripInlineImages(systemContent);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
    ];

    const currentMessage = visibleHistory[visibleHistory.length - 1];
    const priorMessages = this.selectPriorMessages(visibleHistory.slice(0, -1), mode);
    for (const msg of priorMessages) {
      messages.push({
        role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
        content: msg.content,
      });
    }
    if (currentMessage) {
      const currentImages = this.selectTurnImages(currentMessage.images, hasPriorTurn, currentMessage.content || '', mode);
      const uploadedCount = currentImages.filter(image => image.origin !== 'document').length;
      const documentCount = currentImages.filter(image => image.origin === 'document').length;
      const imageNote = [
        uploadedCount ? `用户随消息附加了 ${uploadedCount} 张图片` : '',
        documentCount ? `当前文档内有 ${documentCount} 张图片已随消息提供` : '',
      ].filter(Boolean).join('；');
      const textContent = currentImages.length
        ? `${currentMessage.content || ''}\n\n[${imageNote}。]`.trim()
        : currentMessage.content;
      messages.push({
        role: currentMessage.role as 'user' | 'assistant' | 'system' | 'tool',
        content: currentMessage.role === 'user' && currentImages.length
          ? this.buildMultimodalUserContent(textContent, currentImages)
          : textContent,
      });
    }

    const historyChars = priorMessages.reduce((sum, message) => sum + (message.content?.length || 0), 0);
    debugLog('info', 'agent.prompt', {
      mode,
      maxContextChars,
      docBudget,
      systemChars: systemContent.length,
      fullTextChars: context?.fullText?.length || 0,
      historyMessages: priorMessages.length,
      historyChars,
      messageCount: messages.length,
    });

    return messages;
  }


  private selectPriorMessages(messages: AgentMessage[], mode: 'normal' | 'compact'): AgentMessage[] {
    const perMessage = mode === 'compact' ? 4000 : 40000;
    const budget = mode === 'compact' ? 16000 : 160000;
    const kept: AgentMessage[] = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0 && kept.length < (mode === 'compact' ? 8 : 20); index--) {
      const content = clipHead(messages[index].content || '', perMessage);
      if (used + content.length > budget && kept.length > 0) break;
      kept.push({ ...messages[index], content, images: undefined });
      used += content.length;
    }
    return kept.reverse();
  }

  private selectTurnImages(
    images: ChatImageInput[] | undefined,
    hasPriorTurn: boolean,
    userMessage: string,
    mode: 'normal' | 'compact',
  ): ChatImageInput[] {
    const readable = this.getReadableImages(images);
    const uploads = readable.filter(image => image.origin !== 'document');
    const documents = readable.filter(image => image.origin === 'document');
    if (mode === 'compact') return uploads.slice(0, 1);
    return [...uploads, ...documents].slice(0, 8);
  }

  private buildMultimodalUserContent(text: string, images: ChatImageInput[]): ChatMessage['content'] {
    return [
      { type: 'text', text: text || '请阅读并分析我上传的图片。' },
      ...images.map(image => ({
        type: 'image_url' as const,
        image_url: {
          url: image.dataUrl,
          detail: 'auto' as const,
        },
      })),
    ];
  }

  private getReadableImages(images?: ChatImageInput[]): ChatImageInput[] {
    return (images ?? [])
      .map(image => ({
        ...image,
        dataUrl: image.dataUrl || image.sourceUrl || '',
      }))
      .filter(image => Boolean(image.dataUrl));
  }
}


function isContextWindowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /context window is full|context length|maximum context|too many tokens|reduce conversation history|请精简对话历史|上下文过长|上下文窗口/i.test(message);
}

function stripInlineImages(text: string): string {
  return text.replace(/data:image\/[a-z0-9.+-]+(?:;[^,]*)?;base64,[a-z0-9+/=\s]+/gi, '[图片]');
}

function describeDocumentImage(image: ChatImageInput, index: number): string {
  const sourceUrl = publicHttpUrl(image.sourceUrl);
  return [
    `图片 ${index + 1}`,
    image.name,
    image.width && image.height ? `${image.width}x${image.height}` : '',
    sourceUrl,
  ].filter(Boolean).join(' | ');
}

function publicHttpUrl(url?: string): string {
  if (!url || /^(?:data|blob):/i.test(url)) return '';
  if (!/^https?:\/\//i.test(url)) return '';
  return url.length > 300 ? `${url.slice(0, 300)}…` : url;
}

function clipHead(text: string, maxChars: number): string {
  const cleaned = stripInlineImages(text);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}\n...[较早内容已省略]`;
}

function clipMiddle(text: string, maxChars: number): string {
  const cleaned = stripInlineImages(text);
  if (cleaned.length <= maxChars) return cleaned;
  const head = Math.ceil(maxChars * 0.72);
  const tail = Math.max(0, maxChars - head);
  return `${cleaned.slice(0, head)}\n...[中间内容已省略]\n${tail ? cleaned.slice(-tail) : ''}`;
}

export const agentSystem = new AgentSystem();
