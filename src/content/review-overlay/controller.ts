// ============================================================
// Review Overlay Controller - Visual review mode in the page
// ============================================================

import { ChromeDocumentAdapter } from '../../adapters/chrome/adapter';
import { ReviewPoint, ReviewSession } from '../../shared/types/index';
import { escapeHtml } from '../../shared/utils/index';

export class ReviewOverlayController {
  private adapter: ChromeDocumentAdapter;
  private session: ReviewSession | null = null;
  private overlayContainer: HTMLElement | null = null;
  private statusBar: HTMLElement | null = null;

  constructor(adapter: ChromeDocumentAdapter) {
    this.adapter = adapter;
  }

  isActive(): boolean {
    return this.session !== null;
  }

  async startReview(mode: 'correct' | 'rewrite' | 'polish' = 'correct'): Promise<void> {
    if (!this.adapter.isAttached()) return;

    const context = this.adapter.getContext();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REVIEW_REQUEST',
        payload: { context, mode },
      });

      if (response?.error) {
        this.showNotification(`Review error: ${response.error}`, 'error');
        return;
      }

      if (response?.session) {
        this.session = response.session as ReviewSession;
        this.renderOverlay();
        this.renderStatusBar();
        this.focusCurrentPoint();
      }
    } catch (error) {
      console.error('[Doc Copilot] Review failed:', error);
    }
  }

  acceptCurrent(): void {
    if (!this.session) return;
    const point = this.session.points[this.session.currentIndex];
    if (!point || point.status !== 'pending') return;

    // Apply the change
    this.adapter.replaceRange(point.originalRange, point.suggestedText);
    point.status = 'accepted';

    this.updatePointUI(point);
    this.moveToNextPending();
  }

  rejectCurrent(): void {
    if (!this.session) return;
    const point = this.session.points[this.session.currentIndex];
    if (!point || point.status !== 'pending') return;

    point.status = 'rejected';
    this.updatePointUI(point);
    this.moveToNextPending();
  }

  nextPoint(): void {
    if (!this.session) return;
    const { points } = this.session;
    let next = this.session.currentIndex + 1;

    while (next < points.length && points[next].status !== 'pending') next++;

    if (next < points.length) {
      this.session.currentIndex = next;
      this.focusCurrentPoint();
    }
  }

  previousPoint(): void {
    if (!this.session) return;
    const { points } = this.session;
    let prev = this.session.currentIndex - 1;

    while (prev >= 0 && points[prev].status !== 'pending') prev--;

    if (prev >= 0) {
      this.session.currentIndex = prev;
      this.focusCurrentPoint();
    }
  }

  acceptAll(): void {
    if (!this.session) return;

    // Apply all pending changes (in reverse order to preserve positions)
    const pending = this.session.points
      .filter(p => p.status === 'pending')
      .reverse();

    for (const point of pending) {
      this.adapter.replaceRange(point.originalRange, point.suggestedText);
      point.status = 'accepted';
    }

    this.endReview();
    this.showNotification(`✅ Accepted all ${pending.length} changes`, 'success');
  }

  rejectAll(): void {
    if (!this.session) return;

    const pending = this.session.points.filter(p => p.status === 'pending');
    pending.forEach(p => p.status = 'rejected');

    this.endReview();
    this.showNotification(`❌ Rejected all ${pending.length} changes`, 'info');
  }

  private endReview(): void {
    this.session = null;
    this.overlayContainer?.remove();
    this.overlayContainer = null;
    this.statusBar?.remove();
    this.statusBar = null;
  }

  private moveToNextPending(): void {
    if (!this.session) return;

    const pending = this.session.points.filter(p => p.status === 'pending');
    if (pending.length === 0) {
      this.endReview();
      this.showNotification('✅ Review complete!', 'success');
      return;
    }

    this.nextPoint();
    // If no next, try wrapping to first pending
    if (this.session) {
      const firstPending = this.session.points.findIndex(p => p.status === 'pending');
      if (firstPending >= 0 && firstPending !== this.session.currentIndex) {
        this.session.currentIndex = firstPending;
        this.focusCurrentPoint();
      }
    }
    this.updateStatusBar();
  }

  private renderOverlay(): void {
    if (!this.session) return;

    // Remove existing overlay
    this.overlayContainer?.remove();

    // Create overlay container
    this.overlayContainer = document.createElement('div');
    this.overlayContainer.id = 'doc-copilot-review-overlay';
    this.overlayContainer.className = 'dc-review-overlay';

    // Render each review point
    this.session.points.forEach(point => {
      const el = this.createPointElement(point);
      this.overlayContainer!.appendChild(el);
    });

    document.body.appendChild(this.overlayContainer);
  }

  private createPointElement(point: ReviewPoint): HTMLElement {
    const el = document.createElement('div');
    el.className = `dc-review-point dc-review-${point.status}`;
    el.dataset.pointId = point.id;

    el.innerHTML = `
      <div class="dc-review-point-header">
        <span class="dc-review-category">${point.category}</span>
        <span class="dc-review-reason">${escapeHtml(point.reason)}</span>
      </div>
      <div class="dc-review-point-content">
        <div class="dc-review-original">
          <span class="dc-label">Original:</span>
          <span class="dc-text dc-strikethrough">${escapeHtml(point.originalText)}</span>
        </div>
        <div class="dc-review-suggested">
          <span class="dc-label">Suggested:</span>
          <span class="dc-text dc-highlight">${escapeHtml(point.suggestedText)}</span>
        </div>
      </div>
      <div class="dc-review-point-actions">
        <button class="dc-btn dc-btn-accept" title="Accept (Tab)">✓ Accept</button>
        <button class="dc-btn dc-btn-reject" title="Reject (Esc)">✗ Reject</button>
      </div>
    `;

    // Button handlers
    el.querySelector('.dc-btn-accept')?.addEventListener('click', () => {
      this.session!.currentIndex = this.session!.points.findIndex(p => p.id === point.id);
      this.acceptCurrent();
    });

    el.querySelector('.dc-btn-reject')?.addEventListener('click', () => {
      this.session!.currentIndex = this.session!.points.findIndex(p => p.id === point.id);
      this.rejectCurrent();
    });

    return el;
  }

  private updatePointUI(point: ReviewPoint): void {
    const el = this.overlayContainer?.querySelector(`[data-point-id="${point.id}"]`);
    if (!el) return;

    el.className = `dc-review-point dc-review-${point.status}`;
    if (point.status !== 'pending') {
      el.classList.add('dc-review-resolved');
    }
  }

  private focusCurrentPoint(): void {
    if (!this.session || !this.overlayContainer) return;

    // Remove focus from all points
    this.overlayContainer.querySelectorAll('.dc-review-focused').forEach(el => {
      el.classList.remove('dc-review-focused');
    });

    // Focus current point
    const point = this.session.points[this.session.currentIndex];
    if (!point) return;

    const el = this.overlayContainer.querySelector(`[data-point-id="${point.id}"]`);
    if (el) {
      el.classList.add('dc-review-focused');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  private renderStatusBar(): void {
    this.statusBar?.remove();

    this.statusBar = document.createElement('div');
    this.statusBar.className = 'dc-review-status-bar';
    this.updateStatusBar();

    // Add action buttons to status bar
    const actions = document.createElement('div');
    actions.className = 'dc-review-status-actions';
    actions.innerHTML = `
      <button class="dc-btn dc-btn-sm dc-btn-accept-all" title="Accept All (Ctrl+Shift+A)">✓ Accept All</button>
      <button class="dc-btn dc-btn-sm dc-btn-reject-all" title="Reject All (Ctrl+Shift+R)">✗ Reject All</button>
      <button class="dc-btn dc-btn-sm dc-btn-close" title="Close Review">✕ Close</button>
    `;

    actions.querySelector('.dc-btn-accept-all')?.addEventListener('click', () => this.acceptAll());
    actions.querySelector('.dc-btn-reject-all')?.addEventListener('click', () => this.rejectAll());
    actions.querySelector('.dc-btn-close')?.addEventListener('click', () => this.endReview());

    this.statusBar.appendChild(actions);
    document.body.appendChild(this.statusBar);
  }

  private updateStatusBar(): void {
    if (!this.statusBar || !this.session) return;

    const total = this.session.points.length;
    const accepted = this.session.points.filter(p => p.status === 'accepted').length;
    const rejected = this.session.points.filter(p => p.status === 'rejected').length;
    const pending = total - accepted - rejected;
    const current = this.session.currentIndex + 1;

    const info = this.statusBar.querySelector('.dc-review-status-info') ||
      document.createElement('div');
    info.className = 'dc-review-status-info';
    info.innerHTML = `
      <span>📝 Review Mode</span>
      <span class="dc-divider">|</span>
      <span>${current}/${total}</span>
      <span class="dc-divider">|</span>
      <span class="dc-accepted">✓ ${accepted}</span>
      <span class="dc-rejected">✗ ${rejected}</span>
      <span class="dc-pending">⏳ ${pending}</span>
      <span class="dc-divider">|</span>
      <span class="dc-hint">Tab: Accept · Esc: Reject · Ctrl+↑↓: Navigate</span>
    `;

    if (!info.parentElement) {
      this.statusBar.prepend(info);
    }
  }

  private showNotification(message: string, type: 'success' | 'error' | 'info'): void {
    const el = document.createElement('div');
    el.className = `dc-notification dc-notification-${type}`;
    el.textContent = message;
    document.body.appendChild(el);

    setTimeout(() => {
      el.classList.add('dc-notification-fade');
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }
}
