import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentTool } from '../../shared/types/index';
import { toolsForContext } from './agent-tool-registry.ts';

function makeTool(name: string): AgentTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => '',
  };
}

test('keeps built-in document write tools hidden while exposing search and configured image tools', () => {
  const builtins = [
    makeTool('search_document'),
    makeTool('insert_at_cursor'),
    makeTool('replace_selection'),
    makeTool('replace_text'),
  ];
  const image = makeTool('generate_image');

  assert.deepEqual(toolsForContext(builtins, image, [], false).map(tool => tool.name), ['search_document']);
  assert.deepEqual(toolsForContext(builtins, image, [], true).map(tool => tool.name), ['search_document', 'generate_image']);
});
