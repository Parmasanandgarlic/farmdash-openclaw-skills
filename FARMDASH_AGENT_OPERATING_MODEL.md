# FarmDash Agent Operating Model

This document defines how FarmDash skills should compose when one agent needs research, execution, monitoring, and risk controls in the same workflow.

It does not add new MCP tools on its own. Instead, it standardizes how to use the existing FarmDash skill surface safely and predictably.

## Skill Roles (All 10 FarmDash OpenClaw Skills)

Use all 10 skills together as a cohesive zero-custody pipeline, not as isolated products:

| Skill | Canonical Slug & Manual | Role | Custody / Execution Posture |
|---|---|---|---|
| `FarmDash Trail Intelligence` | [`farmdash-trail-intelligence`](https://www.farmdash.one/agents/skills/farmdash-trail-intelligence) | Protocol discovery, Trail Heat ranking, wallet balances, historical trends, sybil review, points scenarios, capital-route previews | Strictly read-only |
| `FarmDash Wagon Steward` | [`farmdash-wagon-steward`](https://www.farmdash.one/agents/skills/farmdash-wagon-steward) | EVM portfolio mirror, candidate liquid reserves, allocation concentration & position health | Strictly read-only |
| `FarmDash Supply Master` | [`farmdash-supply-master`](https://www.farmdash.one/agents/skills/farmdash-supply-master) | Net-expected-yield pool ranking (`yield_quality_v3`), ERC-4626 verification, stablecoin ladders, reward-decay & IL checks | Strictly read-only |
| `FarmDash Camp Guard` | [`farmdash-camp-guard`](https://www.farmdash.one/agents/skills/farmdash-camp-guard) | Pre-sign allowance audits, Risk Sentinel route/depeg/net-edge checks, unsigned-tx policy verdicts | Read-only safety gate (`pass`/`review`/`halt`) |
| `FarmDash Hedge Warden` | [`farmdash-hedge-warden`](https://www.farmdash.one/agents/skills/farmdash-hedge-warden) | Delta-neutral spot hedge sizing (`spotNotional × beta × targetHedgeRatio`) with confidence ≥ 0.60 gate | Advisory only; hands off to Futures Strategist |
| `FarmDash Trail Marshal` | [`farmdash-trail-marshal`](https://www.farmdash.one/agents/skills/farmdash-trail-marshal) | 18-recipe workflow catalog (`list_workflows`, `plan_workflow`, `run_workflow`, `get_workflow_status`) | Guarded orchestration; never holds keys or executes |
| `FarmDash Signal Architect` | [`farmdash-signal-architect`](https://www.farmdash.one/agents/skills/farmdash-signal-architect) | EVM spot (LI.FI & Relay; 0x paused) and native Solana (Jupiter) quoting, simulation, zero-custody preparation & settlement confirmation | Zero-custody execution prep (`USER_SIGNED` default or `BOUNDED_AUTONOMOUS` opt-in) |
| `FarmDash Futures Strategist` | [`farmdash-futures-strategist`](https://www.farmdash.one/agents/skills/farmdash-futures-strategist) | Hyperliquid perps research, regime/sizing, `builderFeeStatus` / `ApproveBuilderFee`, EIP-712 order prep, execution, performance & venue reconciliation | Zero-custody Hyperliquid execution (`USER_SIGNED` default or `BOUNDED_AUTONOMOUS` opt-in) |
| `FarmDash Autonomous Operator` | [`farmdash-autonomous-operator`](https://www.farmdash.one/agents/skills/farmdash-autonomous-operator) | Persistent sessions, shared `FarmingContext`, event stream snapshots, DeFi intent resolution, OODA loop, bounded EIP-712/Solana/futures delegation grants, circuit breakers & crash recovery | Session & bounded-delegation control plane; never holds keys |
| `FarmDash Ledger Keeper` | [`farmdash-ledger-keeper`](https://www.farmdash.one/agents/skills/farmdash-ledger-keeper) | Post-trade activity/cost reconciliation (`settlement_status: confirmed` only; `realizedPnlUsd: null`) and CSV export | Strictly read-only post-trade accounting |

## Transport & Endpoint Connectivity

- **Hosted Streamable HTTP MCP (`https://www.farmdash.one/api/mcp`):** Zero-install remote MCP endpoint exposing **56 core tools** directly over HTTP (supports `?profile=research`, `?profile=observation`, `?profile=spot-trader`, `?profile=futures`, etc.).
- **Full Stdio MCP Server (98 tools) & REST API (`https://www.farmdash.one/agents/openapi.yaml`):** Covers all **98 runtime tools**, including the 42 session-bound intent, workflow execution, delegation, and MEE lifecycle tools not directly mapped on the stateless HTTP MCP dispatcher.
- **Multi-Skill Workflow Catalog (`GET https://www.farmdash.one/api/v1/agent/workflows`):** Public JSON catalog of all 18 canonical cross-skill recipes compiled against `mcp-server/src/tool-contracts.ts` and verified against `SKILL.json` tool ownership.

## First-Prompt Execution Mode Selection (Zero-Custody Default vs Opt-In Bounded Autonomy)

Before any wallet-changing swap, Solana swap, or Hyperliquid perp order, inspect `execution_mode_selection` (served on `GET /api/v1/agent/status`, `POST /api/v1/agent/authority`, spot quote/intent endpoints, Solana quote/swap endpoints, and Hyperliquid `analyze-strategy` / `prepare-order`) and prompt the user first:

1. **Standard FarmDash (`USER_SIGNED` — default):** Human review and local wallet signature on every trade (EIP-191/EIP-712 on EVM/Hyperliquid, native wallet signature on Solana). Available immediately on Scout (5 spot + 5 futures lifecycles per capital owner per UTC day, independent of 30 daily discovery requests), Pioneer (`$39.99/mo`), Syndicate (`$199/mo`), or Base USDC x402 one-offs.
2. **Autonomous FarmDash (`BOUNDED_AUTONOMOUS` — opt-in):** Owner-signed, scoped, expiring, revocable delegation grant enforced per domain (`spot.BOUNDED_AUTONOMOUS`, `futures.BOUNDED_AUTONOMOUS`, `solana.BOUNDED_AUTONOMOUS`) with customer-local signing (`EOA_V1_OWNER_LOCAL_SIGNER`). Requires a valid FarmDash session (Pioneer+ or a 0.02 USDC Base `session_control` x402 one-off) and explicit grant registration via **FarmDash Autonomous Operator**.

FarmDash never requests, receives, stores, or transmits private keys, seed phrases, or mnemonics. Commercial access (tiers, API keys, x402 payments) never grants transaction authority, and transaction authority never waives commercial limits or transparent venue/routing fees (`https://www.farmdash.one/fees`).

## Autonomous Agent Use-Case Map

Use this map before choosing individual tools. It keeps autonomous behavior grounded in a business purpose and a safety boundary.

| Use case | Primary goal | Core tools | Required posture |
|---|---|---|---|
| Bounded Autopilot | Run a recurring loop inside explicit budgets, allowlists, and cooldowns | `agent_onboard`, `create_session`, `configure_autopilot`, `autopilot_cycle`, `session_heartbeat` | Stop or switch to `analysis_only` when any bound is violated |
| Airdrop Rotation Desk | Detect when to enter, wait, rotate, or exit farming opportunities | `get_trail_heat`, `get_historical_trailheat`, `get_agent_events`, `simulate_points`, `get_swap_quote` | Treat "wait" as a valid action when edge is unclear |
| Cross-Chain ROI Gate | Decide whether a bridge is worth its cost and execution risk | `get_chain_breakdown`, `get_wallet_balances`, `get_token_prices`, `get_swap_quote`, `optimize_portfolio` | Bridge only when net expected edge remains positive |
| Perps Hedge Co-Pilot | Evaluate whether spot farming exposure needs a Hyperliquid hedge | `scan_funding_rates`, `scan_market_conditions`, `get_futures_account`, `analyze_futures_strategy`, `calculate_position_size` | Prefer `no_trade` when confidence, liquidity, or jurisdiction is unclear |
| Operator Reputation Loop | Review execution quality and prove agent reliability | `get_agent_performance` (MCP tool); `check_reputation` and `vouch_for_agent` exist only as HTTP routes (`/api/agents/reputation`, `/api/agents/vouch`) — no MCP tool wraps them yet; there is no `get_swap_history` anywhere | Reputation is evidence, not permission to copy trades blindly |

## Sense -> Decide -> Act -> Learn Loop

Every autonomous workflow should be explainable as four stages:

1. Sense: refresh events, Trail Heat, chain distribution, balances, and market state.
2. Decide: rank actions by expected edge, sybil pressure, gas, bridge cost, quote freshness, and user constraints.
3. Act: execute only with a fresh quote, explicit approval or configured policy, and the required local signature.
4. Learn: compare expected vs realized output and reduce confidence or autonomy when outcomes degrade.

Persist at least: `sessionId`, research timestamp, quote timestamp, last action timestamp, configured limits, expected outcome, realized outcome, tx hashes, and request IDs.

## Cross-Skill Composition Patterns

### 1. Research -> Safety Gate -> Mode Choice -> EVM Spot Entry -> Settle -> Protocol Action

Use when the user wants a new EVM farming position.

1. `get_trail_heat` and `get_historical_trailheat` (Trail Intelligence) to rank candidates and confirm momentum.
2. `get_portfolio_summary` / `get_idle_capital` (Wagon Steward) and `compare_yields` (Supply Master) to confirm reserves and net expected yield.
3. `audit_allowance_risk` + `run_risk_sentinel` (Camp Guard) to verify a clean `pass` verdict before quoting.
4. Prompt the user for **Standard FarmDash (`USER_SIGNED`, default)** vs **Autonomous FarmDash (`BOUNDED_AUTONOMOUS`, opt-in)** via `execution_mode_selection`.
5. `get_swap_quote` (market estimate first, then firm `POST /api/v1/agent/quote-intent` with `idempotencyKey`) → `simulate_swap_execution` → local wallet sign → `execute_swap` (or `prepare_autonomous_swap` under an active grant) → wallet broadcast → `confirm_swap` (authenticated session via MCP, or zero-session Scout EIP-191 wallet signature on `POST /api/agents/confirm`).
6. Finish with the canonical protocol domain plus optional disclosed FarmDash `/go/{slug}` route and `https://www.farmdash.one/fees`, then reconcile in Ledger Keeper.

### 2. Native Solana Spot Entry -> Local Sign -> Finalize

Use when the user wants to swap SPL tokens on Solana.

1. `get_solana_quote` (Jupiter preview + `execution_mode_selection`, never routed through EVM compatibility swaps).
2. Prompt the user for `USER_SIGNED` (default) vs `BOUNDED_AUTONOMOUS` (native owner-signed Solana policy).
3. `prepare_solana_swap` (returns unsigned `VersionedTransaction` + RPC simulation + transparent Jupiter platform fee disclosure when configured).
4. Customer wallet signs locally and broadcasts to Solana RPC.
5. `confirm_solana_swap` to verify message digest, required signer, economic deltas, and finality.

### 3. Research -> Hedge -> Builder Approval -> Execute -> Reconcile (Hyperliquid Perps)

Use when a farming position has directional risk or the user wants a Hyperliquid perp strategy.

1. Measure spot exposure (Wagon Steward) and size the hedge (Hedge Warden `recommend_delta_hedge`, blocking execution if confidence < 0.60).
2. `analyze_futures_strategy` (Futures Strategist) — inspects regime, invalidation, `execution_mode_selection`, and upfront `builderFeeStatus` (`f=1` = 0.1 bp = 0.001% of filled notional).
3. Prompt the user for `USER_SIGNED` (default) vs `BOUNDED_AUTONOMOUS` (distinct owner-signed futures grant + Hyperliquid API-wallet delegation).
4. If `builderFeeStatus.approved` is false (or `prepare_perp_order` returns HTTP 409 `builder_fee_approval_required`), have the **Hyperliquid main account wallet** (never the API wallet) sign and submit the returned `builderApproval` (`HyperliquidTransaction:ApproveBuilderFee`) once.
5. `prepare_perp_order` → local EIP-712 venue signature → `execute_perp_order` → `reconcile_perp_order` (never infer fills from portfolio deltas).
6. Re-read spot/perp residual delta and export post-trade records via Ledger Keeper.

### 4. Event -> Reprice -> Reallocate

Use when airdrops, snapshots, or TVL spikes change the expected payoff.

1. `get_agent_events` detects the trigger.
2. `get_trail_heat` and `get_historical_trailheat` confirm whether the move is durable.
3. `get_swap_quote` estimates the cost of repositioning; `run_risk_sentinel` confirms positive net edge.
4. `optimize_portfolio` checks whether the new allocation still fits the user goal.
5. If approved under the chosen execution mode, execute, confirm settlement, and record the result for later review in Ledger Keeper.

## Bounded Autonomy Mode

Always treat autonomy as bounded, user-scoped, and revocable.

Required guardrails for any unattended or semi-attended loop:

- `maxActionsPerCycle`: hard cap on swaps, orders, or protocol changes in one cycle
- `maxDailyNotionalUsd`: daily notional budget across spot, bridge, and perps actions
- `maxOpenPositions`: cap on simultaneous protocols or perp positions
- `allowedChains`: explicit chain allowlist
- `allowedProtocols`: explicit protocol allowlist
- `deniedProtocols`: explicit denylist for emergency blocks
- `maxBridgeCostUsd`: reject cross-chain moves that cost too much to justify the edge
- `maxSlippageBps`: reject execution outside the user's slippage budget
- `maxGasUsdPerAction`: reject trades whose transaction cost breaks projected net benefit
- `cooldownMinutes`: minimum wait between autonomous actions
- `sessionTtlMinutes`: session expiry if the loop stops checking in
- `requireFreshResearchMinutes`: maximum age of Trail Heat, funding, or quote data before execution
- `fallbackMode`: `analysis_only` or `halt`

Recommended safe defaults:

```json
{
  "maxActionsPerCycle": 1,
  "maxDailyNotionalUsd": 1000,
  "maxOpenPositions": 3,
  "allowedChains": ["Base", "Arbitrum"],
  "allowedProtocols": ["ostium", "kamino", "etherfi"],
  "maxBridgeCostUsd": 15,
  "maxSlippageBps": 75,
  "maxGasUsdPerAction": 20,
  "cooldownMinutes": 30,
  "sessionTtlMinutes": 60,
  "requireFreshResearchMinutes": 10,
  "fallbackMode": "analysis_only"
}
```

If any bound is violated, stop the loop and return a structured explanation instead of forcing execution.

## Jurisdiction And Compliance Gate

Before recommending or executing:

1. Determine the user's stated or configured jurisdiction.
2. Filter out chains, protocols, or derivatives flows that may be restricted.
3. If jurisdiction is unknown, default to research-only for sensitive actions.
4. For perps, obtain explicit confirmation that the user wants derivatives analysis in their jurisdiction.

Minimum policy output the agent should keep in context:

```json
{
  "jurisdiction": "US",
  "spotAllowed": true,
  "bridgingAllowed": true,
  "perpsAllowed": false,
  "restrictedProtocols": [],
  "note": "Unknown or restricted derivative access; stay in analysis-only mode for perps."
}
```

This is a decision gate, not legal advice. When in doubt, narrow the workflow instead of broadening it.

## Cross-Chain Strategy, Not Just Routing

Do not treat Li.Fi as a hidden transport detail. Cross-chain movement should be justified by projected net benefit.

Before bridging, compare:

- projected points or yield upside
- bridge fee
- gas on both chains
- time-to-eligibility or snapshot timing
- additional wallet or sybil complexity
- execution risk from stale quotes or thin liquidity

Simple decision rule:

`netEdgeUsd = expectedUpsideUsd - bridgeFeeUsd - gasUsd - riskBufferUsd`

Only recommend a cross-chain move when `netEdgeUsd` stays positive after costs and uncertainty.

## Trader-Grade Execution Gates

Use these additive gates before any workflow becomes a recommendation. They are meant to make "wait" and "no trade" first-class outcomes.

### Spot, Bridge, And Airdrop Routes

Before asking for approval, classify the route:

- Green: positive net edge, fresh quote, known spender, stable output across two quotes, no high-severity risk flag.
- Yellow: positive but thin edge, bridge leg involved, volatile token, quote drift, or gas consumes more than 20% of expected upside.
- Red: stale quote, unknown spender, excessive allowance, negative net edge, depeg risk, route outside allowlist, or unclear user goal.

Default behavior: Green can proceed to confirmation, Yellow should monitor or re-check unless the user explicitly values speed, and Red must halt unless the action is a reduce or exit path.

For size-sensitive routes, quote twice 10-20 seconds apart. If expected output deteriorates by more than the user's slippage budget or 50 bps, whichever is smaller, refresh the plan and do not let the user sign the older quote.

### Hyperliquid Perps

Before any non-reduce-only order:

- Pull `get_futures_account` when margin state, open positions, or recent drawdown are unknown.
- Reject entries whose estimated liquidation price is inside 2x current ATR unless the order is an explicitly confirmed micro-hedge.
- Require a stop, invalidation, or reduce-only unwind rule before signature.
- For funding trades, show break-even hours after fees, expected slippage, carry decay, and funding flip risk.
- Prefer passive or limit execution when urgency is low; use market or IOC only when speed is worth the slippage.

Default behavior: do not average down. If a trade moves against the user, reassess, reduce, or cancel stale orders before adding exposure.

## Performance Feedback And Diagnostics

Every FarmDash workflow should support a feedback loop, even if execution happens in another skill.

Track at minimum:

- research timestamp
- execution timestamp
- protocol or asset selected
- expected output or payoff
- realized output or payoff
- fees paid
- slippage or spread paid
- reason for the action
- reason for any override or rejection

Calibration rules:

- Reduce confidence when realized outcomes consistently trail forecasts.
- Reduce autonomy when recent swaps or orders cluster near guardrails.
- Prefer `no_trade` or `analysis_only` when data freshness or execution quality degrades.
- Promote protocols and strategies that continue to outperform after fees and bridge costs.

If the current tool surface does not return a dedicated calibration object, use `get_agent_performance`, quote deltas, and session logs as the evidence base. (`get_swap_history` is not a FarmDash tool on any surface — do not call it.)

## Social And Multi-Agent Notes

FarmDash does not yet expose native copy-trading or multi-agent coordination primitives through these skills.

Until that exists:

- treat reputation or vouching as informational, not execution authority
- never mirror another wallet blindly
- require the same local research and guardrail checks for copied ideas as for original ideas

## Core Principle

The right FarmDash agent outcome is not "always trade." The right outcome is:

- research when clarity is low
- prompt the user's zero-custody execution mode (`USER_SIGNED` default vs `BOUNDED_AUTONOMOUS` opt-in) before touching capital
- execute when the edge is real and every safety, simulation, and fee disclosure gate passes
- reconcile settlement honestly and stand down when the constraints say stop

## Official FarmDash Links

- [FarmDash DeFi Intelligence Website](https://www.farmdash.one/)
- [FarmDash Agent Hub](https://www.farmdash.one/agents)
- [Agent Integration Documentation](https://www.farmdash.one/docs)
- [Live Agent Capability Status](https://www.farmdash.one/api/v1/agent/status)
- [OpenAPI Contract](https://www.farmdash.one/agents/openapi.yaml)
- [Hosted Streamable HTTP MCP Endpoint](https://www.farmdash.one/api/mcp)
- [MCP Discovery Manifest](https://www.farmdash.one/.well-known/mcp.json)
- [Multi-Skill Workflow Catalog](https://www.farmdash.one/api/v1/agent/workflows)
- [Fees and Commercial Terms](https://www.farmdash.one/fees)
- [Security and Authority Boundaries](https://www.farmdash.one/security)
