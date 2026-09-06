---
name: FarmDash Hedge Warden
description: "Plan delta hedges for DeFi spot and yield positions using beta-aware short-perp targets, funding costs, residual delta, and safety gates."
tags: ["defi", "delta-hedging", "defi-hedging", "crypto-hedging", "portfolio-hedge", "perpetual-futures", "short-perp", "delta-neutral", "basis-risk", "funding-cost", "residual-delta", "risk-management", "yield-farming-risk", "openclaw", "ai-agent", "mcp", "farmdash"]
author: FarmDash Pioneers (@Parmasanandgarlic)
homepage: https://www.farmdash.one/agents
version: "1.1.1"
icon: hedge
env:
  FARMDASH_API_KEY:
    description: "Optional Bearer token for Pioneer or Syndicate tier."
    required: false
metadata: {"openclaw":{"homepage":"https://www.farmdash.one/agents","skillKey":"farmdash-hedge-warden","primaryEnv":"FARMDASH_API_KEY","execution":"read-only-hedge-plan"}}
---

# FarmDash Hedge Warden

Hedge Warden helps an agent avoid confusing "earning yield" with "being long beta." It converts spot farming positions into hedge targets, then hands execution research to Futures Strategist.

It never signs or submits perp orders.

## Tool

### `recommend_delta_hedge`

Inputs:

- `spotExposure`: array of `{ asset, notionalUsd, beta?, confidence? }`.
- `riskPreference`: `conservative`, `balanced`, or `aggressive`.
- `volatilityRegime`: `low`, `normal`, or `high`.
- `marketConditions`: optional external context from the agent.

Outputs:

- total spot notional.
- recommended hedge notional.
- per-asset short hedge legs.
- handoff instructions for Futures Strategist.
- invalidation rules.
- `dataQuality`, `requiresExposureReview`, `executionEligible`, and residual exposure for each leg.

Sizing formula: `spotNotionalUsd × beta × targetHedgeRatio`. Confidence never reduces the hedge notional. A confidence value below 0.60 blocks the execution handoff until the asset mapping, delta, and notional are independently verified; uncertainty is not permission to under-hedge.

## Agent Rules

- Treat this as a hedge plan, not a trade signal.
- Re-run if spot exposure changes by more than 10%.
- Re-run if volatility regime changes.
- Never execute from Hedge Warden output alone.
- Before execution, Futures Strategist must run `scan_market_conditions`, `get_futures_account`, `analyze_futures_strategy`, and `calculate_position_size`.
- If Futures Strategist says `no_trade`, the hedge is not executable.
- Net existing spot and perp exposure before sizing; this endpoint does not currently subtract existing hedges.
- Verify that the perp is a valid hedge instrument for the spot asset. Symbols alone do not prove correlation, redemption parity, or basis stability.
- Calculate expected funding and execution drag over the hedge horizon. A risk hedge may be justified with negative carry, but it must be labeled as insurance cost rather than positive edge.
- Use portfolio-level limits for asset, stablecoin, protocol, chain, venue, and correlated-factor concentration. Per-leg neutrality can still leave portfolio beta.
- Delta-neutral is a measured state, not a setup label. Verify actual fills and residual delta after both non-atomic legs settle.

## Standard Flow

1. Use Wagon Steward to measure spot exposure.
2. Use Trail Intelligence and Supply Master to understand why the spot leg exists.
3. Call `recommend_delta_hedge`.
4. Reconcile existing hedge inventory, correlation/basis, funding, liquidity, and the user's hedge horizon.
5. Hand only `executionEligible` legs to Futures Strategist for research and sizing.
6. Ask the user for explicit confirmation only after fresh futures research and sizing are complete.
7. After both non-atomic legs settle, re-read spot/perp state and report residual delta; if one leg fails, stop dependent actions and present the predefined unwind.

## Disclaimers

Hedges can lose money, over-hedge, under-hedge, or fail during volatile markets. Funding, liquidation risk, basis, and venue risk can erase yield. This skill is not financial advice.

**Install:** Copy this file into your OpenClaw workspace, or fetch `https://www.farmdash.one/openclaw-skills/farmdash-hedge-warden/SKILL.md`.

**Companion skills:** FarmDash Futures Strategist, FarmDash Wagon Steward, FarmDash Supply Master, FarmDash Camp Guard.

**Why FarmDash:** Unlike generic hedge advice, Hedge Warden sizes by spot-notional × beta × target-hedge-ratio, never lets confidence shrink the hedge, and blocks the execution handoff below 0.60 confidence until independently verified.

**FarmDash:** [DeFi hedging and risk intelligence](https://www.farmdash.one/)
**Agent Hub:** [FarmDash DeFi hedging agent tools](https://www.farmdash.one/agents)
**OpenAPI Spec:** [FarmDash API Schema](https://www.farmdash.one/agents/openapi.yaml)
**MCP Config:** [FarmDash MCP Server](https://www.farmdash.one/.well-known/mcp.json)

<!-- farmdash-canonical-links:start -->

## Official FarmDash Links

- [FarmDash DeFi intelligence website](https://www.farmdash.one/)
- [FarmDash Agent Hub](https://www.farmdash.one/agents)
- [Canonical FarmDash Hedge Warden skill manual](https://www.farmdash.one/openclaw-skills/farmdash-hedge-warden/SKILL.md)
- [Agent integration documentation](https://www.farmdash.one/docs)
- [Live agent capability status](https://www.farmdash.one/api/v1/agent/status)
- [OpenAPI contract](https://www.farmdash.one/agents/openapi.yaml)
- [MCP discovery manifest](https://www.farmdash.one/.well-known/mcp.json)
- [Fees and commercial terms](https://www.farmdash.one/fees)
- [Security and authority boundaries](https://www.farmdash.one/security)

<!-- farmdash-canonical-links:end -->
