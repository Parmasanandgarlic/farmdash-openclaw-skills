---
name: FarmDash Ledger Keeper
description: "Reconcile FarmDash DeFi activity, transaction records, fees, and CSV exports without inventing fills, realized P&L, or tax treatment."
tags: ["defi", "defi-accounting", "crypto-accounting", "transaction-ledger", "portfolio-reconciliation", "trade-history", "fee-tracking", "pnl-tracking", "csv-export", "tax-records", "onchain-accounting", "post-trade-analysis", "read-only", "openclaw", "ai-agent", "mcp", "farmdash"]
author: FarmDash Pioneers (@Parmasanandgarlic)
homepage: https://www.farmdash.one/agents
version: "1.1.1"
icon: ledger
env:
  FARMDASH_API_KEY:
    description: "Bearer token for Pioneer or Syndicate tier."
    required: false
metadata: {"openclaw":{"homepage":"https://www.farmdash.one/agents","skillKey":"farmdash-ledger-keeper","primaryEnv":"FARMDASH_API_KEY","execution":"read-only-ledger"}}
---

# FarmDash Ledger Keeper

Ledger Keeper is the post-trade review skill. Use it after swaps, hedges, rotations, or autonomous sessions to reconcile recorded activity and export clean records.

It does not execute trades. It does not produce tax advice.

## Tools

### `ledger_realized_pnl`

The tool name is retained for client compatibility. The current response is an activity-and-cost reconciliation and explicitly returns `realizedPnlUsd: null`; it is not realized P&L.

Inputs:

- `agentAddress`
- optional `start`
- optional `end`

Outputs:

- spot event count.
- confirmed spot event count.
- spot volume.
- recorded execution costs.
- futures event count and estimated notional when event records exist.
- recent rows for review.
- `calculationScope: recorded_activity_and_costs_only` and completeness fields.

A transaction hash counts as broadcast, not confirmation. Only `settlement_status: confirmed` counts as a confirmed spot event. Futures notional includes submitted `order_submitted` events only and is not a fill, exposure, or P&L measure.

### `ledger_tax_export`

Exports recorded spot execution rows as CSV with:

- agent address.
- date.
- protocol.
- from token.
- to token.
- volume.
- recorded cost.
- tx hash.
- chain id.

Futures activity requires venue fills for tax-lot accounting and is not represented as tax-ready lots by this skill.

## Standard Flow

1. After execution, call `ledger_realized_pnl` for the active date range.
2. Compare the ledger summary to Wagon Steward's current portfolio view.
3. If the user asks for records, call `ledger_tax_export`.
4. Tell the user the export is informational and should be reviewed by a qualified professional.

## Agent Rules

- Never infer tax treatment from protocol labels.
- Never call estimated notional a realized gain or loss.
- Never infer fills from submitted orders, or confirmation from a transaction hash.
- Realized P&L requires authoritative fills, closed P&L, funding, venue fees, gas, transfers, and cost-basis methodology. If any are absent, return unavailable rather than zero.
- Reconcile opening inventory + transfers + trades + income - fees against closing inventory. Report unexplained residuals before discussing performance.
- Never hide missing-table or degraded-source warnings.
- Do not mix ledger review with execution confirmation.

## Disclaimers

Ledger Keeper provides informational records only. It is not tax, legal, accounting, or investment advice.

**Install:** Copy this file into your OpenClaw workspace, or fetch `https://www.farmdash.one/openclaw-skills/farmdash-ledger-keeper/SKILL.md`.

**Companion skills:** FarmDash Signal Architect, FarmDash Futures Strategist, FarmDash Wagon Steward, FarmDash Trail Marshal.

**FarmDash:** [DeFi portfolio and transaction intelligence](https://www.farmdash.one/)
**Agent Hub:** [FarmDash DeFi accounting agent tools](https://www.farmdash.one/agents)
**OpenAPI Spec:** [FarmDash API Schema](https://www.farmdash.one/agents/openapi.yaml)
**MCP Config:** [FarmDash MCP Server](https://www.farmdash.one/.well-known/mcp.json)

<!-- farmdash-canonical-links:start -->

## Official FarmDash Links

- [FarmDash DeFi intelligence website](https://www.farmdash.one/)
- [FarmDash Agent Hub](https://www.farmdash.one/agents)
- [Canonical FarmDash Ledger Keeper skill manual](https://www.farmdash.one/openclaw-skills/farmdash-ledger-keeper/SKILL.md)
- [Agent integration documentation](https://www.farmdash.one/docs)
- [Live agent capability status](https://www.farmdash.one/api/v1/agent/status)
- [OpenAPI contract](https://www.farmdash.one/agents/openapi.yaml)
- [MCP discovery manifest](https://www.farmdash.one/.well-known/mcp.json)
- [Fees and commercial terms](https://www.farmdash.one/fees)
- [Security and authority boundaries](https://www.farmdash.one/security)

<!-- farmdash-canonical-links:end -->
