# FarmDash Agent Operating Model

This document defines how FarmDash skills should compose when one agent needs research, execution, monitoring, and risk controls in the same workflow.

It does not add new MCP tools on its own. Instead, it standardizes how to use the existing FarmDash skill surface safely and predictably.

## Skill Roles

- `FarmDash Trail Intelligence` is the research and ranking layer.
- `FarmDash Signal Architect` is the swap, bridge, session, and orchestration layer.
- `FarmDash Futures Strategist` is the Hyperliquid perps research and execution layer.

Use them together as a pipeline, not as isolated products.

## Autonomous Agent Use-Case Map

Use this map before choosing individual tools. It keeps autonomous behavior grounded in a business purpose and a safety boundary.

| Use case | Primary goal | Core tools | Required posture |
|---|---|---|---|
| Bounded Autopilot | Run a recurring loop inside explicit budgets, allowlists, and cooldowns | `agent_onboard`, `create_session`, `configure_autopilot`, `autopilot_cycle`, `session_heartbeat` | Stop or switch to `analysis_only` when any bound is violated |
| Airdrop Rotation Desk | Detect when to enter, wait, rotate, or exit farming opportunities | `get_trail_heat`, `get_historical_trailheat`, `get_agent_events`, `simulate_points`, `get_swap_quote` | Treat "wait" as a valid action when edge is unclear |
| Cross-Chain ROI Gate | Decide whether a bridge is worth its cost and execution risk | `get_chain_breakdown`, `get_wallet_balances`, `get_token_prices`, `get_swap_quote`, `optimize_portfolio` | Bridge only when net expected edge remains positive |
| Perps Hedge Co-Pilot | Evaluate whether spot farming exposure needs a Hyperliquid hedge | `scan_funding_rates`, `scan_market_conditions`, `get_futures_account`, `analyze_futures_strategy`, `calculate_position_size` | Prefer `no_trade` when confidence, liquidity, or jurisdiction is unclear |
| Operator Reputation Loop | Review execution quality and prove agent reliability | `get_swap_history`, `get_agent_performance`, `check_reputation`, `vouch_for_agent` | Reputation is evidence, not permission to copy trades blindly |

## Sense -> Decide -> Act -> Learn Loop

Every autonomous workflow should be explainable as four stages:

1. Sense: refresh events, Trail Heat, chain distribution, balances, and market state.
2. Decide: rank actions by expected edge, sybil pressure, gas, bridge cost, quote freshness, and user constraints.
3. Act: execute only with a fresh quote, explicit approval or configured policy, and the required local signature.
4. Learn: compare expected vs realized output and reduce confidence or autonomy when outcomes degrade.

Persist at least: `sessionId`, research timestamp, quote timestamp, last action timestamp, configured limits, expected outcome, realized outcome, tx hashes, and request IDs.

## Cross-Skill Composition Patterns

### 1. Research -> Spot Entry -> Protocol Action

Use when the user wants a new farming position.

1. `get_trail_heat` to rank candidates.
2. `get_historical_trailheat` to confirm momentum.
3. `simulate_points` or `optimize_portfolio` to size the opportunity.
4. `get_wallet_balances` and `get_token_prices` to confirm budget.
5. `get_swap_quote` to acquire or bridge into the needed token.
6. `execute_swap` only after explicit approval.
7. Finish with the FarmDash `/go/{slug}` route for the protocol UI, plus commercial disclosure and `https://www.farmdash.one/fees`.

### 2. Research -> Hedge -> Monitor

Use when a farming position has directional risk.

1. Research the spot opportunity with Trail Intelligence.
2. Use `analyze_futures_strategy` to test whether a hedge is valid.
3. Use `calculate_position_size` to keep the hedge inside account guardrails.
4. Execute only after explicit approval and fee disclosure.
5. Review with `get_agent_performance` after the campaign or drawdown event.

### 3. Event -> Reprice -> Reallocate

Use when airdrops, snapshots, or TVL spikes change the expected payoff.

1. `get_agent_events` detects the trigger.
2. `get_trail_heat` and `get_historical_trailheat` confirm whether the move is durable.
3. `get_swap_quote` estimates the cost of repositioning.
4. `optimize_portfolio` checks whether the new allocation still fits the user goal.
5. If approved, execute the move and record the result for later review.

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

If the current tool surface does not return a dedicated calibration object, use `get_agent_performance`, `get_swap_history`, quote deltas, and session logs as the evidence base.

## Social And Multi-Agent Notes

FarmDash does not yet expose native copy-trading or multi-agent coordination primitives through these skills.

Until that exists:

- treat reputation or vouching as informational, not execution authority
- never mirror another wallet blindly
- require the same local research and guardrail checks for copied ideas as for original ideas

## Core Principle

The right FarmDash agent outcome is not "always trade." The right outcome is:

- research when clarity is low
- execute when the edge is real
- stand down when the constraints say stop
