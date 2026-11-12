// ============================================================
// Command Palette Controller - command execution UI reused by context-menu actions
// ============================================================

import { ChromeDocumentAdapter } from '../../adapters/chrome/adapter';
import { escapeHtml } from '../../shared/utils/index';

interface Command {
  id: string;
  label: string;
  description: string;
  icon: string;
  action: () => void;
}

export class CommandPaletteController {
  private adapter: ChromeDocumentAdapter;
  private container: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private commands: Command[] = [];
  private filteredCommands: Command[] = [];
  private selectedIndex = 0;

  constructor(adapter: ChromeDocumentAdapter) {
    this.adapter = adapter;
    this.initCommands();
  }

  isVisible(): boolean {
    return this.container !== null && this.container.style.display !== 'none';
  }

  show(): void {
    if (!this.container) {
      this.createUI();
    }

    this.container!.style.display = 'block';
    this.input!.value = '';
    this.selectedIndex = 0;
    this.filterCommands('');
    this.positionPalette();

    // Focus input after a frame
    requestAnimationFrame(() => this.input!.focus());
  }

  hide(): void {
    if (this.container) {
      this.container.style.display = 'none';
    }
    // Return focus to editor
    if (this.adapter.isAttached()) {
      const el = document.querySelector('[contenteditable]:focus, textarea:focus, input:focus');
      (el as HTMLElement)?.focus();
    }
  }

  executeCommand(commandId: string): void {
    const cmd = this.commands.find(c => c.id === commandId);
    if (cmd) {
      this.hide();
      cmd.action();
    }
  }

  private initCommands(): void {
    this.commands = [
      {
        id: 'fix',
        label: '/fix',
        description: 'Fix grammar and spelling errors',
        icon: '🔧',
        action: () => this.runCommand('fix'),
      },
      {
        id: 'rewrite',
        label: '/rewrite',
        description: 'Rewrite selected text',
        icon: '✏️',
        action: () => this.runCommand('rewrite'),
      },
      {
        id: 'polish',
        label: '/polish',
        description: 'Polish and improve text quality',
        icon: '✨',
        action: () => this.runCommand('polish'),
      },
      {
        id: 'summarize',
        label: '/summarize',
        description: 'Summarize selected text',
        icon: '📋',
        action: () => this.runCommand('summarize'),
      },
      {
        id: 'expand',
        label: '/expand',
        description: 'Expand text with more detail',
        icon: '📝',
        action: () => this.runCommand('expand'),
      },
      {
        id: 'translate_en',
        label: '/translate-en',
        description: 'Translate to English',
        icon: '🌐',
        action: () => this.runCommand('translate_en'),
      },
      {
        id: 'translate_zh',
        label: '/translate-zh',
        description: 'Translate to Chinese',
        icon: '🌐',
        action: () => this.runCommand('translate_zh'),
      },
      {
        id: 'formal',
        label: '/formal',
        description: 'Convert to formal tone',
        icon: '👔',
        action: () => this.runCommand('formal'),
      },
      {
        id: 'casual',
        label: '/casual',
        description: 'Convert to casual tone',
        icon: '😊',
        action: () => this.runCommand('casual'),
      },
      {
        id: 'summarize-section',
        label: '/summarize-section',
        description: 'Summarize content from last heading to cursor',
        icon: '🗂️',
        action: () => this.runSummarizeSection(),
      },
      {
        id: 'review',
        label: '/review',
        description: 'Start document review mode',
        icon: '📝',
        action: () => this.startReview('correct'),
      },
      {
        id: 'review-style',
        label: '/review-style',
        description: 'Review document style and structure',
        icon: '🎨',
        action: () => this.startReview('rewrite'),
      },
      {
        id: 'chat',
        label: '/chat',
        description: 'Open AI chat panel',
        icon: '💬',
        action: () => this.openChat(),
      },
      {
        id: 'settings',
        label: '/settings',
        description: 'Open settings',
        icon: '⚙️',
        action: () => this.openSettings(),
      },
    ];

    this.filteredCommands = [...this.commands];
  }

  private createUI(): void {
    // Shadow DOM for style isolation
    const host = document.createElement('div');
    host.id = 'doc-copilot-command-palette';

    this.container = document.createElement('div');
    this.container.className = 'dc-command-palette';
    this.container.innerHTML = `
      <div class="dc-cp-backdrop"></div>
      <div class="dc-cp-dialog">
        <div class="dc-cp-input-wrapper">
          <span class="dc-cp-icon">⌘</span>
          <input
            class="dc-cp-input"
            type="text"
            placeholder="输入命令... (如 fix、rewrite、summarize)"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="dc-cp-list"></div>
        <div class="dc-cp-footer">
          <span><kbd>↑↓</kbd> 导航</span>
          <span><kbd>Enter</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    `;

    this.input = this.container.querySelector('.dc-cp-input') as HTMLInputElement;
    this.listEl = this.container.querySelector('.dc-cp-list') as HTMLElement;

    // Event listeners
    this.input.addEventListener('input', () => {
      this.filterCommands(this.input!.value);
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredCommands.length - 1);
        this.renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = this.filteredCommands[this.selectedIndex];
        if (cmd) {
          this.hide();
          cmd.action();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
    });

    // Click backdrop to close
    this.container.querySelector('.dc-cp-backdrop')?.addEventListener('click', () => {
      this.hide();
    });

    host.appendChild(this.container);
    document.body.appendChild(host);
  }

