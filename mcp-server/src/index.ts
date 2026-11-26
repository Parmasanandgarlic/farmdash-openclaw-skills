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

/**
 * Canonical parameter descriptions applied to any Zod input field lacking an
 * explicit `.describe(...)` in `index-base.ts`. Guarantees 100% parameter
 * documentation across stdio, Docker, Glama TDQS, `.well-known/mcp.json`,
 * and hosted Streamable HTTP `/api/mcp`.
 */
const DEFAULT_PARAM_DESCRIPTIONS: Record<string, string> = {
  sessionId: 'Active FarmDash agent session ID returned by create_session (optional when supplied via session headers).',
  agentAddress: 'Checksummed or lowercase 0x EVM wallet address (40 hex chars) representing the agent identity.',
  sessionToken: 'Opaque session capability token (32-256 chars) issued by create_session; required for session-bound reads/writes (also accepted via X-FarmDash-Session-Token header).',
  intentId: 'Durable FarmDash intent identifier (e.g., fd_intent_*) returned by create_intent or firm quote responses.',
  receiptId: 'Durable FarmDash execution receipt identifier (fdrcpt_*) returned by intent/execution routes.',
  signature: 'Hex-encoded cryptographic signature (EIP-191 personal_sign or EIP-712 typed signature) produced locally by the authorized wallet.',
  nonce: 'Single-use replay-protection nonce bound to the signed payload (fresh integer or string nonce within the validity window).',
  expiresAt: 'Expiration timestamp (Unix milliseconds or ISO-8601 UTC string) after which the signed request or approval is rejected.',
  expiresInSeconds: 'Validity duration in seconds before the generated approval payload expires.',
  simulationId: 'Authoritative pre-execution simulation ID returned by simulate_swap_execution or /api/v1/simulate.',
  grantId: 'Owner-signed bounded execution delegation grant ID (from request_execution_delegation / register_execution_delegation).',
  ownerAddress: 'Capital owner 0x EVM wallet address (40 hex chars) that holds authority over delegations, session keys, or MEE intents.',
  accountAddress: 'Trading or clearinghouse 0x EVM account address on the target venue (defaults to agentAddress when omitted).',
  approverAddress: '0x EVM address of the human or policy approver signing the intent approval.',
  executionMode: 'Execution authority mode: USER_SIGNED (default, wallet signs each action) or BOUNDED_AUTONOMOUS (requires active owner-signed grant).',
  executionDomain: 'Execution domain scope for authority checks or delegation (e.g., spot, futures, solana).',
  continuationId: 'Opaque handoff identifier returned by find_capital_route or market-estimate to bind continuation context without granting execution authority.',
  idempotencyKey: 'Caller-generated unique key (8-128 chars) ensuring safe retries without duplicate quote intents or tenders.',
  executionTrialId: 'Optional Scout execution-trial admission token ID bound to a signed trial identity challenge.',
  fromChainId: 'Origin EVM chain ID (supported execution chains: 1 Ethereum, 10 Optimism, 137 Polygon, 8453 Base, 42161 Arbitrum, 59144 Linea).',
  toChainId: 'Destination EVM chain ID (1 Ethereum, 10 Optimism, 137 Polygon, 8453 Base, 42161 Arbitrum, 59144 Linea).',
  fromAmount: 'Input token amount in integer base units (wei / smallest token denomination; decimal digits only, no decimals).',
  protocol: 'Preferred stabilized swap routing provider (lifi or relay). Omit to let FarmDash select the best compliant route.',
  walletAddress: 'Customer 0x EVM wallet address (40 hex chars) that will hold funds and locally sign any resulting transaction.',
  toAddress: 'Recipient 0x EVM wallet address (40 hex chars) for swap output tokens (typically matches agentAddress/walletAddress).',
  slippage: 'Maximum allowed swap slippage as a percentage (e.g., 0.5 for 0.5%; bounded by route policy).',
  slippageBps: 'Maximum allowed Solana swap slippage in basis points (e.g., 50 for 0.50%).',
  expectedUpsideUsd: 'Optional caller-estimated gross upside in USD used by economic viability checks against routing fees and gas.',
  riskBufferUsd: 'Optional safety buffer in USD subtracted from net edge before recommending execution.',
  healthFactor: 'Optional current lending/margin health factor used to guard against liquidation-inducing swaps.',
  liquidationBufferPct: 'Optional minimum liquidation buffer percentage required after the proposed swap.',
  safetyMode: 'Risk evaluation strictness level (e.g., strict or standard) for pre-quote safety checks.',
  feeEventId: 'Swap fee event identifier returned by execute_swap to bind on-chain settlement verification.',
  txHash: 'On-chain 0x transaction hash (66 hex chars) submitted by the customer wallet for server-side receipt verification.',
  coin: 'Hyperliquid perpetual market ticker symbol (e.g., BTC, ETH, SOL, HYPE).',
  isBuy: 'Order direction: true for long/buy, false for short/sell.',
  size: 'Perpetual order size in base-asset contract units (positive decimal string or number).',
  price: 'Limit price in USD for the perpetual order (positive decimal string or number).',
  orderType: 'Hyperliquid order type specification (e.g., limit, market, ioc, alo, trigger).',
  reduceOnly: 'When true, order may only reduce an existing position and cannot increase exposure.',
  leverage: 'Requested position leverage multiplier (positive integer bounded by market and policy limits).',
  intentHash: 'Deterministic EIP-712 intent digest returned by prepare_perp_order tying the signed action to the prepared order.',
  orderIds: 'Array of 1 to 50 positive integer Hyperliquid order IDs to cancel.',
  signedAction: 'Hyperliquid EIP-712 signed cancel/order action payload produced locally by the authorized wallet.',
  status: 'Status filter or recorded lifecycle status value (e.g., pending, confirmed, failed, approved, rejected).',
  limit: 'Maximum number of records to return (bounded integer).',
  addresses: 'Array of 1 or more public wallet addresses (0x EVM or Solana Base58) to audit for Sybil clustering risk.',
  protocolId: 'Canonical FarmDash protocol slug (e.g., hyperliquid, etherfi, ethena, pendle).',
  days: 'Lookback window in days for historical Trail Heat time-series observations (e.g., 7, 30, 90).',
  chains: 'Optional array of chain names or IDs to filter yield pools (e.g., ["Ethereum", "Arbitrum", "Base"]).',
  assets: 'Optional array of token symbols to include (e.g., ["USDC", "ETH", "USDe"]).',
  projects: 'Optional array of DeFi protocol slugs to restrict results (e.g., ["aave-v3", "pendle", "morpho"]).',
  riskPreference: 'Operator risk appetite tier (e.g., conservative, balanced, aggressive) controlling yield, hedge, or autopilot bounds.',
  minTvlUsd: 'Minimum pool TVL in USD to filter out illiquid or dust pools.',
  stableOnly: 'When true, restrict yield results to stablecoin-denominated pools only.',
  spotExposure: 'Array or map of current spot/LP/restaking holdings (asset symbol and USD or token size) to evaluate for delta-neutral hedging.',
  volatilityRegime: 'Optional market volatility regime override (e.g., low, normal, elevated, stress).',
  marketConditions: 'Optional pre-fetched market snapshot context (funding, OI, skew) to inform hedge sizing.',
  agentName: 'Human-readable display name for the agent session (1-24 characters).',
  issuedAt: 'ISO-8601 UTC timestamp when the session creation challenge was signed.',
  signatureType: 'Signature scheme used to authenticate the request (e.g., eip191 or eip712).',
  patch: 'Partial JSON object of FarmingContext fields to merge into the active agent session.',
  since: 'ISO-8601 UTC timestamp or cursor to fetch only events occurring after this point.',
  types: 'Optional array of event type identifiers to filter the event stream snapshot.',
  apiWalletAddress: 'Delegated Hyperliquid API wallet 0x address bound by the owner wallet.',
  strategies: 'Array of enabled autopilot strategy identifiers allowed within this bounded session.',
  maxEquityPct: 'Maximum percentage of account equity the autopilot may recommend allocating per cycle.',
  rebalanceIntervalMin: 'Minimum cooldown interval in minutes between autopilot rebalance evaluations.',
  autoCompound: 'When true, include yield compounding recommendations in autopilot cycles (still subject to execution authority).',
  accountState: 'Current portfolio or margin account state snapshot supplied to evaluate the autopilot cycle.',
  sessionPublicKey: 'Public 0x address of the bounded ERC-4337 session key being registered (never pass a private key).',
  allowedProtocols: 'Allowlist of protocol slugs or contract addresses permitted under this session key grant.',
  allowedAssets: 'Allowlist of token symbols or addresses permitted under this session key grant.',
  maxValuePerTx: 'Maximum USD or base-unit notional value allowed in a single session-key transaction.',
  maxTotalValue: 'Cumulative maximum notional value permitted over the lifetime of the session-key grant.',
  chainId: 'Target EVM chain ID where the session key or contract operation applies.',
  jobId: 'Autopilot cycle job identifier returned by autopilot_cycle.',
  policy: 'Explicit owner policy object defining spend caps, chain/protocol allowlists, slippage limits, and cooldowns.',
  context: 'Additional structured execution context (market, wallet, or session metadata) evaluated against the policy.',
  simulation: 'Structured simulation payload or parameters for intent readiness probing.',
  decision: 'Explicit human approval decision value (e.g., approved or rejected).',
  policyCheckId: 'Identifier of the prior policy-check record bound to this approval.',
  maxUsdValue: 'Maximum USD notional ceiling authorized by this human approval.',
  reason: 'Human-readable rationale explaining the approval, rejection, or action.',
  metadata: 'Optional key-value metadata object attached to the record for operator audit trails.',
  preparation: 'Structured preparation parameters for building an unsigned transaction payload.',
  signedPayload: 'Locally signed transaction or typed-data payload returned by the customer signer.',
  receipt: 'Structured execution receipt object recording observed transaction outcome.',
  details: 'Structured diagnostic or confirmation details attached to the intent lifecycle record.',
  error: 'Structured error detail object recorded when an intent execution attempt fails or halts.',
  id: 'MEE cross-chain intent identifier returned by create_mee_intent.',
  steps: 'Ordered array of cross-chain MEE execution step descriptors (chain, target, asset, amount).',
  tenderId: 'Virtuals ACP v2 tender identifier returned by prepare_virtuals_tender_v2.',
  selectionId: 'Provider plan selection identifier returned by select_virtuals_provider_plan_v2.',
  providerSelectionId: 'Selected Virtuals ACP v2 provider plan ID bound to the tender authorization.',
  disclosureManifest: 'Signed commercial/risk disclosure manifest acknowledging ACP v2 tender boundaries.',
  approvalNonce: 'Fresh single-use nonce binding the tender approval payload against replay.',
  approvalExpiresAt: 'Expiration timestamp (Unix ms or ISO-8601 UTC) for the tender approval.',
  role: 'Participant role identifier within the Virtuals ACP v2 job binding or funding step.',
  onchainJobId: 'On-chain Virtuals ACP job identifier to bind or reserve funding against.',
  amountUnits: 'Funding amount in integer base units (decimal string) for the ACP v2 reservation.',
  reservationId: 'Funding reservation identifier returned by reserve_virtuals_tender_funding_v2.',
  transactionHashes: 'Array of on-chain 0x transaction hashes proving tender funding settlement.',
  expectedOutputAmount: 'Expected specialist output amount in base units for economic validation.',
  expectedGasUsdCents: 'Estimated gas cost in integer USD cents for pre-hire economic gating.',
  expectedYieldUsdCents: 'Estimated gross yield in integer USD cents for pre-hire economic gating.',
  providers: 'Array of candidate specialist provider descriptors evaluated during hiring.',
};

