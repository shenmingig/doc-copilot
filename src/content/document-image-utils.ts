import { ChatImageInput, ExtensionMessage } from '../shared/types/index';

export const MODEL_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const DOCUMENT_IMAGE_ROOT_SELECTOR = [
  '#knowledgeContent',
  'div[data-slate-editor="true"].mp-editor-container:not(.mp-micro-editor)',
  '.page-block.root-block',
  '.block.docx-page-block',
  '.page-main-item.editor',
  '#docx',
  '.docx-editor',
  '.docx-page-content',
  '[role="main"]',
  'main',
].join(', ');

const IMAGE_URL_ATTRS = [
  'src',
  'data-src',
  'data-original',
  'data-url',
  'data-lazy-src',
  'data-actualsrc',
  'data-image-src',
];

export function extractDocumentImagesFromDom(root: ParentNode = document.querySelector(DOCUMENT_IMAGE_ROOT_SELECTOR) || document.body): ChatImageInput[] {
  const seen = new Set<string>();
  const images: ChatImageInput[] = [];

  root.querySelectorAll<HTMLImageElement>('img').forEach((img, index) => {
    if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;

    const raw = img.currentSrc || img.src || IMAGE_URL_ATTRS.map(attr => img.getAttribute(attr)).find(Boolean);
    if (!raw) return;

    const sourceUrl = normalizeImageKey(raw);
    if (!sourceUrl || seen.has(sourceUrl)) return;

    const mimeType = guessImageMimeType(sourceUrl);
    if (!isSupportedModelImageSource(sourceUrl, mimeType)) return;

    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || img.width || Math.round(rect.width) || undefined;
    const height = img.naturalHeight || img.height || Math.round(rect.height) || undefined;
    if (isDecorativeDocumentImage(img, width, height)) return;

    seen.add(sourceUrl);
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

export function mergeCurrentDocumentImages(images?: ChatImageInput[], limit = 8): ChatImageInput[] {
  const merged = new Map<string, ChatImageInput>();
  for (const image of [...(images ?? []), ...extractDocumentImagesFromDom()]) {
    if (!isSupportedModelImage(image)) continue;
    const key = normalizeImageKey(image.sourceUrl || image.dataUrl);
    if (key && !merged.has(key)) merged.set(key, image);
  }
  return Array.from(merged.values()).slice(0, limit);
}

export async function prepareDocumentImagesForModel(
  images?: ChatImageInput[],
  limit = 4,
): Promise<ChatImageInput[]> {
  const selected = (images ?? []).filter(isSupportedModelImage).slice(0, limit);
  if (!selected.length) return [];

  const prepared = await Promise.all(selected.map(async (image, index): Promise<ChatImageInput | null> => {
    if (isValidBase64ModelDataUrl(image.dataUrl, image.mimeType)) {
      return {
        ...image,
        mimeType: normalizeImageMimeType(image.mimeType || guessImageMimeType(image.dataUrl)),
        name: image.name || `文档图片 ${index + 1}`,
        previewUrl: undefined,
        origin: 'document' as const,
      };
    }

    const sourceUrl = image.sourceUrl || image.dataUrl;
    if (!sourceUrl) return null;

    const loaded = await loadDocumentImageDataUrl(image).catch(() => null);
    if (!loaded) return null;

    return {
      ...image,
      dataUrl: loaded.dataUrl,
      mimeType: loaded.mimeType,
      width: loaded.width || image.width,
      height: loaded.height || image.height,
      previewUrl: undefined,
      origin: 'document' as const,
    };
  }));

  return prepared.filter((image): image is ChatImageInput => Boolean(image));
}

function isSupportedModelImage(image: ChatImageInput): boolean {
  const source = image.dataUrl || image.sourceUrl || '';
  const mimeType = normalizeImageMimeType(image.mimeType || guessImageMimeType(source));
  return isSupportedModelImageSource(source, mimeType);
}

function isSupportedModelImageSource(source: string, mimeType?: string): boolean {
  const normalizedMime = normalizeImageMimeType(mimeType || guessImageMimeType(source));
  if (!MODEL_IMAGE_MIME_TYPES.has(normalizedMime)) return false;

  if (source.startsWith('data:')) {
    return isValidBase64ModelDataUrl(source, normalizedMime);
  }

  const path = source.split('?')[0].toLowerCase();
  return !path.endsWith('.svg');
}

function isValidBase64ModelDataUrl(source: string, mimeType?: string): boolean {
  const match = source.match(/^data:([^;,]+)(;base64)?,/i);
  if (!match) return false;
  const normalizedMime = normalizeImageMimeType(mimeType || match[1]);
  return MODEL_IMAGE_MIME_TYPES.has(normalizedMime) && Boolean(match[2]);
}

function normalizeImageMimeType(mimeType = ''): string {
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return normalized;
}

function guessImageMimeType(url: string): string {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)/);
    return normalizeImageMimeType(match?.[1] || 'image/png');
  }

  const lower = url.toLowerCase();
  if (/format=webp|sticker_format=\.webp/.test(lower)) return 'image/webp';
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}

