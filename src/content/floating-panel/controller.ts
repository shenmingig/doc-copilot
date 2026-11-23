// ============================================================
// Floating Panel Controller - Floating bubble + chat panel
// ============================================================

import { ChromeDocumentAdapter } from '../../adapters/chrome/adapter';
import { ISiteAdapter } from '../../adapters/sites/types';
import { AppSettings, AgentMessage, ChatHistorySession, ChatImageInput, DEFAULT_SETTINGS, ModelConfig, ModelRole, ExtensionMessage, PinnedReference, DocumentReferenceBinding, ReferenceContext, isAiConfigured, isModelConfigComplete } from '../../shared/types/index';
import { settingsStorage } from '../../shared/storage/settings';
import { renderMarkdown, getLogEntries, clearLogEntries, escapeHtml } from '../../shared/utils/index';

const MODEL_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export class FloatingPanelController {
  private adapter: ChromeDocumentAdapter;
  private siteAdapter: ISiteAdapter;

  // DOM
  private bubble: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private imageLightbox: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private printStyle: HTMLStyleElement | null = null;

  // State
  private settings: AppSettings = DEFAULT_SETTINGS;
  private chatMessages: AgentMessage[] = [];
  private isPanelOpen = false;
  private isWaitingResponse = false;
  private activeAgentStream: {
    hadChunks: boolean;
    finalized: boolean;
    content: string;
    response?: AgentMessage;
    error?: string;
  } | null = null;
  private activeThinkingText = '';
  private activeThinkingStatus = '';
  private pendingChatImages: ChatImageInput[] = [];
  private pageKey = this.computePageKey();
  private currentSessionId = this.generateSessionId();
  private historySessions: ChatHistorySession[] = [];
  private historySaveTimer: ReturnType<typeof setTimeout> | null = null;
  private isHistoryOpen = false;
  private isFunctionMenuOpen = false;
  private pinnedReferences: PinnedReference[] = [];
  private referenceBinding: DocumentReferenceBinding | null = null;
  private isReferencesOpen = false;
  private hasShownSetupGuide = false;
  private settingsReady: Promise<void>;
  private settingsLoaded = false;

  // Bubble drag state
  private isDraggingBubble = false;
  private bubbleDragOffset = { x: 0, y: 0 };
  private bubbleHasMoved = false;

  // Panel drag state
  private isDraggingPanel = false;
  private panelDragOffset = { x: 0, y: 0 };

  // Token usage polling
  private usageInterval: ReturnType<typeof setInterval> | null = null;
  private contextTooltipTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    requests: 0,
  };
  private imageProgressTimer: ReturnType<typeof setInterval> | null = null;
  private imageProgressStartedAt = 0;
  private chatRequestTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(adapter: ChromeDocumentAdapter, siteAdapter: ISiteAdapter) {
    this.adapter = adapter;
    this.siteAdapter = siteAdapter;
    this.settingsReady = this.loadSettings();
    this.listenForEvents();
    this.createBubble();
  }

  toggle(): void {
    if (this.isPanelOpen) {
      this.hidePanel();
    } else {
      this.showPanel();
    }
  }

  show(): void {
    this.showPanel();
  }

  hide(): void {
    this.hidePanel();
  }

  openSettings(): void {
    this.showPanel();
    this.openSettingsDrawer();
  }

  // ================================================================
  // Bubble
  // ================================================================

  private createBubble(): void {
    this.host = document.createElement('div');
    this.host.id = 'doc-copilot-root';

    this.bubble = document.createElement('div');
    this.bubble.className = 'dc-bubble';
    this.bubble.innerHTML = `<span class="dc-bubble-icon">✦</span>`;
    this.bubble.title = 'Doc Copilot';

    // Click to toggle panel (but not after drag)
    this.bubble.addEventListener('mousedown', this.onBubbleMouseDown);
    this.bubble.addEventListener('click', (e) => {
      if (!this.bubbleHasMoved) {
        e.stopPropagation();
        this.toggle();
      }
    });

    this.host.appendChild(this.bubble);
    document.body.appendChild(this.host);
  }

  private onBubbleMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.isDraggingBubble = true;
    this.bubbleHasMoved = false;
    const rect = this.bubble!.getBoundingClientRect();
    this.bubbleDragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    const onMove = (ev: MouseEvent) => {
      if (!this.isDraggingBubble) return;
      this.bubbleHasMoved = true;
      const x = Math.max(0, Math.min(window.innerWidth - 48, ev.clientX - this.bubbleDragOffset.x));
      const y = Math.max(0, Math.min(window.innerHeight - 48, ev.clientY - this.bubbleDragOffset.y));
      this.bubble!.style.left = `${x}px`;
      this.bubble!.style.top = `${y}px`;
      this.bubble!.style.right = 'auto';
      this.bubble!.style.bottom = 'auto';
    };

    const onUp = () => {
      this.isDraggingBubble = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // ================================================================
  // Panel
  // ================================================================

  private showPanel(): void {
    if (!this.panel) this.createPanel();
    this.ensureCurrentPageScope();
    this.panel!.style.display = 'flex';
    this.panel!.style.opacity = '0';
    this.panel!.style.transform = 'scale(0.95) translateY(8px)';
    requestAnimationFrame(() => {
      this.panel!.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      this.panel!.style.opacity = '1';
      this.panel!.style.transform = 'scale(1) translateY(0)';
    });
    this.isPanelOpen = true;
    this.bubble?.classList.add('dc-bubble-active');
    this.startUsagePolling();
    this.initializeHistoryPanel();
    this.initializeReferencesPanel();
    this.refreshSetupState();
    this.settingsReady
      .then(() => {
        if (!this.panel || !this.isPanelOpen) return;
        this.refreshSetupState();
        if (!this.isAiSetupComplete() && !this.hasShownSetupGuide) {
          this.hasShownSetupGuide = true;
          window.setTimeout(() => this.openSetupGuide(), 120);
        }
      })
      .catch(error => console.warn('[Doc Copilot] Failed to initialize settings state:', error));
  }

  private hidePanel(): void {
    if (this.panel) {
      this.closeFunctionMenu();
      this.closeReferencesDrawer();
      this.panel.style.opacity = '0';
      this.panel.style.transform = 'scale(0.95) translateY(8px)';
      setTimeout(() => {
        if (this.panel) this.panel.style.display = 'none';
      }, 200);
    }
    this.isPanelOpen = false;
    this.bubble?.classList.remove('dc-bubble-active');
    this.stopUsagePolling();
  }

  private createPanel(): void {
    this.panel = document.createElement('div');
    this.panel.className = 'dc-panel';
    this.panel.style.display = 'none';

    this.panel.innerHTML = `
      <div class="dc-panel-header" data-draggable>
        <div class="dc-panel-title">✦ Doc Copilot</div>
        <div class="dc-panel-actions">
          <button class="dc-panel-btn dc-panel-pin" title="钉住当前页面为引用">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M5.4 1.8l4.8 4.8M9.7 2.3L13.7 6.3 11.9 8.1 10.7 6.9 7.2 10.4 7.6 13.7 2.3 8.4 5.6 8.8 9.1 5.3 7.9 4.1 9.7 2.3z" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="dc-panel-btn dc-panel-function" title="功能">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M9.5 1.8l4.7 4.7-1.9 1.9-1.1-1.1-5.7 5.7a1.5 1.5 0 01-2.1 0l-.4-.4a1.5 1.5 0 010-2.1l5.7-5.7-1.1-1.1 1.9-1.9z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M5.2 10.8l1.9 1.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="dc-panel-btn dc-panel-settings" title="Settings">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 10a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M13.45 9.8a1.3 1.3 0 00.26 1.43l.05.05a1.58 1.58 0 010 2.24 1.58 1.58 0 01-2.24 0l-.05-.05a1.3 1.3 0 00-1.43-.26 1.3 1.3 0 00-.79 1.19v.14a1.58 1.58 0 01-3.16 0v-.07a1.3 1.3 0 00-.85-1.19 1.3 1.3 0 00-1.43.26l-.05.05a1.58 1.58 0 01-2.24 0 1.58 1.58 0 010-2.24l.05-.05a1.3 1.3 0 00.26-1.43 1.3 1.3 0 00-1.19-.79h-.14a1.58 1.58 0 010-3.16h.07a1.3 1.3 0 001.19-.85 1.3 1.3 0 00-.26-1.43l-.05-.05a1.58 1.58 0 010-2.24 1.58 1.58 0 012.24 0l.05.05a1.3 1.3 0 001.43.26h.06a1.3 1.3 0 00.79-1.19v-.14a1.58 1.58 0 013.16 0v.07a1.3 1.3 0 00.79 1.19 1.3 1.3 0 001.43-.26l.05-.05a1.58 1.58 0 012.24 0 1.58 1.58 0 010 2.24l-.05.05a1.3 1.3 0 00-.26 1.43v.06a1.3 1.3 0 001.19.79h.14a1.58 1.58 0 010 3.16h-.07a1.3 1.3 0 00-1.19.79z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="dc-panel-btn dc-panel-close" title="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>

      <div class="dc-chat-bar">
        <div class="dc-chat-title">Chat</div>
        <div class="dc-chat-bar-actions">
          <button class="dc-panel-btn dc-panel-references" title="引用资料">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 2.5h6.2a1.8 1.8 0 011.8 1.8v8.9l-4-2-4 2V2.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              <path d="M6.4 5.2h4.1M6.4 7.3h3" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/>
            </svg>
          </button>
          <button class="dc-panel-btn dc-panel-history" title="历史会话">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 2.2a5.8 5.8 0 105.52 4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M13.5 2.2v4h-4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M8 5.2v3.1l2.1 1.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="dc-panel-body">
        <div class="dc-chat">
          <div class="dc-chat-messages">
            ${this.renderWelcomeHTML()}
          </div>
          <div class="dc-chat-input-area">
            <div class="dc-chat-attachments" hidden></div>
            <div class="dc-chat-input-wrapper">
              <button class="dc-chat-attach" title="添加图片" type="button">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 2.5h10a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12V4A1.5 1.5 0 013 2.5z" stroke="currentColor" stroke-width="1.2"/>
                  <path d="M4 11l2.2-2.2a1 1 0 011.4 0L9 10.2l1.2-1.2a1 1 0 011.4 0L13 10.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                  <circle cx="11.2" cy="5.4" r="1" fill="currentColor"/>
                </svg>
              </button>
              <textarea class="dc-chat-input" placeholder="Type a message..." rows="1"></textarea>
              <button class="dc-chat-send" title="Send">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14.5 1.5L7 9M14.5 1.5L10 14.5L7 9M14.5 1.5L1.5 6L7 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
            <input class="dc-chat-file" type="file" accept="image/*" multiple hidden aria-hidden="true" tabindex="-1" />
          </div>
        </div>

      </div>

      <div class="dc-function-menu" style="display:none">
        <div class="dc-function-list">
          <button class="dc-function-item" data-fn="save-pdf">
            <span class="dc-function-item-icon">📄</span>
            <span class="dc-function-item-label">转存 PDF</span>
          </button>
          <button class="dc-function-item" data-fn="copy-text">
            <span class="dc-function-item-icon">📋</span>
            <span class="dc-function-item-label">复制纯文本</span>
          </button>
          <button class="dc-function-item" data-fn="copy-markdown">
            <span class="dc-function-item-icon">✍️</span>
            <span class="dc-function-item-label">复制 Markdown</span>
          </button>
          <button class="dc-function-item" data-fn="generate-image">
            <span class="dc-function-item-icon">🖼️</span>
            <span class="dc-function-item-label">生成图片</span>
          </button>
          <button class="dc-function-item" data-fn="print">
            <span class="dc-function-item-icon">🖨️</span>
            <span class="dc-function-item-label">打印</span>
          </button>
        </div>
        <div class="dc-function-status"></div>
      </div>

      <!-- Settings Drawer (initially hidden) -->
      <div class="dc-settings-drawer" style="display: none;">
        <div class="dc-settings-drawer-header">
          <div class="dc-settings-drawer-title">⚙️ Settings</div>
          <button class="dc-panel-btn dc-settings-drawer-close" title="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="dc-settings-drawer-body">
          ${this.renderSettingsHTML()}
        </div>
      </div>

      <div class="dc-history-drawer" style="display: none;">
        <div class="dc-history-header">
          <div class="dc-history-title">历史会话</div>
          <button class="dc-panel-btn dc-history-close" title="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="dc-history-body">
          <div class="dc-history-list"></div>
        </div>
      </div>

      <div class="dc-references-drawer" style="display: none;">
        <div class="dc-references-header">
          <div class="dc-references-title">引用资料</div>
          <button class="dc-panel-btn dc-references-close" title="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="dc-references-body">
          <div class="dc-references-help">勾选后，当前文档的 Chat 会优先引用这些网页片段。</div>
          <div class="dc-references-list"></div>
        </div>
      </div>

      <div class="dc-panel-footer">
        <div class="dc-status-line" data-level="low">
          <span class="dc-status-model" data-status-model>模型：未配置</span>
          <span class="dc-status-sep">|</span>
          <span class="dc-status-bar" aria-hidden="true"><span class="dc-status-bar-fill" data-status-fill></span></span>
          <span class="dc-status-pct" data-status-pct>0.0%</span>
          <span class="dc-status-sep">|</span>
          <span class="dc-status-context" data-status-context>上下文：0/1M</span>
          <span class="dc-context-tooltip" hidden></span>
        </div>
      </div>

      <div class="dc-resize-handle dc-resize-n" data-resize="n"></div>
      <div class="dc-resize-handle dc-resize-e" data-resize="e"></div>
      <div class="dc-resize-handle dc-resize-s" data-resize="s"></div>
      <div class="dc-resize-handle dc-resize-w" data-resize="w"></div>
      <div class="dc-resize-handle dc-resize-ne" data-resize="ne"></div>
      <div class="dc-resize-handle dc-resize-se" data-resize="se"></div>
      <div class="dc-resize-handle dc-resize-sw" data-resize="sw"></div>
      <div class="dc-resize-handle dc-resize-nw" data-resize="nw"></div>
    `;

    this.setupPanelDrag();
    this.setupPanelResize();
    this.setupTabs();
    this.setupChat();
    this.setupFunctionTab();
    this.setupSettings();
    this.setupDebugButton();
    this.setupHistory();
    this.bindOnboardingActions();

    this.host!.appendChild(this.panel);
  }

  // ================================================================
  // Token Usage
  // ================================================================

  private startUsagePolling(): void {
    this.bindContextTooltip();
    this.updateContextMeter();
    this.updateUsageDisplay();
    this.usageInterval = setInterval(() => this.updateUsageDisplay(), 3000);
  }

  private stopUsagePolling(): void {
    if (this.usageInterval) {
      clearInterval(this.usageInterval);
      this.usageInterval = null;
    }
    this.hideContextTooltip();
  }

  private async updateUsageDisplay(): Promise<void> {
    if (!this.panel) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_USAGE' });
      if (response?.usage) this.sessionUsage = this.aggregateUsage(response.usage);
      this.updateContextMeter();
    } catch {
      this.updateContextMeter();
    }
  }

  private bindContextTooltip(): void {
    const meter = this.panel?.querySelector('.dc-status-line') as HTMLElement | null;
    if (!meter || meter.dataset.tooltipBound === 'true') return;
    meter.dataset.tooltipBound = 'true';
    meter.addEventListener('mouseenter', () => {
      this.clearContextTooltipTimer();
      this.contextTooltipTimer = setTimeout(() => this.showContextTooltip(), 900);
    });
    meter.addEventListener('mouseleave', () => this.hideContextTooltip());
  }

  private clearContextTooltipTimer(): void {
    if (this.contextTooltipTimer) {
      clearTimeout(this.contextTooltipTimer);
      this.contextTooltipTimer = null;
    }
  }

  private showContextTooltip(): void {
    this.contextTooltipTimer = null;
    this.renderContextTooltip();
    const tooltip = this.panel?.querySelector('.dc-context-tooltip') as HTMLElement | null;
    if (tooltip) tooltip.hidden = false;
  }

  private hideContextTooltip(): void {
    this.clearContextTooltipTimer();
    const tooltip = this.panel?.querySelector('.dc-context-tooltip') as HTMLElement | null;
    if (tooltip) tooltip.hidden = true;
  }

  private updateContextMeter(): void {
    if (!this.panel) return;
    const root = this.panel.querySelector('.dc-status-line') as HTMLElement | null;
    const model = this.panel.querySelector('[data-status-model]') as HTMLElement | null;
    const fill = this.panel.querySelector('[data-status-fill]') as HTMLElement | null;
    const pct = this.panel.querySelector('[data-status-pct]') as HTMLElement | null;
    const context = this.panel.querySelector('[data-status-context]') as HTMLElement | null;
    if (!root || !model || !fill || !pct || !context) return;

    const usage = this.estimateContextUsage();
    const ratio = Math.min(1, usage.used / Math.max(1, usage.limit));
    const percent = Math.round(ratio * 1000) / 10;
    const modelId = this.settings.models.smart.modelId.trim() || '未配置';
    model.textContent = `模型：${modelId}`;
    model.title = modelId;
    fill.style.width = `${percent}%`;
    pct.textContent = `${percent.toFixed(1)}%`;
    context.textContent = `上下文：${this.formatContextAmount(usage.used)}/${this.formatContextAmount(usage.limit)}`;
    root.dataset.level = percent >= 85 ? 'high' : percent >= 60 ? 'mid' : 'low';
    this.renderContextTooltip();
  }

  private renderContextTooltip(): void {
    const tooltip = this.panel?.querySelector('.dc-context-tooltip') as HTMLElement | null;
    if (!tooltip) return;
    const usage = this.estimateContextUsage();
    const percent = Math.round(Math.min(1, usage.used / usage.limit) * 100);
    const session = this.sessionUsage;
    const row = (label: string, value: string) =>
      `<div class="dc-context-tooltip-row"><span>${label}</span><span>${value}</span></div>`;
    tooltip.innerHTML = [
      '<div class="dc-context-tooltip-title">当前上下文</div>',
      row('窗口', this.formatTokenCount(usage.limit)),
      row('预计已用', `${this.formatTokenCount(usage.used)} · ${percent}%`),
      row('文档', this.formatTokenCount(usage.documentTokens)),
      row('对话', this.formatTokenCount(usage.historyTokens)),
      row('图片', this.formatTokenCount(usage.imageTokens)),
      '<div class="dc-context-tooltip-title">累计消耗</div>',
      row('总计', this.formatTokenCount(session.totalTokens)),
      row('输入', this.formatTokenCount(session.promptTokens)),
      row('输出', this.formatTokenCount(session.completionTokens)),
      row('缓存', this.formatTokenCount(session.cachedTokens)),
      row('推理', this.formatTokenCount(session.reasoningTokens)),
      row('请求', String(session.requests)),
      '<div class="dc-context-tooltip-note">进度条是当前上下文占比。累计消耗仍在这里查看。中文大约按 2 个字 1 token 估算。</div>',
    ].join('');
  }

  private estimateContextUsage(): {
    used: number;
    limit: number;
    documentTokens: number;
    historyTokens: number;
    imageTokens: number;
  } {
    const limit = Math.max(1000, this.settings.modelContextTokens || 1_000_000);
    const docBudget = Math.max(1000, this.settings.agentMaxContextChars || 800000);
    const context = this.getPageContext();
    const fullText = String(context?.fullText || '');
    const selectedText = String(context?.selectedText || '');
    const documentTokens = this.estimateTokens(Math.min(fullText.length, docBudget) + Math.min(selectedText.length, 1000));

    const history = this.chatMessages.filter(message => !message.isStreaming);
    let historyChars = 0;
    for (const message of history.slice(-20)) {
      historyChars += Math.min((message.content || '').length, 40000);
    }
    const historyTokens = this.estimateTokens(Math.min(historyChars, 160000));

    const documentImageCount = Math.min(context?.documentImages?.length || 0, 8);
    const pendingUploads = this.pendingChatImages.length;
    const latestUser = [...history].reverse().find(message => message.role === 'user');
    const sentUploads = pendingUploads > 0
      ? 0
      : (latestUser?.images?.filter(image => image.origin !== 'document').length || 0);
    const imageTokens = (documentImageCount + pendingUploads + sentUploads) * 1500;
    const systemTokens = 1500;

    return {
      used: systemTokens + documentTokens + historyTokens + imageTokens,
      limit,
      documentTokens,
      historyTokens,
      imageTokens,
    };
  }

  private estimateTokens(chars: number): number {
    return Math.ceil(Math.max(0, chars) / 2);
  }

  private formatTokenCount(n: number): string {
    if (n === 0) return '0';
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + 'k';
    return Math.round(n / 1000) + 'k';
  }

  private formatContextAmount(n: number): string {
    const value = Math.max(0, n);
    if (value >= 1_000_000) {
      const millions = value / 1_000_000;
      const digits = millions >= 10 || Math.abs(millions - Math.round(millions)) < 0.05 ? 0 : 1;
      return `${millions.toFixed(digits)}M`;
    }
    if (value >= 1000) {
      const thousands = value / 1000;
      return `${thousands.toFixed(thousands >= 100 ? 0 : 1)}k`;
    }
    return String(Math.round(value));
  }

  private aggregateUsage(usage: Record<string, any>): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    requests: number;
  } {
    const roles = Object.values(usage || {});
    const sum = (key: string) => roles.reduce((total, stats: any) => total + (Number(stats?.[key]) || 0), 0);
    const promptTokens = sum('promptTokens');
    const completionTokens = sum('completionTokens');
    return {
      promptTokens,
      completionTokens,
      totalTokens: sum('totalTokens') || promptTokens + completionTokens,
      cachedTokens: sum('cachedTokens'),
      reasoningTokens: sum('reasoningTokens'),
      requests: sum('requests'),
    };
  }

  // ================================================================
  // Panel Drag
  // ================================================================

  private setupPanelDrag(): void {
    const header = this.panel!.querySelector('[data-draggable]') as HTMLElement;
    if (!header) return;

    header.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      this.isDraggingPanel = true;
      const rect = this.panel!.getBoundingClientRect();
      this.panelDragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      const onMove = (ev: MouseEvent) => {
        if (!this.isDraggingPanel) return;
        const x = Math.max(0, ev.clientX - this.panelDragOffset.x);
        const y = Math.max(0, ev.clientY - this.panelDragOffset.y);
        this.panel!.style.left = `${x}px`;
        this.panel!.style.top = `${y}px`;
        this.panel!.style.right = 'auto';
        this.panel!.style.bottom = 'auto';
      };

      const onUp = () => {
        this.isDraggingPanel = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  private setupPanelResize(): void {
    const panel = this.panel;
    if (!panel) return;

    panel.querySelectorAll<HTMLElement>('[data-resize]').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const direction = handle.dataset.resize || '';
        const startX = e.clientX;
        const startY = e.clientY;
        const startRect = panel.getBoundingClientRect();
        const minWidth = 320;
        const minHeight = 360;
        const viewportPadding = 8;
        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;

        panel.classList.add('dc-panel-resizing');
        panel.style.left = `${startRect.left}px`;
        panel.style.top = `${startRect.top}px`;
        panel.style.width = `${startRect.width}px`;
        panel.style.height = `${startRect.height}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        document.body.style.userSelect = 'none';
        document.body.style.cursor = getComputedStyle(handle).cursor;

        const onMove = (ev: MouseEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          let left = startRect.left;
          let top = startRect.top;
          let width = startRect.width;
          let height = startRect.height;

          if (direction.includes('e')) {
            width = clamp(
              startRect.width + dx,
              minWidth,
              window.innerWidth - startRect.left - viewportPadding,
            );
          }

          if (direction.includes('s')) {
            height = clamp(
              startRect.height + dy,
              minHeight,
              window.innerHeight - startRect.top - viewportPadding,
            );
          }

          if (direction.includes('w')) {
            const maxLeft = startRect.right - minWidth;
            left = clamp(startRect.left + dx, viewportPadding, maxLeft);
            width = startRect.right - left;
          }

          if (direction.includes('n')) {
            const maxTop = startRect.bottom - minHeight;
            top = clamp(startRect.top + dy, viewportPadding, maxTop);
            height = startRect.bottom - top;
          }

          panel.style.left = `${left}px`;
          panel.style.top = `${top}px`;
          panel.style.width = `${width}px`;
          panel.style.height = `${height}px`;
        };

        const onUp = () => {
          panel.classList.remove('dc-panel-resizing');
          document.body.style.userSelect = previousUserSelect;
          document.body.style.cursor = previousCursor;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });

    function clamp(value: number, min: number, max: number): number {
      return Math.min(Math.max(value, min), Math.max(min, max));
    }
  }

  // ================================================================
  // Tabs
  // ================================================================

  private setupTabs(): void {
    this.panel!.querySelector('.dc-panel-close')?.addEventListener('click', () => {
      this.hidePanel();
    });

    this.panel!.querySelector('.dc-panel-function')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleFunctionMenu();
    });

    this.panel!.querySelector('.dc-panel-pin')?.addEventListener('click', () => {
      this.pinCurrentPage();
    });

    // Settings button in header
    this.panel!.querySelector('.dc-panel-settings')?.addEventListener('click', () => {
      this.openSettingsDrawer();
    });

    this.panel!.querySelector('.dc-panel-references')?.addEventListener('click', () => {
      this.toggleReferencesDrawer();
    });

    this.panel!.querySelector('.dc-panel-history')?.addEventListener('click', () => {
      this.toggleHistoryDrawer();
    });

    // Settings drawer close button
    this.panel!.querySelector('.dc-settings-drawer-close')?.addEventListener('click', () => {
      this.closeSettingsDrawer();
    });

    this.panel!.querySelector('.dc-references-close')?.addEventListener('click', () => {
      this.closeReferencesDrawer();
    });
  }

  private toggleFunctionMenu(): void {
    if (this.isFunctionMenuOpen) {
      this.closeFunctionMenu();
    } else {
      this.openFunctionMenu();
    }
  }

  private openFunctionMenu(): void {
    const menu = this.panel?.querySelector('.dc-function-menu') as HTMLElement | null;
    if (!menu) return;
    this.closeSettingsDrawer();
    this.closeHistoryDrawer();
    this.closeReferencesDrawer();
    menu.style.display = 'block';
    this.isFunctionMenuOpen = true;
    this.panel?.querySelector('.dc-panel-function')?.classList.add('dc-panel-btn-active');
  }

  private closeFunctionMenu(): void {
    const menu = this.panel?.querySelector('.dc-function-menu') as HTMLElement | null;
    if (menu) menu.style.display = 'none';
    this.isFunctionMenuOpen = false;
    this.panel?.querySelector('.dc-panel-function')?.classList.remove('dc-panel-btn-active');
  }

  // ================================================================
  // Chat
  // ================================================================

  private setupChat(): void {
    const input = this.panel!.querySelector('.dc-chat-input') as HTMLTextAreaElement;
    const sendBtn = this.panel!.querySelector('.dc-chat-send') as HTMLElement;
    const attachBtn = this.panel!.querySelector('.dc-chat-attach') as HTMLButtonElement;
    const fileInput = this.panel!.querySelector('.dc-chat-file') as HTMLInputElement;

    fileInput.style.setProperty('display', 'none', 'important');
    fileInput.style.setProperty('position', 'fixed', 'important');
    fileInput.style.setProperty('left', '-9999px', 'important');
    fileInput.style.setProperty('width', '1px', 'important');
    fileInput.style.setProperty('height', '1px', 'important');
    fileInput.style.setProperty('opacity', '0', 'important');
    fileInput.style.setProperty('pointer-events', 'none', 'important');

    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      await this.addImageFiles(fileInput.files);
      fileInput.value = '';
    });

    input.addEventListener('paste', async (e) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      await this.addImageFiles(files);
    });

    const send = async () => {
      const text = input.value.trim();
      const displayImages = [...this.pendingChatImages];
      if ((!text && displayImages.length === 0) || this.isWaitingResponse) return;
      if (!this.isAiSetupComplete()) {
        this.openSetupGuide();
        return;
      }
      const historyBeforeSend = this.getModelChatHistory();

      input.value = '';
      input.style.height = 'auto';
      this.pendingChatImages = [];
      this.renderChatAttachments();
      this.removeWelcome();
      this.addChatMessage({
        id: this.generateSessionId(),
        role: 'user',
        content: text || '请阅读这张图片。',
        timestamp: Date.now(),
        images: displayImages,
      }, { forceScroll: true });
      this.isWaitingResponse = true;
      this.showTypingIndicator({ forceScroll: true });
      this.startChatRequestWatchdog();
      this.saveCurrentHistory();

      try {
        const context = this.getPageContext();
        if (context) {
          context.documentImages = this.mergeCurrentDocumentImages(context.documentImages);
        }
        const references = await this.getReferenceContexts(text, context);
        const documentImages = await this.prepareDocumentImagesForModel(context?.documentImages);
        if (context) {
          context.documentImages = documentImages.map(image => ({
            ...image,
            dataUrl: '',
            previewUrl: undefined,
            sourceUrl: this.publicHttpUrl(image.sourceUrl) || undefined,
          }));
        }
        const modelImages = [
          ...displayImages
            .map(({ previewUrl: _previewUrl, ...image }) => image)
            .filter(image => this.isSupportedModelImage(image, 'upload')),
          ...documentImages,
        ];
        const response = await chrome.runtime.sendMessage({
          type: 'AGENT_MESSAGE',
          payload: {
            message: text || '请阅读这张图片。',
            context,
            images: modelImages,
            history: historyBeforeSend,
            references,
          },
        });
        this.stopChatRequestWatchdog();

        if (!this.isWaitingResponse && !this.activeAgentStream) {
          this.saveCurrentHistory();
          this.updateUsageDisplay();
          return;
        }

        if (this.activeAgentStream?.finalized) {
          this.activeAgentStream = null;
          this.saveCurrentHistory();
          this.updateUsageDisplay();
          return;
        }

        if (this.activeAgentStream?.hadChunks) {
          if (response?.error) {
            this.finishChatWithError(response.error);
            return;
          }
          this.finalizeStreamingAssistant(response?.response);
          this.activeAgentStream = null;
          this.saveCurrentHistory();
          this.updateUsageDisplay();
          return;
        }

        if (response?.error) {
          this.finishChatWithError(response.error);
        } else if (response?.response) {
          this.hideTypingIndicator();
          this.isWaitingResponse = false;
          this.activeAgentStream = null;
          this.addChatMessage(response.response);
          this.saveCurrentHistory();
        } else {
          this.finishChatWithError('AI 服务没有返回有效内容，请检查 API URL、Key、模型 ID 或稍后重试。');
        }
      } catch (error) {
        this.stopChatRequestWatchdog();
        if (this.activeAgentStream?.finalized) {
          this.activeAgentStream = null;
          this.saveCurrentHistory();
          this.updateUsageDisplay();
          return;
        }

        this.finishChatWithError((error as Error).message || '请求失败，请检查网络或 AI 配置。');
      }

      // Update token display right after response
      this.updateUsageDisplay();
    };

    sendBtn.addEventListener('click', send);

    // Track IME composition state to prevent Enter from sending during composition
    let isComposing = false;
    input.addEventListener('compositionstart', () => { isComposing = true; });
    input.addEventListener('compositionend', () => { isComposing = false; });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        send();
      }
    });
  }

  private removeWelcome(): void {
    const welcome = this.panel?.querySelector('.dc-chat-welcome');
    if (welcome) welcome.remove();
  }

  private renderWelcomeHTML(): string {
    if (!this.isAiSetupComplete()) {
      return `
        <div class="dc-chat-welcome dc-chat-setup">
          <div class="dc-chat-welcome-icon">✦</div>
          <div class="dc-chat-welcome-text">
            <strong>先完成 AI 配置</strong>
            <span>填写 API Base URL、API Key，以及文本模型 ID 后即可开始使用。</span>
          </div>
          <button class="dc-onboarding-btn" type="button" data-open-ai-setup>打开配置</button>
        </div>
      `;
    }

    return `
      <div class="dc-chat-welcome">
        <div class="dc-chat-welcome-icon">✦</div>
        <div class="dc-chat-welcome-text">Hi! Ask me anything about this document.</div>
      </div>
    `;
  }

  private renderChatWelcome(messagesEl?: HTMLElement | null): void {
    const target = messagesEl ?? this.panel?.querySelector('.dc-chat-messages') as HTMLElement | null;
    if (!target) return;
    target.innerHTML = this.renderWelcomeHTML();
    this.bindOnboardingActions(target);
  }

  private bindOnboardingActions(root: ParentNode | null = this.panel): void {
    root?.querySelectorAll<HTMLElement>('[data-open-ai-setup]').forEach(btn => {
      btn.addEventListener('click', () => this.openSetupGuide());
    });
  }

  private addChatMessage(msg: AgentMessage, options?: { forceScroll?: boolean }): void {
    this.chatMessages.push(msg);
    const messagesEl = this.panel!.querySelector('.dc-chat-messages') as HTMLElement;
    const shouldAutoScroll = options?.forceScroll ?? this.isChatNearBottom(messagesEl);

    const bubble = document.createElement('div');
    bubble.className = `dc-msg dc-msg-${msg.role}`;

    const isUser = msg.role === 'user';
    bubble.innerHTML = `
      <div class="dc-msg-bubble ${isUser ? 'dc-msg-bubble-user' : 'dc-msg-bubble-ai'}">
        ${!isUser && msg.thinking ? this.renderThinkingHtml(msg.thinking, false, '结构规划') : ''}
        ${this.renderMessageImages(msg.images)}
        ${this.formatMessageContent(msg.content)}
      </div>
    `;
    if (!isUser && msg.thinking) this.bindThinkingToggle(bubble);
    this.bindMessageImageActions(bubble, msg.images);

    messagesEl.appendChild(bubble);
    if (shouldAutoScroll) this.scrollChatToBottom(messagesEl);
  }

  private showTypingIndicator(options?: { forceScroll?: boolean }): void {
    const messagesEl = this.panel?.querySelector('.dc-chat-messages') as HTMLElement | null;
    if (!messagesEl) return;
    const shouldAutoScroll = options?.forceScroll ?? this.isChatNearBottom(messagesEl);
    this.activeAgentStream = {
      hadChunks: false,
      finalized: false,
      content: '',
    };
    this.activeThinkingText = '';
    this.activeThinkingStatus = '';
    const indicator = document.createElement('div');
    indicator.className = 'dc-msg dc-msg-assistant dc-typing-indicator';
    indicator.innerHTML = `
      <div class="dc-msg-bubble dc-msg-bubble-ai">
        <div class="dc-typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    messagesEl.appendChild(indicator);
    if (shouldAutoScroll) this.scrollChatToBottom(messagesEl);
  }

  private hideTypingIndicator(): void {
    this.panel?.querySelector('.dc-typing-indicator')?.remove();
  }

  private startChatRequestWatchdog(): void {
    this.stopChatRequestWatchdog();
    this.chatRequestTimer = setTimeout(() => {
      if (!this.isWaitingResponse) return;
      this.finishChatWithError('请求等待超过 300 秒，可能是 AI 服务不可达、排队过久或模型没有返回。请检查 API 配置后重试。');
    }, 300000);
  }

  private stopChatRequestWatchdog(): void {
    if (!this.chatRequestTimer) return;
    clearTimeout(this.chatRequestTimer);
    this.chatRequestTimer = null;
  }

  private finishChatWithError(message: string): void {
    this.stopChatRequestWatchdog();
    this.stopImageProgress();
    const readable = this.normalizeErrorMessage(message);
    this.finalizeStreamingAssistant(undefined, readable);
    this.activeAgentStream = null;
    this.isWaitingResponse = false;
    this.saveCurrentHistory();
    this.updateUsageDisplay();
  }

  private normalizeErrorMessage(message: string): string {
    const text = String(message || '').trim();
    if (!text) return '请求失败，但没有收到具体错误信息。请检查 API URL、Key、模型 ID 或稍后重试。';
    if (/^API 错误 \d+:.*not implemented|convert_request_failed/i.test(text)) {
      return '当前网关没有实现这个协议（not implemented）。生图会自动改走对话接口；如果仍然失败，请把图像模型 ID 改成网关支持的生图模型。';
    }
    if (/Extension context invalidated/i.test(text)) return '扩展上下文已刷新，请重新加载页面后重试。';
    if (/Receiving end does not exist|Could not establish connection/i.test(text)) return '没有连接到 Doc Copilot 后台，请刷新页面或重新加载扩展后重试。';
    if (/Failed to fetch|NetworkError|Load failed/i.test(text)) return '无法访问 AI 服务，请检查 API Base URL、网络或跨域配置。';
    if (/401|unauthorized|invalid api key/i.test(text)) return 'API Key 无效或无权限，请检查设置里的 SK。';
    if (/403|forbidden/i.test(text)) return 'AI 服务拒绝访问，请检查 API Key 权限或服务访问控制。';
    if (/404|not found/i.test(text)) return 'AI 接口或模型不存在，请检查 API Base URL 和 Model ID。';
    if (/429|too many|rate/i.test(text)) return 'AI 服务限流或排队，请稍后重试。';
    if (/timeout|timed out|超时/i.test(text)) return 'AI 请求超时，请稍后重试或降低上下文/图片数量。';
    if (/error counting image token|illegal base64 data|failed to decode base64 data|image\/svg\+xml/i.test(text)) {
      return '页面里包含暂不支持的图片格式（如 SVG 或非 base64 图片），已在新版中过滤。请刷新页面或重新加载扩展后重试。';
    }
    return text;
  }

  private updateStreamingAssistant(fullText: string): void {
    const messagesEl = this.panel?.querySelector('.dc-chat-messages') as HTMLElement | null;
    const shouldAutoScroll = messagesEl ? this.isChatNearBottom(messagesEl) : false;
    let indicator = this.panel?.querySelector('.dc-typing-indicator') as HTMLElement | null;
    if (!indicator) {
      this.showTypingIndicator({ forceScroll: shouldAutoScroll });
      indicator = this.panel?.querySelector('.dc-typing-indicator') as HTMLElement | null;
    }

    if (!this.activeAgentStream) {
      this.activeAgentStream = {
        hadChunks: false,
        finalized: false,
        content: '',
      };
    }
    this.activeAgentStream.hadChunks = true;
    this.activeAgentStream.content = fullText;
    this.scheduleHistorySave();

    const bubble = indicator?.querySelector('.dc-msg-bubble') as HTMLElement | null;
    if (!indicator || !bubble) return;

    this.fillAssistantBubble(bubble, fullText, this.activeThinkingText, this.activeThinkingStatus);
    if (messagesEl && shouldAutoScroll) this.scrollChatToBottom(messagesEl);
  }

  private finalizeStreamingAssistant(response?: AgentMessage, error?: string): void {
    this.stopImageProgress();
    const stream = this.activeAgentStream;
    const indicator = this.panel?.querySelector('.dc-typing-indicator') as HTMLElement | null;
    const bubble = indicator?.querySelector('.dc-msg-bubble') as HTMLElement | null;
    const messagesEl = this.panel?.querySelector('.dc-chat-messages') as HTMLElement | null;
    const shouldAutoScroll = messagesEl ? this.isChatNearBottom(messagesEl) : false;

    const content = error
      ? `⚠️ ${error}`
      : response?.content || stream?.content || '⚠️ AI 服务在流式与非流式重试后仍返回空内容。请检查 API Base URL、模型 ID，或查看日志里的原始响应。';
    const thinking = response?.thinking || this.activeThinkingText || undefined;
    const finalMessage: AgentMessage = response ?? {
      id: '',
      role: 'assistant',
      content,
      timestamp: Date.now(),
    };
    finalMessage.content = content;
    if (thinking) finalMessage.thinking = thinking;

    if (indicator && bubble) {
      indicator.classList.remove('dc-typing-indicator');
      this.fillAssistantBubble(bubble, content, thinking || '', this.activeThinkingStatus || '结构规划');
      this.chatMessages.push(finalMessage);
      if (messagesEl && shouldAutoScroll) this.scrollChatToBottom(messagesEl);
    } else {
      this.addChatMessage(finalMessage);
    }

    this.isWaitingResponse = false;
    if (this.activeAgentStream) {
      this.activeAgentStream.finalized = true;
      this.activeAgentStream.response = finalMessage;
      this.activeAgentStream.error = error;
    }
  }

  private isChatNearBottom(messagesEl: HTMLElement, thresholdPx = 80): boolean {
    const distanceToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    return distanceToBottom <= thresholdPx;
  }

  private scrollChatToBottom(messagesEl: HTMLElement): void {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private updateTypingStatus(status: string, thinkingText?: string, expanded = false): void {
    const indicator = this.panel?.querySelector('.dc-typing-indicator');
    if (!indicator) return;
    const bubble = indicator.querySelector('.dc-msg-bubble') as HTMLElement | null;
    if (!bubble) return;
    this.activeThinkingStatus = status;
    if (thinkingText) this.activeThinkingText = thinkingText;

    if (thinkingText) {
      const answer = bubble.querySelector('.dc-answer') as HTMLElement | null;
      const answerHtml = answer?.innerHTML || '';
      bubble.innerHTML = `${this.renderThinkingHtml(thinkingText, expanded, status)}${answerHtml ? `<div class="dc-answer">${answerHtml}</div>` : ''}`;
      this.bindThinkingToggle(bubble);
      return;
    }

    if (!bubble.querySelector('.dc-thinking-block')) {
      bubble.innerHTML = `<span class="dc-typing-status">${escapeHtml(status)}</span>`;
    } else {
      const labelEl = bubble.querySelector('.dc-thinking-label');
      if (labelEl) labelEl.textContent = status;
    }
  }

  private fillAssistantBubble(bubble: HTMLElement, content: string, thinking = '', label = ''): void {
    const thinkingHtml = thinking ? this.renderThinkingHtml(thinking, true, label || this.activeThinkingStatus || '结构规划') : '';
    bubble.innerHTML = `${thinkingHtml}<div class="dc-answer">${this.formatMessageContent(content)}</div>`;
    if (thinkingHtml) this.bindThinkingToggle(bubble);
  }

  private renderThinkingHtml(thinkingText: string, expanded: boolean, label: string): string {
    return `
      <div class="dc-thinking-block">
        <button class="dc-thinking-toggle" type="button" aria-expanded="${expanded ? 'true' : 'false'}" title="展开规划">
          <span class="dc-thinking-label">${escapeHtml(label)}</span>
          <span class="dc-thinking-chevron">${expanded ? '▼' : '▶'}</span>
        </button>
        <div class="dc-thinking-text"${expanded ? '' : ' hidden'}>${this.formatMessageContent(thinkingText)}</div>
      </div>
    `;
  }

  private bindThinkingToggle(root: ParentNode): void {
    const button = root.querySelector('.dc-thinking-toggle') as HTMLElement | null;
    if (!button || button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => {
      const textEl = root.querySelector('.dc-thinking-text') as HTMLElement | null;
      const chevron = root.querySelector('.dc-thinking-chevron') as HTMLElement | null;
      if (!textEl || !chevron) return;
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      textEl.hidden = expanded;
      chevron.textContent = expanded ? '▶' : '▼';
    });
  }

  private formatMessageContent(content: string): string {
    return renderMarkdown(content);
  }

  private startImageProgress(initialStatus: string): void {
    this.stopImageProgress();
    this.imageProgressStartedAt = Date.now();
    this.updateTypingStatus(initialStatus, '已等待 0 秒\n图像生成通常需要 20-60 秒，复杂内容或服务排队时可能更久。');
    this.imageProgressTimer = setInterval(() => {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.imageProgressStartedAt) / 1000));
      const stage = elapsedSeconds < 10
        ? '正在调用图像模型'
        : elapsedSeconds < 30
          ? '图像模型正在生成'
          : elapsedSeconds < 60
            ? '图像生成仍在进行'
            : '图像请求较慢，仍在等待';
      this.updateTypingStatus(stage, `已等待 ${this.formatElapsed(elapsedSeconds)}\n图像生成通常需要 20-60 秒，复杂内容或服务排队时可能更久。`);
    }, 5000);
  }

  private stopImageProgress(): void {
    if (!this.imageProgressTimer) return;
    clearInterval(this.imageProgressTimer);
    this.imageProgressTimer = null;
  }

  private formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  }

  private async addImageFiles(files: FileList | File[] | null): Promise<void> {
    const imageFiles = Array.from(files ?? []).filter(file => {
      if (!file.type.startsWith('image/')) return false;
      if (!MODEL_IMAGE_MIME_TYPES.has(this.normalizeImageMimeType(file.type))) {
        console.warn('[Doc Copilot] Skipped unsupported uploaded image:', file.name, file.type);
        return false;
      }
      return true;
    });
    if (!imageFiles.length) return;

    const slots = Math.max(0, 4 - this.pendingChatImages.length);
    const selected = imageFiles.slice(0, slots);
    for (const file of selected) {
      try {
        this.pendingChatImages.push(await this.prepareChatImage(file));
      } catch (error) {
        console.error('[Doc Copilot] Failed to read image:', error);
      }
    }
    this.renderChatAttachments();
  }

  private async prepareChatImage(file: File): Promise<ChatImageInput> {
    const previewUrl = URL.createObjectURL(file);
    const resized = await this.resizeImageFile(file).catch(async () => ({
      dataUrl: await this.fileToDataUrl(file),
      mimeType: file.type || 'image/png',
      width: undefined,
      height: undefined,
    }));
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      mimeType: resized.mimeType,
      dataUrl: resized.dataUrl,
      previewUrl,
      width: resized.width,
      height: resized.height,
      origin: 'upload',
    };
  }

  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
  }

  private async resizeImageFile(file: File): Promise<{ dataUrl: string; mimeType: string; width: number; height: number }> {
    const bitmap = await createImageBitmap(file);
    try {
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is not available');
      ctx.drawImage(bitmap, 0, 0, width, height);
      const outputMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      return {
        dataUrl: canvas.toDataURL(outputMime, outputMime === 'image/jpeg' ? 0.82 : undefined),
        mimeType: outputMime,
        width,
        height,
      };
    } finally {
      bitmap.close();
    }
  }

  private async prepareDocumentImagesForModel(images?: ChatImageInput[]): Promise<ChatImageInput[]> {
    const selected = (images ?? []).filter(image => this.isSupportedModelImage(image, 'document')).slice(0, 8);
    if (!selected.length) return [];

    const prepared = await Promise.all(selected.map(async (image, index): Promise<ChatImageInput | null> => {
      if (this.isValidBase64ModelDataUrl(image.dataUrl, image.mimeType)) {
        const shrunk = await this.shrinkDataUrlImage(image.dataUrl).catch(error => {
          console.warn('[Doc Copilot] Failed to shrink document image:', error);
          return null;
        });
        return this.toModelDocumentImage(image, index, shrunk ?? {
          dataUrl: image.dataUrl,
          mimeType: this.normalizeImageMimeType(image.mimeType || this.guessImageMimeType(image.dataUrl)),
          width: image.width,
          height: image.height,
        });
      }

      const sourceUrl = image.sourceUrl || image.dataUrl;
      if (!sourceUrl) return null;

      try {
        const loaded = await this.loadDocumentImageDataUrl(image, index);
        if (!loaded) return null;
        return this.toModelDocumentImage(image, index, loaded);
      } catch (error) {
        const label = this.publicHttpUrl(sourceUrl) || sourceUrl.slice(0, 80);
        console.warn('[Doc Copilot] Failed to load document image for model:', label, error);
        return null;
      }
    }));

    return prepared.filter((image): image is ChatImageInput => Boolean(image));
  }

  private toModelDocumentImage(
    image: ChatImageInput,
    index: number,
    loaded: { dataUrl: string; mimeType: string; width?: number; height?: number },
  ): ChatImageInput {
    return {
      ...image,
      dataUrl: loaded.dataUrl,
      mimeType: loaded.mimeType,
      width: loaded.width || image.width,
      height: loaded.height || image.height,
      name: image.name || `文档图片 ${index + 1}`,
      sourceUrl: this.publicHttpUrl(image.sourceUrl) || undefined,
      previewUrl: undefined,
      origin: 'document',
    };
  }

  private publicHttpUrl(url?: string): string {
    if (!url || /^(?:data|blob):/i.test(url)) return '';
    if (!/^https?:\/\//i.test(url)) return '';
    return url.length > 300 ? `${url.slice(0, 300)}…` : url;
  }

  private async shrinkDataUrlImage(
    dataUrl: string,
  ): Promise<{ dataUrl: string; mimeType: string; width: number; height: number } | null> {
    const blob = await fetch(dataUrl).then(response => response.blob());
    const bitmap = await createImageBitmap(blob);
    try {
      const maxSide = 1280;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      return {
        dataUrl: canvas.toDataURL('image/jpeg', 0.82),
        mimeType: 'image/jpeg',
        width,
        height,
      };
    } finally {
      bitmap.close();
    }
  }

  private extractDocumentImagesFromDom(): ChatImageInput[] {
    const root = document.querySelector('#knowledgeContent, div[data-slate-editor="true"].mp-editor-container:not(.mp-micro-editor)')
      || document.body;
    const attrs = ['src', 'data-src', 'data-original', 'data-url', 'data-lazy-src', 'data-actualsrc', 'data-image-src'];
    const seen = new Set<string>();
    const images: ChatImageInput[] = [];

    root.querySelectorAll<HTMLImageElement>('img').forEach((img, index) => {
      if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;

      const raw = img.currentSrc || img.src || attrs.map(attr => img.getAttribute(attr)).find(Boolean);
      if (!raw) return;
      const sourceUrl = this.normalizeImageKey(raw);
      if (!sourceUrl || seen.has(sourceUrl)) return;
      const mimeType = this.guessImageMimeType(sourceUrl);
      if (!this.isSupportedModelImageSource(sourceUrl, mimeType)) return;
      seen.add(sourceUrl);

      const rect = img.getBoundingClientRect();
      const width = img.naturalWidth || img.width || Math.round(rect.width) || undefined;
      const height = img.naturalHeight || img.height || Math.round(rect.height) || undefined;
      if (width && height && width <= 24 && height <= 24) return;

      const className = String(img.className || '');
      if (/avatar|icon|emoji|logo|loading|placeholder/i.test(className)) return;

      images.push({
        id: `dom-doc-image-${index + 1}`,
        name: img.getAttribute('alt')?.trim() || img.getAttribute('title')?.trim() || `文档图片 ${images.length + 1}`,
        mimeType,
        dataUrl: sourceUrl,
        sourceUrl,
        previewUrl: sourceUrl,
        width,
        height,
        origin: 'document',
      });
    });

    return images;
  }

  private mergeCurrentDocumentImages(images?: ChatImageInput[]): ChatImageInput[] {
    const merged = new Map<string, ChatImageInput>();
    for (const image of [...(images ?? []), ...this.extractDocumentImagesFromDom()]) {
      if (!this.isSupportedModelImage(image, 'document')) continue;
      const key = this.normalizeImageKey(image.sourceUrl || image.dataUrl);
      if (key && !merged.has(key)) merged.set(key, image);
    }
    return Array.from(merged.values()).slice(0, 8);
  }

  private isSupportedModelImage(image: ChatImageInput, origin: 'upload' | 'document'): boolean {
    const source = image.dataUrl || image.sourceUrl || '';
    const mimeType = this.normalizeImageMimeType(image.mimeType || this.guessImageMimeType(source));
    const supported = this.isSupportedModelImageSource(source, mimeType);
    if (!supported) {
      console.warn(`[Doc Copilot] Skipped unsupported ${origin} image:`, {
        name: image.name,
        mimeType: image.mimeType,
        source: source.slice(0, 120),
      });
    }
    return supported;
  }

  private isSupportedModelImageSource(source: string, mimeType?: string): boolean {
    const normalizedMime = this.normalizeImageMimeType(mimeType || this.guessImageMimeType(source));
    if (!MODEL_IMAGE_MIME_TYPES.has(normalizedMime)) return false;

    if (source.startsWith('data:')) {
      return this.isValidBase64ModelDataUrl(source, normalizedMime);
    }

    const path = source.split('?')[0].toLowerCase();
    return !path.endsWith('.svg');
  }

  private isValidBase64ModelDataUrl(source: string, mimeType?: string): boolean {
    const match = source.match(/^data:([^;,]+)(;base64)?,/i);
    if (!match) return false;
    const normalizedMime = this.normalizeImageMimeType(mimeType || match[1]);
    return MODEL_IMAGE_MIME_TYPES.has(normalizedMime) && Boolean(match[2]);
  }

  private normalizeImageMimeType(mimeType = ''): string {
    const normalized = mimeType.split(';')[0].trim().toLowerCase();
    if (normalized === 'image/jpg') return 'image/jpeg';
    return normalized;
  }

  private guessImageMimeType(url: string): string {
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)/);
      return this.normalizeImageMimeType(match?.[1] || 'image/png');
    }
    const path = url.split('?')[0].toLowerCase();
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.gif')) return 'image/gif';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    return 'image/png';
  }

  private normalizeImageKey(url: string): string {
    if (!url) return '';
    try {
      return new URL(url, document.baseURI).href.split('#')[0];
    } catch {
      return url.split('#')[0];
    }
  }

  private async loadDocumentImageDataUrl(
    image: ChatImageInput,
    _index: number,
  ): Promise<{ dataUrl: string; mimeType: string; width?: number; height?: number } | null> {
    const sourceUrl = image.sourceUrl || image.dataUrl;
    if (!sourceUrl) return null;

    const fromCanvas = await this.readLoadedImageFromCanvas(sourceUrl, image.mimeType).catch(() => null);
    if (fromCanvas) return fromCanvas;

    return null;
  }

  private async readLoadedImageFromCanvas(
    sourceUrl: string,
    mimeType = 'image/png',
  ): Promise<{ dataUrl: string; mimeType: string; width: number; height: number } | null> {
    const img = this.findLoadedDocumentImage(sourceUrl);
    if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;

    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);

    const outputMime = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    return {
      dataUrl: canvas.toDataURL(outputMime, outputMime === 'image/jpeg' ? 0.82 : undefined),
      mimeType: outputMime,
      width,
      height,
    };
  }

  private findLoadedDocumentImage(sourceUrl: string): HTMLImageElement | null {
    const normalize = (url: string) => {
      try {
        return new URL(url, document.baseURI).href.split('#')[0];
      } catch {
        return url.split('#')[0];
      }
    };
    const target = normalize(sourceUrl);
    const attrs = ['src', 'data-src', 'data-original', 'data-url', 'data-lazy-src', 'data-actualsrc', 'data-image-src'];

    return Array.from(document.images).find(img => {
      const candidates = [
        img.currentSrc,
        img.src,
        ...attrs.map(attr => img.getAttribute(attr) || ''),
      ].filter(Boolean).map(normalize);
      return candidates.includes(target);
    }) ?? null;
  }

  private renderChatAttachments(): void {
    const container = this.panel?.querySelector('.dc-chat-attachments') as HTMLElement | null;
    if (!container) return;
    container.hidden = this.pendingChatImages.length === 0;
    container.innerHTML = this.pendingChatImages.map((image, index) => `
      <div class="dc-chat-attachment" title="${escapeHtml(image.name || 'image')}">
        <img src="${image.previewUrl || image.dataUrl}" alt="${escapeHtml(image.name || 'image')}" />
        <button type="button" class="dc-chat-attachment-remove" data-image-index="${index}" title="移除图片">×</button>
      </div>
    `).join('');
    container.querySelectorAll('.dc-chat-attachment-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = Number((btn as HTMLElement).dataset.imageIndex);
        const [removed] = this.pendingChatImages.splice(index, 1);
        if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
        this.renderChatAttachments();
      });
    });
  }

  private renderMessageImages(images?: ChatImageInput[]): string {
    const visibleImages = images?.filter(image =>
      image.origin !== 'document' && Boolean(image.previewUrl || image.dataUrl || image.sourceUrl),
    ) ?? [];
    if (!visibleImages.length) return '';
    return `<div class="dc-msg-images">${visibleImages.map(image => `
      <div class="dc-msg-image-item">
        <button class="dc-msg-image-open" type="button" title="点击放大" aria-label="放大图片">
          <img src="${escapeHtml(image.previewUrl || image.dataUrl || image.sourceUrl || '')}" alt="${escapeHtml(image.name || '图片')}" class="dc-msg-image" />
        </button>
        <button class="dc-msg-image-copy" type="button" title="复制图片" aria-label="复制图片">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5.2" y="5.2" width="8" height="8" rx="1.4" stroke="currentColor" stroke-width="1.3"/>
            <path d="M10.5 5.1V3.6A1.6 1.6 0 008.9 2H3.6A1.6 1.6 0 002 3.6v5.3a1.6 1.6 0 001.6 1.6h1.5" stroke="currentColor" stroke-width="1.3"/>
          </svg>
        </button>
      </div>
    `).join('')}</div>`;
  }

  private bindMessageImageActions(root: ParentNode, images?: ChatImageInput[]): void {
    const visibleImages = images?.filter(image =>
      image.origin !== 'document' && Boolean(image.previewUrl || image.dataUrl || image.sourceUrl),
    ) ?? [];

    root.querySelectorAll<HTMLButtonElement>('.dc-msg-image-open').forEach((button, index) => {
      const image = visibleImages[index];
      if (!image) return;
      button.addEventListener('click', () => {
        this.openImagePreview(image.previewUrl || image.dataUrl || image.sourceUrl || '', image.name || '图片');
      });
    });

    root.querySelectorAll<HTMLButtonElement>('.dc-msg-image-copy').forEach((button, index) => {
      const image = visibleImages[index];
      if (!image) return;
      button.addEventListener('click', event => {
        event.stopPropagation();
        void this.copyMessageImage(image, button);
      });
    });
  }

  private async copyMessageImage(image: ChatImageInput, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const originalTitle = image.name ? `复制图片：${image.name}` : '复制图片';
    button.title = '正在复制…';

    try {
      let dataUrl = image.dataUrl || image.sourceUrl || image.previewUrl || '';
      if (!dataUrl.startsWith('data:image/')) {
        const fetched = await chrome.runtime.sendMessage({
          type: 'FETCH_IMAGE_DATA_URL',
          payload: { url: dataUrl },
        }) as { dataUrl?: string; error?: string } | undefined;
        if (!fetched?.dataUrl) throw new Error(fetched?.error || '无法读取图片数据');
        dataUrl = fetched.dataUrl;
      }

      const copied = await chrome.runtime.sendMessage({
        type: 'COPY_IMAGE_TO_CLIPBOARD',
        payload: { dataUrl },
      }) as { ok?: boolean; error?: string } | undefined;
      if (!copied?.ok) throw new Error(copied?.error || '复制失败');

      button.title = '已复制图片';
      button.classList.add('dc-msg-image-copy-done');
    } catch (error) {
      button.title = `复制失败：${(error as Error).message}`;
      button.classList.add('dc-msg-image-copy-error');
    } finally {
      button.disabled = false;
      window.setTimeout(() => {
        button.title = originalTitle;
        button.classList.remove('dc-msg-image-copy-done', 'dc-msg-image-copy-error');
      }, 1800);
    }
  }

  private openImagePreview(src: string, alt: string): void {
    if (!src) return;
    if (!this.imageLightbox) {
      const lightbox = document.createElement('div');
      lightbox.className = 'dc-image-lightbox';
      lightbox.hidden = true;
      lightbox.setAttribute('role', 'dialog');
      lightbox.setAttribute('aria-modal', 'true');
      lightbox.setAttribute('aria-label', '图片预览');
      lightbox.innerHTML = `
        <button class="dc-image-lightbox-close" type="button" title="关闭图片预览" aria-label="关闭图片预览">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M3 3l12 12M15 3L3 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
        </button>
        <img class="dc-image-lightbox-image" alt="" />
      `;
      lightbox.addEventListener('click', event => {
        if (event.target === lightbox || (event.target as HTMLElement).closest('.dc-image-lightbox-close')) {
          this.closeImagePreview();
        }
      });
      document.addEventListener('keydown', this.onImageLightboxKeyDown);
      this.host?.appendChild(lightbox);
      this.imageLightbox = lightbox;
    }

    const previewImage = this.imageLightbox.querySelector('.dc-image-lightbox-image') as HTMLImageElement | null;
    if (!previewImage) return;
    previewImage.src = src;
    previewImage.alt = alt;
    this.imageLightbox.hidden = false;
    (this.imageLightbox.querySelector('.dc-image-lightbox-close') as HTMLButtonElement | null)?.focus();
  }

  private onImageLightboxKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.imageLightbox && !this.imageLightbox.hidden) {
      this.closeImagePreview();
    }
  };

  private closeImagePreview(): void {
    if (!this.imageLightbox) return;
    this.imageLightbox.hidden = true;
    const image = this.imageLightbox.querySelector('.dc-image-lightbox-image') as HTMLImageElement | null;
    if (image) image.src = '';
  }

  // ================================================================
  // Pinned References
  // ================================================================

  private async initializeReferencesPanel(): Promise<void> {
    try {
      await Promise.all([
        this.loadPinnedReferences(),
        this.loadReferenceBinding(),
      ]);
      this.renderReferencesList();
    } catch (error) {
      console.warn('[Doc Copilot] Failed to initialize references:', error);
    }
  }

  private async pinCurrentPage(): Promise<void> {
    const btn = this.panel?.querySelector('.dc-panel-pin') as HTMLButtonElement | null;
    const originalTitle = btn?.title;
    if (btn) {
      btn.disabled = true;
      btn.title = '正在钉住当前页面...';
    }

    try {
      const selectedText = window.getSelection()?.toString().trim() || undefined;
      const content = this.siteAdapter.extractContent(document);
      const fullText = content?.fullText || document.body.innerText || document.body.textContent || '';
      if (!fullText.trim() && !selectedText) throw new Error('当前页面没有可保存的文本内容');
      const title = this.resolveReferenceTitle(content?.title, fullText);

      const response = await chrome.runtime.sendMessage({
        type: 'REFERENCE_PIN_PAGE',
        payload: {
          url: window.location.href,
          title,
          fullText,
          selectedText,
        },
      });

      const reference = response?.reference as PinnedReference | undefined;
      if (!reference) throw new Error(response?.error || '保存引用失败');

      await this.loadPinnedReferences();
      const currentIds = this.referenceBinding?.referenceIds ?? [];
      if (!currentIds.includes(reference.id)) {
        await this.saveReferenceBinding([...currentIds, reference.id]);
      }
      this.renderReferencesList();
      this.flashPanelButton('.dc-panel-pin');
    } catch (error) {
      console.warn('[Doc Copilot] Failed to pin page:', error);
      this.addChatMessage({
        id: this.generateSessionId(),
        role: 'assistant',
        content: `⚠️ ${(error as Error).message}`,
        timestamp: Date.now(),
      });
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.title = originalTitle || '钉住当前页面为引用';
      }
    }
  }

  private resolveReferenceTitle(adapterTitle?: string, fullText = ''): string {
    const candidates = [
      adapterTitle,
      this.extractTitleFromContent(fullText),
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
      document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') || '',
      document.title,
      window.location.href,
    ];

    for (const candidate of candidates) {
      const title = this.cleanReferenceTitle(candidate || '');
      if (title && !this.isGenericReferenceTitle(title)) return title;
    }

    return this.cleanReferenceTitle(document.title) || window.location.href;
  }

  private extractTitleFromContent(fullText: string): string {
    const lines = fullText
      .split('\n')
      .map(line => this.cleanReferenceTitle(line))
      .filter(Boolean);

    for (const line of lines.slice(0, 12)) {
      if (this.isGenericReferenceTitle(line)) continue;
      if (this.looksLikeMetadataLine(line)) continue;
      if (line.length > 80) continue;
      return line;
    }

    return '';
  }

  private cleanReferenceTitle(title: string): string {
    return title
      .replace(/\s+/g, ' ')
      .replace(/\s*[-_|]\s*(Doc Copilot|百度知识库|百度智能云|Baidu|知乎|微信公众平台)\s*$/i, '')
      .trim();
  }

  private isGenericReferenceTitle(title: string): boolean {
    const normalized = title.trim().toLowerCase();
    return !normalized
      || normalized === 'untitled'
      || normalized === 'doc copilot'
      || normalized === '意见反馈'
      || normalized === '反馈'
      || normalized === '百度知识库'
      || normalized === '微信公众平台'
      || normalized === '知乎';
  }

  private looksLikeMetadataLine(line: string): boolean {
    return /^(状态|日期|作者|发布地点|发布于|更新时间|创建时间|最后更新|标签|分类|来源|摘要|案例作者|案例分类|使用工具)[:：]/.test(line)
      || /^https?:\/\//i.test(line)
      || /^文档图片\s*\d+/i.test(line)
      || /^\[?文档图片\s*\d+/i.test(line);
  }

  private async loadPinnedReferences(): Promise<void> {
    const response = await chrome.runtime.sendMessage({ type: 'REFERENCE_LIST', payload: {} });
    this.pinnedReferences = response?.references ?? [];
  }

  private async loadReferenceBinding(): Promise<void> {
    const response = await chrome.runtime.sendMessage({
      type: 'REFERENCE_GET_BINDING',
      payload: { pageKey: this.pageKey },
    });
    this.referenceBinding = response?.binding ?? {
      pageKey: this.pageKey,
      referenceIds: [],
      updatedAt: Date.now(),
    };
  }

  private async saveReferenceBinding(referenceIds: string[]): Promise<void> {
    const response = await chrome.runtime.sendMessage({
      type: 'REFERENCE_SET_BINDING',
      payload: {
        pageKey: this.pageKey,
        referenceIds,
      },
    });
    this.referenceBinding = response?.binding ?? {
      pageKey: this.pageKey,
      referenceIds,
      updatedAt: Date.now(),
    };
  }

  private toggleReferencesDrawer(): void {
    if (this.isReferencesOpen) {
      this.closeReferencesDrawer();
    } else {
      this.openReferencesDrawer();
    }
  }

  private openReferencesDrawer(): void {
    const drawer = this.panel?.querySelector('.dc-references-drawer') as HTMLElement | null;
    if (!drawer) return;
    this.closeSettingsDrawer();
    this.closeFunctionMenu();
    this.closeHistoryDrawer();
    drawer.style.display = 'flex';
    this.isReferencesOpen = true;
    this.panel?.querySelector('.dc-panel-references')?.classList.add('dc-panel-btn-active');
    this.initializeReferencesPanel();
  }

  private closeReferencesDrawer(): void {
    const drawer = this.panel?.querySelector('.dc-references-drawer') as HTMLElement | null;
    if (drawer) drawer.style.display = 'none';
    this.isReferencesOpen = false;
    const selectedCount = this.referenceBinding?.referenceIds.length ?? 0;
    this.panel?.querySelector('.dc-panel-references')?.classList.toggle('dc-panel-btn-active', selectedCount > 0);
  }

  private renderReferencesList(): void {
    const list = this.panel?.querySelector('.dc-references-list') as HTMLElement | null;
    if (!list) return;

    const selectedIds = new Set(this.referenceBinding?.referenceIds ?? []);
    const validSelected = this.pinnedReferences.filter(ref => selectedIds.has(ref.id)).length;
    this.panel?.querySelector('.dc-panel-references')?.classList.toggle('dc-panel-btn-active', validSelected > 0 || this.isReferencesOpen);

    if (!this.pinnedReferences.length) {
      list.innerHTML = `<div class="dc-references-empty">还没有引用。打开资料页后点顶部图钉即可保存。</div>`;
      return;
    }

    list.innerHTML = this.pinnedReferences.map(ref => {
      const checked = selectedIds.has(ref.id) ? 'checked' : '';
      const host = this.formatReferenceHost(ref.url);
      return `
        <div class="dc-reference-item ${checked ? 'dc-reference-item-active' : ''}" data-reference-id="${ref.id}">
          <label class="dc-reference-main">
            <input type="checkbox" data-reference-toggle="${ref.id}" ${checked} />
            <span class="dc-reference-copy">
              <span class="dc-reference-title">${escapeHtml(ref.title || 'Untitled')}</span>
              <span class="dc-reference-meta">${escapeHtml(host)} · ${ref.chunks.length} 段</span>
              <span class="dc-reference-summary">${escapeHtml(ref.summary || '')}</span>
            </span>
          </label>
          <button class="dc-reference-delete" data-reference-delete="${ref.id}" type="button" title="删除引用">×</button>
        </div>
      `;
    }).join('');

    list.querySelectorAll<HTMLInputElement>('[data-reference-toggle]').forEach(input => {
      input.addEventListener('change', async () => {
        const id = input.dataset.referenceToggle || '';
        const ids = new Set(this.referenceBinding?.referenceIds ?? []);
        if (input.checked) ids.add(id);
        else ids.delete(id);
        await this.saveReferenceBinding(Array.from(ids));
        this.renderReferencesList();
      });
    });

    list.querySelectorAll<HTMLElement>('[data-reference-delete]').forEach(btn => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const id = btn.dataset.referenceDelete || '';
        if (!id) return;
        await chrome.runtime.sendMessage({
          type: 'REFERENCE_DELETE',
          payload: { referenceId: id },
        });
        await this.initializeReferencesPanel();
      });
    });
  }

  private async getReferenceContexts(
    message: string,
    context: any,
  ): Promise<ReferenceContext[]> {
    const referenceIds = this.referenceBinding?.referenceIds ?? [];
    if (!referenceIds.length) return [];
    const query = [
      message,
      context?.selectedText,
      context?.textBefore?.slice(-800),
      context?.textAfter?.slice(0, 400),
      context?.title,
    ].filter(Boolean).join('\n');

    const response = await chrome.runtime.sendMessage({
      type: 'REFERENCE_SEARCH_CONTEXT',
      payload: {
        referenceIds,
        query,
        limit: 8,
      },
    });
    return response?.contexts ?? [];
  }

  private formatReferenceHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  private flashPanelButton(selector: string): void {
    const btn = this.panel?.querySelector(selector) as HTMLElement | null;
    if (!btn) return;
    btn.classList.add('dc-panel-btn-active');
    window.setTimeout(() => {
      if (selector === '.dc-panel-references' && ((this.referenceBinding?.referenceIds.length ?? 0) > 0 || this.isReferencesOpen)) {
        return;
      }
      btn.classList.remove('dc-panel-btn-active');
    }, 900);
  }

  // ================================================================
  // Chat History
  // ================================================================

  private computePageKey(): string {
    return `${window.location.origin}${window.location.pathname}`;
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private ensureCurrentPageScope(): void {
    const latestPageKey = this.computePageKey();
    if (latestPageKey === this.pageKey) return;

    this.saveCurrentHistory();
    if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
    this.historySaveTimer = null;
    this.pageKey = latestPageKey;
    this.currentSessionId = this.generateSessionId();
    this.historySessions = [];
    this.chatMessages = [];
    this.pendingChatImages.forEach(image => {
      if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    });
    this.pendingChatImages = [];
    this.activeAgentStream = null;
    this.isWaitingResponse = false;
    this.referenceBinding = {
      pageKey: this.pageKey,
      referenceIds: [],
      updatedAt: Date.now(),
    };
    this.closeHistoryDrawer();
    this.closeReferencesDrawer();
    this.renderChatAttachments();
    this.hideTypingIndicator();
    this.renderChatWelcome();
    this.loadReferenceBinding()
      .then(() => this.renderReferencesList())
      .catch(error => console.warn('[Doc Copilot] Failed to load reference binding:', error));
  }

  private setupHistory(): void {
    this.panel?.querySelector('.dc-history-close')?.addEventListener('click', () => {
      this.closeHistoryDrawer();
    });
  }

  private async initializeHistoryPanel(): Promise<void> {
    try {
      await this.settingsReady;
      await chrome.runtime.sendMessage({ type: 'HISTORY_CLEANUP_EXPIRED', payload: {} });
      await this.loadHistorySessions();
    } catch (error) {
      console.warn('[Doc Copilot] Failed to initialize history:', error);
    }
  }

  private async loadHistorySessions(): Promise<void> {
    if (!this.settings.chatHistoryEnabled) {
      this.historySessions = [];
      this.renderHistoryList();
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: 'HISTORY_LIST_SESSIONS',
      payload: {
        pageKey: this.pageKey,
        limit: this.settings.chatHistoryMaxSessionsPerPage,
      },
    });
    this.historySessions = response?.sessions ?? [];
    this.renderHistoryList();
  }

  private toggleHistoryDrawer(): void {
    if (this.isHistoryOpen) {
      this.closeHistoryDrawer();
    } else {
      this.openHistoryDrawer();
    }
  }

  private openHistoryDrawer(): void {
    const drawer = this.panel?.querySelector('.dc-history-drawer') as HTMLElement | null;
    if (!drawer) return;
    this.closeSettingsDrawer();
    this.closeFunctionMenu();
    this.closeReferencesDrawer();
    drawer.style.display = 'flex';
    this.isHistoryOpen = true;
    this.panel?.querySelector('.dc-panel-history')?.classList.add('dc-panel-btn-active');
    this.loadHistorySessions().catch(error => console.warn('[Doc Copilot] Failed to load history:', error));
  }

  private closeHistoryDrawer(): void {
    const drawer = this.panel?.querySelector('.dc-history-drawer') as HTMLElement | null;
    if (drawer) drawer.style.display = 'none';
    this.isHistoryOpen = false;
    this.panel?.querySelector('.dc-panel-history')?.classList.remove('dc-panel-btn-active');
  }

  private renderHistoryList(): void {
    const list = this.panel?.querySelector('.dc-history-list') as HTMLElement | null;
    if (!list) return;

    if (!this.settings.chatHistoryEnabled) {
      list.innerHTML = `<div class="dc-history-empty">历史会话已关闭</div>`;
      return;
    }

    if (!this.historySessions.length) {
      list.innerHTML = `<div class="dc-history-empty">当前文档暂无历史会话</div>`;
      return;
    }

    list.innerHTML = this.historySessions.map(session => `
      <div class="dc-history-item ${session.sessionId === this.currentSessionId ? 'dc-history-item-active' : ''}" data-session-id="${session.sessionId}">
        <button class="dc-history-main" data-history-open="${session.sessionId}" type="button">
          <span class="dc-history-preview">${escapeHtml(session.preview)}</span>
          <span class="dc-history-meta">${this.formatHistoryTime(session.updatedAt)} · ${session.messageCount} 条</span>
        </button>
        <button class="dc-history-delete" data-history-delete="${session.sessionId}" type="button" title="删除">×</button>
      </div>
    `).join('');

    list.querySelectorAll<HTMLElement>('[data-history-open]').forEach(btn => {
      btn.addEventListener('click', () => this.loadHistorySession(btn.dataset.historyOpen || ''));
    });
    list.querySelectorAll<HTMLElement>('[data-history-delete]').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.deleteHistorySession(btn.dataset.historyDelete || '');
      });
    });
  }

  private async loadHistorySession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    const response = await chrome.runtime.sendMessage({
      type: 'HISTORY_LOAD_SESSION',
      payload: { sessionId },
    });
    const messages = (response?.messages ?? []) as AgentMessage[];
    if (!messages.length) return;

    this.currentSessionId = sessionId;
    this.chatMessages = [];
    const messagesEl = this.panel?.querySelector('.dc-chat-messages') as HTMLElement | null;
    if (messagesEl) messagesEl.innerHTML = '';
    for (const msg of messages) this.addChatMessage(msg, { forceScroll: false });
    if (messagesEl) this.scrollChatToBottom(messagesEl);
    this.closeHistoryDrawer();
    this.saveCurrentHistory();
  }

  private async deleteHistorySession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await chrome.runtime.sendMessage({
      type: 'HISTORY_DELETE_SESSION',
      payload: { sessionId },
    });
    if (sessionId === this.currentSessionId) {
      this.currentSessionId = this.generateSessionId();
      this.chatMessages = [];
      const messagesEl = this.panel?.querySelector('.dc-chat-messages') as HTMLElement | null;
      this.renderChatWelcome(messagesEl);
    }
    await this.loadHistorySessions();
  }

  private saveCurrentHistory(): void {
    if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
    this.historySaveTimer = null;
    if (!this.settings.chatHistoryEnabled) return;
    const messages = this.getPersistableChatMessages();
    if (!messages.length) return;

    chrome.runtime.sendMessage({
      type: 'HISTORY_SAVE_MESSAGES',
      payload: {
        sessionId: this.currentSessionId,
        pageKey: this.pageKey,
        pageUrl: window.location.href,
        title: document.title || this.siteAdapter.extractContent(document)?.title || 'Untitled',
        messages,
      },
    }).then(() => {
      if (this.isHistoryOpen) this.loadHistorySessions();
    }).catch(error => console.warn('[Doc Copilot] Failed to save chat history:', error));
  }

  private scheduleHistorySave(): void {
    if (!this.settings.chatHistoryEnabled || !this.isWaitingResponse) return;
    if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
    this.historySaveTimer = setTimeout(() => {
      this.historySaveTimer = null;
      this.saveCurrentHistory();
    }, 900);
  }

  private getPersistableChatMessages(): AgentMessage[] {
    const messages: AgentMessage[] = this.chatMessages
      .filter(msg => !msg.isStreaming && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'))
      .map(msg => ({
        id: msg.id || this.generateSessionId(),
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        toolName: msg.toolName,
        thinking: msg.thinking,
        images: msg.images
          ?.filter(image => this.isSupportedModelImage(image, image.origin === 'document' ? 'document' : 'upload'))
          .map(image => ({
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            dataUrl: image.origin === 'generated' ? image.dataUrl : '',
            sourceUrl: image.sourceUrl && !image.sourceUrl.startsWith('data:') ? image.sourceUrl : '',
            width: image.width,
            height: image.height,
            origin: image.origin,
          })),
      }));

    const stream = this.activeAgentStream;
    if (this.isWaitingResponse && !stream?.finalized) {
      messages.push({
        id: `${this.currentSessionId}-interrupted-response`,
        role: 'assistant',
        content: stream?.content
          ? `${stream.content}\n\n[回复在页面刷新前中断]`
          : '请求正在处理；如果页面刷新导致请求中断，请重新发送。',
        timestamp: Date.now(),
      });
    }
    return messages;
  }

  private getModelChatHistory(): AgentMessage[] {
    return this.chatMessages
      .filter(msg => !msg.isStreaming && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'))
      .map(msg => ({
        id: msg.id || this.generateSessionId(),
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        toolName: msg.toolName,
        images: msg.images?.filter(image =>
          Boolean(image.dataUrl || image.sourceUrl)
          && this.isSupportedModelImage(image, image.origin === 'upload' ? 'upload' : 'document')),
      }));
  }

  private formatHistoryTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
  }

  // ================================================================
  // Function Menu
  // ================================================================

  private setupFunctionTab(): void {
    this.panel!.querySelectorAll('[data-fn]').forEach(btn => {
      btn.addEventListener('click', () => {
        const fn = (btn as HTMLElement).dataset.fn as string;
        this.executeFn(fn);
      });
    });
  }

  private async executeFn(fn: string): Promise<void> {
    const statusEl = this.panel?.querySelector('.dc-function-status') as HTMLElement | null;
    const showStatus = (msg: string, isError = false) => {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.className = 'dc-function-status' + (isError ? ' dc-function-status-error' : ' dc-function-status-ok');
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
    };

    switch (fn) {
      case 'save-pdf': {
        showStatus('正在生成 PDF，请稍候…');
        const resp = await chrome.runtime.sendMessage({ type: 'SAVE_PDF' }) as { success: boolean; error?: string };
        if (resp?.success) {
          showStatus('PDF 已保存到下载目录');
        } else {
          showStatus(`PDF 生成失败: ${resp?.error ?? '未知错误'}`, true);
        }
        break;
      }

      case 'copy-text': {
        const content = this.siteAdapter.extractContent(document);
        const text = content?.fullText ?? document.body.innerText;
        try {
          await navigator.clipboard.writeText(text);
          showStatus('已复制纯文本到剪贴板');
        } catch {
          showStatus('复制失败，请检查剪贴板权限', true);
        }
        break;
      }

      case 'copy-markdown': {
        const md = this.pageToMarkdown();
        try {
          await navigator.clipboard.writeText(md);
          showStatus('已复制 Markdown 到剪贴板');
        } catch {
          showStatus('复制失败，请检查剪贴板权限', true);
        }
        break;
      }

      case 'generate-image': {
        this.closeFunctionMenu();
        const input = this.panel?.querySelector('.dc-chat-input') as HTMLTextAreaElement | null;
        if (input) {
          const current = input.value.trim();
          input.value = current ? `生图：${current}` : '生图：';
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 120) + 'px';
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
        break;
      }

      case 'print': {
        showStatus('正在准备打印页面…');
        await this.prepareForPrint();
        const restore = () => {
          this.restoreAfterPrint();
          window.removeEventListener('afterprint', restore);
        };
        window.addEventListener('afterprint', restore, { once: true });
        window.print();
        setTimeout(restore, 10000);
        break;
      }

      default:
        showStatus(`未知操作: ${fn}`, true);
    }
  }

  /** Best-effort conversion of the page's main content to Markdown. */
  private pageToMarkdown(): string {
    const content = this.siteAdapter.extractContent(document);
    if (content) {
      const title = content.title ? `# ${content.title}\n\n` : '';
      return title + content.fullText;
    }
    // Generic fallback: walk headings / paragraphs
    const lines: string[] = [];
    const title = document.title;
    if (title) lines.push(`# ${title}`, '');
    document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li').forEach(el => {
      const tag = el.tagName.toLowerCase();
      const text = (el as HTMLElement).innerText.trim();
      if (!text) return;
      if (tag === 'h1') lines.push(`# ${text}`);
      else if (tag === 'h2') lines.push(`## ${text}`);
      else if (tag === 'h3') lines.push(`### ${text}`);
      else if (tag === 'h4') lines.push(`#### ${text}`);
      else if (tag === 'h5') lines.push(`##### ${text}`);
      else if (tag === 'h6') lines.push(`###### ${text}`);
      else if (tag === 'li') lines.push(`- ${text}`);
      else lines.push(text);
    });
    return lines.join('\n');
  }

  // ================================================================
  // Settings
  // ================================================================

  private isAiSetupComplete(): boolean {
    return isAiConfigured(this.settings, this.visibleModelRoles());
  }

  private openSetupGuide(): void {
    this.showPanel();
    this.openSettingsDrawer(true);
  }

  private refreshSetupState(): void {
    if (!this.panel) return;
    const guide = this.panel.querySelector('[data-setup-guide]') as HTMLElement | null;
    if (guide) guide.hidden = this.isAiSetupComplete();
    this.setAdvancedSettingsVisible(this.isAiSetupComplete());

    for (const role of this.visibleModelRoles()) {
      const section = this.panel.querySelector(`[data-model-role="${role}"]`) as HTMLElement | null;
      section?.classList.toggle('dc-model-incomplete', !isModelConfigComplete(this.settings.models[role]));
    }

    if (!this.chatMessages.length) {
      const welcome = this.panel.querySelector('.dc-chat-welcome');
      if (welcome) this.renderChatWelcome();
    }
  }

  private renderSettingsHTML(): string {
    return `
      <div class="dc-settings">
        <button class="dc-advanced-toggle" type="button" data-advanced-toggle title="高级设置" hidden>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 4.5h10M3 11.5h10M6 2.8v3.4M10 9.8v3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
            <circle cx="6" cy="4.5" r="1.5" fill="currentColor"/>
            <circle cx="10" cy="11.5" r="1.5" fill="currentColor"/>
          </svg>
          <span>高级</span>
        </button>

        <div class="dc-setup-guide" data-setup-guide>
          <div class="dc-setup-guide-title">完成 AI 服务配置</div>
          <div class="dc-setup-guide-text">
            Doc Copilot 不再内置 API URL 或 SK。文本 API 协议可按服务配置选择 Anthropic Messages、OpenAI Chat Completions 或 OpenAI Responses；自动模式会按 Model ID 和 Base URL 推断。Base URL 通常填服务根地址。
          </div>
        </div>

        <div class="dc-settings-section" data-model-role="smart">
          <div class="dc-settings-heading">通用</div>
          <div class="dc-field"><label>API Base URL</label><input type="url" class="dc-input" data-model-field="baseUrl" placeholder="https://your-api.example.com" /></div>
          <div class="dc-field"><label>API Key / SK</label><input type="password" class="dc-input" data-model-field="apiKey" placeholder="sk-..." /></div>
          <div class="dc-field"><label>Model ID</label><input type="text" class="dc-input" data-model-field="modelId" placeholder="model-id" /></div>
          <div class="dc-field"><label>文本 API 协议</label><select class="dc-input" data-model-field="apiProtocol"><option value="auto">自动</option><option value="anthropic-messages">Anthropic Messages</option><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option></select></div>
          <div class="dc-settings-note">如果普通 Chat 可用但 Agent 工具调用失败，可手动选择网关支持的协议。自动模式根据 Model ID 和 Base URL 选择。</div>
          <label class="dc-toggle"><input type="checkbox" data-feature="autocomplete" /><span>开启自动补全</span></label>
          <label class="dc-toggle"><input type="checkbox" data-feature="selectionToolbar" /><span>开启选中文本悬浮框</span></label>
          <div class="dc-shortcut-row">
            <span>打开 / 关闭面板</span>
            <kbd>Alt</kbd><kbd>Shift</kbd><kbd>D</kbd>
          </div>
        </div>

        <div class="dc-settings-section" data-model-role="image">
          <div class="dc-settings-heading">图像模型（可选）</div>
          <div class="dc-settings-note">Agent 会根据当前对话和文档需要调用图像模型，文本模型负责理解内容并拟定画面描述。留空则复用上面的 API Base URL 和 API Key。默认模型是 gpt-image-2，优先请求 /images/generations；网关不支持时会尝试对话接口。Gemini 等模型请填写网关里的图像模型 ID，例如 gemini-2.5-flash-image。</div>
          <div class="dc-field"><label>Image API Base URL</label><input type="url" class="dc-input" data-model-field="baseUrl" placeholder="留空则复用通用配置" /></div>
          <div class="dc-field"><label>Image API Key / SK</label><input type="password" class="dc-input" data-model-field="apiKey" placeholder="留空则复用通用配置" /></div>
          <div class="dc-field"><label>Image Model ID</label><input type="text" class="dc-input" data-model-field="modelId" placeholder="gpt-image-2" /></div>
          <div class="dc-field"><label>图片尺寸</label><input type="text" class="dc-input" data-setting="imageGenerationSize" placeholder="1024x1024" /></div>
        </div>

        <div class="dc-settings-section">
          <div class="dc-settings-heading">编辑</div>
          <div class="dc-shortcut-list">
            <div class="dc-shortcut-row"><span>采纳补全 / 审稿建议</span><kbd>Tab</kbd></div>
            <div class="dc-shortcut-row"><span>取消补全 / 关闭浮层</span><kbd>Esc</kbd></div>
            <div class="dc-shortcut-row"><span>上 / 下一个审稿建议</span><kbd>Ctrl</kbd><kbd>↑</kbd><kbd>↓</kbd></div>
            <div class="dc-shortcut-row"><span>全部采纳审稿建议</span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>A</kbd></div>
            <div class="dc-shortcut-row"><span>全部拒绝审稿建议</span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>R</kbd></div>
          </div>
        </div>

        <div class="dc-advanced-popover" data-settings-advanced hidden>
          <div class="dc-advanced-popover-header">
            <div class="dc-advanced-title">高级设置</div>
            <button class="dc-advanced-close" type="button" data-advanced-close title="关闭">
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="dc-settings-section-compact" data-model-role="smart">
            <div class="dc-field"><label>最大 Token</label><input type="number" class="dc-input" data-model-field="maxTokens" min="50" max="32000" step="50" /></div>
            <div class="dc-field"><label>Temperature</label><input type="number" class="dc-input" data-model-field="temperature" min="0" max="2" step="0.1" /></div>
          </div>
          <div class="dc-field"><label>补全置信度阈值</label><input type="number" class="dc-input" data-setting="autocompleteMinConfidence" min="0" max="1" step="0.05" /></div>
          <div class="dc-field"><label>补全延迟 (ms)</label><input type="number" class="dc-input" data-setting="autocompleteDebounceMs" min="100" max="2000" step="100" /></div>
          <div class="dc-field"><label>编辑上下文窗口 (chars)</label><input type="number" class="dc-input" data-setting="contextWindowSize" min="200" max="4000" step="100" /></div>
          <div class="dc-field"><label>Chat 最大上下文 (chars)</label><input type="number" class="dc-input" data-setting="agentMaxContextChars" min="1000" max="2000000" step="10000" /></div>
          <div class="dc-field"><label>模型上下文窗口 (tokens)</label><input type="number" class="dc-input" data-setting="modelContextTokens" min="8000" max="2000000" step="10000" /></div>
          <div class="dc-field"><label>历史会话保留天数</label><input type="number" class="dc-input" data-setting="chatHistoryTtlDays" min="1" max="90" step="1" /></div>
          <div class="dc-field"><label>每页最大历史会话数</label><input type="number" class="dc-input" data-setting="chatHistoryMaxSessionsPerPage" min="1" max="100" step="1" /></div>
          <button class="dc-btn-save dc-btn-advanced-save" type="button" data-save-settings>保存高级设置</button>
        </div>

        <div class="dc-settings-buttons">
          <button class="dc-btn-save" data-save-settings>Save</button>
        </div>
      </div>
    `;
  }

  private setupSettings(): void {
    const drawer = this.panel!.querySelector('.dc-settings-drawer-body') as HTMLElement;
    if (!drawer) return;

    this.populateSettingsForm();

    drawer.querySelectorAll('[data-save-settings]').forEach(btn => {
      btn.addEventListener('click', () => this.saveSettings(btn as HTMLElement));
    });
    drawer.querySelector('[data-advanced-toggle]')?.addEventListener('click', () => {
      this.toggleAdvancedPopover();
    });
    drawer.querySelector('[data-advanced-close]')?.addEventListener('click', () => {
      this.closeAdvancedPopover();
    });
  }

  private async openSettingsDrawer(focusSetup = false): Promise<void> {
    await this.settingsReady;
    const drawer = this.panel?.querySelector('.dc-settings-drawer') as HTMLElement;
    if (drawer) {
      this.closeHistoryDrawer();
      this.closeReferencesDrawer();
      this.closeFunctionMenu();
      drawer.style.display = 'flex';
      // Refresh settings form with latest values
      this.populateSettingsForm();
      const setupMode = focusSetup || !this.isAiSetupComplete();
      this.setAdvancedSettingsVisible(!setupMode);
      this.closeAdvancedPopover();
      if (setupMode) {
        this.focusFirstMissingModelInput();
      }
    }
  }

  private closeSettingsDrawer(): void {
    const drawer = this.panel?.querySelector('.dc-settings-drawer') as HTMLElement;
    if (drawer) {
      this.closeAdvancedPopover();
      drawer.style.display = 'none';
    }
  }

  private populateSettingsForm(): void {
    if (!this.panel) return;

    for (const role of this.configurableModelRoles()) {
      const config = this.settings.models[role];
      this.panel.querySelectorAll<HTMLElement>(`[data-model-role="${role}"]`).forEach(section => {
        for (const [field, value] of Object.entries(config)) {
          section.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-model-field="${field}"]`).forEach(input => {
            input.value = String(value);
          });
        }
      });
    }

    const setInput = (key: string, val: number) => {
      const el = this.panel!.querySelector(`[data-setting="${key}"]`) as HTMLInputElement | null;
      if (el) el.value = String(val);
    };
    setInput('autocompleteMinConfidence', this.settings.autocompleteMinConfidence);
    setInput('autocompleteDebounceMs', this.settings.autocompleteDebounceMs);
    setInput('contextWindowSize', this.settings.contextWindowSize);
    setInput('agentMaxContextChars', this.settings.agentMaxContextChars);
    setInput('modelContextTokens', this.settings.modelContextTokens);
    setInput('chatHistoryTtlDays', this.settings.chatHistoryTtlDays);
    setInput('chatHistoryMaxSessionsPerPage', this.settings.chatHistoryMaxSessionsPerPage);
    const imageSize = this.panel.querySelector('[data-setting="imageGenerationSize"]') as HTMLInputElement | null;
    if (imageSize) imageSize.value = this.settings.imageGenerationSize;

    this.panel.querySelectorAll<HTMLInputElement>('[data-feature]').forEach(input => {
      const feature = input.dataset.feature as keyof AppSettings['features'];
      input.checked = Boolean(this.settings.features[feature]);
    });

    this.refreshSetupState();
  }

  private setAdvancedSettingsVisible(visible: boolean): void {
    const toggle = this.panel?.querySelector('[data-advanced-toggle]') as HTMLElement | null;
    if (toggle) toggle.hidden = !visible;
    if (!visible) this.closeAdvancedPopover();
  }

  private toggleAdvancedPopover(): void {
    const advanced = this.panel?.querySelector('[data-settings-advanced]') as HTMLElement | null;
    if (!advanced) return;
    advanced.hidden = !advanced.hidden;
    this.panel?.querySelector('[data-advanced-toggle]')?.classList.toggle('dc-advanced-toggle-active', !advanced.hidden);
  }

  private closeAdvancedPopover(): void {
    const advanced = this.panel?.querySelector('[data-settings-advanced]') as HTMLElement | null;
    if (advanced) advanced.hidden = true;
    this.panel?.querySelector('[data-advanced-toggle]')?.classList.remove('dc-advanced-toggle-active');
  }

  private focusFirstMissingModelInput(): void {
    window.setTimeout(() => {
      for (const role of this.visibleModelRoles()) {
        const config = this.settings.models[role];
        const missingField = !config.baseUrl.trim()
          ? 'baseUrl'
          : !config.apiKey.trim()
            ? 'apiKey'
            : !config.modelId.trim()
              ? 'modelId'
              : '';
        if (!missingField) continue;

        const input = this.panel?.querySelector(
          `[data-model-role="${role}"] [data-model-field="${missingField}"]`,
        ) as HTMLInputElement | null;
        input?.focus();
        return;
      }
    }, 40);
  }

  private async saveSettings(sourceButton?: HTMLElement): Promise<void> {
    if (!this.panel) return;
    await this.settingsReady;
    const wasComplete = this.isAiSetupComplete();

    for (const role of this.configurableModelRoles()) {
      this.panel.querySelectorAll<HTMLElement>(`[data-model-role="${role}"]`).forEach(section => {
        section.querySelectorAll('[data-model-field]').forEach(input => {
          const field = (input as HTMLElement).dataset.modelField!;
          const value = (input as HTMLInputElement | HTMLSelectElement).value.trim();
          if (field === 'baseUrl' || field === 'apiKey' || field === 'modelId') {
            (this.settings.models[role] as any)[field] = value;
          } else if (field === 'apiProtocol') {
            const supported: ModelConfig['apiProtocol'][] = [
              'auto',
              'anthropic-messages',
              'openai-chat-completions',
              'openai-responses',
            ];
            if (supported.includes(value as ModelConfig['apiProtocol'])) {
              this.settings.models[role].apiProtocol = value as ModelConfig['apiProtocol'];
            }
          } else if (field === 'maxTokens') {
            const parsed = parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) (this.settings.models[role] as any)[field] = parsed;
          } else if (field === 'temperature') {
            const parsed = parseFloat(value);
            if (Number.isFinite(parsed)) (this.settings.models[role] as any)[field] = parsed;
          }
        });
      });
    }

    const readNumber = (key: string): number | undefined => {
      const el = this.panel!.querySelector(`[data-setting="${key}"]`) as HTMLInputElement | null;
      if (!el) return undefined;
      const parsed = parseFloat(el.value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const confidence = readNumber('autocompleteMinConfidence');
    if (confidence !== undefined) this.settings.autocompleteMinConfidence = Math.min(1, Math.max(0, confidence));
    const debounce = readNumber('autocompleteDebounceMs');
    if (debounce !== undefined && debounce > 0) this.settings.autocompleteDebounceMs = Math.round(debounce);
    const ctx = readNumber('contextWindowSize');
    if (ctx !== undefined && ctx > 0) this.settings.contextWindowSize = Math.round(ctx);
    const agentCtx = readNumber('agentMaxContextChars');
    if (agentCtx !== undefined && agentCtx > 0) this.settings.agentMaxContextChars = Math.round(agentCtx);
    const modelContext = readNumber('modelContextTokens');
    if (modelContext !== undefined && modelContext > 0) this.settings.modelContextTokens = Math.round(modelContext);
    const historyTtl = readNumber('chatHistoryTtlDays');
    if (historyTtl !== undefined && historyTtl > 0) this.settings.chatHistoryTtlDays = Math.round(historyTtl);
    const historyLimit = readNumber('chatHistoryMaxSessionsPerPage');
    if (historyLimit !== undefined && historyLimit > 0) this.settings.chatHistoryMaxSessionsPerPage = Math.round(historyLimit);
    const imageSize = (this.panel.querySelector('[data-setting="imageGenerationSize"]') as HTMLInputElement | null)?.value.trim();
    if (imageSize && /^\d+x\d+$/.test(imageSize)) {
      this.settings.imageGenerationSize = imageSize;
    }

    this.panel.querySelectorAll<HTMLInputElement>('[data-feature]').forEach(input => {
      const feature = input.dataset.feature as keyof AppSettings['features'];
      this.settings.features[feature] = input.checked;
    });

    try {
      await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', payload: this.settings });
      this.refreshSetupState();
      this.updateContextMeter();
      if (!wasComplete && this.isAiSetupComplete()) {
        this.closeSettingsDrawer();
        if (!this.chatMessages.length) this.renderChatWelcome();
        return;
      }
      const btn = sourceButton || this.panel.querySelector('.dc-btn-save') as HTMLElement;
      if (btn) { const orig = btn.textContent; btn.textContent = '✓ Saved'; setTimeout(() => btn.textContent = orig, 1500); }
    } catch (error) {
      console.error('[Doc Copilot] Failed to save:', error);
    }
  }

  // ================================================================
  // Helpers
  // ================================================================

  private async loadSettings(): Promise<void> {
    this.settings = await settingsStorage.get();
    this.settingsLoaded = true;
    if (this.panel) this.populateSettingsForm();
    this.refreshSetupState();
  }

  private applySettings(settings: AppSettings): void {
    this.settings = settings;
    this.settingsLoaded = true;
    if (this.panel) this.populateSettingsForm();
    this.refreshSetupState();
  }

  private visibleModelRoles(): ModelRole[] {
    return ['smart'];
  }

  private configurableModelRoles(): ModelRole[] {
    return ['smart', 'image'];
  }

  private listenForEvents(): void {
    document.addEventListener('doc-copilot:toggle-panel', ((e: CustomEvent) => {
      if (e.detail?.tab === 'settings') {
        this.openSettings();
      } else {
        this.show();
      }
    }) as EventListener);

    // Listen for TOOL_STATUS messages from background
    chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
      if (message.type === 'SETTINGS_CHANGED') {
        chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })
          .then(settings => this.applySettings(settings as AppSettings))
          .catch(error => console.warn('[Doc Copilot] Failed to refresh settings:', error));
      }
      if (message.type === 'AGENT_STREAM_CHUNK' && this.isWaitingResponse) {
        const { fullText } = message.payload as { messageId?: string; delta?: string; fullText: string };
        this.updateStreamingAssistant(fullText);
      }
      if (message.type === 'AGENT_STREAM_END' && this.isWaitingResponse) {
        const payload = message.payload as { response?: AgentMessage; error?: string; streamed?: boolean };
        if (payload.error) {
          this.finishChatWithError(payload.error);
        } else if (payload.streamed) {
          this.stopChatRequestWatchdog();
          this.finalizeStreamingAssistant(payload.response);
        }
        this.updateUsageDisplay();
      }
      if (message.type === 'TOOL_STATUS' && this.isWaitingResponse) {
        const { status, thinkingText, expanded } = (message.payload as { status: string; thinkingText?: string; expanded?: boolean });
        if (/图像模型/.test(status)) this.startImageProgress(status);
        else {
          this.stopImageProgress();
          if (status) this.updateTypingStatus(status, thinkingText, expanded === true);
        }
      }
      if (message.type === 'HIDE_FOR_PRINT') {
        this.prepareForPrint()
          .then(result => sendResponse(result))
          .catch(error => sendResponse({ success: false, error: (error as Error).message }));
        return true;
      }
      if (message.type === 'SHOW_AFTER_PRINT') {
        this.restoreAfterPrint();
        sendResponse({ success: true });
      }
    });
  }

  private async prepareForPrint(): Promise<{ success: boolean; imageCount: number }> {
    if (this.host) this.host.style.display = 'none';
    this.injectPrintStyles();
    const imageCount = this.rewriteLazyImageSources();
    await this.waitForImages();
    return { success: true, imageCount };
  }

  private restoreAfterPrint(): void {
    if (this.host) this.host.style.display = '';
    this.printStyle?.remove();
    this.printStyle = null;
  }

  private injectPrintStyles(): void {
    this.printStyle?.remove();
    const style = document.createElement('style');
    style.id = 'doc-copilot-print-fixes';
    style.textContent = `
@media print {
  #doc-copilot-root,
  .dc-bubble,
  .dc-panel {
    display: none !important;
  }

  html,
  body {
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }

  img,
  svg,
  canvas,
  video,
  iframe,
  table,
  pre {
    max-width: 100% !important;
    box-sizing: border-box !important;
  }

  img,
  svg,
  canvas,
  video {
    height: auto !important;
  }
}

@media print {
  body:has(#js_content) {
    min-width: 0 !important;
  }

  #js_article,
  .rich_media,
  .rich_media_inner,
  .rich_media_area_primary,
  .rich_media_content,
  #js_content {
    width: auto !important;
    max-width: 720px !important;
    height: auto !important;
    overflow: visible !important;
    margin-left: auto !important;
    margin-right: auto !important;
    box-sizing: border-box !important;
    transform: none !important;
  }

  .rich_media_content *,
  #js_content * {
    max-width: 100% !important;
    box-sizing: border-box !important;
  }

  .rich_media_content img,
  #js_content img {
    display: inline-block !important;
    opacity: 1 !important;
    visibility: visible !important;
    max-width: 100% !important;
    height: auto !important;
  }

  .rich_media_tool,
  .rich_media_extra,
  .rich_media_area_extra,
  .qr_code_pc_outer,
  #js_pc_qr_code,
  #js_tags,
  #js_like_area,
  #js_share_appmsg,
  .profile_container,
  .reward_area {
    display: none !important;
  }
}

@media print {
  body:has(#knowledgeContent),
  body:has(div[data-slate-editor="true"].mp-editor-container) {
    min-width: 0 !important;
    overflow: visible !important;
    background: #fff !important;
  }

  body:has(#knowledgeContent) #knowledgeContent,
  body:has(#knowledgeContent) .mp-layout-content-container,
  body:has(#knowledgeContent) .baidu__editor__content,
  body:has(#knowledgeContent) .baidu__editor__content__inner,
  body:has(#knowledgeContent) .baidu__editor__content__right,
  body:has(#knowledgeContent) .mp-editor-container-outer,
  body:has(#knowledgeContent) .mp-editor-container,
  body:has(#knowledgeContent) .mp-slide-container,
  body:has(#knowledgeContent) div[data-slate-editor="true"].mp-editor-container:not(.mp-micro-editor) {
    width: auto !important;
    max-width: 760px !important;
    min-width: 0 !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    margin-left: auto !important;
    margin-right: auto !important;
    box-sizing: border-box !important;
    transform: none !important;
  }

  body:has(#knowledgeContent) .mp-layout-content-container,
  body:has(#knowledgeContent) .baidu__editor__content,
  body:has(#knowledgeContent) .baidu__editor__content__inner,
  body:has(#knowledgeContent) .baidu__editor__content__right {
    display: block !important;
  }

  body:has(#knowledgeContent) .mp-paragraph-wrapper,
  body:has(#knowledgeContent) [data-morpho-type],
  body:has(#knowledgeContent) [data-slate-node="element"] {
    max-width: 100% !important;
    overflow: visible !important;
    box-sizing: border-box !important;
    break-inside: auto !important;
  }

  body:has(#knowledgeContent) img,
  body:has(#knowledgeContent) svg,
  body:has(#knowledgeContent) canvas,
  body:has(#knowledgeContent) video,
  body:has(#knowledgeContent) iframe {
    max-width: 100% !important;
    height: auto !important;
    box-sizing: border-box !important;
  }

  body:has(#knowledgeContent) pre,
  body:has(#knowledgeContent) code,
  body:has(#knowledgeContent) .mp-block-code-preview-container {
    white-space: pre-wrap !important;
    word-break: break-word !important;
    overflow: visible !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }

  body:has(#knowledgeContent) .mp-micro-editor,
  body:has(#knowledgeContent) .mp-card-add,
  body:has(#knowledgeContent) .mp-card-menu-wrapper,
  body:has(#knowledgeContent) .mp-card-infos,
  body:has(#knowledgeContent) .mp-heading-order-container,
  body:has(#knowledgeContent) .mp-list-item-bullet,
  body:has(#knowledgeContent) .mp-block-code-top-bar,
  body:has(#knowledgeContent) .mp-editor-bottom-space,
  body:has(#knowledgeContent) .mp-editor-bottom-slot-container,
  body:has(#knowledgeContent) .mp-placeholder-provider,
  body:has(#knowledgeContent) .mp-toast-provider,
  body:has(#knowledgeContent) .mp-mention-dropdown-provider,
  body:has(#knowledgeContent) .mp-paragraph-block-selection,
  body:has(#knowledgeContent) .mp-slash-menus-container,
  body:has(#knowledgeContent) .Material_main__0jMSX,
  body:has(#knowledgeContent) .rc-tree-list-holder,
  body:has(#knowledgeContent) [class*="Repository_contentLeft"],
  body:has(#knowledgeContent) [class*="Repository_contentHeader"],
  body:has(#knowledgeContent) [class*="Repository_side"],
  body:has(#knowledgeContent) [class*="Comment"],
  body:has(#knowledgeContent) [class*="Material_"] {
    display: none !important;
  }
}
`;
    document.head.appendChild(style);
    this.printStyle = style;
  }

  private rewriteLazyImageSources(): number {
    let count = 0;
    const attrs = ['data-src', 'data-original', 'data-backsrc', 'data-lazy-src', 'data-actualsrc'];

    document.querySelectorAll<HTMLImageElement>('img').forEach(img => {
      const lazySrc = attrs.map(attr => img.getAttribute(attr)).find(Boolean);
      if (!lazySrc) return;

      const currentSrc = img.getAttribute('src') || '';
      const looksLikePlaceholder =
        !currentSrc ||
        currentSrc === 'about:blank' ||
        currentSrc.startsWith('data:image/gif') ||
        currentSrc.includes('transparent');

      if (looksLikePlaceholder || currentSrc !== lazySrc) {
        img.setAttribute('src', lazySrc);
        count++;
      }
    });

    document.querySelectorAll<HTMLSourceElement>('source').forEach(source => {
      const dataSrcset = source.getAttribute('data-srcset');
      if (dataSrcset && source.getAttribute('srcset') !== dataSrcset) {
        source.setAttribute('srcset', dataSrcset);
      }
    });

    return count;
  }

  private async waitForImages(timeoutMs = 5000): Promise<void> {
    const images = Array.from(document.images).filter(img => Boolean(img.currentSrc || img.src));
    await Promise.race([
      Promise.all(images.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return img.decode?.().catch(() => undefined) ?? new Promise<void>(resolve => {
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        });
      })),
      this.sleep(timeoutMs),
    ]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getPageContext(): any {
    const fn = (window as any).docCopilotGetPageContext;
    if (typeof fn === 'function') return fn();
    if (this.adapter.isAttached()) return this.adapter.getContext();
    const content = this.siteAdapter.extractContent(document);
    if (content) {
      return {
        textBefore: content.fullText.slice(-1000),
        textAfter: '',
        selectedText: '',
        fullText: content.fullText,
        cursorPosition: { line: 0, character: 0, offset: 0 },
        language: content.language,
        title: content.title,
        documentImages: content.documentImages,
        elementType: 'unknown',
      };
    }
    return null;
  }

  // ================================================================
  // Debug Panel
  // ================================================================

  private setupDebugButton(): void {
    const btn = this.panel!.querySelector('.dc-panel-debug') as HTMLElement | null;
    if (!btn) return;
    btn.addEventListener('click', () => this.toggleDebugOverlay());
  }

  private toggleDebugOverlay(): void {
    const existing = this.host?.querySelector('.dc-debug-overlay');
    if (existing) {
      this.closeDebugOverlay();
      return;
    }

    this.openDebugOverlay();
  }

  private closeDebugOverlay(): void {
    this.host?.querySelector('.dc-debug-overlay')?.remove();
    this.panel?.querySelector('.dc-panel-debug')?.classList.remove('dc-panel-btn-active');
  }

  private openDebugOverlay(): void {
    // Remove any existing overlay first
    this.closeDebugOverlay();

    const entries = getLogEntries();
    const overlay = document.createElement('div');
    overlay.className = 'dc-debug-overlay';

    const fmt = (ts: number) => {
      const d = new Date(ts);
      return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    };

    const rows = entries.length === 0
      ? '<div class="dc-debug-empty">No logs yet.</div>'
      : [...entries].reverse().map(e => {
          const text = e.args.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<div class="dc-debug-row dc-debug-${e.level}"><span class="dc-debug-ts">${fmt(e.ts)}</span><span class="dc-debug-level">${e.level.toUpperCase()}</span><span class="dc-debug-msg">${text}</span></div>`;
        }).join('');

    overlay.innerHTML = `
      <div class="dc-debug-header">
        <span class="dc-debug-title">Debug Logs <span class="dc-debug-count">${entries.length} / 1000</span></span>
        <div class="dc-debug-actions">
          <button class="dc-debug-copy" title="Copy all logs">Copy</button>
          <button class="dc-debug-clear" title="Clear logs">Clear</button>
          <button class="dc-debug-close" title="Close">✕</button>
        </div>
      </div>
      <div class="dc-debug-body">${rows}</div>
    `;

    overlay.querySelector('.dc-debug-close')!.addEventListener('click', () => this.closeDebugOverlay());

    overlay.querySelector('.dc-debug-copy')!.addEventListener('click', () => {
      const text = getLogEntries().map(e =>
        `[${new Date(e.ts).toISOString()}] [${e.level.toUpperCase()}] ${e.args}`
      ).join('\n');
      navigator.clipboard.writeText(text).catch(() => {/* ignore */});
    });

    overlay.querySelector('.dc-debug-clear')!.addEventListener('click', () => {
      clearLogEntries();
      overlay.querySelector('.dc-debug-body')!.innerHTML = '<div class="dc-debug-empty">Logs cleared.</div>';
      (overlay.querySelector('.dc-debug-count') as HTMLElement).textContent = '0 / 1000';
    });

    this.host!.appendChild(overlay);
    this.panel?.querySelector('.dc-panel-debug')?.classList.add('dc-panel-btn-active');
  }
}
