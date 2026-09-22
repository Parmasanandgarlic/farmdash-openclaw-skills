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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createApiFetch, errorPayload } from './api-client.js';
import { getMcpToolCapability } from './tool-capabilities.generated.js';

/* Config */

const BASE_URL = process.env.FARMDASH_BASE_URL ?? 'https://www.farmdash.one/api';
const API_KEY = process.env.FARMDASH_API_KEY ?? '';
const apiFetch = createApiFetch({
  baseUrl: BASE_URL,
  apiKey: API_KEY,
  scoutGrant: process.env.FARMDASH_SCOUT_GRANT ?? '',
  skillId: process.env.FARMDASH_SKILL_ID ?? '',
});
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEX_SIGNATURE = /^0x[a-fA-F0-9]{130}$/;
const BASE_UNIT_AMOUNT = /^[0-9]+$/;
const SIGNATURE_SCHEMA = z.object({
  r: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  s: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  v: z.number().int(),
});

// MCP tools/list renders an empty raw shape (`{}`) as an open object schema.
// A constructed ZodObject instead emits { properties: {}, additionalProperties: false }
// with identical argument-stripping parse behavior, so paramless tools register
// with this marker and their published contract is explicitly closed.
const PARAMLESS_SCHEMA = z.object({});

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
});

const STATE_CHANGING_TOOLS = new Set([
  'create_intent',
  'policy_check_intent',
  'simulate_intent',
  'request_human_approval',
  'submit_signed_approval',
  'prepare_intent',
  'execute_approved_intent',
  'confirm_execution',
  'run_workflow',
  'execute_swap',
  'confirm_swap',
  'execute_perp_order',
  'cancel_perp_order',
  'create_session',
  'session_heartbeat',
  'patch_farming_context',
  'configure_autopilot',
  'autopilot_cycle',
  'pause_autopilot',
  'resume_autopilot',
  'grant_session_key',
  'revoke_session_key',
  'execute_cycle_actions',
  'create_mee_intent',
  'submit_mee_intent',
  'prepare_virtuals_tender_v2',
  'authorize_virtuals_tender_v2',
  'cancel_virtuals_tender',
  'bind_virtuals_tender_job',
  'reserve_virtuals_tender_funding_v2',
  'record_virtuals_tender_funding_v2',
  'evaluate_virtuals_tender',
  'hire_virtuals_specialist',
]);

const DESTRUCTIVE_OR_FINANCIAL_TOOLS = new Set([
  'execute_approved_intent',
  'execute_swap',
  'execute_perp_order',
  'cancel_perp_order',
  'pause_autopilot',
  'revoke_session_key',
  'execute_cycle_actions',
  'submit_mee_intent',
  'cancel_virtuals_tender',
  'record_virtuals_tender_funding_v2',
  'evaluate_virtuals_tender',
  'hire_virtuals_specialist',
]);

function toolAnnotations(name: string) {
  const changesState = STATE_CHANGING_TOOLS.has(name);
  return {
    title: `FarmDash ${name}`,
    readOnlyHint: !changesState,
    destructiveHint: DESTRUCTIVE_OR_FINANCIAL_TOOLS.has(name),
    idempotentHint: !changesState,
    openWorldHint: true,
  };
}

