#!/usr/bin/env node

/**
 * FarmDash Agent OS - MCP Server (v5.0.0)
 *
 * Exposes FarmDash through an explicit intent lifecycle:
 * Research -> Plan -> Approve -> Prepare -> Observe.
 *
 * Legacy specialist tools remain for compatibility, but new state-changing
 * agent actions should use FarmDashIntent lifecycle tools first.
 *
 * Configuration (env vars):
 *   FARMDASH_API_KEY  - Pioneer or Syndicate Bearer token (optional)
 *   FARMDASH_BASE_URL - Override API base (default: https://www.farmdash.one/api)
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FuturesPolicySchema } from './futures-policy.js';
import { createApiFetch, errorPayload, retainedSession } from './api-client.js';
import { getInstallationId } from './installation-identity.js';
import { getMcpToolCapability } from './tool-capabilities.generated.js';
import { resolveProfile, isProfileTool, ROUTING_INSTRUCTIONS } from './discovery.js';

import { MCP_EXECUTION_MODE_SELECTION } from './executionModeSelection.generated.js';
import { getToolAnnotations } from './tool-contracts.js';

// Resolve before server construction or any transport connection; empty is invalid.
const discoveryProfile = resolveProfile(process.env.FARMDASH_MCP_PROFILE);

/* Config */

const BASE_URL = process.env.FARMDASH_BASE_URL ?? 'https://www.farmdash.one/api';
const API_KEY = process.env.FARMDASH_API_KEY ?? '';
const apiFetch = createApiFetch({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  scoutGrant: process.env.FARMDASH_SCOUT_GRANT ?? '',
  skillId: process.env.FARMDASH_SKILL_ID ?? '',
  // If state persistence is unavailable, undefined deliberately omits analytics; startup continues.
  installationId: getInstallationId(),
  clientVersion: process.env.FARMDASH_CLIENT_VERSION ?? '5.0.0',
  skillVersion: process.env.FARMDASH_SKILL_VERSION ?? '',
});
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TOKEN_CONTRACT_GUIDANCE = 'ERC-20 token contract address deployed on the corresponding chain. Do not pass a wallet/EOA; the token address and chain ID must match.';
const HEX_SIGNATURE = /^0x[a-fA-F0-9]{130}$/;
const BASE_UNIT_AMOUNT = /^[0-9]+$/;
// Base58 Solana account/mint addresses: rejects EVM hex shapes at the schema
// boundary instead of forwarding them to the Jupiter routes.
const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const SIGNATURE_SCHEMA = z.object({
  r: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  s: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  v: z.number().int(),
});

// MCP tools/list renders an empty raw shape (`{}`) as an open object schema.
// A constructed ZodObject instead emits { properties: {}, additionalProperties: false }
// with identical argument-stripping parse behavior, so paramless tools register
// with this marker and their published contract is explicitly closed.
const PARAMLESS_SCHEMA = z.object({}).strict();

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
    isError: true,
  };
}

async function apiToolResult(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

const SessionCredentialSchemas = {
  sessionId: z.string().optional(),
  agentAddress: z.string().regex(EVM_ADDRESS).optional(),
  sessionToken: z.string().min(32).max(256).optional(),
};

function withSessionBody(params: Record<string, any>, body: Record<string, any> = {}): Record<string, any> {
  return {
    ...body,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.agentAddress ? { agentAddress: params.agentAddress } : {}),
    ...(params.sessionToken ? { sessionToken: params.sessionToken } : {}),
  };
}

function appendSessionQuery(path: string, params: Record<string, any>, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams(extra);
  if (params.sessionId) qs.set('sessionId', params.sessionId);
  if (params.agentAddress) qs.set('agentAddress', params.agentAddress);
  return qs.size ? `${path}?${qs}` : path;
}

/* MCP Server */

const server = new McpServer({
  name: 'farmdash-agent-os',
  version: '5.0.0',
}, {
  maxToolInputElements: 100,
  instructions: ROUTING_INSTRUCTIONS,
});

const toolAnnotations = getToolAnnotations;

/* ── Resources (Batch 21 §2c) ─────────────────────────────────────────────
   Read-only agent context that does not burn tool-call quota. The OpenAPI
   specs and the status payload are PROXIED from the served backend, so the
   resource can never drift from the served document. The chain/token tables
   below are the only embedded data; tests/mcpResourceContract.test.ts pins
   them to their repo sources (src/config/executionCapabilities.ts
   ExecutionChainId, lib/swap/token-decimals.ts NATIVE_SENTINEL and
   KNOWN_DECIMALS) so drift fails CI.
   farmdash://session/current reports the MCP process's retained session
   metadata without returning credentials. farmdash://execution-truth is
   not registered. */
const SPEC_BASE_URL = BASE_URL.replace(/\/api$/, '');

async function fetchPublicSpec(pathname: string): Promise<string> {
  const response = await fetch(`${SPEC_BASE_URL}${pathname}`, {
    headers: { Accept: 'text/yaml', 'User-Agent': 'farmdash-mcp-server/5.0.0' },
  });
  if (!response.ok) throw new Error(`FarmDash spec fetch failed: HTTP ${response.status}`);
  return response.text();
}

server.registerResource('openapi-spec', 'farmdash://openapi.yaml', {
  title: 'FarmDash OpenAPI specification (served copy)',
  description: 'The served Agent API spec, proxied from GET /agents/openapi.yaml so the resource never drifts from the served document.',
  mimeType: 'text/yaml',
}, async (uri: URL) => ({
  contents: [{ uri: uri.href, mimeType: 'text/yaml', text: await fetchPublicSpec('/agents/openapi.yaml') }],
}));

server.registerResource('signal-architect-openapi', 'farmdash://openapi/signal-architect', {
  title: 'FarmDash Signal Architect OpenAPI specification (served copy)',
  description: 'The served Signal Architect swap spec, proxied from GET /agents/swap/openapi.yaml.',
  mimeType: 'text/yaml',
}, async (uri: URL) => ({
  contents: [{ uri: uri.href, mimeType: 'text/yaml', text: await fetchPublicSpec('/agents/swap/openapi.yaml') }],
}));

server.registerResource('futures-openapi', 'farmdash://openapi/futures', {
  title: 'FarmDash Futures Strategist OpenAPI specification (served copy)',
  description: 'The served Futures Strategist spec, proxied from GET /agents/futures/openapi.yaml.',
  mimeType: 'text/yaml',
}, async (uri: URL) => ({
  contents: [{ uri: uri.href, mimeType: 'text/yaml', text: await fetchPublicSpec('/agents/futures/openapi.yaml') }],
}));

server.registerResource('agent-status', 'farmdash://status', {
  title: 'FarmDash live readiness and capability status',
  description: 'Live readiness, active providers, paused venues and tier inventory, proxied from GET /v1/agent/status.',
  mimeType: 'application/json',
}, async (uri: URL) => {
  const data = await apiFetch('/v1/agent/status');
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
});

// Executable chains — pinned to src/config/executionCapabilities.ts
// ExecutionChainId (1 | 10 | 137 | 8453 | 42161 | 59144 | 'solana-mainnet').
const EXECUTABLE_CHAINS = [
  { name: 'Ethereum', chainId: 1, alchemyNetwork: 'eth-mainnet' },
  { name: 'Optimism', chainId: 10, alchemyNetwork: 'opt-mainnet' },
  { name: 'Polygon', chainId: 137, alchemyNetwork: 'polygon-mainnet' },
  { name: 'Base', chainId: 8453, alchemyNetwork: 'base-mainnet', note: 'x402 settlement chain' },
  { name: 'Arbitrum', chainId: 42161, alchemyNetwork: 'arb-mainnet' },
  { name: 'Linea', chainId: 59144, alchemyNetwork: 'linea-mainnet' },
  { name: 'Solana', chainId: 'solana-mainnet', alchemyNetwork: null, note: 'EVM tooling does not apply; Solana wallet balances are unsupported (typed denial)' },
];

server.registerResource('executable-chains', 'farmdash://chains', {
  title: 'Executable chains and native-asset sentinel',
  description: 'Chain IDs the execution layer supports, with the native-asset sentinel rule: pass 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee (NATIVE_SENTINEL) for a chain native gas token, never a WETH address.',
  mimeType: 'application/json',
}, async (uri: URL) => ({
  contents: [{
    uri: uri.href,
    mimeType: 'application/json',
    text: JSON.stringify({
      chains: EXECUTABLE_CHAINS,
      nativeAssetSentinel: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      sentinelRule: 'Use the sentinel address for the native chain token in swap inputs; the execution guard treats it as 18 decimals. Solana addresses are not supported by the EVM balances surface.',
    }, null, 2),
  }],
}));

// Well-known decimal fallbacks — pinned VERBATIM to
// lib/swap/token-decimals.ts KNOWN_DECIMALS (address-keyed; the source makes
// no chain attribution, so neither does this resource). Quote-time RPC
// decimals are authoritative; these are the offline display fallback.
const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6,
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 6,
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 6,
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 18,
};

server.registerResource('canonical-tokens', new ResourceTemplate('farmdash://tokens/{chainId}', { list: undefined }), {
  title: 'Canonical token guidance for a chain',
  description: 'The native-asset sentinel rule and the well-known decimal fallback table for one executable chain. The source table is address-keyed (lib/swap/token-decimals.ts KNOWN_DECIMALS); quote-time RPC decimals are authoritative and this resource never claims a chain attribution the source does not make.',
  mimeType: 'application/json',
}, async (uri: URL) => {
  const chainId = uri.pathname.split('/').pop() ?? '';
  const chain = EXECUTABLE_CHAINS.find((c) => String(c.chainId) === chainId);
  if (!chain) {
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({ ok: false, error: 'unknown_chain', chainId, executableChains: EXECUTABLE_CHAINS.map((c) => String(c.chainId)) }, null, 2),
      }],
    };
  }
  return {
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({
        chainId: chain.chainId,
        name: chain.name,
        nativeAssetSentinel: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        knownDecimalFallbacks: KNOWN_TOKEN_DECIMALS,
        guidance: 'Pass the sentinel address for the native gas token, never a WETH address. Decimals are fetched live via RPC at quote time; these fallbacks apply only when RPC is unreachable. The table is address-keyed; it is not chain-scoped.',
      }, null, 2),
    }],
  };
});

/* Process-scoped metadata only. Retained credentials are used by the API client
   and must never be serialized in a resource response. */
server.registerResource('retained-session', 'farmdash://session/current', {
  title: 'Session metadata retained by this MCP process',
  description: 'Metadata for the session retained by this stdio process, or null if no session has been retained. Never returns the session token. Reading this resource grants no wallet, signing or delegation authority.',
  mimeType: 'application/json',
}, async (uri: URL) => {
  const retained = retainedSession();
  const session = retained ? {
    sessionId: retained.sessionId,
    agentAddress: retained.agentAddress,
    retainedAt: retained.retainedAt,
    ...(retained.expiresAt !== undefined ? { expiresAt: retained.expiresAt } : {}),
  } : null;
  return {
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({
        ok: true,
        retained: session !== null,
        session,
        guidance: 'This resource reports process-local metadata, not credentials. Session creation is not execution authority.',
      }, null, 2),
    }],
  };
});


// Keep the existing strongly typed registrations while attaching MCP-standard
// annotations to every tool listing. These are hints, never authorization.
const registerToolWithoutAnnotations = server.tool.bind(server) as (...args: any[]) => unknown;
(server as unknown as { tool: (...args: any[]) => unknown }).tool = (name: string, ...args: any[]) => {
  if (!isProfileTool(discoveryProfile, name)) return undefined;
  const callback = args.pop();
  const capability = getMcpToolCapability(name);
  const mockLabel = capability.mock_supported === undefined ? '' : `; mock_supported: ${capability.mock_supported}`;
  const capabilityLabel = `[Capability: ${capability.availability}; tier: ${capability.tier}${mockLabel}; API: ${capability.api_route}; authority: /api/v1/agent/status]`;


  // An empty raw shape serializes as an open object schema in tools/list
  // (no additionalProperties). Register paramless tools through registerTool
  // with the closed marker so they publish { properties: {}, additionalProperties: false }.
  const shape = args[typeof args[0] === 'string' ? 1 : 0];
  if (shape && typeof shape === 'object' && !('_def' in shape) && !('_zod' in shape) && Object.keys(shape).length === 0) {
    const description = typeof args[0] === 'string' ? `${capabilityLabel} ${args[0]}` : capabilityLabel;
    const registerTool = (server as unknown as { registerTool: (...a: any[]) => unknown }).registerTool.bind(server);
    return registerTool(name, {
      description,
      inputSchema: PARAMLESS_SCHEMA,
      annotations: toolAnnotations(name),
    }, callback);
  }
  if (typeof args[0] === 'string') args[0] = `${capabilityLabel} ${args[0]}`;
  else args.unshift(capabilityLabel);
  return registerToolWithoutAnnotations(name, ...args, toolAnnotations(name), callback);
};

const JsonRecordSchema = z.record(z.string(), z.any());
const IntentIdSchema = z.string().startsWith('fdi_');
const ReceiptIdSchema = z.string().startsWith('fdrcpt_');
const ReceiptStatusSchema = z.enum(['SUBMITTED', 'CONFIRMED', 'FAILED', 'REJECTED']);

/* Intent lifecycle: Plan */

server.tool(
  'create_intent',
  'Plan: create a durable FarmDashIntent. This records what an agent wants to do; it never prepares, signs, broadcasts, or executes. COMMERCIAL GATE (Pioneer+ or 0.02 USDC x402): the intent lifecycle resolves to the session_control x402 policy (scoutFree: false, oneOffAllowed: true, 0.02 USDC on Base), so a Scout or keyless caller receives HTTP 402 payment_required with a payable x402 challenge. Do NOT sign an execution-trial challenge - this is a commercial wall, not a 401 identity challenge. Pay the route x402 challenge, upgrade to Pioneer at farmdash.one/agents, or call with a Pioneer API key. The separate 401 execution_trial_identity_required sign-and-retry recipe applies only to execution-trial acquisition (firm quote / futures analysis).',
  {
    ...SessionCredentialSchemas,
    intent: JsonRecordSchema.describe('FarmDashIntent create input. Must include actor, action, chain, protocol, wallet, params, constraints, and evidence.'),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/intents/create', {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { intent: params.intent })),
  })),
);

server.tool(
  'policy_check_intent',
  'Plan: run the explicit FarmDash policy gate for an intent. Execution remains blocked unless this check passes.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
    policy: JsonRecordSchema.optional(),
    context: JsonRecordSchema.optional(),
  },
  async (params) => apiToolResult(() => apiFetch(`/v1/agent/intents/${params.intentId}/policy-check`, {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, {
      policy: params.policy ?? {},
      context: params.context ?? {},
    })),
  })),
);