function normalizeImageKey(url: string): string {
  if (!url) return '';
  try {
    return new URL(url, document.baseURI).href.split('#')[0];
  } catch {
    return url.split('#')[0];
  }
}

function isDecorativeDocumentImage(img: HTMLImageElement, width?: number, height?: number): boolean {
  const className = String(img.className || '');
  const parentClassName = String(img.parentElement?.className || '');
  const blockClassName = String(img.closest('.block')?.className || '');

  if (/docx-image|image-block|mp-image|image-container/i.test(`${className} ${parentClassName} ${blockClassName}`)) {
    return false;
  }

  if (width && height && width <= 48 && height <= 48) return true;
  return /avatar|icon|emoji|logo|loading|placeholder/i.test(`${className} ${parentClassName}`);
}

async function loadDocumentImageDataUrl(
  image: ChatImageInput,
): Promise<{ dataUrl: string; mimeType: string; width?: number; height?: number } | null> {
  const sourceUrl = image.sourceUrl || image.dataUrl;
  if (!sourceUrl) return null;

  const fromCanvas = await readLoadedImageFromCanvas(sourceUrl, image.mimeType).catch(() => null);
  if (fromCanvas) return fromCanvas;

  if (!/^https?:\/\//i.test(sourceUrl)) return null;
  const fetched = await fetchImageDataUrlFromBackground(sourceUrl).catch(() => null);
  if (!fetched) return null;

  return {
    dataUrl: fetched.dataUrl,
    mimeType: normalizeImageMimeType(fetched.mimeType || image.mimeType || guessImageMimeType(sourceUrl)),
    width: image.width,
    height: image.height,
  };
}

async function readLoadedImageFromCanvas(
  sourceUrl: string,
  mimeType = 'image/png',
): Promise<{ dataUrl: string; mimeType: string; width: number; height: number } | null> {
  const img = findLoadedDocumentImage(sourceUrl);
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

  const normalizedMime = normalizeImageMimeType(mimeType);
  const outputMime = normalizedMime === 'image/png' ? 'image/png' : 'image/jpeg';
  return {
    dataUrl: canvas.toDataURL(outputMime, outputMime === 'image/jpeg' ? 0.82 : undefined),
    mimeType: outputMime,
    width,
    height,
  };
}

function findLoadedDocumentImage(sourceUrl: string): HTMLImageElement | null {
  const target = normalizeImageKey(sourceUrl);
  return Array.from(document.images).find(img => {
    const candidates = [
      img.currentSrc,
      img.src,
      ...IMAGE_URL_ATTRS.map(attr => img.getAttribute(attr) || ''),
    ].filter(Boolean).map(normalizeImageKey);
    return candidates.includes(target);
  }) ?? null;
}

async function fetchImageDataUrlFromBackground(
  url: string,
): Promise<{ dataUrl: string; mimeType: string; size?: number } | null> {
  const response = await chrome.runtime.sendMessage({
    type: 'FETCH_IMAGE_DATA_URL',
    payload: { url },
  } satisfies ExtensionMessage<{ url: string }>);

  if (!response || response.error || !response.dataUrl) return null;
  return {
    dataUrl: String(response.dataUrl),
    mimeType: String(response.mimeType || guessImageMimeType(url)),
    size: typeof response.size === 'number' ? response.size : undefined,
  };
}
