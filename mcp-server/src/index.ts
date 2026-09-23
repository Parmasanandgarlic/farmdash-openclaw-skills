#!/usr/bin/env node

/**
 * Runtime contract guard for the legacy MCP registration module.
 *
 * The large registration table lives in index-base.ts. This entry point patches
 * the public registration boundary before loading it so discovery cannot expose
 * quarantined compatibility-swap providers or imply that public callers may
 * self-attest generic intent policy/simulation evidence.
 *
 * The protocol enum enforces the STABILIZED provider set only: Relay is a
 * first-class stabilized quote provider (P0 multi-provider routing), so it
 * is exposed; anything outside this set (e.g. quarantined venues) stays
 * undiscoverable even if a schema ever names it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const originalTool = McpServer.prototype.tool as (...args: any[]) => unknown;
const SWAP_PROVIDER_GUARDED_TOOLS = new Set([
  'find_capital_route',
  'get_swap_quote',
  'execute_swap',
  'run_risk_sentinel',
]);

(McpServer.prototype as unknown as { tool: (...args: any[]) => unknown }).tool = function guardedTool(
  name: string,
  ...args: any[]
) {
  if (SWAP_PROVIDER_GUARDED_TOOLS.has(name)) {
    const schema = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg) && 'protocol' in arg);
    if (schema) {
      schema.protocol = z.enum(['lifi', 'relay']).optional();
    }
  }

  const descriptionIndex = typeof args[0] === 'string' ? 0 : -1;
  const capabilityPrefix = descriptionIndex >= 0
    ? (args[descriptionIndex] as string).match(/^\[Capability: [^\]]+\]\s*/)?.[0] ?? ''
    : '';
  if (descriptionIndex >= 0 && name === 'policy_check_intent') {
    args[descriptionIndex] = `${capabilityPrefix}Readiness probe for the generic intent policy gate. Public callers cannot provide trusted policy decisions; until the server policy evaluator is configured this returns policy_evaluator_unconfigured. Tool discovery does not grant policy authority.`;
  }
  if (descriptionIndex >= 0 && name === 'simulate_intent') {
    args[descriptionIndex] = `${capabilityPrefix}Readiness probe for the generic intent simulation gate. Public callers cannot record trusted simulation evidence; until a server verifier is configured this returns simulation_verifier_unconfigured. Tool discovery does not grant simulation authority.`;
  }
  if (descriptionIndex >= 0 && name === 'confirm_swap') {
    args[descriptionIndex] = `${capabilityPrefix}Confirm a compatibility swap only through FarmDash server verification of the owning session, canonical-chain receipt, exact committed fee asset/payer/recipient/amount, and required finality. A caller-supplied tx hash alone is not confirmation.`;
  }

  return originalTool.call(this, name, ...args);
};

await import('./index-base.js');