const TOOL_PARAM_OVERRIDES: Record<string, Record<string, string>> = {
  get_agent_activity: {
    status: 'Optional receipt status filter (e.g., prepared, submitted, confirmed, failed) to narrow returned execution receipts.',
    limit: 'Maximum number of execution receipts to return (1-250).',
  },
  request_human_approval: {
    status: 'Requested approval status value (e.g., pending, approved, rejected).',
  },
  execute_approved_intent: {
    status: 'Observed execution state being reported to the generic intent lifecycle probe.',
  },
};

function ensureSchemaParamDescriptions(toolName: string, schema: Record<string, any>): void {
  const overrides = TOOL_PARAM_OVERRIDES[toolName];
  for (const [key, field] of Object.entries(schema)) {
    if (!field || typeof field !== 'object') continue;
    const hasDescription = typeof field.description === 'string' && field.description.trim().length > 0;
    if (hasDescription) continue;
    const desc = overrides?.[key] ?? DEFAULT_PARAM_DESCRIPTIONS[key];
    if (desc && typeof field.describe === 'function') {
      schema[key] = field.describe(desc);
    }
  }
}

(McpServer.prototype as unknown as { tool: (...args: any[]) => unknown }).tool = function guardedTool(
  name: string,
  ...args: any[]
) {
  const schema = args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg) && typeof arg.safeParse !== 'function');
  if (SWAP_PROVIDER_GUARDED_TOOLS.has(name) && schema && 'protocol' in schema) {
    const guardedProtocol = z.enum(['lifi', 'relay']).optional();
    const protocolDescription = schema.protocol?.description ?? DEFAULT_PARAM_DESCRIPTIONS.protocol;
    schema.protocol = guardedProtocol.describe(protocolDescription);
  }
  if (schema) {
    ensureSchemaParamDescriptions(name, schema);
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
  if (descriptionIndex >= 0 && name === 'get_receipt') {
    args[descriptionIndex] = `${capabilityPrefix}Observe: fetch one durable FarmDash execution receipt by receiptId. Requires active session credentials (sessionId, agentAddress, and sessionToken or X-FarmDash-Session-Token header).`;
  }
  if (descriptionIndex >= 0 && name === 'get_agent_activity') {
    args[descriptionIndex] = `${capabilityPrefix}Observe: list durable FarmDash execution receipts for an agent session. Filter by intentId and receipt status; use get_agent_events for protocol market events or get_event_stream_snapshot for incremental session cursors. Requires sessionToken (param or X-FarmDash-Session-Token header).`;
  }
  if (descriptionIndex >= 0 && name === 'simulate_swap_execution') {
    args[descriptionIndex] = `${capabilityPrefix}Simulate a legacy EVM swap by passing the firm quote response field simulationRequirements.intent_id as intentId together with its original walletAddress. Inspect the returned ok, simulation_id, and decision before continuing. The quote intent carries commercial admission for this simulation. It does not sign or submit. Use simulate_intent for a durable FarmDashIntent.`;
  }

  return originalTool.call(this, name, ...args);
};

await import('./index-base.js');
