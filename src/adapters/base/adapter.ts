// ============================================================
// Document Adapter - Abstract interface for document access
// ============================================================

import { Position, Range, DocumentContext, ContentChange, Disposable } from '../../shared/types/index';

/**
 * Abstract document adapter interface.
 * Implementations exist for:
 * - Chrome Extension (contentEditable / textarea)
 * - (future) Word Add-in
 * - (future) WPS Plugin
 */
export interface IDocumentAdapter {
  readonly platform: 'chrome' | 'word' | 'wps';

  /** Get the full document text */
  getText(): string;

  /** Get currently selected text */
  getSelectedText(): string;

  /** Get cursor position */
  getCursorPosition(): Position;

  /** Get selection range, if any */
  getSelectionRange(): Range | null;

  /** Insert text at position */
  insertText(position: Position, text: string): void;

  /** Replace a range of text */
  replaceRange(range: Range, text: string): void;

  /** Show ghost text (autocomplete suggestion) at position */
  showGhostText(position: Position, text: string): void;

  /** Remove ghost text */
  removeGhostText(): void;

  /** Accept the current ghost text (insert it permanently) */
  acceptGhostText(): void;

  /** Insert an image at the current cursor position or after a selected range */
  insertImage(url: string, alt?: string, range?: Range | null): boolean;

  /** Get document context around cursor */
  getContext(cursorPos?: Position, windowSize?: number): DocumentContext;

  /** Register content change listener */
  onContentChange(callback: (change: ContentChange) => void): Disposable;

  /** Register cursor/selection change listener */
  onCursorChange(callback: (pos: Position) => void): Disposable;

  /** Check if the adapter can work with the current focused element */
  canAttach(): boolean;

  /** Attach to the current editable element */
  attach(element: HTMLElement): void;

  /** Detach from the current element */
  detach(): void;

  /** Whether currently attached */
  isAttached(): boolean;

  /** Dispose all resources */
  dispose(): void;
}