// Keep the existing strongly typed registrations while attaching MCP-standard
// annotations to every tool listing. These are hints, never authorization.
const registerToolWithoutAnnotations = server.tool.bind(server) as (...args: any[]) => unknown;
(server as unknown as { tool: (...args: any[]) => unknown }).tool = (name: string, ...args: any[]) => {
  const callback = args.pop();
  const capability = getMcpToolCapability(name);
  const capabilityLabel = `[Capability: ${capability.availability}; tier: ${capability.tier}; API: ${capability.api_route}; authority: /api/v1/agent/status]`;
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
  'Plan: create a durable FarmDashIntent. This records what an agent wants to do; it never prepares, signs, broadcasts, or executes.',
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
  'Canonical Trail Heat: fetch DeFiLlama-backed quantitative scores (0-100) with per-number evidence states, components, editorial separation and registry resolution from /v1/trail-heat. Takes no parameters.',
  {},
  async () => {
    try {
      const data = await apiFetch('/v1/trail-heat');
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
  'Get protocol risk indicators from the catalog: sybil risk label, status, category, chains, and discovery_heuristic_score (editorial heuristic, NOT live Trail Heat). Canonical quantitative scores via get_trail_heat.',
  { protocolId: z.string().describe('Protocol ID to audit') },
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
  'Find the most efficient route between tokens/chains. Considers fees, slippage, and gas. Returns a provider-neutral market estimate (never executable, never attributed) — a wallet alone never triggers provider quoting. For execution, create a firm single-provider quote via the quote-intent API (0x, LI.FI, or Relay as the selected provider), then simulate before preparing.',
  {
    fromChainId: z.number().int(),
    toChainId: z.number().int(),
    fromToken: z.string(),
    toToken: z.string(),
    fromAmount: z.string().regex(BASE_UNIT_AMOUNT).describe('Amount in token base units.'),
    protocol: z.enum(['lifi', 'relay']).optional(),
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
  'Real-time stream of protocol events: new airdrops, snapshots, program changes, and TVL spikes. Takes no parameters.',
  {},
  async () => {
    try {
      const data = await apiFetch('/v1/agent/events');
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
  'Project FarmScore for a hypothetical configuration. Returns estimated points, gas, and speculative USD value.',
  {
    totalVolumeUsd: z.number().min(0),
    txCount: z.number().int().min(0),
    daysActive: z.number().int().min(0),
    walletBalanceUsd: z.number().min(0),
    uniqueContracts: z.number().int().min(0),
    isCexFundingOnly: z.boolean(),
    protocolPoints: z.record(z.string(), z.number()),
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
  'Get multi-chain token portfolio for an EVM wallet. Returns balances with live USD prices.',
  { address: z.string().regex(EVM_ADDRESS), chains: z.string().optional() },
  async (params) => {
    try {
      const qs = new URLSearchParams({ address: params.address });
      if (params.chains) qs.set('chains', params.chains);
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
  'get_portfolio_summary',
  'Get high-level portfolio metrics: total USD value, chain distribution, and capital efficiency score.',
  { address: z.string().regex(EVM_ADDRESS) },
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
  'Compatibility alias for agent activity/performance metrics. Current endpoint does not return DeFi position APR, PnL, impermanent loss, or rebalance health.',
  { address: z.string().regex(EVM_ADDRESS) },
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
  'Locate idle stablecoins or native assets across all supported chains.',
  { address: z.string().regex(EVM_ADDRESS) },
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
  'Get live USD prices by symbol or by network:address token pairs.',
  { symbols: z.string().optional(), tokens: z.array(z.string()).optional() },
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
  'Get the JSON catalog of named DeFi workflow recipes. Returns goals, tiers, and step graphs.',
  { filter: z.string().optional() },
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
  'Build a Trail Marshal quality gate for a named workflow. Does not execute steps.',
  {
    workflowId: z.string(),
    installedSkills: z.array(z.string()).optional(),
    agentAddress: z.string().regex(EVM_ADDRESS).optional(),
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
  'Create a guarded workflow run record for a session. Execution still requires each owning skill and explicit user confirmation.',
  {
    workflowId: z.string(),
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    installedSkills: z.array(z.string()).optional(),
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
  'Read the status of a Trail Marshal workflow run.',
  { runId: z.string() },
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

/* 4. FarmDash Signal Architect (v4.0.0) */

server.tool(
  'get_swap_quote',
  'Research or firm quote: without idempotencyKey, return a provider-neutral market estimate with zero trading-provider calls. With idempotencyKey plus a real wallet/destination and slippage, create or reuse a firm single-provider quote intent and return simulationRequirements.intent_id for simulate_swap_execution. Active selection is LI.FI/Relay; 0x remains blocked while operator-paused.',
  {
    fromChainId: z.number().int(),
    toChainId: z.number().int(),
    fromToken: z.string(),
    toToken: z.string(),
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
    idempotencyKey: z.string().min(1).max(128).optional(),
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
  'Compatibility: run the legacy mandatory swap simulation. Lifecycle-native agents should use simulate_intent on a FarmDashIntent instead.',
  {
    intentId: z.string().min(1),
    walletAddress: z.string().regex(EVM_ADDRESS),
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
    fromToken: z.string(),
    toToken: z.string(),
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
  'Confirm a swap by tx hash. Marks the fee event as confirmed.',
  { feeEventId: z.string(), txHash: z.string(), agentAddress: z.string().regex(EVM_ADDRESS) },
  async (params) => {
    try {
      const data = await apiFetch('/agents/confirm', { method: 'POST', body: JSON.stringify(params) });
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
  'Get unranked catalog research candidates. Returns WAIT analysis-only: exact pool identity, wallet eligibility, policy, costs and stay-put comparison remain required. Campaign confirmation does not establish safety.',
  {
    currentProtocols: z.array(z.string()),
    riskPreference: z.enum(['conservative', 'balanced', 'aggressive']),
    chains: z.array(z.string()).optional(),
    budget: z.enum(['low', 'medium', 'high']).optional(),
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
  'Compatibility: resolve a legacy typed DeFi intent. New state-changing actions should create a durable FarmDashIntent and use the policy/simulation/approval lifecycle.',
  {
    action: z.enum(['swap', 'deposit', 'stake', 'provide_liquidity', 'withdraw', 'claim']),
    protocolId: z.string(),
    chainId: z.union([z.number().int().positive(), z.literal('solana-mainnet')]),
    toChainId: z.union([z.number().int().positive(), z.literal('solana-mainnet')]).optional(),
    tokenIn: z.string(),
    amountIn: z.string().regex(BASE_UNIT_AMOUNT),
    userAddress: z.string(),
    tokenOut: z.string().optional(),
    amountOut: z.string().regex(BASE_UNIT_AMOUNT).optional(),
    slippage: z.number().min(0.01).max(5).optional(),
    poolAddress: z.string().optional(),
    deadline: z.number().optional(),
    constraints: z.object({
      minAmountOut: z.string().regex(BASE_UNIT_AMOUNT).optional(),
      maxSlippageBps: z.number().int().positive().optional(),
      maxGasUsd: z.number().positive().optional(),
      expectedUpsideUsd: z.number().positive().optional(),
      riskBufferUsd: z.number().positive().optional(),
      positiveNetEdge: z.boolean().optional(),
    }).optional(),
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
  'Run FarmDash Risk Sentinel on a route or manual health/net-edge inputs before execution.',
  {
    fromChainId: z.number().int().positive().optional(),
    toChainId: z.number().int().positive().optional(),
    fromToken: z.string().optional(),
    toToken: z.string().optional(),
    fromAmount: z.string().regex(BASE_UNIT_AMOUNT).optional(),
    walletAddress: z.string().regex(EVM_ADDRESS).optional(),
    toAddress: z.string().regex(EVM_ADDRESS).optional(),
    protocol: z.enum(['lifi', 'relay']).optional(),
    slippage: z.number().min(0.01).max(5).optional(),
    expectedUpsideUsd: z.number().optional(),
    protocolFeeUsd: z.number().optional(),
    gasUsd: z.number().optional(),
    bridgeFeeUsd: z.number().optional(),
    riskBufferUsd: z.number().optional(),
    enforcePositive: z.boolean().optional(),
    healthFactor: z.number().optional(),
    liquidationBufferPct: z.number().optional(),
    safetyMode: z.enum(['strict', 'balanced']).optional(),
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
  'Scan Hyperliquid perp funding rates across the venue. Takes no parameters.',
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
  'Technical snapshot (EMA, RSI, MACD, etc.) for one perp asset.',
  { coin: z.string() },
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
  'Inspect Hyperliquid equity, margin, positions, and drawdown state. agentAddress identifies the API signer; accountAddress identifies the master/subaccount that owns the equity (omit only for a direct signer). Hyperliquid userRole must verify delegation. Daily/weekly values are conservative venue-derived loss-pressure metrics, not full period returns; history ambiguity fails closed.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    accountAddress: z.string().regex(EVM_ADDRESS).optional(),
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
  'Primary research tool. Returns strategy object with confidence, regime, and simulation. For a delegated Hyperliquid API wallet, set agentAddress to the signer and accountAddress to the master/subaccount whose equity must size the trade; the venue relationship is verified and fails closed.',
  {
    coin: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    accountAddress: z.string().regex(EVM_ADDRESS).optional(),
    riskMultiplier: z.number().min(0.1).max(1).optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/futures/analyze-strategy', { method: 'POST', body: JSON.stringify(params) });
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
  'Translate risk constraints into size and leverage for a perp setup.',
  {
    equity: z.number().positive(),
    entryPrice: z.number().positive(),
    stopPrice: z.number().positive(),
    riskPercent: z.number().positive().optional(),
    targetPrice: z.number().positive().optional(),
    riskMultiplier: z.number().min(0.1).max(1).optional(),
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
  'execute_perp_order',
  'Compatibility: submit a pre-signed EIP-712 Hyperliquid order after a 60-second parameter-bound research gate. For delegated API wallets, set accountAddress to the venue-verified equity owner used during analysis. FarmDash recovers the exact L1 signer, rejects an agentAddress mismatch, and preflights the owner maxBuilderFee. The signed action must disclose builder f=1 (0.1 bp/0.001% of filled notional), and expiresAt is venue-signed as expiresAfter. A resting order is not a fill.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    accountAddress: z.string().regex(EVM_ADDRESS).optional(),
    coin: z.string(),
    isBuy: z.boolean(),
    size: z.string(),
    price: z.string(),
    orderType: z.string(),
    signature: SIGNATURE_SCHEMA,
    reduceOnly: z.boolean().optional(),
    leverage: z.number().positive().optional(),
    signedAction: z.any().optional().describe('If supplied, must include the signed FarmDash builder term { b: treasury, f: 1 }; f is tenths of a basis point.'),
    nonce: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    intentHash: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/futures/execute-order', { method: 'POST', body: JSON.stringify(params) });
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
  'Cancel stale or resting Hyperliquid orders with a venue-signed expiresAfter and FarmDash intent hash. For a delegated API wallet, accountAddress identifies the verified equity owner and is included as the signed vault/subaccount routing address when required. Success requires one authoritative venue success status per order; mixed errors are returned as partial rejection.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    accountAddress: z.string().regex(EVM_ADDRESS).optional(),
    coin: z.string(),
    orderIds: z.array(z.number().int().positive()).min(1).max(50),
    signature: SIGNATURE_SCHEMA,
    signedAction: z.any().optional(),
    nonce: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    intentHash: z.string(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/futures/cancel-order', { method: 'POST', body: JSON.stringify(params) });
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
  'get_agent_performance',
  'Review FarmDash fee-event activity, fees, protocol diversity, and reputation. This endpoint does not return fills, trade outcomes, realized PnL, win rate, or slippage.',
  { agentAddress: z.string().regex(EVM_ADDRESS) },
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
  'Audit token approvals for unlimited, unknown, or high-dollar allowance risk.',
  {
    walletAddress: z.string().regex(EVM_ADDRESS).optional(),
    allowances: z.array(z.object({
      token: z.string().optional(),
      spender: z.string().optional(),
      allowance: z.string().optional(),
      requiredAmount: z.string().optional(),
      amountUsd: z.number().optional(),
      spenderVerified: z.boolean().optional().describe('True only after independent verification against the protocol canonical deployment.'),
    })).optional(),
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
  'Apply Camp Guard transaction policy checks to an unsigned transaction. This is not an RPC simulation.',
  {
    walletAddress: z.string().regex(EVM_ADDRESS).optional(),
    transaction: z.object({
      to: z.string(),
      data: z.string(),
      value: z.string().optional(),
      chainId: z.number().int().positive().optional(),
    }),
    expectedTransaction: z.object({
      to: z.string().regex(EVM_ADDRESS),
      chainId: z.number().int().positive(),
      value: z.string().regex(/^[0-9]+$/).optional(),
      dataHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    }).optional(),
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
    chains: z.array(z.string()).optional(),
    assets: z.array(z.string()).optional(),
    projects: z.array(z.string()).optional(),
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
  'Summarize recorded spot and futures agent activity over a date range.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    start: z.string().optional(),
    end: z.string().optional(),
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
  'Export recorded spot execution records as CSV for downstream accounting review.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    start: z.string().optional(),
    end: z.string().optional(),
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
  'First-run contract: fetch live feature readiness, tier gates, error semantics, and the onboarding capability map before selecting tools. This never enables execution. Takes no parameters.',
  {},
  async () => {
    try {
      const [status, onboarding] = await Promise.all([
        apiFetch('/v1/agent/status'),
        apiFetch('/v1/agent/onboard'),
      ]);
      const data = {
        ok: true,
        first_run_contract: '/api/v1/agent/status',
        instruction: 'Select only tools whose backing feature and deployment prerequisites are available. Do not infer execution capability from tool registration.',
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
  'Create a persistent agent session. Normal callers must include a fresh EIP-712 or EIP-191 session signature. Returns a one-time sessionToken.',
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
      const data = await apiFetch('/v1/agent/context', {
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
  'get_event_stream_snapshot',
  'Observe: read a JSON snapshot from the agent event stream for a live session.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    since: z.string().optional(),
    types: z.array(z.string()).optional(),
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
  'Verify Hyperliquid API wallet delegation for guarded venue-order workflows. Verification does not bypass live status, research, risk, or signature gates.',
  {
    agentAddress: z.string().regex(EVM_ADDRESS),
    apiWalletAddress: z.string().regex(EVM_ADDRESS),
    ownerAddress: z.string().regex(EVM_ADDRESS),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/delegation', { method: 'POST', body: JSON.stringify(params) });
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
  'configure_autopilot',
  'Configure autopilot strategies, assets, and risk parameters.',
  {
    sessionId: z.string(),
    agentAddress: z.string().regex(EVM_ADDRESS),
    sessionToken: z.string(),
    strategies: z.array(z.string()),
    assets: z.array(z.string()),
    riskPreference: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
    maxEquityPct: z.number().positive().max(0.8).optional(),
    rebalanceIntervalMin: z.number().int().positive().optional(),
    autoCompound: z.boolean().optional(),
  },
  async (params) => {
    try {
      const data = await apiFetch('/v1/agent/autopilot', {
        method: 'POST',
        body: JSON.stringify({
          action: 'configure',
          sessionId: params.sessionId,
          agentAddress: params.agentAddress,
          sessionToken: params.sessionToken,
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
    accountState: z.any(),
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
    allowedProtocols: z.array(z.string()),
    allowedAssets: z.array(z.string()),
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
        params: z.record(z.any()),
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
  'Deep risk analysis for a DeFi protocol. Pulls live signals from DeFiLlama (TVL, momentum, chain diversification, historical trends) and combines with Trail Heat scoring to produce a composite risk grade (low/moderate/elevated/high/critical) with actionable signals.',
  {
    protocolId: z.string().describe('Protocol ID (e.g. "hyperliquid", "etherfi")'),
    includeHistorical: z.boolean().optional().describe('Include 30-day historical TVL trend analysis (default: true)'),
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
    protocols: z.array(z.string()).optional().describe('Specific protocol IDs to investigate'),
    poolIdentities: z.array(z.object({ protocolId: z.string(), poolId: z.string(), chain: z.string(), assetAddresses: z.array(z.string()).min(1) })).optional().describe('Exact upstream chain, pool ID and underlying asset addresses'),
    costs: z.object({ gas: z.number().nonnegative().nullable().optional(), slippage: z.number().nonnegative().nullable().optional(), bridge: z.number().nonnegative().nullable().optional(), exit: z.number().nonnegative().nullable().optional(), platform: z.number().nonnegative().nullable().optional(), subscription: z.number().nonnegative().nullable().optional(), perCall: z.number().nonnegative().nullable().optional() }).optional().describe('Editable scenario costs in USD; missing mandatory costs force WAIT'),
    stayPutApy: z.number().nonnegative().optional().describe('Editable stay-put baseline APY assumption'),
    scenarioApy: z.record(z.number().nonnegative()).optional().describe('Editable APY assumptions by protocol; excluded from observed yield'),
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

/* Start */

const ACP_UINT256_MAX = (1n << 256n) - 1n;
const AcpPositiveUint256Schema = z.string()
  .regex(/^[1-9]\d{0,77}$/)
  .refine((value) => BigInt(value) <= ACP_UINT256_MAX, 'ACP value exceeds uint256.');
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
    tenderId: AcpTenderIdSchema, nonce: z.string().regex(/^\d{10,20}$/),
    expiresAt: z.string().datetime(), signature: z.string().max(16_386).regex(/^0x[0-9a-fA-F]+$/),
  },
  async (params) => apiToolResult(() => apiFetch('/v1/agent/virtuals-acp', {
    method: 'POST', sessionToken: params.sessionToken,
    body: JSON.stringify(withSessionBody(params, { action: 'authorize_tender_v2', params: { tenderId: params.tenderId, nonce: params.nonce, expiresAt: params.expiresAt, signature: params.signature } })),
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
