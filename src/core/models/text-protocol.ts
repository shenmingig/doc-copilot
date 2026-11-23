import type { ModelApiProtocol } from '../../shared/types/index';

export interface TextProtocolRouting {
  protocol: Exclude<ModelApiProtocol, 'auto'> | 'compatible';
  locked: boolean;
  anthropicOnly: boolean;
  openAiV1Only: boolean;
  preferMessages: boolean;
  responsesOnly: boolean;
}

export function isClaudeModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().includes('claude');
}

export function isAnthropicMessagesOnlyEndpoint(baseUrl: string): boolean {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/messages$/i.test(trimmed)) return true;

  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

export function prefersAnthropicMessages(modelId: string, baseUrl: string): boolean {
  if (!isClaudeModel(modelId)) return /\/messages$/i.test(baseUrl.trim().replace(/\/+$/, ''));
  return !/\/chat\/completions$/i.test(baseUrl.trim().replace(/\/+$/, ''));
}

export function resolveTextProtocolRouting(
  modelId: string,
  baseUrl: string,
  configured: ModelApiProtocol = 'auto',
): TextProtocolRouting {
  const locked = configured !== 'auto';
  const claudeModel = isClaudeModel(modelId);
  const inferred = !modelId.trim()
    ? 'compatible'
    : claudeModel
      ? 'anthropic-messages'
      : /gpt|grok|(?:^|[/:._-])o[1-4](?:$|[/:._-])/i.test(modelId)
        ? 'openai-chat-completions'
        : 'compatible';
  const protocol = configured === 'auto' ? inferred : configured;
  const preferMessages = protocol === 'anthropic-messages'
    || (configured === 'auto' && !/\/chat\/completions$/i.test(baseUrl.trim().replace(/\/+$/, '')) && claudeModel)
    || (configured === 'auto' && protocol === 'compatible' && /\/messages$/i.test(baseUrl.trim().replace(/\/+$/, '')));
  const anthropicOnly = protocol === 'anthropic-messages'
    && (locked || isAnthropicMessagesOnlyEndpoint(baseUrl));
  const responsesOnly = protocol === 'openai-responses' && locked;

  return {
    protocol,
    locked,
    anthropicOnly,
    openAiV1Only: protocol === 'openai-chat-completions' || protocol === 'openai-responses',
    preferMessages,
    responsesOnly,
  };
}