  private filterCommands(query: string): void {
    const q = query.toLowerCase().replace(/^\//, '');

    if (!q) {
      this.filteredCommands = [...this.commands];
    } else {
      this.filteredCommands = this.commands.filter(cmd =>
        cmd.id.includes(q) ||
        cmd.label.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q),
      );
    }

    this.selectedIndex = 0;
    this.renderList();
  }

  private renderList(): void {
    if (!this.listEl) return;

    if (this.filteredCommands.length === 0) {
      this.listEl.innerHTML = `
        <div class="dc-cp-empty">No matching commands</div>
      `;
      return;
    }

    this.listEl.innerHTML = this.filteredCommands
      .map((cmd, i) => `
        <div class="dc-cp-item ${i === this.selectedIndex ? 'dc-cp-item-selected' : ''}"
             data-cmd-id="${cmd.id}">
          <span class="dc-cp-item-icon">${cmd.icon}</span>
          <div class="dc-cp-item-text">
            <span class="dc-cp-item-label">${escapeHtml(cmd.label)}</span>
            <span class="dc-cp-item-desc">${escapeHtml(cmd.description)}</span>
          </div>
        </div>
      `)
      .join('');

    // Click handlers
    this.listEl.querySelectorAll('.dc-cp-item').forEach(el => {
      el.addEventListener('click', () => {
        const cmdId = (el as HTMLElement).dataset.cmdId;
        const cmd = this.commands.find(c => c.id === cmdId);
        if (cmd) {
          this.hide();
          cmd.action();
        }
      });
    });
  }

  private positionPalette(): void {
    // Center on screen (like VS Code command palette)
    // CSS handles this via fixed positioning
  }

  private async runCommand(commandId: string): Promise<void> {
    const context = this.adapter.getContext();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AGENT_MESSAGE',
        payload: {
          message: `/${commandId}`,
          context,
        },
      });

      if (response?.error) {
        console.error('[Doc Copilot] Command error:', response.error);
        return;
      }

      // If we have selected text and a result, replace it
      if (context.selectedText && response?.response?.content) {
        const selRange = this.adapter.getSelectionRange();
        if (selRange) {
          this.adapter.replaceRange(selRange, response.response.content);
        }
      }
    } catch (error) {
      console.error('[Doc Copilot] Command failed:', error);
    }
  }

  private startReview(mode: 'correct' | 'rewrite'): void {
    // Dispatch to review overlay via custom event
    document.dispatchEvent(new CustomEvent('doc-copilot:start-review', {
      detail: { mode },
    }));
  }

  private openChat(): void {
    document.dispatchEvent(new CustomEvent('doc-copilot:toggle-panel', {
      detail: { tab: 'chat' },
    }));
  }

  private openSettings(): void {
    document.dispatchEvent(new CustomEvent('doc-copilot:toggle-panel', {
      detail: { tab: 'settings' },
    }));
  }

  // ─── Summarize Section ───────────────────────────────────────────────────────

  private async runSummarizeSection(): Promise<void> {
    const sectionText = this.extractSectionBeforeCursor();
    if (!sectionText || sectionText.trim().length < 20) {
      console.warn('[Doc Copilot] No section content found before cursor');
      return;
    }

    const context = this.adapter.getContext();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AGENT_MESSAGE',
        payload: {
          message: `/summarize-section`,
          context: { ...context, selectedText: sectionText },
        },
      });
      if (response?.error) {
        console.error('[Doc Copilot] Summarize error:', response.error);
        return;
      }
      if (response?.response?.content) {
        const cursorPos = this.adapter.getCursorPosition();
        this.adapter.insertText(cursorPos, '\n\n' + response.response.content);
      }
    } catch (error) {
      console.error('[Doc Copilot] Summarize section failed:', error);
    }
  }

  /**
   * Walk backwards from cursor to find the nearest heading,
   * then return the text from that heading to the cursor.
   */
  private extractSectionBeforeCursor(): string {
    const context = this.adapter.getContext();
    const textBefore = context.textBefore;

    // Detect heading lines: Markdown (#) or lines that look like titles (short line ending with \n)
    const headingRegex = /^#{1,6}\s.+$/m;
    const lines = textBefore.split('\n');
    let headingLineIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (headingRegex.test(lines[i].trim())) {
        headingLineIdx = i;
        break;
      }
    }

    if (headingLineIdx === -1) {
      // No heading found — use all text before cursor (up to 4000 chars)
      return textBefore.slice(-4000);
    }

    return lines.slice(headingLineIdx).join('\n');
  }
}