server.tool(
  'simulate_intent',
  'Plan: record a mandatory simulation result for an intent. Prepare and execute are blocked until a successful, unexpired simulation exists.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
    simulation: JsonRecordSchema.optional(),
  },
  async (params) => apiToolResult(() => apiFetch(`/v1/agent/intents/${params.intentId}/simulate`, {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { simulation: params.simulation ?? {} })),
  })),
);

/* Intent lifecycle: Approve */

server.tool(
  'request_approval_payload',
  'Approve: build the EIP-712 IntentApproval payload that the human approver signs before submit_signed_approval.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
    approverAddress: z.string().min(1),
    decision: z.enum(['APPROVED', 'REJECTED']).default('APPROVED'),
    expiresInSeconds: z.number().int().min(60).max(600).optional(),
  },
  async (params) => apiToolResult(() => apiFetch(`/v1/agent/intents/${params.intentId}/approval-payload`, {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, {
      approver_address: params.approverAddress,
      decision: params.decision,
      expires_in_seconds: params.expiresInSeconds,
    })),
  })),
);

server.tool(
  'request_human_approval',
  'Approve: submit a signed EIP-712 human approval or rejection for an intent. This compatibility tool is signed-only for normal callers.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
    approverAddress: z.string().min(1),
    status: z.enum(['APPROVED', 'REJECTED']).default('APPROVED'),
    signature: z.string().regex(HEX_SIGNATURE),
    simulationId: z.string().startsWith('fdsim_'),
    policyCheckId: z.string().startsWith('fdpc_'),
    maxUsdValue: z.number().nonnegative(),
    nonce: z.string().min(1),
    expiresAt: z.string().datetime(),
    reason: z.string().optional(),
    metadata: JsonRecordSchema.optional(),
  },
  async (params) => apiToolResult(() => apiFetch(`/v1/agent/intents/${params.intentId}/approve`, {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, {
      status: params.status,
      decision: params.status,
      approver_address: params.approverAddress,
      signature: params.signature,
      simulation_id: params.simulationId,
      policy_check_id: params.policyCheckId,
      max_usd_value: params.maxUsdValue,
      nonce: params.nonce,
      expires_at: params.expiresAt,
      reason: params.reason,
      metadata: params.metadata ?? {},
    })),
  })),
);

server.tool(
  'submit_signed_approval',
  'Approve: submit a signed EIP-712 IntentApproval payload produced by request_approval_payload. This does not prepare or execute the intent.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
    approverAddress: z.string().min(1),
    decision: z.enum(['APPROVED', 'REJECTED']).default('APPROVED'),
    signature: z.string().regex(HEX_SIGNATURE),
    simulationId: z.string().startsWith('fdsim_'),
    policyCheckId: z.string().startsWith('fdpc_'),
    maxUsdValue: z.number().nonnegative(),
    nonce: z.string().min(1),
    expiresAt: z.string().datetime(),
    reason: z.string().optional(),
    metadata: JsonRecordSchema.optional(),
  },
  async (params) => apiToolResult(() => apiFetch(`/v1/agent/intents/${params.intentId}/approve`, {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, {
      status: params.decision,
      decision: params.decision,
      approver_address: params.approverAddress,
      signature: params.signature,
      simulation_id: params.simulationId,
      policy_check_id: params.policyCheckId,
      max_usd_value: params.maxUsdValue,
      nonce: params.nonce,
      expires_at: params.expiresAt,
      reason: params.reason,
      metadata: params.metadata ?? {},
    })),
  })),
);

server.tool(
  'get_approval_status',
  'Approve: inspect whether an intent is still awaiting approval, has been approved, or was rejected.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
  },
  async (params) => apiToolResult(async () => {
    const response = asRecord(await apiFetch(
      appendSessionQuery(`/v1/agent/intents/${params.intentId}`, params),
      { sessionToken: params.sessionToken },
    ));
    const intent = asRecord(response.intent);
    const metadata = asRecord(intent.metadata);
    const status = firstString(intent.status) ?? 'UNKNOWN';
    return {
      ok: response.ok ?? true,
      intent_id: params.intentId,
      status,
      approval_required: status === 'APPROVAL_REQUIRED',
      approved: ['APPROVED', 'PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED'].includes(status),
      rejected: status === 'REJECTED',
      approval_id: firstString(metadata.approval_id, metadata.approvalId),
      intent,
    };
  }),
);

/* Intent lifecycle: Execute */

server.tool(
  'prepare_intent',
  'Execute: validate adapter support and prepare an intent after policy, simulation, and approval gates pass. This does not broadcast a transaction.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
    preparation: JsonRecordSchema.optional(),
  },
  async (params) => apiToolResult(() => apiFetch(`/v1/agent/intents/${params.intentId}/prepare`, {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, params.preparation ?? {})),
  })),
);

server.tool(
  'execute_approved_intent',
  'Unavailable for generic public execution: the lifecycle API rejects client-supplied receipts until a trusted adapter and server-side transaction verifier are deployed. Use this only to observe the structured execution_verifier_unconfigured response; raw arbitrary calldata is rejected.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
    status: ReceiptStatusSchema.optional(),
    txHash: z.string().optional(),
    signature: z.string().optional(),
    signedPayload: JsonRecordSchema.optional(),
    receipt: JsonRecordSchema.optional(),
    details: JsonRecordSchema.optional(),
    error: z.string().optional(),
  },
  async (params) => apiToolResult(() => apiFetch(`/v1/agent/intents/${params.intentId}/execute`, {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify((() => {
      const receipt = asRecord(params.receipt);
      return withSessionBody(params, {
        ...receipt,
        status: params.status ?? firstString(receipt.status) ?? 'SUBMITTED',
        tx_hash: params.txHash ?? firstString(receipt.tx_hash, receipt.txHash),
        signature: params.signature ?? firstString(receipt.signature),
        signedPayload: params.signedPayload ?? receipt.signedPayload ?? receipt.signed_payload,
        details: params.details ?? asRecord(receipt.details),
        error: params.error ?? firstString(receipt.error),
      });
    })()),
  })),
);

server.tool(
  'confirm_execution',
  'Unavailable for generic public confirmation: FarmDash will not record a caller-supplied receipt. A trusted adapter and server-side transaction verifier must be deployed before this action can be enabled; use get_receipt only for verified receipt observation.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema,
    txHash: z.string().min(1),
    details: JsonRecordSchema.optional(),
  },
  async (params) => apiToolResult(() => apiFetch(`/v1/agent/intents/${params.intentId}/execute`, {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, {
      status: 'CONFIRMED',
      tx_hash: params.txHash,
      details: params.details ?? {},
    })),
  })),
);

/* Intent lifecycle: Observe */

server.tool(
  'get_receipt',
  'Observe: fetch one durable FarmDash receipt by receipt_id.',
  {
    ...SessionCredentialSchemas,
    receiptId: ReceiptIdSchema,
  },
  async (params) => apiToolResult(() => apiFetch(
    appendSessionQuery(`/v1/agent/receipts/${params.receiptId}`, params),
    { sessionToken: params.sessionToken },
  )),
);

server.tool(
  'get_agent_activity',
  'Observe: list durable FarmDash execution receipts. Filter by intent_id and receipt status to review recent agent activity.',
  {
    ...SessionCredentialSchemas,
    intentId: IntentIdSchema.optional(),
    status: ReceiptStatusSchema.optional(),
    limit: z.number().int().min(1).max(250).optional(),
  },
  async (params) => apiToolResult(() => {
    const qs = new URLSearchParams();
    if (params.intentId) qs.set('intent_id', params.intentId);
    if (params.status) qs.set('status', params.status);
    if (params.limit) qs.set('limit', params.limit.toString());
    if (params.sessionId) qs.set('sessionId', params.sessionId);
    if (params.agentAddress) qs.set('agentAddress', params.agentAddress);
    return apiFetch(`/v1/agent/receipts${qs.size ? `?${qs}` : ''}`, { sessionToken: params.sessionToken });
  }),
);

/* 1. FarmDash Trail Intelligence (v2.2.0) */

