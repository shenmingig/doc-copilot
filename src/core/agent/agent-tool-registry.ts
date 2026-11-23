import type { AgentTool } from '../../shared/types/index';

export function toolsForContext(
  builtinTools: AgentTool[],
  imageGenerationTool: AgentTool,
  customTools: AgentTool[],
  includeImageGeneration: boolean,
): AgentTool[] {
  return [
    ...builtinTools.filter(tool => tool.name === 'search_document'),
    ...(includeImageGeneration ? [imageGenerationTool] : []),
    ...customTools,
  ];
}
