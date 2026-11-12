// ============================================================
// Site Adapter Types - For extracting content from specific platforms
// ============================================================

import { ChatImageInput } from '../../shared/types/index';

export interface SiteContentResult {
  /** Full document text content */
  fullText: string;
  /** Document title */
  title: string;
  /** Detected language */
  language: string;
  /** Whether currently in edit mode */
  isEditable: boolean;
  /** The editable element, if in edit mode */
  editableElement?: HTMLElement;
  /** The main content container element */
  contentElement: HTMLElement;
  /** Images found inside the main document content */
  documentImages?: ChatImageInput[];
  /** Document metadata (author, date, etc.) */
  metadata?: Record<string, string>;
}

export interface ISiteAdapter {
  /** Unique identifier */
  readonly id: string;
  /** Human-readable name */
  readonly name: string;
  /** Check if this adapter should handle the current page */
  matches(url: string, document: Document): boolean;
  /** Extract document content from the page */
  extractContent(document: Document): SiteContentResult | null;
  /** Get the editable element if in edit mode (may return null in read-only) */
  getEditableElement(document: Document): HTMLElement | null;
  /** Observe for mode changes (edit <-> read-only) and content updates */
  observe(document: Document, callback: (content: SiteContentResult) => void): () => void;
}
