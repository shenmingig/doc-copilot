// Hidden extension page used to copy generated images without page focus.
// navigator.clipboard rejects unfocused documents; execCommand('copy') does not
// when the extension has the clipboardWrite permission.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const request = message as { target?: string; type?: string; dataUrl?: string };
  if (request?.target !== 'offscreen' || request.type !== 'OFFSCREEN_COPY_IMAGE') return;

  copyImage(request.dataUrl || '')
    .then(() => sendResponse({ ok: true }))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message || 'copy failed' }));
  return true;
});

async function copyImage(dataUrl: string): Promise<void> {
  if (!dataUrl.startsWith('data:image/')) throw new Error('invalid image data');
  const pngDataUrl = await toPngDataUrl(dataUrl);
  try {
    await writeAsyncClipboard(pngDataUrl);
    return;
  } catch (error) {
    console.warn('[Doc Copilot] Offscreen async clipboard failed:', error);
  }
  await writeLegacyImage(pngDataUrl);
}

async function writeAsyncClipboard(dataUrl: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('clipboard api unavailable');
  }
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.type !== 'image/png') throw new Error(`expected image/png, got ${blob.type || 'unknown'}`);
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': blob }),
  ]);
}

async function writeLegacyImage(dataUrl: string): Promise<void> {
  const host = document.createElement('div');
  host.contentEditable = 'true';
  host.style.position = 'fixed';
  host.style.left = '0';
  host.style.top = '0';
  host.style.opacity = '0';
  host.style.pointerEvents = 'none';
  const image = document.createElement('img');
  image.alt = '';
  image.src = dataUrl;
  host.appendChild(image);
  document.body.appendChild(host);
  try {
    await image.decode();
    const selection = document.getSelection();
    if (!selection) throw new Error('selection unavailable');
    const range = document.createRange();
    range.selectNode(image);
    selection.removeAllRanges();
    selection.addRange(range);
    const copied = document.execCommand('copy');
    selection.removeAllRanges();
    if (!copied) throw new Error('execCommand copy returned false');
  } finally {
    host.remove();
  }
}

async function toPngDataUrl(dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  if (blob.type === 'image/png') return dataUrl;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('png conversion failed');
    return blobToDataUrl(png);
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('failed to read image'));
    reader.readAsDataURL(blob);
  });
}
