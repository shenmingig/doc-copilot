// ============================================================
// Document plan - structure a full-document answer before writing
// ============================================================

import type { ChatMessage, DocumentContext, ReferenceContext } from '../../shared/types/index';

export interface PlannedSection {
  title: string;
  action: '保留' | '重写' | '新增' | '删除';
  note: string;
}

export interface PlannedImage {
  afterSection: string;
  caption: string;
  prompt: string;
}

export interface DocumentPlan {
  summary: string;
  sections: PlannedSection[];
  images: PlannedImage[];
}

export interface ResolvedPlanImage extends PlannedImage {
  url?: string;
  error?: string;
}

interface PlanPromptInput {
  userMessage: string;
  context: DocumentContext | null;
  references?: ReferenceContext[];
  maxContextChars: number;
  allowImages: boolean;
  plan?: DocumentPlan;
}

const ACTIONS = new Map<string, PlannedSection['action']>([
  ['保留', '保留'],
  ['keep', '保留'],
  ['重写', '重写'],
  ['rewrite', '重写'],
  ['新增', '新增'],
  ['add', '新增'],
  ['删除', '删除'],
  ['delete', '删除'],
  ['remove', '删除'],
]);

export function wantsIllustratedDocument(userMessage: string): boolean {
  return /图文并茂|illustrated/i.test(userMessage);
}

export function isDirectIllustrationRequest(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  if (/^\/(?:image|img)(?:$|\s|[:：])/i.test(text)) return true;
  if (isDocumentPlanRequest(text)) return false;
  const asksToGenerate = /生成|绘制|创建|配图|画(?:图|一张|一个|个)|调用.{0,16}(?:画图|生图|图像|图片)|(?:画|绘制).{0,12}图|generate|create|draw|illustrate|render|image\s+api/i.test(text);
  const namesAnImage = /画图|图片|图像|插图|配图|示意图|信息图|图表|(?:这张|这个|一张|一幅|个)图|image|picture|diagram|illustration|chart/i.test(text);
  return asksToGenerate && namesAnImage;
}

export function isDocumentPlanRequest(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;

  const local = /这句话|这一句|选中的|选中内容|这段话|这一段|当前段|选区/.test(text);
  const asksForFullDocument = /整篇|全文|整页|整个文档|这篇文章|这篇文档|这个文档|当前文章|当前文档|完整文章|完整稿/.test(text);
  const asksToRestructure = /结构化|结构清晰|调整结构|重排结构|大纲|分节|分章|章节/.test(text);
  const asksToRewrite = /优化|重写|改写|整理|重构|润色/.test(text);
  const asksForImages = wantsIllustratedDocument(text)
    || (/配图|插图|加几张图|配上图|带图/.test(text) && (asksForFullDocument || asksToRewrite || asksToRestructure || /文档|文章/.test(text)));

  if (local && !asksForFullDocument) return false;
  if (asksForImages) return true;
  if (asksForFullDocument && (asksToRewrite || asksToRestructure)) return true;
  if (asksToRestructure && /文档|文章|全文|整篇/.test(text)) return true;
  return false;
}

export function parseDocumentPlan(raw: string, allowImages: boolean): DocumentPlan | null {
  const source = raw.trim();
  if (!source) return null;

  for (const candidate of extractJsonValues(source)) {
    const plan = planFromUnknown(candidate, allowImages);
    if (plan) return plan;
  }

  const salvaged = salvageTruncatedPlan(source, allowImages);
  if (salvaged) return salvaged;
  return parseOutline(source);
}

export function fallbackDocumentPlan(userMessage: string, sourceText: string, allowImages: boolean): DocumentPlan {
  const headings = extractHeadingTitles(sourceText).slice(0, 5);
  const titles = headings.length >= 2 ? headings : ['背景', '核心内容', '结论'];
  return {
    summary: cleanText(userMessage, 80) || '整理当前文档',
    sections: titles.map(title => ({
      title,
      action: '重写' as const,
      note: '按原文事实压缩并写清楚',
    })),
    images: allowImages ? titles.slice(0, 2).map(title => ({
      afterSection: title,
      caption: `${title}示意图`,
      prompt: `为一篇中文文档绘制一张简洁清晰的信息图，主题是「${title}」。突出关键对象和关系，不要大段文字。`,
    })) : [],
  };
}

export function ensurePlanImages(plan: DocumentPlan, allowImages: boolean): DocumentPlan {
  if (!allowImages || plan.images.length > 0) return plan;
  return {
    ...plan,
    images: [{
      afterSection: plan.sections[0]?.title || '',
      caption: '示意图',
      prompt: `为一篇文档配一张简洁、清晰的示意图：${plan.summary}。不要出现大段文字。`,
    }],
  };
}

