#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  if (names.length !== 84 || new Set(names).size !== 84) {
    throw new Error(`Expected 84 unique tools, got ${names.length}`);
  }
  for (const tool of listed.tools) {
    if (!tool.inputSchema || tool.inputSchema.type !== 'object') {
      throw new Error(`${tool.name} has no object inputSchema`);
    }
  }
  console.log(JSON.stringify({ ok: true, tool_count: names.length, server: serverPath }, null, 2));
} finally {
  await client.close();
}
