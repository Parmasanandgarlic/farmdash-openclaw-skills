#!/usr/bin/env node
/**
 * Upstream provenance and byte-parity guard.
 *
 * This repository is a byte-exact mirror of canonical FarmDash production truth. Nothing
 * here should ever be edited by hand: a mirrored file that diverges from the SHA256
 * recorded in UPSTREAM.json is either an accidental local edit or an incomplete sync, and
 * both are distribution defects that production cannot detect on its own. Historically this
 * tree carried an unauthenticated confirm_swap for several releases while the live manifest
 * kept pointing agents at it.
 *
 * Run from the repository root:  node mcp-server/scripts/verify-upstream-parity.mjs
 * Exits non-zero on any divergence, so CI fails instead of shipping a stale mirror.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const upstreamPath = path.join(root, 'UPSTREAM.json');

if (!existsSync(upstreamPath)) {
  console.error('FAIL: UPSTREAM.json missing - provenance cannot be verified');
  process.exit(1);
}

const upstream = JSON.parse(readFileSync(upstreamPath, 'utf8'));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const problems = [];
let checked = 0;

for (const [rel, meta] of Object.entries(upstream.mirrored ?? {})) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) { problems.push(`missing: ${rel}`); continue; }
  const actual = sha(abs);
  checked++;
  if (actual !== meta.sha256) {
    problems.push(`diverged: ${rel}\n    expected ${meta.sha256}\n    actual   ${actual}`);
  }
}

// Tool count must match the recorded provenance.
const genPath = path.join(root, 'mcp-server/src/tool-capabilities.generated.ts');
if (existsSync(genPath)) {
  const names = [...readFileSync(genPath, 'utf8').matchAll(/^\s{2}"([a-z0-9_]+)":\s*\{/gm)].map((m) => m[1]);
  if (names.length !== upstream.mcp_tool_count) {
    problems.push(`tool count drift: recorded ${upstream.mcp_tool_count}, found ${names.length}`);
  }
}

console.log(`upstream source     : ${upstream.source_repository}@${upstream.source_sha}`);
console.log(`mirrored files      : ${checked}/${Object.keys(upstream.mirrored ?? {}).length} verified`);
console.log(`recorded tool count : ${upstream.mcp_tool_count}`);

if (problems.length) {
  console.error(`\nFAIL: ${problems.length} parity problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRe-sync from canonical FarmDash production truth. Do not hand-edit mirrored files.');
  process.exit(1);
}

console.log('\nPASS: public distribution matches recorded canonical provenance');