export function formatPlanMarkdown(plan: DocumentPlan, activeImageIndex = -1): string {
  const sections = plan.sections
    .map((section, index) => `${index + 1}. **${section.action} · ${section.title}** — ${section.note || '按文档事实整理'}`)
    .join('\n');
  const images = plan.images.length
    ? plan.images.map((image, index) => {
      const state = index === activeImageIndex ? '（生成中）' : '';
      return `- ${image.afterSection}后：${image.caption}${state}`;
    }).join('\n')
    : '- 这篇不配图';
  return `**目标**：${plan.summary}\n\n${sections}\n\n**配图**\n${images}`;
}

export function buildPlanMessages(input: PlanPromptInput): ChatMessage[] {
  const imageRule = input.allowImages
    ? '用户要求图文结果。images 输出 1 到 3 项，afterSection 必须等于某个 section.title。prompt 要能直接交给图像模型，描述画面，不要要求图里写大段文字。'
    : '用户没有要求配图。images 必须是空数组。';

  return [
    {
      role: 'system',
      content: `你是 Doc Copilot 的写作规划器。只输出一个 JSON 对象，不要使用 Markdown 代码块。
JSON 格式：
{"summary":"一句话说明改写目标","sections":[{"title":"章节标题","action":"保留|重写|新增|删除","note":"这一节写什么，不超过40字"}],"images":[{"afterSection":"章节标题","caption":"图注","prompt":"画面描述"}]}
规则：
- sections 输出 3 到 6 项，覆盖用户要求的整篇内容。
- 只重组、压缩、删重复和补衔接，不要编造文档里没有的事实。
- ${imageRule}
- 使用与用户请求相同的语言写 summary、title、note、caption。`,
    },
    {
      role: 'user',
      content: `用户请求：${input.userMessage}\n\n${buildSourceBlock(input)}`,
    },
  ];
}

export function buildDraftMessages(input: PlanPromptInput & { plan: DocumentPlan }): ChatMessage[] {
  const plan = input.plan;
  const imageRule = plan.images.length
    ? `结构里有 ${plan.images.length} 张图。请在对应章节标题的下一行单独写 [[IMAGE:1]] 这样的占位符，编号从 1 开始并与图片顺序一致。不要写图片 URL，不要省略占位符。系统会把占位符替换成真实图片，不要建议用户使用 Mermaid、手工画图或去外部网站导出图片。`
    : '结构里没有图片。不要输出图片占位符、Mermaid 或图片 URL。';

  return [
    {
      role: 'system',
      content: `你是 Doc Copilot。请把当前文档写成一篇可以直接阅读的 Markdown 文稿。
要求：
- 按给定结构输出优化后的全文，不要只列修改说明，不要输出 JSON，不要复述规划过程。
- 不要声称自己没有编辑工具。
- 使用与用户请求相同的语言。
- 用 ## 作为章节标题，标题沿用结构中的标题。
- 只使用文档和引用里的事实。缺少的信息要明确说缺少，不要编造数据、链接或图片地址。
- 标记为删除的内容不要写进正文。
- ${imageRule}`,
    },
    {
      role: 'user',
      content: `用户请求：${input.userMessage}\n\n写作结构：\n${JSON.stringify(plan)}\n\n${buildSourceBlock(input)}`,
    },
  ];
}

export function previewImageMarkers(markdown: string): string {
  return markdown.replace(/\[\[IMAGE:\s*(\d+)\s*\]\]/g, (_match, index) => `\n\n*配图 ${index}：生成后会放在这里*\n\n`);
}

export function placePlanImages(markdown: string, images: ResolvedPlanImage[]): string {
  let result = markdown
    .split('\n')
    .filter(line => !/(?:用|使用)\s*mermaid|mermaid\s+live\s+editor|导出\s*png|手工(?:画|绘制)/i.test(line))
    .join('\n')
    .trim();
  images.forEach((image, index) => {
    const pattern = new RegExp(`\\[\\[IMAGE:\\s*${index + 1}\\s*\\]\\]`);
    if (pattern.test(result)) return;
    const token = `[[IMAGE:${index + 1}]]`;
    result = insertTokenAfterHeading(result, image.afterSection, token) || `${result}\n\n${token}`;
  });

  result = result.replace(/\[\[IMAGE:\s*(\d+)\s*\]\]/g, (_match, rawIndex) => {
    const image = images[Number(rawIndex) - 1];
    if (!image) return '';
    if (image.url) return `\n\n![${image.caption}](${image.url})\n\n`;
    const reason = image.error ? `：${cleanText(image.error, 80)}` : '';
    return `\n\n> 配图没有生成（${image.caption}${reason}）\n\n`;
  });

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

export function completionText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const record = response as Record<string, unknown>;
  const choice = Array.isArray(record.choices) ? record.choices[0] as Record<string, unknown> | undefined : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  return [
    textValue(message?.content),
    textValue(message?.reasoning_content),
    textValue(message?.reasoning),
    textValue(choice?.text),
    textValue(choice?.reasoning_content),
    textValue(record.output_text),
    textValue(record.content),
    textValue(record.answer),
    textValue(record.result),
  ].map(part => part.trim()).filter(Boolean).join('\n');
}

