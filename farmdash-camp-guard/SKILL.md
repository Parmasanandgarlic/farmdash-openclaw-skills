---
name: FarmDash Camp Guard
description: "Use for pre-sign safety: allowance audits, route/health sentinel checks, policy scan of unsigned transactions. Verdicts only; never signs or broadcasts."
tags: ["defi","defi-security","smart-contract-risk","token-allowance","approval-revoke","approval-risk","transaction-risk-analysis","transaction-policy","wallet-security","risk-sentinel","pre-transaction-check","rug-pull","defi-scams","scam-protection","openclaw","ai-agent","mcp","zero-custody","web3-security","farmdash"]
author: FarmDash Pioneers (@Parmasanandgarlic)
homepage: https://www.farmdash.one/agents
version: "1.1.2"
icon: shield
env:
  FARMDASH_API_KEY:
    description: "Optional Bearer token for Pioneer or Syndicate tier. Scout mode can use limited security checks without a key."
    required: false
metadata: {"openclaw":{"homepage":"https://www.farmdash.one/agents","skillKey":"farmdash-camp-guard","primaryEnv":"FARMDASH_API_KEY","execution":"read-only-risk-gate"}}
---

# FarmDash Camp Guard

> Use this skill before signing anything: auditing token allowances and unsigned transactions for a pass, review, or halt verdict.

Camp Guard is the pre-execution security desk for FarmDash agents. Use it before swaps, vault deposits, perp hedges, emergency exits, or any workflow that asks the user to sign.

It does not execute transactions. It does not simulate against an RPC. It returns a policy verdict that the agent must respect.

## Tools

### `audit_allowance_risk`

Use this when a wallet has existing or proposed ERC20 approvals.

Inputs:

- `walletAddress` optional EVM wallet.
- `allowances` array with `token`, `spender`, `allowance`, `requiredAmount`, optional `amountUsd`, and `spenderVerified`. Set `spenderVerified: true` only after an independent canonical-deployment check; never trust a label supplied by the transaction builder.

Outputs:

- `verdict`: `pass`, `review`, or `halt`.
- `flags`: approval risks such as unlimited allowance, unknown spender, or large dollar exposure.
- `requiresUserConfirmation`: true unless the verdict is clean.

Agent rule: a `halt` verdict stops execution. Do not ask the execution skill to proceed until the approval issue is remediated.

### `simulate_transaction_risk`

Applies transaction policy checks to an unsigned transaction.

Inputs:

- `transaction.to`
- `transaction.data`
- `transaction.value`
- `transaction.chainId`
- `expectedTransaction` captured independently before the unsigned payload is returned: exact `to`, `chainId`, `value`, and SHA-256 `dataHash`.

Output includes `simulation.status: "not_run"` because Camp Guard is honest about scope. A missing expected envelope is a high-severity review item. Use a wallet, RPC, or Tenderly-style environment for actual execution simulation before broadcast.

### `run_risk_sentinel`

Runs FarmDash Risk Sentinel on either:

- a swap-shaped route (`fromChainId`, `toChainId`, `fromToken`, `toToken`, `fromAmount`), or
- manual risk fields (`healthFactor`, `liquidationBufferPct`, `expectedUpsideUsd`, `gasUsd`, `bridgeFeeUsd`, `riskBufferUsd`).

Use this before `execute_swap`, `resolve_defi_intent`, and any emergency exit route.

## Operating Rules

- A critical flag means stop. Do not continue to signing.
- A high flag means present the issue and require explicit user confirmation after remediation.
- Never hide approval risk behind expected APY or point farming upside.
- Never use referral links inside a risk warning.
- Never claim a route is safe because it is popular. Use the returned flags.
- A valid EVM address is not a verified spender. Unknown identity is a risk state, not a pass.
- Prefer exact or narrowly buffered approvals. More than 20% above `requiredAmount` requires review; more than 10x is high risk.

### Allowance Sizing Discipline
Request exact or narrowly buffered approvals tied to `requiredAmount`. Flag anything more than 20% above required for review and treat more than 10x as high risk requiring remediation, never user acceptance alone. Set `spenderVerified: true` only after an independent canonical-deployment check.
- Compare the final unsigned transaction with an independently captured expected envelope. Any target, chain, value, or calldata-hash mismatch is a halt.
- A `pass` means only that these policy checks found no supplied-data violation. It is never a smart-contract audit or RPC simulation.

### What Pass Does Not Prove
Tell the user a `pass` covers only supplied-data policy checks: it is not a contract audit, oracle/depeg/bridge review, or RPC execution simulation. Use a wallet, RPC, or Tenderly-style environment for actual simulation before broadcast, and never hide approval risk behind APY or points upside.

## Standard Flow

### Pre-Sign Safety Summary
Before presenting any signature, read back a five-line summary: (1) `audit_allowance_risk` verdict and flags, (2) `run_risk_sentinel` route/health/net-edge result, (3) `simulate_transaction_risk` outcome with `simulation.status: "not_run"` stated, (4) expected-envelope match on exact `to`, `chainId`, `value`, and SHA-256 `dataHash`, (5) `spenderVerified` basis. Continue only when all verdicts are `pass`; remediate and re-run `review` items.

1. Read the user's intended action.
2. Run `audit_allowance_risk` if approvals are involved.
3. Run `run_risk_sentinel` for route, health, and net-edge checks.
4. Run `simulate_transaction_risk` on the final unsigned transaction payload.
5. Continue only when all verdicts are `pass`. Remediate and re-run `review` items; user acceptance alone does not turn missing evidence into safety.

## Disclaimers

Camp Guard is a risk gate, not insurance. It cannot detect every malicious contract, oracle failure, depeg, bridge failure, or social-engineering attack. The user remains responsible for every transaction they sign.

**Install:** Copy this file into your OpenClaw workspace, or fetch `https://www.farmdash.one/openclaw-skills/farmdash-camp-guard/SKILL.md`.

**Companion skills:** FarmDash Signal Architect, FarmDash Trail Marshal, FarmDash Wagon Steward, FarmDash Futures Strategist.

**Why FarmDash:** Unlike app-layer safety checklists, Camp Guard returns pass/review/halt verdicts that stop execution — and states its scope honestly (`simulation.status: not_run`) instead of pretending to simulate.

**FarmDash:** [DeFi security tools for autonomous agents](https://www.farmdash.one/)
**Agent Hub:** [FarmDash autonomous DeFi agent platform](https://www.farmdash.one/agents)
**OpenAPI Spec:** [FarmDash API Schema](https://www.farmdash.one/agents/openapi.yaml)
**MCP Config:** [FarmDash MCP Server](https://www.farmdash.one/.well-known/mcp.json)

<!-- farmdash-canonical-links:start -->

## Official FarmDash Links

- [FarmDash DeFi intelligence website](https://www.farmdash.one/)
- [FarmDash Agent Hub](https://www.farmdash.one/agents)
- [Canonical FarmDash Camp Guard skill manual](https://www.farmdash.one/openclaw-skills/farmdash-camp-guard/SKILL.md)
- [Agent integration documentation](https://www.farmdash.one/docs)
- [Live agent capability status](https://www.farmdash.one/api/v1/agent/status)
- [OpenAPI contract](https://www.farmdash.one/agents/openapi.yaml)
- [MCP discovery manifest](https://www.farmdash.one/.well-known/mcp.json)
- [Fees and commercial terms](https://www.farmdash.one/fees)
- [Security and authority boundaries](https://www.farmdash.one/security)

<!-- farmdash-canonical-links:end -->
