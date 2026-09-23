#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOL_CAPABILITIES } from '../dist/tool-capabilities.generated.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '..', 'dist', 'index.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, FARMDASH_BASE_URL: process.env.FARMDASH_BASE_URL || 'https://www.farmdash.one/api' },
  stderr: 'pipe',
});
const client = new Client({ name: 'farmdash-public-introspection-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  const expectedNames = Object.keys(MCP_TOOL_CAPABILITIES);
  const listedSet = new Set(names);
  const expectedSet = new Set(expectedNames);

  if (listedSet.size !== names.length) {
    throw new Error(`tools/list contains duplicate names: ${names.length} rows, ${listedSet.size} unique`);
  }

  const missing = expectedNames.filter((name) => !listedSet.has(name));
  const unexpected = names.filter((name) => !expectedSet.has(name));
  if (missing.length || unexpected.length) {
    throw new Error(`MCP runtime/capability drift: missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`);
  }

  for (const tool of listed.tools) {
    if (!tool.inputSchema || tool.inputSchema.type !== 'object') {
      throw new Error(`${tool.name} has no object inputSchema`);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    tool_count: names.length,
    capability_count: expectedNames.length,
    server: serverPath,
  }, null, 2));
} finally {
  await client.close();
}