function buildSourceBlock(input: PlanPromptInput): string {
  const parts: string[] = [];
  const context = input.context;
  if (context?.title) parts.push(`标题：${context.title}`);
  if (context?.fullText) {
    const fullText = context.fullText.length > input.maxContextChars
      ? `${context.fullText.slice(0, input.maxContextChars)}\n...（已截断）`
      : context.fullText;
    parts.push(`文档全文：\n"""\n${fullText}\n"""`);
  }
  if (context?.selectedText) parts.push(`选中文本："""${context.selectedText.slice(0, 1000)}"""`);
  if (context?.textBefore || context?.textAfter) {
    parts.push(`光标附近："""${(context.textBefore || '').slice(-500)}[CURSOR]${(context.textAfter || '').slice(0, 500)}"""`);
  }
  if (input.references?.length) {
    const references = input.references.map(reference => {
      const text = reference.text.length > 1400 ? `${reference.text.slice(0, 1400)}\n...` : reference.text;
      return `[引用 ${reference.index}] ${reference.title}\n${text}`;
    }).join('\n\n');
    parts.push(`引用资料：\n${references}`);
  }
  return parts.join('\n\n');
}

function planFromUnknown(value: unknown, allowImages: boolean): DocumentPlan | null {
  if (Array.isArray(value)) return planFromRecord({ sections: value }, allowImages);
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const direct = planFromRecord(record, allowImages);
  if (direct) return direct;
  for (const key of ['plan', 'data', 'result', 'output']) {
    const nested = record[key];
    if (Array.isArray(nested) || (nested && typeof nested === 'object')) {
      const plan = planFromRecord(
        Array.isArray(nested) ? { sections: nested } : nested as Record<string, unknown>,
        allowImages,
      );
      if (plan) return plan;
    }
  }
  return null;
}

function planFromRecord(record: Record<string, unknown>, allowImages: boolean): DocumentPlan | null {
  const sectionRows = firstArray(record, ['sections', '章节', 'outline', 'chapters', 'parts', '大纲', 'structure']);
  const sections: PlannedSection[] = [];
  for (const item of sectionRows) {
    if (typeof item === 'string') {
      const title = cleanText(item, 40);
      if (!title) continue;
      sections.push({ title, action: actionFromText(item) || '重写', note: cleanText(item, 80) });
    } else if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      const title = cleanText(firstValue(row, ['title', '标题', 'heading', 'name', 'section', '章节']), 40);
      if (!title) continue;
      const actionText = cleanText(firstValue(row, ['action', '动作', '操作', 'change', 'type']), 12);
      const note = cleanText(firstValue(row, ['note', '说明', '备注', 'description', 'desc', '内容', 'summary']), 80);
      sections.push({
        title,
        action: actionFromText(actionText) || actionFromText(note) || '重写',
        note,
      });
    }
    if (sections.length >= 6) break;
  }
  if (!sections.length) return null;
  if (sections.length === 1) {
    sections.push({ title: '结论', action: '重写', note: '收束原文里的关键结论' });
  }

  const images: PlannedImage[] = [];
  if (allowImages) {
    for (const item of firstArray(record, ['images', '图片', '配图', 'illustrations'])) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const prompt = cleanText(firstValue(row, ['prompt', '描述', 'description', 'prompt_text', 'text']), 400);
      if (!prompt) continue;
      images.push({
        afterSection: cleanText(firstValue(row, ['afterSection', 'after', '位置', 'section']), 40) || sections[0].title,
        caption: cleanText(firstValue(row, ['caption', '图注', 'alt', 'title', '标题']), 40) || '配图',
        prompt,
      });
      if (images.length >= 3) break;
    }
  }

  return {
    summary: cleanText(firstValue(record, ['summary', '摘要', '总结', '目标', 'goal']), 140) || '按文档已有事实重组结构',
    sections,
    images,
  };
}

