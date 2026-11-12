// ============================================================
// Pinned References Storage - IndexedDB-backed local references
// ============================================================

import {
  DocumentReferenceBinding,
  PinnedReference,
  ReferenceChunk,
  ReferenceContext,
} from '../types/index';

const DB_NAME = 'doc-copilot-references';
const DB_VERSION = 1;
const REFERENCES_STORE = 'references';
const BINDINGS_STORE = 'bindings';
const MAX_REFERENCE_TEXT_CHARS = 120_000;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 160;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url.split('#')[0];
  }
}

function cleanText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_REFERENCE_TEXT_CHARS);
}

function makeSummary(text: string): string {
  return cleanText(text).replace(/\s+/g, ' ').slice(0, 240);
}

function chunkText(referenceId: string, text: string): ReferenceChunk[] {
  const chunks: ReferenceChunk[] = [];
  const source = cleanText(text);
  if (!source) return chunks;

  let start = 0;
  while (start < source.length) {
    const end = Math.min(source.length, start + CHUNK_SIZE);
    const slice = source.slice(start, end).trim();
    if (slice) {
      chunks.push({
        id: `${referenceId}-chunk-${chunks.length + 1}`,
        referenceId,
        text: slice,
        startOffset: start,
        endOffset: end,
      });
    }
    if (end >= source.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const latin = normalized.match(/[a-z0-9_./:-]{2,}/g) ?? [];
  const cjk = normalized.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const cjkPairs = cjk.flatMap(token => {
    const pairs: string[] = [];
    for (let i = 0; i < token.length - 1; i++) pairs.push(token.slice(i, i + 2));
    return pairs;
  });
  return Array.from(new Set([...latin, ...cjk, ...cjkPairs])).slice(0, 120);
}

function scoreChunk(queryTokens: string[], chunk: ReferenceChunk, title: string): number {
  if (!queryTokens.length) return 0;
  const text = `${title}\n${chunk.text}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    const first = text.indexOf(token);
    if (first >= 0) {
      score += token.length >= 4 ? 3 : 1;
      if (first < 240) score += 1;
    }
  }
  return score;
}

export class PinnedReferenceStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(REFERENCES_STORE)) {
            const refs = db.createObjectStore(REFERENCES_STORE, { keyPath: 'id' });
            refs.createIndex('normalizedUrl', 'normalizedUrl', { unique: true });
            refs.createIndex('updatedAt', 'updatedAt');
          }
          if (!db.objectStoreNames.contains(BINDINGS_STORE)) {
            db.createObjectStore(BINDINGS_STORE, { keyPath: 'pageKey' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open references DB'));
      });
    }
    return this.dbPromise;
  }

  async pinPage(payload: {
    url: string;
    title: string;
    fullText: string;
    selectedText?: string;
  }): Promise<PinnedReference> {
    const db = await this.db();
    const normalizedUrl = normalizeUrl(payload.url);
    const now = Date.now();
    const tx = db.transaction(REFERENCES_STORE, 'readwrite');
    const store = tx.objectStore(REFERENCES_STORE);
    const existing = await requestToPromise(store.index('normalizedUrl').get(normalizedUrl)) as PinnedReference | undefined;
    const id = existing?.id || `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const sourceText = cleanText(payload.selectedText || payload.fullText);
    const reference: PinnedReference = {
      id,
      url: payload.url,
      normalizedUrl,
      title: payload.title || existing?.title || 'Untitled',
      fullText: sourceText,
      summary: makeSummary(sourceText),
      chunks: chunkText(id, sourceText),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      pinnedAt: existing?.pinnedAt ?? now,
      sourceType: payload.selectedText ? 'selection' : 'page',
    };
    store.put(reference);
    await txDone(tx);
    return reference;
  }

  async listReferences(): Promise<PinnedReference[]> {
    const db = await this.db();
    const tx = db.transaction(REFERENCES_STORE, 'readonly');
    const refs = await requestToPromise(tx.objectStore(REFERENCES_STORE).getAll()) as PinnedReference[];
    await txDone(tx);
    return refs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteReference(referenceId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([REFERENCES_STORE, BINDINGS_STORE], 'readwrite');
    tx.objectStore(REFERENCES_STORE).delete(referenceId);

    const bindingsStore = tx.objectStore(BINDINGS_STORE);
    const bindings = await requestToPromise(bindingsStore.getAll()) as DocumentReferenceBinding[];
    for (const binding of bindings) {
      if (!binding.referenceIds.includes(referenceId)) continue;
      bindingsStore.put({
        ...binding,
        referenceIds: binding.referenceIds.filter(id => id !== referenceId),
        updatedAt: Date.now(),
      } satisfies DocumentReferenceBinding);
    }

    await txDone(tx);
  }

  async getBinding(pageKey: string): Promise<DocumentReferenceBinding> {
    const db = await this.db();
    const tx = db.transaction(BINDINGS_STORE, 'readonly');
    const binding = await requestToPromise(tx.objectStore(BINDINGS_STORE).get(pageKey)) as DocumentReferenceBinding | undefined;
    await txDone(tx);
    return binding ?? { pageKey, referenceIds: [], updatedAt: Date.now() };
  }

  async setBinding(pageKey: string, referenceIds: string[]): Promise<DocumentReferenceBinding> {
    const uniqueIds = Array.from(new Set(referenceIds)).slice(0, 12);
    const binding: DocumentReferenceBinding = {
      pageKey,
      referenceIds: uniqueIds,
      updatedAt: Date.now(),
    };
    const db = await this.db();
    const tx = db.transaction(BINDINGS_STORE, 'readwrite');
    tx.objectStore(BINDINGS_STORE).put(binding);
    await txDone(tx);
    return binding;
  }

  async searchContext(payload: {
    referenceIds: string[];
    query: string;
    limit?: number;
  }): Promise<ReferenceContext[]> {
    const orderedIds = Array.from(new Set(payload.referenceIds));
    const ids = new Set(orderedIds);
    if (!ids.size) return [];

    const refOrder = new Map(orderedIds.map((id, index) => [id, index]));
    const refs = (await this.listReferences())
      .filter(ref => ids.has(ref.id))
      .sort((a, b) => (refOrder.get(a.id) ?? 0) - (refOrder.get(b.id) ?? 0));
    const queryTokens = tokenize(payload.query);
    const allContexts: ReferenceContext[] = [];
    const guaranteed: ReferenceContext[] = [];

    for (const ref of refs) {
      let bestForRef: ReferenceContext | null = null;
      for (const chunk of ref.chunks) {
        const score = scoreChunk(queryTokens, chunk, ref.title);
        const context: ReferenceContext = {
          referenceId: ref.id,
          title: ref.title,
          url: ref.url,
          chunkId: chunk.id,
          text: chunk.text,
          score,
          index: 0,
        };
        allContexts.push(context);
        if (!bestForRef || score > bestForRef.score) {
          bestForRef = context;
        }
      }
      if (bestForRef) guaranteed.push(bestForRef);
    }

    const limit = payload.limit ?? 8;
    const selected = new Map<string, ReferenceContext>();

    for (const context of guaranteed.slice(0, limit)) {
      selected.set(context.chunkId, context);
    }

    for (const context of allContexts
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    ) {
      if (selected.size >= limit) break;
      selected.set(context.chunkId, context);
    }

    return Array.from(selected.values())
      .map((context, index) => ({ ...context, index: index + 1 }));
  }
}

export const pinnedReferenceStorage = new PinnedReferenceStorage();
