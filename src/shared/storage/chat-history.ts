// ============================================================
// Chat History Storage - IndexedDB-backed local history
// ============================================================

import {
  AgentMessage,
  ChatHistoryMessage,
  ChatHistorySession,
  ChatImageInput,
} from '../types/index';

const DB_NAME = 'doc-copilot-history';
const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';
const MESSAGES_STORE = 'messages';

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

function sanitizeImage(image: ChatImageInput): ChatImageInput {
  return {
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    dataUrl: image.origin === 'generated'
      && image.dataUrl.startsWith('data:image/')
      && image.dataUrl.length <= 6_000_000
      ? image.dataUrl
      : '',
    sourceUrl: image.sourceUrl,
    width: image.width,
    height: image.height,
    origin: image.origin,
  };
}

function sanitizeMessage(message: AgentMessage): AgentMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    toolName: message.toolName,
    images: message.images?.map(sanitizeImage),
    thinking: message.thinking,
  };
}

function previewFromMessages(messages: AgentMessage[]): string {
  const firstUser = messages.find(msg => msg.role === 'user' && msg.content.trim());
  const text = firstUser?.content || messages.find(msg => msg.content.trim())?.content || '新会话';
  return text.replace(/\s+/g, ' ').trim().slice(0, 80) || '新会话';
}

class ChatHistoryStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
            const sessions = db.createObjectStore(SESSIONS_STORE, { keyPath: 'sessionId' });
            sessions.createIndex('pageKey_updatedAt', ['pageKey', 'updatedAt']);
            sessions.createIndex('expiresAt', 'expiresAt');
          }
          if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
            const messages = db.createObjectStore(MESSAGES_STORE, { keyPath: 'messageId' });
            messages.createIndex('sessionId_timestamp', ['sessionId', 'timestamp']);
            messages.createIndex('pageKey', 'pageKey');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open chat history DB'));
      });
    }
    return this.dbPromise;
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    const db = await this.db();
    const tx = db.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite');
    const sessionsStore = tx.objectStore(SESSIONS_STORE);
    const messagesStore = tx.objectStore(MESSAGES_STORE);
    const sessions = await requestToPromise(sessionsStore.getAll()) as ChatHistorySession[];
    const expired = sessions.filter(session => session.expiresAt <= now);

    for (const session of expired) {
      sessionsStore.delete(session.sessionId);
      const index = messagesStore.index('sessionId_timestamp');
      const range = IDBKeyRange.bound([session.sessionId, 0], [session.sessionId, Number.MAX_SAFE_INTEGER]);
      const messages = await requestToPromise(index.getAll(range)) as ChatHistoryMessage[];
      for (const message of messages) messagesStore.delete(message.messageId);
    }

    await txDone(tx);
    return expired.length;
  }

  async listSessions(pageKey: string, limit: number): Promise<ChatHistorySession[]> {
    const db = await this.db();
    const tx = db.transaction(SESSIONS_STORE, 'readonly');
    const sessions = await requestToPromise(tx.objectStore(SESSIONS_STORE).getAll()) as ChatHistorySession[];
    await txDone(tx);
    return sessions
      .filter(session => session.pageKey === pageKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async loadSession(sessionId: string): Promise<{ session: ChatHistorySession | null; messages: AgentMessage[] }> {
    const db = await this.db();
    const tx = db.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readonly');
    const session = await requestToPromise(tx.objectStore(SESSIONS_STORE).get(sessionId)) as ChatHistorySession | undefined;
    if (!session) {
      await txDone(tx);
      return { session: null, messages: [] };
    }

    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const rows = await requestToPromise(tx.objectStore(MESSAGES_STORE).index('sessionId_timestamp').getAll(range)) as ChatHistoryMessage[];
    await txDone(tx);

    return {
      session,
      messages: rows
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(row => ({
          id: row.messageId,
          role: row.role,
          content: row.content,
          timestamp: row.timestamp,
          images: row.images,
          thinking: row.thinking,
        })),
    };
  }

  async saveMessages(payload: {
    sessionId: string;
    pageKey: string;
    pageUrl: string;
    title: string;
    messages: AgentMessage[];
    ttlDays: number;
  }): Promise<ChatHistorySession> {
    const db = await this.db();
    const now = Date.now();
    const cleanMessages = payload.messages
      .filter(message => !message.isStreaming)
      .map(sanitizeMessage);
    const createdAt = Math.min(...cleanMessages.map(msg => msg.timestamp), now);
    const updatedAt = Math.max(...cleanMessages.map(msg => msg.timestamp), now);
    const expiresAt = now + Math.max(1, payload.ttlDays) * 24 * 60 * 60 * 1000;
    const session: ChatHistorySession = {
      sessionId: payload.sessionId,
      pageKey: payload.pageKey,
      pageUrl: payload.pageUrl,
      title: payload.title || 'Untitled',
      createdAt,
      updatedAt,
      expiresAt,
      messageCount: cleanMessages.length,
      preview: previewFromMessages(cleanMessages),
    };

    const tx = db.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite');
    const sessionsStore = tx.objectStore(SESSIONS_STORE);
    const messagesStore = tx.objectStore(MESSAGES_STORE);
    sessionsStore.put(session);

    const range = IDBKeyRange.bound([payload.sessionId, 0], [payload.sessionId, Number.MAX_SAFE_INTEGER]);
    const existing = await requestToPromise(messagesStore.index('sessionId_timestamp').getAll(range)) as ChatHistoryMessage[];
    for (const row of existing) messagesStore.delete(row.messageId);

    for (const message of cleanMessages) {
      messagesStore.put({
        messageId: message.id,
        sessionId: payload.sessionId,
        pageKey: payload.pageKey,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        images: message.images,
        thinking: message.thinking,
      } satisfies ChatHistoryMessage);
    }

    await txDone(tx);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite');
    tx.objectStore(SESSIONS_STORE).delete(sessionId);

    const messagesStore = tx.objectStore(MESSAGES_STORE);
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const messages = await requestToPromise(messagesStore.index('sessionId_timestamp').getAll(range)) as ChatHistoryMessage[];
    for (const message of messages) messagesStore.delete(message.messageId);

    await txDone(tx);
  }
}

export const chatHistoryStorage = new ChatHistoryStorage();
