// Copy a generated image without requiring the host page to stay focused.
// Page clipboard writes fail once the user clicks elsewhere during generation.

import { debugLog } from '../shared/debug-log';

const OFFSCREEN_URL = 'offscreen.html';

let offscreenReady: Promise<void> | null = null;

export async function copyImageToClipboard(dataUrl: string): Promise<{ ok: boolean; error?: string }> {
  if (!dataUrl.startsWith('data:image/')) {
    return { ok: false, error: 'invalid image data' };
  }

  const workerError = await copyWithServiceWorker(dataUrl);
  if (!workerError) {
    debugLog('info', 'clipboard.image_copied', { via: 'service-worker' });
    return { ok: true };
  }

  try {
    await copyWithOffscreen(dataUrl);
    debugLog('info', 'clipboard.image_copied', { via: 'offscreen' });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog('warn', 'clipboard.image_failed', {
      workerError,
      offscreenError: message,
      dataChars: dataUrl.length,
    });
    return { ok: false, error: message };
  }
}

async function copyWithServiceWorker(dataUrl: string): Promise<string | null> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === 'undefined') {
    return 'clipboard api unavailable in worker';
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    if (blob.type !== 'image/png') return `worker skipped ${blob.type || 'unknown'} image`;
    await clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function copyWithOffscreen(dataUrl: string): Promise<void> {
  await ensureOffscreenDocument();
  let lastError = 'offscreen did not respond';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'OFFSCREEN_COPY_IMAGE',
        dataUrl,
      }) as { ok?: boolean; error?: string } | undefined;
      if (response?.ok) return;
      lastError = response?.error || 'offscreen copy failed';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(40 * (attempt + 1));
  }
  throw new Error(lastError);
}

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    const url = chrome.runtime.getURL(OFFSCREEN_URL);
    if (typeof chrome.runtime.getContexts === 'function') {
      const existing = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [url],
      });
      if (existing.length > 0) return;
    }
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Copy a generated image to the clipboard after generation finishes.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|single offscreen/i.test(message)) throw error;
    }
  })().catch((error) => {
    offscreenReady = null;
    throw error;
  });

  return offscreenReady;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
