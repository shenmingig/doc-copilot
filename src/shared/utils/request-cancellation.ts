export function requestAborted(): DOMException {
  return new DOMException('请求已取消', 'AbortError');
}

export function throwIfRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw requestAborted();
}

/** Link one operation to its caller without aborting unrelated model requests. */
export function linkRequestAbort(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort(requestAborted());
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(requestAborted());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(requestAborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class ActiveRequest {
  private id: string | null = null;

  start(id: string): void { this.id = id; }
  matches(id?: string): boolean { return !!id && this.id === id; }
  clear(): string | null {
    const id = this.id;
    this.id = null;
    return id;
  }
}

export class ScopedRequestRegistry {
  private entries = new Map<string, { id: string; controller: AbortController }>();

  start(scope: string, id: string): AbortController {
    this.entries.get(scope)?.controller.abort(requestAborted());
    const controller = new AbortController();
    this.entries.set(scope, { id, controller });
    return controller;
  }

  cancel(scope: string, id: string): boolean {
    const entry = this.entries.get(scope);
    if (!entry || entry.id !== id) return false;
    entry.controller.abort(requestAborted());
    return true;
  }

  finish(scope: string, controller: AbortController): void {
    if (this.entries.get(scope)?.controller === controller) this.entries.delete(scope);
  }
}