function parseOutline(raw: string): DocumentPlan | null {
  const matches = raw.split('\n').map(line => line.trim()).filter(line =>
    /^(?:#{1,6}\s+|(?:\d+|[一二三四五六七八九十]+)[.、．)\]]\s+|[-*]\s+)/.test(line),
  );
  if (matches.length < 2 || matches.length > 6) return null;
  const sections = matches.map(line => {
    const body = line.replace(/^(?:#{1,6}\s+|(?:\d+|[一二三四五六七八九十]+)[.、．)\]]\s+|[-*]\s+)/, '').replace(/\*\*/g, '').trim();
    const title = cleanText(body.split(/[:：\-—]/)[0], 40);
    return {
      title,
      action: actionFromText(body) || '重写' as const,
      note: cleanText(body, 80),
    };
  }).filter(section => section.title.length >= 2);
  if (sections.length < 2) return null;
  return { summary: '按模型给出的大纲整理', sections, images: [] };
}

function salvageTruncatedPlan(raw: string, allowImages: boolean): DocumentPlan | null {
  const markers = ['"sections"', '"章节"', '"outline"', '"大纲"'];
  let start = -1;
  for (const marker of markers) {
    const at = raw.lastIndexOf(marker);
    if (at < 0) continue;
    const brace = raw.lastIndexOf('{', at);
    if (brace > start) start = brace;
  }
  if (start < 0) return null;
  const repaired = repairJson(raw.slice(start));
  return repaired ? planFromUnknown(repaired, allowImages) : null;
}

function extractJsonValues(raw: string): unknown[] {
  const values: unknown[] = [];
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let searchFrom = 0;
  let attempts = 0;
  while (searchFrom < trimmed.length && attempts < 30) {
    const start = trimmed.indexOf('{', searchFrom);
    if (start < 0) break;
    attempts += 1;
    const slice = trimmed.slice(start);
    const balanced = readBalancedJson(slice);
    if (balanced) {
      const parsed = parseLooseJson(balanced);
      if (parsed !== null) values.push(parsed);
      searchFrom = start + balanced.length;
      continue;
    }
    searchFrom = start + 1;
  }
  return values;
}

function readBalancedJson(raw: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(0, index + 1);
    }
  }
  return null;
}

function parseLooseJson(raw: string): unknown {
  const normalized = raw
    .replace(/[“”]/g, '"')
    .replace(/，(?=\s*")/g, ',')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function repairJson(raw: string): unknown {
  let repaired = raw.trim().replace(/[“”]/g, '"');
  repaired = repaired.replace(/,\s*"[^"\n]*$/, '');
  repaired = repaired.replace(/,\s*$/, '');
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of repaired) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if ((char === '}' || char === ']') && stack.length) stack.pop();
  }
  if (inString) repaired += '"';
  repaired += stack.reverse().join('');
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

function extractHeadingTitles(sourceText: string): string[] {
  const titles: string[] = [];
  for (const line of sourceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 40) continue;
    const markdown = trimmed.match(/^#{1,6}\s+(.+)$/);
    const numbered = trimmed.match(/^(?:\d+|[一二三四五六七八九十]+)[.、．]\s*(.+)$/);
    const title = cleanText(markdown?.[1] || numbered?.[1] || '', 40);
    if (title.length < 2 || titles.includes(title)) continue;
    titles.push(title);
    if (titles.length >= 5) break;
  }
  return titles;
}

function firstArray(record: Record<string, unknown>, names: string[]): unknown[] {
  const value = firstValue(record, names);
  return Array.isArray(value) ? value : [];
}

function firstValue(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name];
  }
  const lowered = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
  for (const name of names) {
    const value = lowered.get(name.toLowerCase());
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function actionFromText(value: string): PlannedSection['action'] | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  const exact = ACTIONS.get(text);
  if (exact) return exact;
  const leading = text.match(/^(保留|重写|新增|删除|keep|rewrite|add|delete|remove)(?=$|\s|[:：,，])/);
  return leading ? ACTIONS.get(leading[1]) || null : null;
}


function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').replace(/[\[\]]/g, '').trim().slice(0, maxLength);
}

function insertTokenAfterHeading(markdown: string, title: string, token: string): string | null {
  const target = title.trim().toLowerCase();
  if (!target) return null;
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^#{1,6}\s+(.+?)\s*$/);
    if (!heading) continue;
    const text = heading[1].replace(/[*_`]/g, '').trim().toLowerCase();
    if (text !== target && !text.includes(target) && !target.includes(text)) continue;
    lines.splice(index + 1, 0, '', token, '');
    return lines.join('\n');
  }
  return null;
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.thinking === 'string') return record.thinking;
    if (typeof record.reasoning_content === 'string') return record.reasoning_content;
    return '';
  }).join('');
}