server.tool(
  'get_trail_heat',
  'Canonical Trail Heat: fetch DeFiLlama-backed quantitative scores (0-100) with per-number evidence states, components, editorial separation and registry resolution from /v1/trail-heat. Aggregate responses also include live agent recommendations; canonical score leads and only owner-confirmed, non-wallet-bound FarmDash referral routes are eligible for the near-equivalent-quality tiebreaker. Optional bounds mirror the backend query parameters; the backend clamps them (top default 10).',
  {
    top: z.number().int().min(1).max(50).optional().describe('Trim the protocol list to the top N (1-50; backend clamps, default 10)'),
    recommend: z.number().int().min(1).max(50).optional().describe('Include the live recommendation block, limited to N (1-50)'),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams();
      if (params.top) qs.set('top', String(params.top));
      if (params.recommend) qs.set('recommend', String(params.recommend));
      const data = await apiFetch(`/v1/trail-heat${qs.size ? `?${qs}` : ''}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_protocol_metadata',
  'Research: get catalog metadata for a specific DeFi protocol — status, chains, description, tags, and discovery_heuristic_score (catalog editorial heuristic, NOT live Trail Heat; canonical scores via get_trail_heat).',
  { protocolId: z.string().describe('Protocol ID (e.g. "hyperliquid")') },
  async (params) => {
    try {
      const qs = new URLSearchParams({ protocolId: params.protocolId });
      const data = await apiFetch(`/v1/agent/protocols?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_protocol_risk_factors',
  'Read the catalog risk label, category, chains, status, and editorial discovery score for a protocol ID. Use analyze_protocol_risk for a source-backed assessment and get_trail_heat for canonical quantitative scores. The catalog provides background only.',
  {
    protocolId: z.string().describe('Exact FarmDash catalog protocol ID, such as hyperliquid.'),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams({ protocolId: params.protocolId });
      const data = await apiFetch(`/v1/agent/protocols?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'find_capital_route',
  'Read a provider-neutral EVM market estimate for an exact token pair, chains, and input amount. It makes no provider calls and establishes neither liquidity nor execution authority. Use get_swap_quote with idempotencyKey for a separate firm quote intent.',
  {
    fromChainId: z.number().int().describe('Numeric EVM source chain ID.'),
    toChainId: z.number().int().describe('Numeric EVM destination chain ID. Use the source ID for a same-chain estimate.'),
    fromToken: z.string().min(1).max(128).describe('Resolver-supported symbol, native identifier, token address, or chain-qualified asset; discovery resolves canonical assets server-side.'),
    toToken: z.string().min(1).max(128).describe('Resolver-supported symbol, native identifier, token address, or chain-qualified asset; discovery resolves canonical assets server-side.'),
    fromAmount: z.string().regex(BASE_UNIT_AMOUNT).describe('Amount in token base units.'),
    protocol: z.enum(['lifi', 'relay']).optional().describe('Optional compatibility selector accepted by the preview route. The result remains provider-neutral.'),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams({
        fromChainId: params.fromChainId.toString(),
        toChainId: params.toChainId.toString(),
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAmount: params.fromAmount,
      });
      if (params.protocol) qs.set('protocol', params.protocol);
      const data = await apiFetch(`/agents/quote?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_chain_breakdown',
  'Get protocol distribution aggregated by blockchain network. Returns counts, airdrops, and category coverage. Takes no parameters.',
  {},
  async () => {
    try {
      const data = await apiFetch('/v1/agent/chain-breakdown');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_agent_events',
  'Poll Pioneer+ tenant-bound agent events using the owning authenticated session (sessionId, agentAddress, and sessionToken); no Scout or mock preview. Returns recent event records, not a public real-time stream. Optional bounds mirror the backend query parameters.',
  {
    ...SessionCredentialSchemas,
    limit: z.number().int().min(1).max(200).optional().describe('Max events to return (default 50, max 200)'),
    since: z.string().optional().describe('ISO timestamp lower bound (default 24h ago)'),
    types: z.string().optional().describe('Comma-separated event types, e.g. trail_heat_spike,new_protocol'),
  },
  async (params) => {
    try {
      const extra: Record<string, string> = {};
      if (params.limit) extra.limit = String(params.limit);
      if (params.since) extra.since = params.since;
      if (params.types) extra.types = params.types;
      const data = await apiFetch(appendSessionQuery('/v1/agent/events', params, extra), { sessionToken: params.sessionToken });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'audit_sybil_risk',
  'Research: audit 1-10 EVM addresses for sybil risk. Returns cluster risk score and hygiene suggestions.',
  { addresses: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).min(1).max(10) },
  async (params) => {
    try {
      const qs = new URLSearchParams({ addresses: params.addresses.join(',') });
      const data = await apiFetch(`/v1/agent/sybil-audit?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'simulate_points',
  'Estimate hypothetical FarmScore from caller-supplied activity and protocol points with Pioneer-equivalent route access. Returns totalScore, breakdown, marginalLevers, and unknownProtocolsDefaulted. Projects no reward, allocation, or monetary return.',
  {
    totalVolumeUsd: z.number().min(0).describe('Hypothetical total eligible volume in USD.'),
    txCount: z.number().int().min(0).describe('Hypothetical total transaction count.'),
    daysActive: z.number().int().min(0).describe('Number of distinct hypothetical active days.'),
    walletBalanceUsd: z.number().min(0).describe('Hypothetical wallet balance in USD.'),
    uniqueContracts: z.number().int().min(0).describe('Number of distinct hypothetical contracts used.'),
    isCexFundingOnly: z.boolean().describe('True when the assumed wallet receives funding exclusively from centralized exchanges.'),
    protocolPoints: z.record(z.string(), z.number()).describe('Hypothetical points by FarmDash protocol ID. Unknown IDs receive the default multiplier and are reported.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/simulate-points', {
        method: 'POST',
        body: JSON.stringify(params),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_historical_trailheat',
  'Query historical Trail Heat snapshots, 1-365 days back. Returns score trends and momentum flags.',
  {
    protocolId: z.string().optional(),
    days: z.number().int().min(1).max(365).default(30),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams({ days: params.days.toString() });
      if (params.protocolId) qs.set('protocolId', params.protocolId);
      const data = await apiFetch(`/v1/agent/historical-trailheat?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 2. FarmDash Wagon Steward (v0.6.0) */

server.tool(
  'get_wallet_balances',
  'Inspect token balances and available USD valuations for an EVM wallet. Scout returns a bounded preview. For full balances use Pioneer or Syndicate access or the route x402 terms. The backend caps full results at 100 tokens before local filters.',
  {
    address: z.string().regex(EVM_ADDRESS).describe('0x-prefixed EVM wallet address to look up.'),
    chains: z.string().optional().describe('Comma-separated Alchemy network IDs, such as eth-mainnet,base-mainnet. Uses up to five valid networks. Omit for Ethereum, Arbitrum, Base, Optimism, and Linea.'),
    minUsdValue: z.number().min(0).optional().describe('Drop tokens whose USD value is below this (MCP-side filter, not a backend query bound)'),
    limit: z.number().int().min(1).optional().describe('Cap the token count after filtering (MCP-side, not a backend query bound)'),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams({ address: params.address });
      if (params.chains) qs.set('chains', params.chains);
      const data = await apiFetch(`/v1/agent/balances?${qs}`);
      const data2 = applyBalancesBounds(data, params.minUsdValue, params.limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data2, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

// Context-window guard for dusty wallets: the backend returns up to 100 tokens
// and offers no value/count query bound, so the wrapper filters the page here.
function applyBalancesBounds(data: unknown, minUsdValue?: number, limit?: number) {
  if (minUsdValue === undefined && limit === undefined) return data;
  if (!data || typeof data !== 'object') return data;
  const out = { ...(data as Record<string, unknown>) };
  const portfolio = out.portfolio as { tokens?: unknown[] } | undefined;
  if (portfolio && Array.isArray(portfolio.tokens)) {
    let tokens = portfolio.tokens as Array<{ valueUsd?: number }>;
    if (typeof minUsdValue === 'number' && minUsdValue > 0) {
      tokens = tokens.filter((t) => (t.valueUsd ?? 0) >= minUsdValue);
    }
    if (typeof limit === 'number' && limit > 0) {
      tokens = tokens.slice(0, limit);
    }
    out.portfolio = { ...portfolio, tokens };
  }
  return out;
}

server.tool(
  'get_portfolio_summary',
  'Summarize an EVM wallet across Ethereum, Arbitrum, Base, Optimism, and Linea. Full access returns total USD value, chain distribution, and top tokens. Scout returns a bounded preview. Use get_wallet_balances for token-level inspection or get_idle_capital for stablecoins and native assets.',
  { address: z.string().regex(EVM_ADDRESS).describe('0x-prefixed EVM wallet address to look up.') },
  async (params) => {
    try {
      const qs = new URLSearchParams({ address: params.address, summary: 'true' });
      const data = await apiFetch(`/v1/agent/balances?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_position_health',
  'Legacy alias for get_agent_performance. Returns FarmDash-recorded activity and fees for the supplied address, with a bounded Scout preview. Use get_agent_performance for new integrations. This tool cannot assess position APR, PnL, impermanent loss, or rebalance health.',
  { address: z.string().regex(EVM_ADDRESS).describe('0x-prefixed EVM wallet address to look up.') },
  async (params) => {
    try {
      const qs = new URLSearchParams({ address: params.address, health: 'true' });
      const data = await apiFetch(`/v1/agent/performance?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_idle_capital',
  'Find stablecoin and native-token balances across Ethereum, Arbitrum, Base, Optimism, and Linea. Full access returns idleAssets and idleCapitalUsd. Scout returns a bounded portfolio preview. These wallet balances do not establish deployable capital or available execution authority.',
  { address: z.string().regex(EVM_ADDRESS).describe('0x-prefixed EVM wallet address to look up.') },
  async (params) => {
    try {
      const qs = new URLSearchParams({ address: params.address, summary: 'true', idleOnly: 'true' });
      const data = await apiFetch(`/v1/agent/balances?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_token_prices',
  'Read available USD spot prices and check data_mode for partial or unavailable coverage. Provide symbols or tokens. If both are supplied, symbols take precedence. These prices are for research and do not establish an executable quote.',
  {
    symbols: z.string().optional().describe('Comma-separated token symbols, such as ETH,SOL,BTC. The price service uses the first 25 non-empty symbols.'),
    tokens: z.array(z.string().max(128)).max(50).optional()
      .describe('Token contracts as network:0x-address pairs, using the full 40-digit hex address. The service reads the first 25 non-empty pairs. Use when symbol lookup would be ambiguous.'),
  },
  async (params) => {
    try {
      if (!params.symbols && (!params.tokens || params.tokens.length === 0)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide symbols or tokens.' }) }],
          isError: true,
        };
      }
      const qs = new URLSearchParams();
      if (params.symbols) qs.set('symbols', params.symbols);
      if (params.tokens?.length) qs.set('tokens', params.tokens.join(','));
      const data = await apiFetch(`/v1/agent/prices?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 3. FarmDash Trail Marshal (v1.0.0) */

server.tool(
  'list_workflows',
  'Browse the public DeFi workflow catalog before planning. Returns workflow IDs, required tiers, and ordered skill and tool steps.',
  { filter: z.string().optional().describe('Case-insensitive substring to match against recipe IDs, names, descriptions, tiers, and steps. Omit to list all recipes.') },
  async (params) => {
    try {
      const qs = new URLSearchParams();
      if (params.filter) qs.set('filter', params.filter);
      const data = await apiFetch(`/v1/agent/workflows${qs.size ? `?${qs}` : ''}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'plan_workflow',
  'Compile a recipe against tool contracts and installed skills before creating a run. Requires Pioneer or Syndicate. Returns blockers, required confirmations, and next actions. Records a planning event without creating a run or executing steps.',
  {
    workflowId: z.string().describe('Recipe ID returned by list_workflows.'),
    installedSkills: z.array(z.string().max(128)).max(50).optional()
      .describe('Up to 50 installed skill slugs from the recipe steps, such as signal-architect. Each slug is at most 128 characters. Omit if installation is unknown or pass [] if none are installed.'),
    agentAddress: z.string().regex(EVM_ADDRESS).optional()
      .describe('0x-prefixed EVM wallet address to associate with the planning event. Omit for an unattributed plan.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/orchestrator', {
        method: 'POST',
        body: JSON.stringify({ action: 'plan_strategy', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'run_workflow',
  'Create a temporary dry-run record for a recipe and return run.runId for status lookup. Requires Pioneer or Syndicate and a valid session credential. Resolve compilation blockers before retrying. Each owning skill must perform its own authority checks and get explicit user confirmation before execution.',
  {
    workflowId: z.string().describe('Recipe ID returned by list_workflows.'),
    sessionId: z.string().describe('ID returned by create_session for the wallet starting this run.'),
    agentAddress: z.string().regex(EVM_ADDRESS).describe('0x-prefixed EVM wallet address that owns the session.'),
    sessionToken: z.string().describe('Secret token returned by create_session for this exact session and wallet. Keep it out of logs and user-visible output.'),
    installedSkills: z.array(z.string().max(128)).max(50).optional()
      .describe('Up to 50 installed skill slugs from the recipe steps, such as signal-architect. Each slug is at most 128 characters. Omit if installation is unknown or pass [] if none are installed.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/orchestrator', {
        method: 'POST',
        body: JSON.stringify({ action: 'run_workflow', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_workflow_status',
  'Check the current dry-run record after run_workflow. Requires Pioneer or Syndicate. Returns the stored plan and status without executing any step. A 404 means the temporary run is unavailable; use plan_workflow to reassess before creating a replacement.',
  { runId: z.string().describe('UUID in run.runId returned by run_workflow. Keep this identifier private.') },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/orchestrator', {
        method: 'POST',
        body: JSON.stringify({ action: 'get_workflow_status', runId: params.runId }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'select_execution_continuation',
  'Select a server-issued execution continuation as read-only context. Returns canonical next_operation parameters and missing prerequisites; it makes no quote, preparation, admission, debit, signing, or submission call and grants no execution authority. Unknown or expired IDs fail closed.',
  { continuationId: z.string().uuid() },
  async ({ continuationId }) => apiToolResult(() => apiFetch('/v1/agent/continuation', {
    method: 'POST', body: JSON.stringify({ continuationId }),
  })),
);

/* 3b. FarmDash Payment Kernel (Phase A) */

server.tool(
  'get_payments_bootstrap',
  'Free, provider-free payment bootstrap terms: how an agent holding only native Base ETH obtains metered access, including native-ETH payment intents, FarmDash prepaid credit, and the single-use execution-bootstrap grant. This tool is read-only. It contacts no swap provider, performs no mutation, and grants no execution authority. Issuing an intent or a grant requires an explicit authenticated POST with a server-issued, purpose-specific signature challenge, which this tool does not perform.',
  {},
  async () => {
    try {
      const data = await apiFetch('/v1/payments/bootstrap');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 4. FarmDash Signal Architect (v4.0.0) */

server.tool(
  'get_swap_quote',
  'Research or firm quote: without idempotencyKey, return a provider-neutral market estimate with zero trading-provider calls. With idempotencyKey plus a real wallet/destination and slippage, create or reuse a firm single-provider quote intent and return simulationRequirements.intent_id for simulate_swap_execution. Active selection is LI.FI/Relay; 0x remains blocked while operator-paused.',
  {
    fromChainId: z.number().int(),
    toChainId: z.number().int(),
    fromToken: z.string().min(1).max(128).describe('Resolver-supported symbol, native identifier, token address, or chain-qualified asset; discovery resolves canonical assets server-side.'),
    toToken: z.string().min(1).max(128).describe('Resolver-supported symbol, native identifier, token address, or chain-qualified asset; discovery resolves canonical assets server-side.'),
    fromAmount: z.string().regex(BASE_UNIT_AMOUNT),
    protocol: z.enum(['lifi', 'relay']).optional(),
    walletAddress: z.string().regex(EVM_ADDRESS).optional(),
    toAddress: z.string().regex(EVM_ADDRESS).optional(),
    slippage: z.number().min(0.01).max(5).optional(),
    expectedUpsideUsd: z.number().optional(),
    riskBufferUsd: z.number().optional(),
    healthFactor: z.number().optional(),
    liquidationBufferPct: z.number().optional(),
    safetyMode: z.enum(['strict', 'balanced']).optional(),
    continuationId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    executionTrialProof: z.object({ issuedAt: z.number().int().positive(), signature: z.string().min(1) }).optional().describe('Locally signed commercial owner challenge; no transaction or delegation authority.'),
    executionMode: z.enum(['USER_SIGNED', 'BOUNDED_AUTONOMOUS']).optional(),
    sessionId: z.string().optional(), sessionToken: z.string().optional(), grantId: z.string().optional(),
  },
  async (params) => {
    try {
      if (params.idempotencyKey) {
        const data = await apiFetch('/v1/agent/quote-intent', {
          method: 'POST',
          body: JSON.stringify({
            fromChainId: params.fromChainId,
            toChainId: params.toChainId,
            fromToken: params.fromToken,
            toToken: params.toToken,
            fromAmount: params.fromAmount,
            walletAddress: params.walletAddress,
            toAddress: params.toAddress ?? params.walletAddress,
            slippage: params.slippage,
            protocol: params.protocol,
            idempotencyKey: params.idempotencyKey,
            continuationId: params.continuationId,
            executionTrialProof: params.executionTrialProof,
            executionMode: params.executionMode,
            sessionId: params.sessionId, sessionToken: params.sessionToken, grantId: params.grantId,
          }),
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      }

      const qs = new URLSearchParams();
      qs.set('fromChainId', params.fromChainId.toString());
      qs.set('toChainId', params.toChainId.toString());
      qs.set('fromToken', params.fromToken);
      qs.set('toToken', params.toToken);
      qs.set('fromAmount', params.fromAmount);
      if (params.protocol) qs.set('protocol', params.protocol);
      if (params.continuationId) qs.set('continuationId', params.continuationId);
      if (params.walletAddress) qs.set('walletAddress', params.walletAddress);
      if (params.toAddress) qs.set('toAddress', params.toAddress);
      if (params.slippage !== undefined) qs.set('slippage', params.slippage.toString());
      if (params.expectedUpsideUsd !== undefined) qs.set('expectedUpsideUsd', params.expectedUpsideUsd.toString());
      if (params.riskBufferUsd !== undefined) qs.set('riskBufferUsd', params.riskBufferUsd.toString());
      if (params.healthFactor !== undefined) qs.set('healthFactor', params.healthFactor.toString());
      if (params.liquidationBufferPct !== undefined) qs.set('liquidationBufferPct', params.liquidationBufferPct.toString());
      if (params.safetyMode) qs.set('safetyMode', params.safetyMode);

      const data = await apiFetch(`/agents/quote?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'simulate_swap_execution',
  'Simulate a legacy EVM swap using the firm quote response simulationRequirements.intent_id and its original wallet. Inspect the returned ok, simulation_id, and decision before continuing. The quote intent carries commercial admission for this simulation. It does not sign or submit. Use simulate_intent for a durable FarmDashIntent.',
  {
    intentId: z.string().min(1).describe('fd_intent_* value from simulationRequirements.intent_id. The top-level qi_* quote ID is rejected.'),
    walletAddress: z.string().regex(EVM_ADDRESS).describe('EVM wallet bound to the original firm quote.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/simulate', {
        method: 'POST',
        body: JSON.stringify({
          intent_id: params.intentId,
          wallet_address: params.walletAddress,
        }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'execute_swap',
  'Compatibility route: validate a signed token-swap request after a fresh successful simulation and return transaction calldata. FarmDash does not broadcast the returned transaction. Generic execute_approved_intent remains unavailable.',
  {
    fromChainId: z.number().int(),
    toChainId: z.number().int(),
    fromToken: z.string().regex(EVM_ADDRESS).describe(TOKEN_CONTRACT_GUIDANCE),
    toToken: z.string().regex(EVM_ADDRESS).describe(TOKEN_CONTRACT_GUIDANCE),
    fromAmount: z.string().regex(BASE_UNIT_AMOUNT),
    agentAddress: z.string().regex(EVM_ADDRESS),
    toAddress: z.string().regex(EVM_ADDRESS),
    nonce: z.string(),
    signature: z.string(),
    simulationId: z.string().min(1),
    intentId: z.string().optional(),
    slippage: z.number().optional(),
    protocol: z.enum(['lifi', 'relay']).optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/agents/swap', { method: 'POST', body: JSON.stringify(params) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'confirm_swap',
  'Confirm settlement of a FarmDash fee event for a compatibility swap the customer-controlled wallet has already broadcast. Requires the owning session; independently verifies the canonical-chain receipt, the exact committed fee asset, payer, recipient, amount and required finality before durably marking the fee event confirmed. FarmDash never broadcasts this transaction, and a caller-supplied transaction hash alone is not confirmation.',
  { sessionId: z.string(), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string(), feeEventId: z.string(), txHash: z.string() },
  async (params) => {
    try {
      // The session token is an ambient caller credential: send it as the
      // X-FarmDash-Session-Token header, never inside the logged JSON body.
      const { sessionToken, ...body } = params;
      const data = await apiFetch('/agents/confirm', { method: 'POST', body: JSON.stringify(body), sessionToken });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 4b. Native Solana compatibility swap (Jupiter) */

server.tool(
  'get_solana_quote',
  'Read-only Solana swap quote preview through Jupiter. PREVIEW ONLY: the response is explicitly non-authoritative pricing intelligence and cannot be executed through the EVM compatibility-swap path. FarmDash never signs, builds or broadcasts a transaction from this route. Pass Base58 mints (SOL uses So11111111111111111111111111111111111111112) and the amount in base units.',
  {
    inputMint: z.string().regex(SOLANA_BASE58).describe('Base58 SPL mint address being sold. Native SOL uses So11111111111111111111111111111111111111112.'),
    outputMint: z.string().regex(SOLANA_BASE58).describe('Base58 SPL mint address being bought.'),
    amount: z.string().regex(BASE_UNIT_AMOUNT).describe('Input amount in the input mint base units.'),
    slippageBps: z.number().int().min(1).max(500).optional().describe('Slippage tolerance in basis points (default provider value when omitted).'),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
      });
      if (params.slippageBps !== undefined) qs.set('slippageBps', params.slippageBps.toString());
      const data = await apiFetch(`/agents/solana-quote?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'prepare_solana_swap',
  'Prepare an unsigned Solana swap VersionedTransaction with authoritative RPC simulation. Zero custody: FarmDash returns the unsigned transaction and stops at READY_FOR_USER_SIGNATURE; the customer wallet signs and broadcasts it. Requires a stable idempotencyKey. An expired preparation returns non-retryable 410 and needs a NEW idempotency key; a 409 submitted/ambiguous outcome is not safe to resubmit and must be reconciled first.',
  {
    wallet: z.string().regex(SOLANA_BASE58).describe('Base58 Solana public key of the paying/owning wallet. Must not be an EVM address.'),
    inputMint: z.string().regex(SOLANA_BASE58).describe('Base58 SPL mint address being sold.'),
    outputMint: z.string().regex(SOLANA_BASE58).describe('Base58 SPL mint address being bought.'),
    amount: z.string().regex(BASE_UNIT_AMOUNT).describe('Input amount in the input mint base units.'),
    slippageBps: z.number().int().min(1).max(500).optional(),
    minAmountOut: z.string().regex(BASE_UNIT_AMOUNT).optional().describe('Optional explicit minimum output in base units; overrides the slippage-derived floor when supplied.'),
    idempotencyKey: z.string().min(1).max(128).describe('Stable replay key for this exact preparation. Reuse it only for a retryable failure of the SAME request.'),
    continuationId: z.string().uuid().optional().describe('Optional server-issued execution continuation to bind this preparation to.'),
    executionTrialProof: z.object({ issuedAt: z.number().int().positive(), signature: z.string().min(1) }).optional().describe('Locally signed commercial owner challenge; no transaction or delegation authority.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/agents/solana-swap', {
        method: 'POST',
        body: JSON.stringify(params),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'confirm_solana_swap',
  'Confirm and reconcile a Solana swap the customer wallet has already broadcast. Verifies the server-authored preparation, wallet binding, inclusion, required signer, exact message digest and economic deltas. "confirmed" without finality is not settlement; replaying the same signature is idempotent. FarmDash never signs or broadcasts.',
  {
    preparationId: z.string().min(1).describe('preparationId returned by prepare_solana_swap.'),
    wallet: z.string().regex(SOLANA_BASE58).describe('Base58 Solana public key that signed the preparation. Must match the prepared wallet.'),
    txSignature: z.string().regex(SOLANA_SIGNATURE).describe('Base58 Solana transaction signature that exists only after the wallet broadcast.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/agents/solana-confirm', {
        method: 'POST',
        body: JSON.stringify(params),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'optimize_portfolio',
  'Find up to ten unranked catalog candidates to research. Requires paid access through Pioneer, Syndicate capacity, or the route x402 terms. Returns WAIT. Before acting, verify exact pools, wallet eligibility, policy, costs, and the stay-put comparison. Campaign status does not establish safety.',
  {
    currentProtocols: z.array(z.string().max(128)).max(50).describe('Up to 50 existing FarmDash protocol IDs to exclude. Use [] for no exclusions.'),
    riskPreference: z.enum(['conservative', 'balanced', 'aggressive']).describe('Requested research risk preference. The result echoes this value without using it to rank candidates.'),
    chains: z.array(z.string()).optional().describe('Exact FarmDash catalog chain names to include. The first 50 are considered. Omit or pass [] for all catalog chains.'),
    budget: z.enum(['low', 'medium', 'high']).optional().describe('Optional qualitative budget. Defaults to medium and is echoed without restricting candidates or authorizing spend.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/optimize-portfolio', { method: 'POST', body: JSON.stringify(params) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'resolve_defi_intent',
  'Build unsigned compatibility steps for a typed DeFi action on supported EVM chains. Returns intent, execution steps, and supportedProtocols. The resolver may record estimated fee telemetry. API access follows route terms and gives no signing or broadcast authority. Use create_intent for the durable lifecycle.',
  {
    action: z.enum(['swap', 'deposit', 'stake', 'provide_liquidity', 'withdraw', 'claim']).describe('Requested financial operation. Availability depends on the protocol and chain combination.'),
    protocolId: z.string().describe('Canonical protocol ID supported by this legacy resolver.'),
    chainId: z.union([z.number().int().positive(), z.literal('solana-mainnet')]).describe('Source EVM chain ID: 1, 10, 137, 8453, 42161, or 59144. The route rejects Solana.'),
    toChainId: z.union([z.number().int().positive(), z.literal('solana-mainnet')]).optional().describe('Optional destination EVM chain ID from the same supported set.'),
    tokenIn: z.string().describe('Source token contract address or ETH for native Ethereum token.'),
    amountIn: z.string().regex(BASE_UNIT_AMOUNT).describe('Nonzero integer string in source-token base units.'),
    userAddress: z.string().describe('Public 0x-prefixed EVM address that would sign the steps locally.'),
    tokenOut: z.string().optional().describe('Destination token contract address or ETH for native Ethereum token.'),
    amountOut: z.string().regex(BASE_UNIT_AMOUNT).optional().describe('Nonzero integer string in destination-token base units.'),
    slippage: z.number().min(0.01).max(5).optional().describe('Price tolerance in percentage points (0.5 means 0.5%).'),
    poolAddress: z.string().optional().describe('Target EVM liquidity pool contract where applicable.'),
    deadline: z.number().optional().describe('Unix timestamp in seconds or milliseconds.'),
    constraints: z.object({
      minAmountOut: z.string().regex(BASE_UNIT_AMOUNT).optional().describe('Minimum acceptable output as a nonzero token base-unit integer string.'),
      maxSlippageBps: z.number().int().positive().optional().describe('Maximum allowed slippage in basis points.'),
      maxGasUsd: z.number().positive().optional().describe('Maximum acceptable gas estimate in USD.'),
      expectedUpsideUsd: z.number().positive().optional().describe('Expected gross upside in USD.'),
      riskBufferUsd: z.number().positive().optional().describe('Additional modeled risk cost in USD.'),
      positiveNetEdge: z.boolean().optional().describe('Require the estimated net edge to be positive when true.'),
    }).optional().describe('Optional lower output bound, maximum costs, and required opportunity economics.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/intent', { method: 'POST', body: JSON.stringify(params) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'run_risk_sentinel',
  'Check swap-route or manual health and net-edge risk within route capacity. Supply both chain IDs, both tokens, and input amount for quoted mode, which requests a provider preview and returns riskReport and quotePreview. Otherwise the manual result contains health, netEdge, flags, and shouldHalt. A halt can publish an authorized risk alert. This action grants no trading authority.',
  {
    fromChainId: z.number().int().positive().optional().describe('Source EVM chain ID for quoted mode.'),
    toChainId: z.number().int().positive().optional().describe('Destination EVM chain ID for quoted mode.'),
    fromToken: z.string().regex(EVM_ADDRESS).describe(TOKEN_CONTRACT_GUIDANCE).optional(),
    toToken: z.string().regex(EVM_ADDRESS).describe(TOKEN_CONTRACT_GUIDANCE).optional(),
    fromAmount: z.string().regex(BASE_UNIT_AMOUNT).optional().describe('Input token amount as an integer string in base units.'),
    walletAddress: z.string().regex(EVM_ADDRESS).optional().describe('Optional EVM wallet for route context. Publishing halt alerts requires independent wallet authorization.'),
    toAddress: z.string().regex(EVM_ADDRESS).optional().describe('Optional EVM destination recipient. Defaults to the supplied wallet if present.'),
    protocol: z.enum(['lifi', 'relay']).optional().describe('Optional quoted-mode route provider, LI.FI or Relay.'),
    slippage: z.number().min(0.01).max(5).optional().describe('Quoted-mode tolerance in percentage points (0.5 means 0.5%).'),
    expectedUpsideUsd: z.number().optional().describe('Expected gross upside in USD for net-edge analysis.'),
    protocolFeeUsd: z.number().optional().describe('Estimated protocol fees in USD for a manual assessment.'),
    gasUsd: z.number().optional().describe('Estimated gas in USD for a manual assessment.'),
    bridgeFeeUsd: z.number().optional().describe('Estimated bridge fee in USD for a manual assessment.'),
    riskBufferUsd: z.number().optional().describe('Additional modeled risk cost in USD.'),
    enforcePositive: z.boolean().optional().describe('Treat nonpositive or unknown net edge as a blocking risk when supported by the selected mode.'),
    healthFactor: z.number().optional().describe('Current lending health factor as a ratio.'),
    liquidationBufferPct: z.number().optional().describe('Estimated headroom before liquidation in percentage points.'),
    safetyMode: z.enum(['strict', 'balanced']).optional().describe('Risk strictness mode for the quoted route assessment.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/risk-sentinel', { method: 'POST', body: JSON.stringify(params) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 5. FarmDash Futures Strategist (v2.3.0) */

server.tool(
  'scan_funding_rates',
  'Scan supported Hyperliquid perpetual markets for funding signals. Keyless Scout returns up to the top three arbOpportunities. Pioneer, Syndicate, or eligible per-call x402 adds the full opportunity list, highFunding, and timestamp. Rates are research evidence and do not establish executable arbitrage.',
  {},
  async () => {
    try {
      const data = await apiFetch('/v1/agent/futures/scan-funding');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'scan_market_conditions',
  'Read timestamped Hyperliquid technical indicators and a strategyHint for one supported perpetual market. Scout is eligible within route limits. HIP-3 namespaced markets are unsupported. A strategy hint conveys no trading authority.',
  {
    coin: z.string().describe('Hyperliquid native perpetual symbol, such as ETH. Omit any perp-DEX namespace.'),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams({ coin: params.coin });
      const data = await apiFetch(`/v1/agent/futures/market-conditions?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_futures_account',
  'Read Hyperliquid equity, margin, positions, and drawdown state with Pioneer, Syndicate, or eligible route x402 access. Identify the API signer and equity owner separately for delegated wallets. Hyperliquid verifies the venue relationship and ambiguous history fails closed. Daily and weekly values measure loss-pressure, a subset of performance evidence.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS).describe('Public EVM address of the direct signer or delegated Hyperliquid API wallet.'),
    accountAddress: z.string().regex(EVM_ADDRESS).optional().describe('Public EVM address of the master or subaccount owning the equity. Omit only for a direct signer.'),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams({ agentAddress: params.agentAddress });
      if (params.accountAddress) qs.set('accountAddress', params.accountAddress);
      const data = await apiFetch(`/v1/agent/futures/account-state?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'analyze_futures_strategy',
  'Analyze a supported Hyperliquid market against venue-verified account state. Returns strategy, simulation, and researchGate. Use an execution-ready gate within 60 seconds for new-risk preparation. Access follows Pioneer, Syndicate, or route-specific x402 and eligible trial terms. Bounded mode requires an active owner-signed grant. The call does not sign or submit orders.',
  {
    coin: z.string().describe('Hyperliquid native perpetual symbol, such as ETH. Namespaced HIP-3 symbols are unsupported.'),
    agentAddress: z.string().regex(EVM_ADDRESS).describe('Public EVM address of the direct signer or delegated Hyperliquid API wallet.'),
    accountAddress: z.string().regex(EVM_ADDRESS).optional().describe('Public EVM address of the master or subaccount owning the equity. Omit only for a direct signer.'),
    riskMultiplier: z.number().min(0.1).max(1).optional().describe('Scale the allowed risk from 0.1 to 1. Defaults to 1.'),
    idempotencyKey: z.string().regex(/^[\x21-\x7e]{1,128}$/).optional().describe('Compatibility wrapper field. Trial admission uses the route executionTrialId or Idempotency-Key header and may reject an MCP-only request.'),
    executionTrialProof: z.object({
      issuedAt: z.number().int().positive().describe('Unix milliseconds included in the commercial owner challenge.'),
      signature: z.string().min(1).describe('Signature over the commercial owner challenge. Never provide venue or wallet keys.'),
    }).optional().describe('Locally signed owner challenge for eligible commercial trial admission. Does not convey venue authority.'),
    executionMode: z.enum(['USER_SIGNED', 'BOUNDED_AUTONOMOUS']).optional().describe('USER_SIGNED by default. BOUNDED_AUTONOMOUS requires an active market-bound owner grant and venue relationship.'),
    grantId: z.string().optional().describe('Active owner-signed futures grant that permits this session, account, signer, and market.'),
    sessionId: z.string().optional().describe('Active FarmDash session ID bound to the futures grant.'),
    sessionToken: z.string().optional().describe('Private token for the matching FarmDash session in bounded mode.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/futures/analyze-strategy', { method: 'POST', sessionToken: params.sessionToken, body: JSON.stringify(params) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'calculate_position_size',
  'Calculate hypothetical Hyperliquid sizing, margin, leverage, and diagnostics from supplied equity and prices. The service caps leverage at 5x and risk at 2% of equity. Requires Pioneer, Syndicate, or eligible futures-strategy x402 subject to route terms. Sizing does not place an order or determine actual liquidation.',
  {
    equity: z.number().positive().describe('Total account equity in USD.'),
    entryPrice: z.number().positive().describe('Proposed entry price in USD per unit.'),
    stopPrice: z.number().positive().describe('Stop price in USD per unit, different from entry. Below entry implies long, above implies short.'),
    riskPercent: z.number().positive().optional().describe('Fraction of equity to risk. Use 0.01 for 1%. Defaults to the 2% cap before applying riskMultiplier.'),
    targetPrice: z.number().positive().optional().describe('Optional target price in USD per unit used for reward/risk diagnostics.'),
    riskMultiplier: z.number().min(0.1).max(1).optional().describe('Scale the requested fraction from 0.1 to 1. Defaults to 1.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/futures/position-sizing', { method: 'POST', body: JSON.stringify(params) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'prepare_perp_order',
  'Prepare an exact zero-custody Hyperliquid order for local EIP-712 signing. FarmDash returns the action, typed data, nonce, expiry and intent hash but never signs or submits. New-risk preparation requires a fresh execution-ready analysis; reduce-only preparation remains authority-bound at execution.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    accountAddress: z.string().regex(EVM_ADDRESS).optional(),
    coin: z.string(),
    isBuy: z.boolean(),
    size: z.string(),
    price: z.string(),
    orderType: z.enum(['limit_gtc', 'limit_ioc', 'limit_alo', 'market_ioc', 'stop_loss', 'take_profit']),
    reduceOnly: z.boolean().optional(),
    leverage: z.number().positive().max(5).optional(),
    nonce: z.number().int().positive().optional(),
    expiresAt: z.number().int().positive().optional(),
    executionMode: z.enum(['USER_SIGNED', 'BOUNDED_AUTONOMOUS']).default('USER_SIGNED'),
    executionTrialId: z.string().min(1).optional(),
    continuationId: z.string().uuid().optional(),
    grantId: z.string().optional(), sessionId: z.string().optional(), sessionToken: z.string().optional(),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/futures/prepare-order', {
    method: 'POST',
    body: JSON.stringify(params),
  })),
);

server.tool(
  'execute_perp_order',
  'USER_SIGNED requires fresh human approval. BOUNDED_AUTONOMOUS requires a valid owner-signed futures policy, authenticated session, and a local API-wallet signature on every action (operational with zero custody). Compatibility: submit a pre-signed EIP-712 Hyperliquid order after a 60-second parameter-bound research gate. `market_ioc` is a signed, price-protected IOC limit order with a live 100 bps adverse-price cap, never an unbounded market order; its outcome distinguishes full, partial, and zero fill, and an IOC resting response is unknown/inconsistent. For delegated API wallets, set accountAddress to the venue-verified equity owner used during analysis. FarmDash recovers the exact L1 signer, rejects an agentAddress mismatch, and preflights the owner maxBuilderFee. The signed action must disclose builder f=1 (0.1 bp/0.001% of filled notional), and expiresAt is venue-signed as expiresAfter. Venue nonce authority is network + signer + nonce across account/vault contexts; durable replay control fails closed before submission.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    accountAddress: z.string().regex(EVM_ADDRESS).optional(),
    coin: z.string(),
    isBuy: z.boolean(),
    size: z.string(),
    price: z.string(),
    orderType: z.enum(['limit_gtc', 'limit_ioc', 'limit_alo', 'market_ioc', 'stop_loss', 'take_profit']),
    signature: SIGNATURE_SCHEMA,
    reduceOnly: z.boolean().optional(),
    leverage: z.number().positive().optional(),
    signedAction: z.any().optional().describe('If supplied, must include the signed FarmDash builder term { b: treasury, f: 1 }; f is tenths of a basis point.'),
    executionTrialId: z.string().min(1).optional(),
    nonce: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    intentHash: z.string(),
    executionMode: z.enum(['USER_SIGNED', 'BOUNDED_AUTONOMOUS']).default('USER_SIGNED'),
    grantId: z.string().optional(), sessionId: z.string().optional(), sessionToken: z.string().optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/futures/execute-order', { method: 'POST', sessionToken: params.sessionToken, body: JSON.stringify(params) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'cancel_perp_order',
  'USER_SIGNED requires fresh human approval; BOUNDED_AUTONOMOUS requires futures.cancel scope, a valid owner-signed policy and authenticated session, but not unused entry budget. Local venue signatures are required in both modes. Cancel stale or resting Hyperliquid orders with a venue-signed expiresAfter and FarmDash intent hash. For a delegated API wallet, accountAddress identifies the verified equity owner and is included as the signed vault/subaccount routing address when required. `accepted` is an application acknowledgement, not final venue cancellation: reconcile every requested ID through /api/v1/agent/futures/reconcile-order before dependent actions. Mixed errors are partial rejection; malformed or timeout outcomes are unknown. Venue nonce authority is network + signer + nonce across account/vault contexts; durable replay control fails closed before submission.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    accountAddress: z.string().regex(EVM_ADDRESS).optional(),
    coin: z.string(),
    orderIds: z.array(z.number().int().positive()).min(1).max(50).refine(
      (orderIds) => new Set(orderIds).size === orderIds.length,
      'Duplicate order IDs are not allowed in a signed cancellation.',
    ),
    signature: SIGNATURE_SCHEMA,
    signedAction: z.any().optional(),
    nonce: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    intentHash: z.string(),
    executionMode: z.enum(['USER_SIGNED', 'BOUNDED_AUTONOMOUS']).default('USER_SIGNED'),
    grantId: z.string().optional(), sessionId: z.string().optional(), sessionToken: z.string().optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/futures/cancel-order', { method: 'POST', sessionToken: params.sessionToken, body: JSON.stringify(params) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'reconcile_perp_order',
  'Reconcile ONE Hyperliquid order from direct venue evidence (order status plus user fills) and record it durably. Signs nothing, submits nothing, and is idempotent: replaying it re-records the same evidence instead of double counting fills. Execution is never inferred from portfolio or balance deltas. Call this after any order whose final state is unknown, and after cancel_perp_order reports accepted.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS).describe('Recovered/verified L1 signer address that owns the order context.'),
    coin: z.string().regex(/^[A-Za-z0-9]{1,16}$/).describe('Hyperliquid market symbol, for example ETH.'),
    orderId: z.number().int().positive().describe('Venue order id to reconcile. Reconcile one order id at a time.'),
    accountAddress: z.string().regex(EVM_ADDRESS).optional().describe('Venue-verified equity owner (master/subaccount) when agentAddress is a delegated API wallet.'),
    intentHash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Optional lowercase 32-byte hex intent hash from the original preparation, when known.'),
    controlActionId: z.string().uuid().optional().describe('Optional control-action id when reconciling a cancellation or protective order.'),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/futures/reconcile-order', {
    method: 'POST',
    body: JSON.stringify(params),
  })),
);

server.tool(
  'get_agent_performance',
  'Review FarmDash-recorded fee activity, protocol diversity, and reputation for an EVM address. Scout returns a bounded preview. Full results use the address associated with the paid credential when bound. This report does not establish fills, realized PnL, win rate, or slippage.',
  { agentAddress: z.string().regex(EVM_ADDRESS).describe('0x-prefixed EVM address whose FarmDash fee activity to inspect.') },
  async (params) => {
    try {
      const qs = new URLSearchParams({ address: params.agentAddress });
      const data = await apiFetch(`/v1/agent/performance?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 6. FarmDash Camp Guard (v1.0.0) */

server.tool(
  'audit_allowance_risk',
  'Review caller-supplied ERC-20 allowances for unlimited, unverified, insufficient, or disproportionate approvals. Returns verdict, flags, and requiresUserConfirmation within route capacity. It does not revoke approvals or read live allowances. A halt can publish an authorized risk alert.',
  {
    walletAddress: z.string().regex(EVM_ADDRESS).optional().describe('Optional public EVM wallet for context. Halt alerts require separate wallet authorization.'),
    allowances: z.array(z.object({
      token: z.string().optional().describe('ERC-20 token contract address.'),
      spender: z.string().optional().describe('EVM address entitled to spend the allowance.'),
      allowance: z.string().optional().describe('Observed allowance as an integer string in token base units.'),
      requiredAmount: z.string().optional().describe('Positive intended spend as an integer string in the same base units.'),
      amountUsd: z.number().optional().describe('Estimated USD value of the approval exposure.'),
      spenderVerified: z.boolean().optional().describe('True only after independent verification against the protocol canonical deployment.'),
    })).optional().describe('Approval observations supplied by the caller. Populate each row with token, spender, allowance, and requiredAmount for a usable review.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/camp-guard', {
        method: 'POST',
        body: JSON.stringify({ action: 'allowance_review', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'simulate_transaction_risk',
  'Check unsigned EVM calldata, target, native value, and chain against Camp Guard policy within route capacity. Provide independently captured expectedTransaction to detect substitution. Returns verdict, flags, and simulation.status=not_run. Run RPC simulation in the signing environment before broadcast. A halt can publish an authorized risk alert.',
  {
    walletAddress: z.string().regex(EVM_ADDRESS).optional().describe('Optional public EVM wallet for context. Halt alerts require separate wallet authorization.'),
    transaction: z.object({
      to: z.string().describe('Target EVM contract or recipient.'),
      data: z.string().describe('0x-prefixed calldata. Use 0x for a plain native transfer.'),
      value: z.string().optional().describe('Native value in base units, encoded as a decimal integer or 0x-prefixed hexadecimal string.'),
      chainId: z.number().int().positive().optional().describe('Numeric EVM network ID. Supply it for meaningful chain validation.'),
    }).describe('Unsigned EVM payload proposed for local signing.'),
    expectedTransaction: z.object({
      to: z.string().regex(EVM_ADDRESS).describe('Target EVM contract or recipient.'),
      chainId: z.number().int().positive().describe('Numeric EVM network ID. Supply it for meaningful chain validation.'),
      value: z.string().regex(/^(?:[0-9]+|0x[0-9a-fA-F]+)$/).optional().describe('Native value in base units, encoded as a decimal integer or 0x-prefixed hexadecimal string.'),
      dataHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe('SHA-256 of lowercase UTF-8 transaction.data (0x...) or of its decoded calldata bytes, formatted as 0x + 64 hex chars.'),
    }).optional().describe('Independent expected values captured before preparation. Do not derive them from the transaction under review.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/camp-guard', {
        method: 'POST',
        body: JSON.stringify({ action: 'transaction_policy', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 7. FarmDash Supply Master (v1.0.0) */

server.tool(
  'compare_yields',
  'Research: compare DeFi yield pools by APY, TVL depth, stablecoin exposure, IL risk, and sustainability score.',
  {
    chains: z.array(z.string().max(128)).max(50).optional(),
    assets: z.array(z.string().max(128)).max(50).optional(),
    projects: z.array(z.string().max(128)).max(50).optional(),
    riskPreference: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
    minTvlUsd: z.number().positive().optional(),
    stableOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/supply', {
        method: 'POST',
        body: JSON.stringify({ action: 'compare_yields', ...params }),
        timeout: 20_000,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 8. FarmDash Hedge Warden (v1.0.0) */

server.tool(
  'recommend_delta_hedge',
  'Recommend short-perp hedge notionals for spot farming exposure. Produces a handoff only; it does not execute.',
  {
    spotExposure: z.array(z.object({
      asset: z.string(),
      notionalUsd: z.number().positive(),
      beta: z.number().positive().optional(),
      confidence: z.number().min(0).max(1).optional(),
    })).min(1),
    riskPreference: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
    volatilityRegime: z.enum(['low', 'normal', 'high']).optional(),
    marketConditions: z.any().optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/hedge', {
        method: 'POST',
        body: JSON.stringify({ action: 'recommend_delta_hedge', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 9. FarmDash Ledger Keeper (v1.0.0) */

server.tool(
  'ledger_realized_pnl',
  'Read recorded FarmDash spot and futures activity and costs for an authorized EVM agent. Requires Pioneer-equivalent route access plus a wallet-bound API key or matching active session. Returns a summary, up to 20 recent events per lane, and warnings. Contains no realized P&L. Only confirmed settlement counts as confirmed.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS).describe('0x-prefixed EVM agent address bound to the API key or matching session.'),
    start: z.string().optional().describe('Inclusive ISO 8601 range start. Defaults to 30 days before now.'),
    end: z.string().optional().describe('Inclusive ISO 8601 range end. Defaults to now.'),
    sessionId: z.string().min(1).optional().describe('Active FarmDash session ID when authenticating without a wallet-bound API key.'),
    sessionToken: z.string().min(1).optional().describe('Active FarmDash session token proving ownership of agentAddress when authenticating without a wallet-bound API key.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/ledger', {
        method: 'POST',
        body: JSON.stringify({ action: 'realized_pnl', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ledger_tax_export',
  'Export recorded spot execution rows as CSV with row count and accounting warnings. Requires Pioneer-equivalent route access plus a wallet-bound API key or matching active session. Futures tax lots require venue fills outside this export.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS).describe('0x-prefixed EVM agent address bound to the API key or matching session.'),
    start: z.string().optional().describe('Inclusive ISO 8601 range start. Defaults to 30 days before now.'),
    end: z.string().optional().describe('Inclusive ISO 8601 range end. Defaults to now.'),
    sessionId: z.string().min(1).optional().describe('Active FarmDash session ID when authenticating without a wallet-bound API key.'),
    sessionToken: z.string().min(1).optional().describe('Active FarmDash session token proving ownership of agentAddress when authenticating without a wallet-bound API key.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/ledger', {
        method: 'POST',
        body: JSON.stringify({ action: 'tax_export', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 10. Autonomous Operator (Universal) */

server.tool(
  'agent_onboard',
  'First-run contract: fetch live feature readiness, tier gates, error semantics, execution-mode selection (USER_SIGNED default vs opt-in BOUNDED_AUTONOMOUS), and the onboarding capability map before selecting tools. Before entering any wallet-changing execution workflow, query current execution authority with get_execution_authority for the active persisted FarmDash session: if an active valid bounded delegation already exists for that session, report its policy bounds instead of re-prompting; a different/new agentSessionId does not inherit another session’s grant and remains USER_SIGNED (Standard FarmDash), and you must explicitly obtain user choice/consent before requesting a one-time scoped delegation for BOUNDED_AUTONOMOUS (Autonomous FarmDash, EOA_V1_OWNER_LOCAL_SIGNER where sessionPublicKey == ownerAddress). This never enables execution. Takes no parameters.',
  {},
  async () => {
    try {
      const [status, onboarding] = await Promise.all([
        apiFetch('/v1/agent/status'),
        apiFetch('/v1/agent/onboard'),
      ]);
      const onboardingRecord = asRecord(onboarding);
      const executionModeSelection =
        onboardingRecord.execution_mode_selection ?? MCP_EXECUTION_MODE_SELECTION;
      const data = {
        ok: true,
        first_run_contract: '/api/v1/agent/status',
        instruction:
          'Select only tools whose backing feature and deployment prerequisites are available. Do not infer execution capability from tool registration. Before entering any wallet-changing execution workflow: (1) query current execution authority via get_execution_authority for the active persisted FarmDash session; (2) if an active valid bounded delegation already exists for that persisted session, discover and report its policy bounds rather than repeatedly asking the user (a bounded EVM grant remains scoped to its agentSessionId — a different or new agentSessionId does not inherit another session’s grant and remains USER_SIGNED / CREATE_DELEGATION); (3) if no bounded delegation exists for the current session, USER_SIGNED (Standard FarmDash) remains the default; (4) explain that the user can alternatively sign one bounded delegation to enable ongoing autonomous operation ("Sign once and let your agent operate autonomously within the limits you set.") bounded by chains, protocols/router contracts, assets, allowed actions, per-action value, cumulative budget, gas, slippage, validity/expiry, and revocation, where operational EOA V1 (current_signer_model: EOA_V1_OWNER_LOCAL_SIGNER, separate_session_signer_supported: false) requires sessionPublicKey == ownerAddress with the authorized owner EOA signing in the customer’s local agent runtime, FarmDash never receives or stores the private key, and separate delegated session-key signers belong to the not-yet-operational smart-account/ERC-4337 path; (5) before creating that delegation, explicitly obtain user choice/consent — never infer BOUNDED_AUTONOMOUS consent from an API key, subscription payment, x402 payment, session creation, prior FarmDash usage, optimization request, position monitoring request, or generic "do this for me" instruction.',
        execution_mode_selection: executionModeSelection,
        status,
        onboarding,
      };
      return textResult(data);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  'create_session',
  'Create a persistent agent session. Normal callers must include a fresh EIP-712 or EIP-191 session signature. Returns a one-time sessionToken. Tier: Pioneer+ (Scout callers receive HTTP 402 payment_required).',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    agentName: z.string().optional(),
    signature: z.string().min(1).optional(),
    nonce: z.string().min(1).optional(),
    issuedAt: z.string().datetime().optional(),
    signatureType: z.enum(['eip712', 'eip191']).optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/session', {
        method: 'POST',
        body: JSON.stringify({
          action: 'create',
          agentAddress: params.agentAddress,
          agentMeta: params.agentName ? { name: params.agentName } : undefined,
          signature: params.signature,
          nonce: params.nonce,
          issuedAt: params.issuedAt,
          signatureType: params.signatureType,
        }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'session_heartbeat',
  'Keep an agent session alive. Extends expiry by 24h.',
  { sessionId: z.string(), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string() },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/session', {
        method: 'POST',
        sessionToken: params.sessionToken,
        body: JSON.stringify({ action: 'heartbeat', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_farming_context',
  'Read the shared FarmingContext for a live agent session.',
  { sessionId: z.string(), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string() },
  async (params) => {
    try {
      const qs = new URLSearchParams({
        sessionId: params.sessionId,
        agentAddress: params.agentAddress,
      });
      const data = await apiFetch(`/v1/agent/context?${qs}`, {
        sessionToken: params.sessionToken,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'patch_farming_context',
  'Patch the shared FarmingContext for a live agent session. Server controls revision, sessionId, and agentAddress.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    patch: z.record(z.string(), z.any()),
  },
  async (params) => {
    try {
      const { sessionToken, ...patchParams } = params;
      const data = await apiFetch('/v1/agent/context', {
        method: 'POST',
        sessionToken,
        body: JSON.stringify(patchParams),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_event_stream_snapshot',
  'Observe: read a JSON snapshot from the agent event stream for a live session.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    since: z.string().optional(),
    types: z.array(z.string().max(128)).max(50).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams({
        sessionId: params.sessionId,
        agentAddress: params.agentAddress,
        format: 'json',
        once: 'true',
      });
      if (params.since) qs.set('since', params.since);
      if (params.types?.length) qs.set('types', params.types.join(','));
      if (params.limit) qs.set('limit', params.limit.toString());
      const data = await apiFetch(`/v1/agent/stream?${qs}`, {
        sessionToken: params.sessionToken,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'verify_delegation',
  'Verify Hyperliquid API wallet delegation for guarded venue-order workflows. Verification does not bypass live status, research, risk, or signature gates. GATED BY DESIGN: this MCP tool is hard-blocked because MCP cannot collect the owner signature inputs it needs - the call requires an EIP-712 DelegationBind signature over { ownerAddress, agentAddress, apiWalletAddress, nonce }, and the MCP schema carries only the three addresses. The HTTP route POST /api/v1/agent/delegation exists and accepts { agentAddress, apiWalletAddress, ownerAddress, signature, nonce } - use owner-signed delegation via HTTP instead. Tier: Syndicate.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    apiWalletAddress: z.string().regex(EVM_ADDRESS),
    ownerAddress: z.string().regex(EVM_ADDRESS),
  },
  async (params) => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          error: 'unavailable_mcp_signature_inputs',
          code: 'unavailable_mcp_signature_inputs',
          retryable: false,
          message: 'verify_delegation is hard-blocked in MCP because this schema cannot collect the owner EIP-712 DelegationBind signature and fresh nonce required by POST /api/v1/agent/delegation. Use owner-signed delegation via HTTP instead (Syndicate tier required).',
          alternative: {
            method: 'POST',
            endpoint: '/api/v1/agent/delegation',
            api_route: '/v1/agent/delegation',
            required_tier: 'syndicate',
            required_fields: ['agentAddress', 'apiWalletAddress', 'ownerAddress', 'signature', 'nonce'],
            supplied_addresses: {
              agentAddress: params.agentAddress,
              apiWalletAddress: params.apiWalletAddress,
              ownerAddress: params.ownerAddress,
            },
          },
        }, null, 2),
      }],
      isError: true,
    };
  },
);

server.tool(
  'configure_autopilot',
  'Configure autopilot strategies, assets, and risk parameters.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    strategies: z.array(z.string().max(128)).max(50),
    assets: z.array(z.string().max(128)).max(50),
    riskPreference: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
    maxEquityPct: z.number().positive().max(0.8).optional(),
    rebalanceIntervalMin: z.number().int().positive().optional(),
    autoCompound: z.boolean().optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        sessionToken: params.sessionToken,
        body: JSON.stringify({
          action: 'configure',
          sessionId: params.sessionId,
          agentAddress: params.agentAddress,
          config: {
            strategies: params.strategies,
            assets: params.assets,
            riskPreference: params.riskPreference,
            maxEquityPct: params.maxEquityPct,
            rebalanceIntervalMin: params.rebalanceIntervalMin,
            autoCompound: params.autoCompound,
          },
        }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'autopilot_cycle',
  'Run one authenticated autopilot cycle. Returns recommended actions.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    accountState: z.any().optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', { method: 'POST', body: JSON.stringify({ action: 'cycle', ...params }) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'pause_autopilot',
  'Pause the backend cycle scheduler for an active agent session. This does not close positions, revoke venue authority, or prove chain-state changes.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        body: JSON.stringify({ action: 'pause', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'resume_autopilot',
  'Resume the backend cycle scheduler for a paused agent session. Recommendations remain separately gated from transaction execution.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        body: JSON.stringify({ action: 'resume_autopilot', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'grant_session_key',
  'Register a signed, bounded ERC-4337 session-key grant. Registration is not execution; server-side UserOperation submission remains preparation-only.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    ownerAddress: z.string().regex(EVM_ADDRESS),
    sessionPublicKey: z.string(),
    validAfter: z.string().describe('ISO timestamp'),
    validUntil: z.string().describe('ISO timestamp'),
    allowedProtocols: z.array(z.string().max(128)).max(50),
    allowedAssets: z.array(z.string().max(128)).max(50),
    maxValuePerTx: z.number(),
    maxTotalValue: z.number(),
    chainId: z.number(),
    nonce: z.string(),
    signature: z.string().regex(HEX_SIGNATURE),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        body: JSON.stringify({ action: 'grant_session_key', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'revoke_session_key',
  'Revoke any active session key grants for this agent session.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    ownerAddress: z.string().regex(EVM_ADDRESS).optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        body: JSON.stringify({ action: 'revoke_session_key', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'session_key_status',
  'Check the active session key grant and autonomous execution status.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    ownerAddress: z.string().regex(EVM_ADDRESS).optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        body: JSON.stringify({ action: 'session_key_status', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_execution_authority',
  'Query execution authority configuration (USER_SIGNED vs BOUNDED_AUTONOMOUS), zero-custody confirmation, and active delegation status.',
  {
    executionDomain: z.enum(['spot', 'futures']).default('spot'),
    sessionToken: z.string().optional(),
    ownerAddress: z.string().regex(EVM_ADDRESS).optional().describe('Wallet owner EVM address'),
    sessionId: z.string().optional().describe('Agent session identifier; required for futures'),
    grantId: z.string().optional(),
  },
  async (params) => {
    try {
      const query = new URLSearchParams();
      if (params.ownerAddress) query.set('ownerAddress', params.ownerAddress);
      if (params.sessionId) query.set('sessionId', params.sessionId);
      const data = params.executionDomain === 'futures'
        ? await apiFetch('/v1/agent/authority', { method: 'POST', sessionToken: params.sessionToken, body: JSON.stringify({ action: 'get_futures_authority', sessionId: params.sessionId, grantId: params.grantId }) })
        : await apiFetch(query.size ? `/v1/agent/authority?${query.toString()}` : '/v1/agent/authority');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'request_execution_delegation',
  'Request an exact EIP-712 / ERC-8196 bounded delegation payload for user wallet approval. The user signs one scoped delegation so their agent runtime can execute within those bounds.',
  {
    executionDomain: z.enum(['spot', 'futures']).default('spot'),
    sessionToken: z.string().optional(),
    policy: FuturesPolicySchema.optional().describe('Exact owner-signed futures policy when executionDomain=futures'),
    ownerAddress: z.string().regex(EVM_ADDRESS).optional().describe('User wallet owner address'),
    agentSessionId: z.string().optional().describe('Agent session identifier'),
    sessionPublicKey: z.string().optional().describe('Public key / address of the agent local signer'),
    chainId: z.number().int().positive().optional().describe('EVM Chain ID'),
    allowedProtocols: z.array(z.string().max(128)).max(50).optional().describe('Allowlisted protocol router addresses'),
    allowedAssets: z.array(z.string().max(128)).max(50).optional().describe('Allowlisted token addresses'),
    allowedActions: z.array(z.string().max(128)).max(50).optional().describe('Allowed action types, e.g. ["SWAP"]'),
    maxValuePerTx: z.number().positive().optional().describe('Maximum value per transaction in USD'),
    maxTotalValue: z.number().positive().optional().describe('Maximum total cumulative spend in USD'),
    maxGasUsd: z.number().positive().optional().describe('Maximum gas in USD'),
    maxValuePerTxCents: z.number().int().positive().optional().describe('Deprecated legacy alias: Maximum value per transaction in cents'),
    maxTotalValueCents: z.number().int().positive().optional().describe('Deprecated legacy alias: Maximum total cumulative spend in cents'),
    maxGasUsdCents: z.number().int().positive().optional().describe('Deprecated legacy alias: Maximum gas in cents'),
    maxSlippageBps: z.number().int().positive().optional().describe('Maximum allowed slippage in basis points'),
    validAfter: z.string().optional().describe('ISO timestamp for grant validity start'),
    validUntil: z.string().optional().describe('ISO timestamp for grant validity expiration'),
  },
  async (params) => {
    try {
      const body: Record<string, unknown> = params.executionDomain === 'futures'
        ? { action: 'request_futures_policy', policy: params.policy }
        : { ...params, action: 'request_delegation' };
      if (body.maxValuePerTx === undefined && typeof body.maxValuePerTxCents === 'number') {
        body.maxValuePerTx = body.maxValuePerTxCents / 100;
      }
      if (body.maxTotalValue === undefined && typeof body.maxTotalValueCents === 'number') {
        body.maxTotalValue = body.maxTotalValueCents / 100;
      }
      if (body.maxGasUsd === undefined && typeof body.maxGasUsdCents === 'number') {
        body.maxGasUsd = body.maxGasUsdCents / 100;
      }
      const data = await apiFetch('/v1/agent/authority', {
        method: 'POST',
        sessionToken: params.sessionToken,
        body: JSON.stringify(body),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'register_execution_delegation',
  'Register a user-signed bounded delegation grant. The agent runtime gains bounded autonomous execution authority within signed policy limits.',
  {
    executionDomain: z.enum(['spot', 'futures']).default('spot'),
    sessionToken: z.string().optional(),
    policy: FuturesPolicySchema.optional(),
    ownerAddress: z.string().regex(EVM_ADDRESS).optional().describe('User wallet owner address'),
    signature: z.string().regex(HEX_SIGNATURE).describe('EIP-712 signature over bounded delegation typed data'),
    delegation: z.object({
      ownerAddress: z.string().regex(EVM_ADDRESS),
      agentSessionId: z.string(),
      sessionPublicKey: z.string(),
      chainId: z.number(),
      allowedProtocols: z.array(z.string().max(128)).max(50),
      allowedAssets: z.array(z.string().max(128)).max(50),
      allowedActions: z.array(z.string().max(128)).max(50),
      maxValuePerTx: z.number(),
      maxTotalValue: z.number(),
      maxGasUsd: z.number().optional(),
      maxSlippageBps: z.number().optional(),
      validAfter: z.string(),
      validUntil: z.string(),
      nonce: z.string(),
      policyHash: z.string().optional(),
    }).optional().describe('The exact spot delegation parameters that were signed'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/authority', {
        method: 'POST',
        sessionToken: params.sessionToken,
        body: JSON.stringify(params.executionDomain === 'futures' ? { action: 'register_futures_policy', policy: params.policy, signature: params.signature } : { ...params, action: 'register_delegation' }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'revoke_execution_authority',
  'Revoke active bounded execution authority for an owner or agent session.',
  {
    executionDomain: z.enum(['spot', 'futures']).default('spot'),
    sessionToken: z.string().optional(),
    grantId: z.string().describe('ID of the grant to revoke'),
    sessionId: z.string().optional(),
    ownerAddress: z.string().regex(EVM_ADDRESS).optional().describe('Wallet owner address'),
    agentSessionId: z.string().optional().describe('Agent session identifier'),
    reason: z.string().optional().describe('Reason for revocation'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/authority', {
        method: 'POST',
        sessionToken: params.sessionToken,
        body: JSON.stringify(params.executionDomain === 'futures' ? { action: 'revoke_futures_policy', sessionId: params.sessionId ?? params.agentSessionId, grantId: params.grantId } : { ...params, action: 'revoke' }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'prepare_autonomous_swap',
  'Prepare an autonomous spot swap within signed delegation bounds from authoritative quote and simulation records. FarmDash verifies 13 policy invariants, locks an atomic budget reservation, and computes the locked calldata digest. The agent signs and broadcasts in its local runtime.',
  {
    intentId: z.string().describe('Authoritative swap intent ID from get_swap_quote'),
    simulationId: z.string().describe('Authoritative preflight simulation ID from simulate_swap_intent'),
    agentSessionId: z.string().describe('Authenticated agent session ID'),
    sessionToken: z.string().min(32).max(256).optional(),
    ownerAddress: z.string().regex(EVM_ADDRESS).describe('Wallet owner EVM address'),
    sessionPublicKey: z.string().describe('Agent local signer public address (must equal ownerAddress for EOA V1)'),
    grantId: z.string().optional().describe('Active delegation grant ID (optional; looked up automatically if omitted)'),
    fromToken: z.string().optional().describe('Optional input token symbol or address'),
    toToken: z.string().optional().describe('Optional output token symbol or address'),
    amount: z.string().optional().describe('Optional input amount in token base units'),
    chainId: z.number().int().positive().optional().describe('Optional EVM Chain ID'),
    slippageBps: z.number().int().min(1).max(500).optional().describe('Optional slippage tolerance in basis points'),
    action: z.string().optional().default('SWAP').describe('Action type, defaults to SWAP'),
    protocol: z.string().optional().describe('Target protocol router address'),
  },
  async (params) => {
    try {
      const { action: swapAction, sessionToken, ...swapParams } = params;
      const data = await apiFetch('/v1/agent/authority', {
        method: 'POST',
        body: JSON.stringify({ action: 'prepare_autonomous_swap', swapAction, ...swapParams }),
        sessionToken,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'confirm_autonomous_swap',
  'Submit on-chain transaction hash for independent RPC receipt verification and economic reconciliation.',
  {
    reservationId: z.string().describe('Active reservation ID from prepare_autonomous_swap'),
    txHash: z.string().describe('On-chain transaction hash for public RPC receipt verification'),
    agentSessionId: z.string().describe('Authenticated agent session ID'),
    sessionToken: z.string().min(32).max(256).optional(),
    ownerAddress: z.string().regex(EVM_ADDRESS).optional().describe('Wallet owner EVM address'),
    grantId: z.string().optional().describe('Grant ID'),
    intentId: z.string().optional().describe('Intent ID'),
    status: z.enum(['confirmed', 'failed', 'ambiguous']).optional().describe('Optional client execution status hint'),
    errorReason: z.string().optional().describe('Error reason if execution failed or was ambiguous'),
  },
  async (params) => {
    try {
      const { sessionToken, ...confirmParams } = params;
      const data = await apiFetch('/v1/agent/authority', {
        method: 'POST',
        body: JSON.stringify({ action: 'confirm_autonomous_swap', ...confirmParams }),
        sessionToken,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'release_autonomous_reservation',
  'Release an active autonomous budget reservation if signing or broadcast is aborted before on-chain submission.',
  {
    sessionId: z.string().describe('Authenticated agent session ID'),
    sessionToken: z.string().min(32).max(256).optional(),
    reservationId: z.string().describe('Active budget reservation ID to release'),
    ownerAddress: z.string().regex(EVM_ADDRESS).describe('User wallet owner address'),
    reason: z.string().optional().describe('Reason for aborting or releasing reservation'),
  },
  async (params) => {
    try {
      const { sessionToken, ...releaseParams } = params;
      const data = await apiFetch('/v1/agent/authority', {
        method: 'POST',
        body: JSON.stringify({ action: 'release_autonomous_reservation', ...releaseParams }),
        sessionToken,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_cycle_status',
  'Poll the status of an asynchronous autopilot cycle job.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    jobId: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        body: JSON.stringify({ action: 'cycle_status', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'execute_cycle_actions',
  'Inspect the cycle execution gate. Server-side ERC-4337 action submission is preview-only and returns autonomous_execution_preview_only until real calldata, session signatures, and bundler verification ship.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    jobId: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        body: JSON.stringify({ action: 'cycle_execute', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);
server.tool(
  'create_mee_intent',
  'Create a preparation-only MEE-shaped cross-chain intent bundle. Creation is not authoritative simulation, submission, or settlement.',
  {
    ownerAddress: z.string().regex(EVM_ADDRESS),
    steps: z.array(
      z.object({
        chainId: z.number(),
        targetProtocol: z.string(),
        action: z.string(),
        params: z.record(z.string(), z.any()),
        estimatedGasUsd: z.number().optional(),
      }),
    ),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/mee', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'simulate_mee_intent',
  'Preview declared-input cross-chain economics for a MEE-shaped intent. The result is non-authoritative and cannot be submitted while the coordinator gate is disabled.',
  {
    id: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/mee', {
        method: 'POST',
        body: JSON.stringify({ action: 'simulate', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'submit_mee_intent',
  'Capability probe for MEE submission. Currently returns typed feature_not_ready until a production coordinator and authoritative cross-chain receipt verifier are deployed.',
  {
    id: z.string(),
    signature: z.string().regex(HEX_SIGNATURE),
    nonce: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/mee', {
        method: 'POST',
        body: JSON.stringify({ action: 'submit', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_mee_intent_status',
  'Read the preparation status of a MEE-shaped intent. Created or simulated state is not proof of submission or settlement.',
  {
    id: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/mee', {
        method: 'POST',
        body: JSON.stringify({ action: 'status', ...params }),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 11. Protocol Risk Analyzer (v1.0.0) */

server.tool(
  'analyze_protocol_risk',
  'Assess a catalog protocol with DeFiLlama TVL, concentration, momentum, diversification, and optional historical trends. Requires Pioneer or equivalent route access. Returns riskGrade, riskScore, signals, and evidence-labeled onChainData. An unresolved upstream identity returns unknown risk with catalog evidence only. Unavailable observations remain null.',
  {
    protocolId: z.string().describe('Exact FarmDash catalog protocol ID, such as hyperliquid or etherfi.'),
    includeHistorical: z.boolean().optional().describe('Include the 30-day TVL trend when available. Defaults to true.'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/protocol-risk', {
        method: 'POST',
        body: JSON.stringify({
          protocolId: params.protocolId,
          includeHistorical: params.includeHistorical ?? true,
        }),
        timeout: 20_000,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 12. Yield Strategy Simulator (v1.0.0) */

server.tool(
  'simulate_yield_strategy',
  'Read-only independent yield alternatives with exact pool, chain and asset identities. Missing rates/costs remain null; hypothetical yields and rewards never enter observed totals. Returns WAIT analysis-only until wallet, policy, route, freshness and all-in economics are verified.',
  {
    capitalUsd: z.number().positive().describe('Total capital to allocate in USD'),
    riskPreference: z.enum(['conservative', 'balanced', 'aggressive']).optional().describe('Risk tolerance (default: balanced)'),
    timeHorizonDays: z.number().int().min(7).max(365).optional().describe('Simulation horizon in days (default: 90)'),
    protocols: z.array(z.string().max(128)).max(50).optional().describe('Specific protocol IDs to investigate'),
    poolIdentities: z.array(z.object({ protocolId: z.string(), poolId: z.string(), chain: z.string(), assetAddresses: z.array(z.string()).min(1) })).optional().describe('Exact upstream chain, pool ID and underlying asset addresses'),
    costs: z.object({ gas: z.number().nonnegative().nullable().optional(), slippage: z.number().nonnegative().nullable().optional(), bridge: z.number().nonnegative().nullable().optional(), exit: z.number().nonnegative().nullable().optional(), platform: z.number().nonnegative().nullable().optional(), subscription: z.number().nonnegative().nullable().optional(), perCall: z.number().nonnegative().nullable().optional() }).optional().describe('Editable scenario costs in USD; missing mandatory costs force WAIT'),
    stayPutApy: z.number().nonnegative().optional().describe('Editable stay-put baseline APY assumption'),
    scenarioApy: z.record(z.string(), z.number().nonnegative()).optional().describe('Editable APY assumptions by protocol; excluded from observed yield'),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/simulate-yield', {
        method: 'POST',
        body: JSON.stringify({
          capitalUsd: params.capitalUsd,
          riskPreference: params.riskPreference ?? 'balanced',
          timeHorizonDays: params.timeHorizonDays ?? 90,
          protocols: params.protocols ?? [],
          poolIdentities: params.poolIdentities, costs: params.costs, stayPutApy: params.stayPutApy, scenarioApy: params.scenarioApy,
        }),
        timeout: 25_000,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* 13. Trail Heat Query (v1.0.0) */

server.tool(
  'query_trail_heat',
  'DISCOVERY HEURISTIC query (NOT canonical Trail Heat): filter/sort/paginate the catalog editorial heuristic scores. Scores share the directory and export discovery_snapshot contract (catalog-editorial-v2), with campaign evidence and unknown source freshness. For quantitative DeFiLlama-backed scores use get_trail_heat.',
  {
    minScore: z.number().int().min(0).max(100).optional().describe('Minimum heuristic score (0-100)'),
    maxScore: z.number().int().min(0).max(100).optional().describe('Maximum heuristic score (0-100)'),
    status: z.enum(['Confirmed Airdrop', 'Points Program', 'Speculative', 'Completed']).optional().describe('Filter by protocol status'),
    category: z.string().optional().describe('Filter by category (e.g. Perps, Dex, Lending, L2, Restaking)'),
    chain: z.string().optional().describe('Filter by chain name (e.g. Ethereum, Arbitrum, Solana)'),
    hot: z.boolean().optional().describe('Only hot/trending protocols'),
    sortBy: z.enum(['score', 'tvl', 'name', 'change7d']).optional().describe('Sort field (default: discovery heuristic score)'),
    sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort order (default: desc)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results per page (default: 25)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset (default: 0)'),
  },
  async (params) => {
    try {
      const qs = new URLSearchParams();
      if (params.minScore !== undefined) qs.set('minScore', params.minScore.toString());
      if (params.maxScore !== undefined) qs.set('maxScore', params.maxScore.toString());
      if (params.status) qs.set('status', params.status);
      if (params.category) qs.set('category', params.category);
      if (params.chain) qs.set('chain', params.chain);
      if (params.hot !== undefined) qs.set('hot', params.hot.toString());
      if (params.sortBy) qs.set('sortBy', params.sortBy);
      if (params.sortOrder) qs.set('sortOrder', params.sortOrder);
      if (params.limit !== undefined) qs.set('limit', params.limit.toString());
      if (params.offset !== undefined) qs.set('offset', params.offset.toString());
      const data = await apiFetch(`/v1/agent/trail-heat-query?${qs}`);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err), null, 2) }],
        isError: true,
      };
    }
  },
);

/* ── Guided workflow prompts (Batch 21 §4c) ──────────────────────────────
   Prompts are client-invoked runbooks. They carry no authority and execute no
   tool: they only name the canonical order of operations and the gates that
   each step must satisfy. Every financial action still requires its own
   signature, simulation, session, policy and reconciliation evidence. */

const PROMPT_MESSAGE = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

server.registerPrompt('spot-swap-runbook', {
  title: 'FarmDash spot swap runbook (zero custody)',
  description: 'Deterministic EVM or Solana swap sequence with the simulation, signing and settlement gates named in order. Read-only guidance; grants no authority.',
  argsSchema: {
    chain: z.string().optional().describe('EVM chain id, or "solana" for the native Solana path.'),
    fromToken: z.string().optional().describe('Input token symbol, address or Solana mint.'),
    toToken: z.string().optional().describe('Output token symbol, address or Solana mint.'),
    amount: z.string().optional().describe('Human amount for context only; tool calls require base units.'),
  },
}, (args) => {
  const evm = (args.chain ?? '').toLowerCase() !== 'solana';
  const context = [args.chain ? `chain=${args.chain}` : null, args.fromToken ? `from=${args.fromToken}` : null, args.toToken ? `to=${args.toToken}` : null, args.amount ? `amount=${args.amount}` : null].filter(Boolean).join(' ');
  return PROMPT_MESSAGE([
    `Help me execute one FarmDash spot swap${context ? ` (${context})` : ''}. Follow this exact order and stop at the first failed gate.`,
    '',
    '0. Read farmdash://status and farmdash://chains first. Do not infer readiness from tool availability.',
    evm
      ? '1. Research: get_swap_quote WITHOUT idempotencyKey returns a provider-neutral market estimate and makes zero provider calls. It is not executable.'
      : '1. Research: get_solana_quote returns a Jupiter preview. It is explicitly non-authoritative and never executable through the EVM path.',
    evm
      ? '2. Firm quote: call get_swap_quote WITH idempotencyKey plus a real walletAddress/toAddress and slippage. Keep BOTH ids: top-level intentId (qi_* cache/idempotency identity) and simulationRequirements.intent_id (fd_intent_* simulation identity). Never swap them.'
      : '2. Prepare: call prepare_solana_swap with a stable idempotencyKey and Base58 wallet/mints. It returns an unsigned VersionedTransaction and stops at READY_FOR_USER_SIGNATURE.',
    evm
      ? '3. Simulate: simulate_swap_execution with the fd_intent_* id. Preparation is blocked without a successful, unexpired simulation.'
      : '3. Sign locally: my wallet signs the returned VersionedTransaction. FarmDash never signs and never holds keys.',
    evm
      ? '4. Sign locally: build the EIP-191 payload v1:FARMDASH_SWAP:{fromChainId}:{toChainId}:{fromToken}:{toToken}:{fromAmount}:{agentAddress}:{toAddress}:{nonce} with EVERY 0x-prefixed field lowercased, including token addresses. Nonce is Unix ms and must be within 60 seconds.'
      : '4. Broadcast: submit the signed transaction from my own wallet. A submission is not settlement.',
    evm
      ? '5. Prepare: execute_swap with the signature, nonce, simulationId and intentId. It returns calldata only; FarmDash never broadcasts it.'
      : '5. Confirm: call confirm_solana_swap with preparationId, wallet and the public txSignature. An expired preparation returns 410 and needs a NEW idempotency key; a 409 ambiguous outcome must be reconciled, never resubmitted blindly.',
    evm
      ? '6. Broadcast: my wallet submits the returned transaction. Then call confirm_swap with the owning session and the resulting tx hash. A caller-supplied hash alone is not confirmation.'
      : '',
    '',
    'Report each step\'s typed result. If a step returns a typed failure, stop and report the code, message and request_id instead of retrying with different parameters. Never describe preparation as execution, or a tx hash as settlement.',
  ].filter((line) => line !== '').join('\n'));
});

server.registerPrompt('perp-trade-runbook', {
  title: 'FarmDash Hyperliquid perp order runbook',
  description: 'Deterministic perp sequence: research gate, sizing, local EIP-712 signing, forwarding, and mandatory venue reconciliation. Read-only guidance; grants no authority.',
  argsSchema: {
    coin: z.string().optional().describe('Hyperliquid market symbol, for example ETH.'),
    side: z.enum(['long', 'short']).optional(),
  },
}, (args) => PROMPT_MESSAGE([
  `Help me place one guarded Hyperliquid perp order${args.coin ? ` on ${args.coin}` : ''}${args.side ? ` (${args.side})` : ''}. Follow this order and stop at the first failed gate.`,
  '',
  '0. Read farmdash://status. Commercial access is API capacity only; it never creates venue signing authority.',
  '1. Research: analyze_futures_strategy sets a 60-second parameter-bound new-risk gate. Reduce-only orders are exempt from NEW risk but still require authority.',
  '2. Account truth: get_futures_account. agentAddress is the API signer; accountAddress is the venue-verified equity owner. A userRole mismatch fails closed.',
  '3. Sizing: calculate_position_size with equity, entry and stop. Server guardrails are hard: max 5x leverage, 2% risk per trade, 20% concentration, -3% daily loss, -15% circuit breaker.',
  '4. Prepare: prepare_perp_order returns the exact action, EIP-712 typed data, nonce, expiry and intent hash. It never signs. market_ioc is a price-protected IOC limit with a live 100 bps adverse-price cap, not an unbounded market order.',
  '5. Sign locally: my wallet signs the returned typed data. The signed action must disclose the FarmDash builder term { b: treasury, f: 1 }.',
  '6. Submit: execute_perp_order with the signature, nonce, expiresAt and intentHash. The venue nonce authority is network + signer + nonce across account and vault contexts; replay control fails closed.',
  '7. Reconcile (mandatory): call reconcile_perp_order with the venue orderId. Never infer execution from balance or portfolio deltas, and never resubmit an unknown outcome. For a resting order, cancel_perp_order reports `accepted`, which is an application acknowledgement and NOT a cancellation; reconcile every requested id afterward.',
  '',
  'Report full, partial and zero fills distinctly. If any step returns a typed failure or an ambiguous outcome, stop and report the code, message and request_id.',
].join('\n')));

server.registerPrompt('bounded-autonomy-setup', {
  title: 'FarmDash bounded autonomy setup (opt-in only)',
  description: 'Explains the one-time scoped delegation path and the exact gates, and requires explicit user consent before anything is requested. Read-only guidance; creates no grant.',
  argsSchema: {
    domain: z.enum(['spot', 'futures']).optional().describe('Execution domain the user wants to consider. Defaults to spot.'),
  },
}, (args) => PROMPT_MESSAGE([
  `Explain and, only if I explicitly opt in, prepare a bounded ${args.domain ?? 'spot'} execution delegation. Do not create, request or register anything before I answer.`,
  '',
  '1. Read farmdash://status, then get_execution_authority for the active persisted session. If a valid bounded delegation already exists for THIS agentSessionId, report its policy bounds instead of asking me to sign another.',
  '2. State the two options plainly: Standard FarmDash (USER_SIGNED, I approve and sign each action) is the default; Autonomous FarmDash (BOUNDED_AUTONOMOUS) needs one owner-signed scoped delegation. A different or new agentSessionId never inherits another session grant.',
  '3. Name the signer model truth: EOA_V1_OWNER_LOCAL_SIGNER requires sessionPublicKey == ownerAddress, and the owner EOA signs in MY local runtime. FarmDash never receives or stores the private key. Separate delegated session-key signers belong to the not-yet-operational ERC-4337 path.',
  '4. Ask me to choose, and wait. Never infer consent from an API key, subscription, x402 payment, session creation, prior usage, an optimization request or a generic "do this for me".',
  '5. Only after I opt in: request_execution_delegation to build the exact EIP-712/ERC-8196 payload, bounded by chains, protocols/router contracts, assets, allowed actions, per-action value, cumulative budget, gas, slippage, validity and revocation.',
  '6. I sign that payload locally, then register_execution_delegation with the signature. Revocation is revoke_execution_authority and must be offered up front.',
  '',
  'Be explicit that payment, API keys and sessions are never wallet authority, and that a delegation is scoped to one agentSessionId.',
].join('\n')));

server.registerPrompt('yield-rebalance-audit', {
  title: 'FarmDash yield and idle-capital audit',
  description: 'Research-only audit of idle capital and candidate yields with the evidence boundaries named. Analysis only; produces no transaction.',
  argsSchema: {
    wallet: z.string().optional().describe('EVM wallet address to audit.'),
  },
}, (args) => PROMPT_MESSAGE([
  `Audit my idle capital and candidate yields${args.wallet ? ` for ${args.wallet}` : ''}. This is research only: do not prepare, sign or submit anything.`,
  '',
  '1. get_portfolio_summary and get_idle_capital for the wallet. These are paid reads, not session-authenticated, and they are not realized PnL.',
  '2. compare_yields with explicit chains/assets/risk filters. Rows are bounded to 50; treat the list as candidates, not recommendations.',
  '3. analyze_protocol_risk for each shortlisted protocol, and get_trail_heat for canonical DeFiLlama-backed scores. Catalog discovery_heuristic_score is editorial and is NOT canonical Trail Heat.',
  '4. simulate_yield_strategy for a scenario comparison. Every output is WAIT / analysis-only until exact pool identity, wallet eligibility, policy, costs and a stay-put comparison are established.',
  '5. State the freshness: Trail Heat freshness is disclosed per payload; a stale or unknown-observation score must be reported as such, never presented as live.',
  '',
  'End with a ranked shortlist, the evidence state per number, and an explicit statement that no position has been created.',
].join('\n')));

/* Start */

const ACP_UINT256_MAX = (1n << 256n) - 1n;
const AcpPositiveUint256Schema = z.string()
  .regex(/^[1-9]\d{0,77}$/)
  .refine((value) => /^[1-9]\d{0,77}$/.test(value) && BigInt(value) <= ACP_UINT256_MAX, 'ACP value exceeds uint256.');
const AcpTenderIdSchema = z.string().regex(/^fdat_[A-Za-z0-9_-]{8,59}$/);
const AcpProviderSetSchema = z.object({
  solidity_auditor: z.string().regex(EVM_ADDRESS),
  defi_economist: z.string().regex(EVM_ADDRESS),
  sentiment_analyst: z.string().regex(EVM_ADDRESS),
}).strict().refine(
  (providers) => new Set(Object.values(providers).map((address) => address.toLowerCase())).size === 3,
  'ACP requires three distinct provider addresses.',
);
const AcpDisclosureManifestSchema = z.object({
  schemaVersion: z.literal('farmdash-acp-disclosure/v1'),
  categories: z.array(z.enum([
    'transaction_intent', 'token_addresses', 'wallet_address', 'amounts',
    'calldata', 'strategy_context', 'proprietary_context', 'personal_data',
    'credentials_override',
  ])).min(1).max(16),
  secretScan: z.enum(['passed', 'overridden']),
  overrideReasonHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((manifest, context) => {
  if (manifest.secretScan === 'overridden' && !manifest.overrideReasonHash) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['overrideReasonHash'], message: 'A secret-scan override requires a reason commitment.' });
  }
  if (manifest.secretScan === 'passed' && manifest.overrideReasonHash !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['overrideReasonHash'], message: 'A passed secret scan cannot include an override reason.' });
  }
});

server.tool(
  'select_virtuals_provider_plan_v2',
  'Select a deterministic live-registry ACP V2 committee with one eligible provider per fixed role and three distinct verified controller identities. This selection-only action cannot authorize or spend funds.',
  {
    sessionId: z.string().min(1).max(200),
    agentAddress: z.string().regex(EVM_ADDRESS),
    accountAddress: z.string().regex(EVM_ADDRESS).optional(),
    sessionToken: z.string().min(32).max(256),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'select_provider_plan_v2', params: {} })),
  })),
);

server.tool(
  'prepare_virtuals_tender_v2',
  'Prepare a non-spendable ACP V2 evidence draft. FarmDash revalidates simulation ownership and derives output/gas economics; the caller sends only a local task commitment and disclosure manifest. This tool cannot authorize, create, fund, or settle an ACP job.',
  {
    sessionId: z.string().min(1).max(200),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string().min(32).max(256),
    idempotencyKey: z.string().min(16).max(200),
    taskCommitmentHash: z.string().regex(/^[a-f0-9]{64}$/).describe('Lowercase SHA-256 commitment computed locally over the canonical, salted task. Do not send task plaintext.'),
    simulationId: z.string().min(1).max(200),
    maxPaymentUnits: AcpPositiveUint256Schema.describe('Maximum total raw Base USDC units; no spend is authorized by preparation.'),
    providers: AcpProviderSetSchema.optional().describe('Deprecated in V2; use selectionId instead.'),
    selectionId: z.string().min(1),
    disclosureManifest: AcpDisclosureManifestSchema,
    approvalNonce: z.string().regex(/^\d{10,20}$/),
    approvalExpiresAt: z.string().datetime(),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, {
      action: 'prepare_tender_v2',
      params: {
        idempotencyKey: params.idempotencyKey,
        taskCommitmentHash: params.taskCommitmentHash,
        simulationId: params.simulationId,
        maxPaymentUnits: params.maxPaymentUnits,
        providers: params.providers,
        selectionId: params.selectionId,
        disclosureManifest: params.disclosureManifest,
        approvalNonce: params.approvalNonce,
        approvalExpiresAt: params.approvalExpiresAt,
      },
    })),
  })),
);

server.tool(
  'authorize_virtuals_tender_v2',
  'Submit an exact V2 EIP-712 signature produced by the customer ACP wallet. FarmDash first verifies deployment readiness and all committed providers; it still cannot create or fund jobs.',
  {
    sessionId: z.string().min(1).max(200), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string().min(32).max(256),
    tenderId: AcpTenderIdSchema, providerSelectionId: z.string().uuid(), nonce: z.string().regex(/^\d{10,20}$/),
    expiresAt: z.string().datetime(), signature: z.string().max(16_386).regex(/^0x[0-9a-fA-F]+$/),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'authorize_tender_v2', params: { tenderId: params.tenderId, providerSelectionId: params.providerSelectionId, nonce: params.nonce, expiresAt: params.expiresAt, signature: params.signature } })),
  })),
);

server.tool(
  'get_virtuals_tender',
  'Read the authenticated customer ACP tender, immutable commitments, role progress, and settlement state. This read grants no authority.',
  {
    sessionId: z.string().min(1).max(200), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string().min(32).max(256),
    tenderId: AcpTenderIdSchema,
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'get_tender', params: { tenderId: params.tenderId } })),
  })),
);

server.tool(
  'cancel_virtuals_tender',
  'Cancel an authenticated non-spendable ACP draft. It cannot erase or refund an already-created on-chain job.',
  {
    sessionId: z.string().min(1).max(200), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string().min(32).max(256),
    tenderId: AcpTenderIdSchema,
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'cancel_tender', params: { tenderId: params.tenderId } })),
  })),
);

server.tool(
  'bind_virtuals_tender_job',
  'Report a customer-created on-chain ACP job ID for one committed role. FarmDash independently verifies the Base client, provider, and evaluator before binding.',
  {
    sessionId: z.string().min(1).max(200), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string().min(32).max(256),
    tenderId: AcpTenderIdSchema,
    role: z.enum(['solidity_auditor', 'defi_economist', 'sentiment_analyst']),
    onchainJobId: AcpPositiveUint256Schema,
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'bind_job', params: { tenderId: params.tenderId, role: params.role, onchainJobId: params.onchainJobId } })),
  })),
);

server.tool(
  'reserve_virtuals_tender_funding_v2',
  'Atomically reserve one role budget against the exact customer-signed ACP V2 cap after FarmDash verifies the on-chain job and proposed budget. This accounting action cannot approve tokens or spend the customer wallet.',
  {
    sessionId: z.string().min(1).max(200), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string().min(32).max(256),
    tenderId: AcpTenderIdSchema,
    role: z.enum(['solidity_auditor', 'defi_economist', 'sentiment_analyst']),
    onchainJobId: AcpPositiveUint256Schema,
    amountUnits: AcpPositiveUint256Schema,
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'reserve_funding_v2', params: { tenderId: params.tenderId, role: params.role, onchainJobId: params.onchainJobId, amountUnits: params.amountUnits } })),
  })),
);

server.tool(
  'record_virtuals_tender_funding_v2',
  'Durably record canonical Base transaction hashes after the customer wallet submits an existing ACP V2 funding reservation. This action cannot submit a transaction itself.',
  {
    sessionId: z.string().min(1).max(200), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string().min(32).max(256),
    tenderId: AcpTenderIdSchema,
    reservationId: z.string().uuid(),
    transactionHashes: z.array(z.string().regex(/^0x[a-fA-F0-9]{64}$/)).min(1).max(4),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'record_funding_submission_v2', params: { tenderId: params.tenderId, reservationId: params.reservationId, transactionHashes: params.transactionHashes } })),
  })),
);

server.tool(
  'evaluate_virtuals_tender',
  'Request evaluation or resume settlement for a fully bound customer-funded ACP tender. FarmDash can only complete/reject jobs committed to its evaluator identity.',
  {
    sessionId: z.string().min(1).max(200), agentAddress: z.string().regex(EVM_ADDRESS), sessionToken: z.string().min(32).max(256),
    tenderId: AcpTenderIdSchema,
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'evaluate_tender', params: { tenderId: params.tenderId } })),
  })),
);

server.tool(
  'hire_virtuals_specialist',
  'Deprecated V1 compatibility tool. It prepares a zero-custody V1 tender only when the deployment explicitly enables V1 creation. Prefer prepare_virtuals_tender_v2. This tool never creates, budgets, funds, or signs an ACP job.',
  {
    sessionId: z.string().min(1).max(200),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string().min(32).max(256),
    idempotencyKey: z.string().min(16).max(200),
    task: JsonRecordSchema.describe('Task payload retained by the local customer connector; FarmDash persists only its commitment hash.'),
    simulationId: z.string().min(1).max(200),
    expectedOutputAmount: z.string().regex(/^\d+(?:\.\d+)?$/),
    expectedGasUsdCents: z.string().regex(BASE_UNIT_AMOUNT),
    expectedYieldUsdCents: z.string().regex(BASE_UNIT_AMOUNT),
    maxPaymentUnits: z.string().regex(BASE_UNIT_AMOUNT).describe('Maximum total raw Base USDC units (6 decimals) across the three customer-funded jobs.'),
    providers: z.object({
      solidity_auditor: z.string().regex(EVM_ADDRESS),
      defi_economist: z.string().regex(EVM_ADDRESS),
      sentiment_analyst: z.string().regex(EVM_ADDRESS),
    }),
    approvalNonce: z.string().regex(/^\d{10,20}$/),
    approvalExpiresAt: z.string().datetime(),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST',
    sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, {
      action: 'create_tender',
      params: {
        idempotencyKey: params.idempotencyKey,
        task: params.task,
        simulationId: params.simulationId,
        expectedOutputAmount: params.expectedOutputAmount,
        expectedGasUsdCents: params.expectedGasUsdCents,
        expectedYieldUsdCents: params.expectedYieldUsdCents,
        maxPaymentUnits: params.maxPaymentUnits,
        providers: params.providers,
        approvalNonce: params.approvalNonce,
        approvalExpiresAt: params.approvalExpiresAt,
      },
    })),
  }))
);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[farmdash-mcp] Fatal:', err);
  process.exit(1);
});
