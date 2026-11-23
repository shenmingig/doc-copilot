import type { ChatMessage } from '../../shared/types/index';

type ResponsesInputItem = Record<string, unknown>;

function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part.type === 'text' ? part.text || '' : '').filter(Boolean).join('\n');
}

export function toResponsesInput(messages: ChatMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id || '',
          output: contentText(message.content),
      });
      continue;
    }

    if (message.tool_calls?.length) {
        const text = contentText(message.content);
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    if (typeof message.content === 'string') {
      if (message.content) content.push({
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: message.content,
      });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          content.push({
            type: 'input_image',
            image_url: part.image_url.url,
            detail: part.image_url.detail || 'auto',
          });
        } else if (part.type === 'text' && part.text) {
          content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
        }
      }
    }

    if (content.length) input.push({ role: message.role, content });
  }

  return input;
}
