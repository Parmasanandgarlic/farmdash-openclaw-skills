> **Public installability:** this directory is the runnable, MIT-licensed FarmDash stdio MCP server. The npm package name `@farmdash/mcp-server` is reserved by this package metadata but is **not advertised as published** until a registry release is independently verified. Build from this public source today.

# FarmDash MCP Server (source distribution)

FarmDash Agent OS MCP Server (v5.0.0) provides 94 capability-labeled DeFi research, risk, simulation, and zero-custody workflow tools via [Model Context Protocol](https://modelcontextprotocol.io). The authoritative canonical catalog is generated from registrations in `src/index-base.ts` and the committed runtime schema snapshot.

> **Current capability contract:** Read the generated table below and [canonical execution truth](https://www.farmdash.one/execution-truth.json), then check live `/api/v1/agent/status`. Operational implementation readiness is not funded production proof or authorization. USER_SIGNED requires customer-local signing; bounded execution additionally requires a domain-specific owner policy and agent-local signature, authenticated exact-principal binding, simulation, budget, replay and reconciliation checks. FarmDash never receives the customer key.

## Quick Start

```bash
git clone https://github.com/Parmasanandgarlic/farmdash-openclaw-skills.git
cd farmdash-openclaw-skills/mcp-server
npm ci
npm run build
npm run smoke
```

## Client Configuration

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "farmdash": {
      "command": "node",
      "args": ["/absolute/path/to/farmdash-openclaw-skills/mcp-server/dist/index.js"]
    }
  }
}
```

Scout needs no API key, so no `env` block is required. Add one only to run a paid tier:

```json
    "env": {
      "FARMDASH_API_KEY": "your-pioneer-or-syndicate-bearer-token"
    }
```

### Cursor

Add to Cursor Settings > MCP:

```json
{
  "farmdash": {
    "command": "node",
    "args": ["/absolute/path/to/farmdash-openclaw-skills/mcp-server/dist/index.js"]
  }
}
```

### Cline

Add to `.cline/mcp_settings.json`:

```json
{
  "mcpServers": {
    "farmdash": {
      "command": "node",
      "args": ["/absolute/path/to/farmdash-openclaw-skills/mcp-server/dist/index.js"]
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FARMDASH_API_KEY` | No | unset | Omit for Scout. Set only a real paid bearer token via secure client configuration; any non-empty value is sent as an Authorization credential. Never use placeholders or wallet keys. |
| `FARMDASH_BASE_URL` | No | `https://www.farmdash.one/api` | Override the API base URL. |

Leave `FARMDASH_API_KEY` unset for Scout. Eligible free routes have 30 requests per 24 hours per IP; catalog responses can be truncated/masked, and premium routes may require payment before quota is exhausted. Qualifying route-specific paid access controls full data. Parse the live 402 price/asset/network/proof and obey STOP_RETRYING; published 0.01 USDC default overage is not a universal price. The current repository default for session-control capacity is 0.02 USDC. Payment is not authority.

Two further optional variables exist for advanced integrations: `FARMDASH_SCOUT_GRANT` (an onboarding grant, normally attached in memory after `agent_onboard` returns one) and `FARMDASH_SKILL_ID` (OpenClaw skill attribution). Neither is needed for a normal client.

## Tool Highlights (94 Total)

This section groups principal canonical tools; it is not an inventory sum. Canonical registrations in `src/index-base.ts` and the committed schema snapshot define the 94-tool catalog. Inspect installed `tools/list` through tool discovery to retrieve the complete runtime catalog. `agent_onboard` reads live readiness before returning guidance; onboarding is not wallet authority or a required skill-registration step.

### Protocol Risk Analyzer — NEW in v5.0

| Tool | Tier | Description |
|------|------|-------------|
| `analyze_protocol_risk` | Pioneer+ | Deep risk analysis combining DeFiLlama on-chain signals with Trail Heat. Returns risk grade, TVL concentration, momentum decay, chain diversification, and historical trend signals. |

### Yield Strategy Simulator — NEW in v5.0

| Tool | Tier | Description |
|------|------|-------------|
| `simulate_yield_strategy` | Pioneer+ | Advanced portfolio simulation modeling allocations across the canonical protocol catalog using live DeFiLlama pool data and Trail Heat scoring. Returns projected allocations, yields, diversification score, and risk metrics. |

### Trail Heat Query — NEW in v5.0

| Tool | Tier | Description |
|------|------|-------------|
| `query_trail_heat` | Pioneer+ | Programmatic Trail Heat query with advanced filtering (score range, status, category, chain, hot), sorting, and pagination across the canonical protocol catalog. |

### Signal Architect

| Tool | Tier | Description |
|------|------|-------------|
| `get_trail_heat` | Scout+ | Evidence-labeled ranked protocol dataset (0-100 scoring; catalog heuristics and live quantitative scores are distinct) with optional filtering |
| `get_chain_breakdown` | Scout+ | Protocol distribution by blockchain |
| `get_swap_quote` | Any | Provider-neutral preview or explicit firm wallet-bound quote-intent, according to request mode; preview is not executable |
| `simulate_swap_execution` | Any | Mandatory pre-execution simulation for a quote intent |
| `find_capital_route` | Any | Lower-level live route quote preview across explicit token and chain inputs |
| `execute_swap` | Any (EIP-191) | Validate the signed, simulated request and return the exact transaction payload; FarmDash does not broadcast it |
| `confirm_swap` | Session-bound | Verify the canonical-chain receipt and exact server-committed fee fields |

### Agent Intelligence

| Tool | Tier | Description |
|------|------|-------------|
| `audit_sybil_risk` | Pioneer+ | Wallet cluster analysis (1-10 addresses, 0-100 risk) |
| `simulate_points` | Pioneer+ | Project FarmScore for hypothetical activity |
| `optimize_portfolio` | Pioneer+ | AI portfolio rebalancing recommendations |
| `get_historical_trailheat` | Pioneer+ | Trail Heat score history (up to 365 days) |
| `get_agent_events` | Pioneer+ | Real-time protocol event stream |
| `get_wallet_balances` | Pioneer+ | Multi-chain ERC-20 balances (10 networks) |
| `get_portfolio_summary` | Pioneer+ | Compact authoritative wallet portfolio summary |
| `get_position_health` | Pioneer+ | FarmDash activity and reputation health context; not realized P&L |
| `get_idle_capital` | Pioneer+ | Stable/native idle-capital view from the wallet portfolio |
| `get_token_prices` | Any | Live spot prices (up to 25 tokens) |
| `get_agent_performance` | Pioneer+ | FarmDash fee-event activity, costs, protocol diversity, and Trail Cred context; not realized P&L, win rate, or execution quality |

### Futures Strategist

Commercial access buys API capacity only; it never creates Hyperliquid signing authority. Scout is 30 requests / 24h, Pioneer is 1,500 / day, and Syndicate is 50,000 / day. Eligible x402 payments unlock one request under the route's published policy.

| Tool | Access | Description |
|------|--------|-------------|
| `scan_funding_rates` | Scout preview; Pioneer+ or its route-specific x402 for full response | Hyperliquid vs Binance/Bybit funding-rate arbitrage |
| `scan_market_conditions` | Scout+ | Technical indicators (EMA, RSI, MACD, ATR, BB, ADX) |
| `get_futures_account` | Pioneer+ or wallet-portfolio x402 | Positions, margin, equity, PnL, liquidation prices |
| `analyze_futures_strategy` | Pioneer+ or futures-strategy x402 | Full research pipeline; new-risk execution gate is valid for 60 seconds |
| `calculate_position_size` | Pioneer+ or futures-strategy x402 | Risk-based sizing with guardrail enforcement |
| `execute_perp_order` | Scout capacity or paid capacity + EIP-712 authority | Forwards a user-signed Hyperliquid order; FarmDash never signs |
| `cancel_perp_order` | Scout capacity or paid capacity + EIP-712 authority | Forwards a user-signed cancellation; no prior FarmDash order required |

### Virtuals ACP Tender Coordination

| Tool | Tier | Description |
|------|------|-------------|
| `hire_virtuals_specialist` | Authenticated session | Legacy V1 draft preparation retained for controlled compatibility; new V1 creation is disabled by default. New integrations use the allowlisted V2 tools below. |
| `select_virtuals_provider_plan_v2` | Authenticated allowlisted session | Selects a policy-bound, independently verified three-role provider committee from live registry observations; cannot authorize or spend. |
| `prepare_virtuals_tender_v2` | Authenticated allowlisted session | Prepares tenant-bound immutable ACP evidence and Base V2 approval data without accepting task plaintext or granting spend authority. |
| `authorize_virtuals_tender_v2` | Authenticated session | Verifies deployment/provider readiness and an exact customer-wallet Base V2 signature. |
| `get_virtuals_tender` | Authenticated session | Reads tenant-scoped commitments, funding reservations, settlement attempts, and receipt observations. |
| `cancel_virtuals_tender` | Authenticated session | Cancels only a non-spendable draft. |
| `bind_virtuals_tender_job` | Authenticated session | Verifies and binds an already customer-created Base ACP job. |
| `reserve_virtuals_tender_funding_v2` | Authenticated session | Reserves one exact role budget against the signed cap; cannot spend customer funds. |
| `record_virtuals_tender_funding_v2` | Authenticated session | Records hashes after the customer wallet submits reserved funding; cannot submit transactions. |
| `evaluate_virtuals_tender` | Authenticated session | Evaluates a fully bound/funded V2 committee or resumes typed settlement observation. |

## Resources

The server exposes two OpenAPI specifications as MCP resources:

- `farmdash://openapi.yaml` — Signal Architect core spec
- `farmdash://futures-openapi.yaml` — Futures Strategist spec

## Authentication

### Swap Execution (EIP-191)

```
Message: v1:FARMDASH_SWAP:{fromChainId}:{toChainId}:{fromToken}:{toToken}:{fromAmount}:{agentAddress}:{toAddress}:{nonce}
Signing: personal_sign (EIP-191)
Nonce:   Unix timestamp in milliseconds (60-second validity window)
Gate:    execute_swap requires a fresh successful simulate_swap_execution result
```

### Futures Orders (EIP-712)

```
Signing: EIP-712 typed data (Hyperliquid domain)
Gate:    New-risk research evidence has a 60-second validity window; reduce-only exemptions do not bypass authority
```

### Virtuals ACP Tender (EIP-712)

New integrations use the V2 sequence: `select_virtuals_provider_plan_v2`, `prepare_virtuals_tender_v2`, `authorize_virtuals_tender_v2`, customer-local job creation, `bind_virtuals_tender_job`, `reserve_virtuals_tender_funding_v2`, customer-local funding, `record_virtuals_tender_funding_v2`, and `evaluate_virtuals_tender`. The exact V2 approval binds task, disclosure, evidence, provider-plan, economic-policy, evaluator, cap, nonce, and expiry commitments. FarmDash is a separately registered evaluator and can settle only jobs that independently verify to the customer client, committed provider, confirmed funding ledger, structured V2 evidence, deterministic simulation gate, and canonical Base receipts. `hire_virtuals_specialist` is a legacy V1 compatibility path and V1 creation is disabled by default.

## Capability prerequisites

<!-- capability-truth:start -->
<!-- Generated by scripts/generate-capability-truth.mjs. -->
| Capability | Canonical status |
| --- | --- |
| spot.USER_SIGNED | operational |
| spot.BOUNDED_AUTONOMOUS | operational |
| futures.USER_SIGNED | operational |
| futures.BOUNDED_AUTONOMOUS | operational |
| solana.USER_SIGNED | operational |
| solana.BOUNDED_AUTONOMOUS | operational |
| ERC4337_SERVER_SUBMISSION | preparation_only |
| GENERIC_SERVER_INTENT_EXECUTION | preparation_only |
| MEE | preparation_only |
| ACP | deployment_prerequisite |
<!-- capability-truth:end -->

Generic execution and MEE retain their verifier/coordinator prerequisites; a configured bundler cannot qualify ERC-4337 public tenant authority by itself. ACP V2 remains deployment-prerequisite gated; inspect its exact live readiness checks before treating the sequence described here as a paid service. Webhooks require their migration, `WEBHOOK_ENCRYPTION_KEY`, `CRON_SECRET`, and the scheduled durable worker. Commercial capacity and execution authority are separate.

Sessions are Pioneer+ or eligible x402 capacity, with separate target-bound session authentication. Source-contract states are active/paused and terminal halted/expired; heartbeat expiry is 24 hours. Pause leaves positions in place. Close/kill await grant revocation; session controls are not venue delegation or owner policy.

## Guardrails (Server-Enforced)

The Futures Strategist enforces hard limits that cannot be overridden:

| Guardrail | Limit |
|-----------|-------|
| Max leverage | 5x |
| Max risk per trade | 2% of equity |
| Daily loss limit | -3% |
| Circuit breaker | -15% total |
| Position concentration | 20% max per asset |

## Pricing Tiers

| Tier | Price | Rate Limit | Key Features |
|------|-------|------------|--------------|
| **Scout** | Free | 30 req/24h | Swap quotes, top 3 Trail Heat, market conditions |
| **Pioneer** | $39.99/mo USDC | 1,500/day | Full dataset, sybil audits, strategy analysis, balances |
| **Syndicate** | $199/mo USDC | 50,000/day | High-volume capacity; signed order/cancel capacity is also available to Scout; webhook delivery remains deployment-prerequisites-gated |

## Providers and execution chains

LI.FI and Relay are enabled/configured/firm_quote_ready. 0x is operator-paused, disabled, and excluded from primary/fallback; OKX is quarantined. x402 is a payment/access rail, never a swap provider. EVM compatibility chains are Ethereum 1, Optimism 10, Polygon 137, Base 8453, Arbitrum 42161, and Linea 59144; private submission is unsupported. Status labels are not funded transaction proofs.

## Fee Model

- **Swap fee** (combined routing target; LI.FI 25 bps platform component deducted, not stacked; gas/slippage excluded): 50 bps under $10K, 40 bps at $10K+, 35 bps at $100K+, 20 bps at $1M+
- **Treasury**: `0xb0Ed0d7bca24BBaD635B977C2efbE06742e33377`

## What's New in v5.0

- **`analyze_protocol_risk`** — Deep risk analysis pulling live DeFiLlama signals (TVL, momentum, chain diversification, 30-day historical trends) combined with Trail Heat scoring. Returns composite risk grade (low/moderate/elevated/high/critical) with actionable danger/warning/info signals.
- **`simulate_yield_strategy`** — Advanced portfolio simulation combining Wagon Steward wallet intelligence with Supply Master yield data. Models allocations across the canonical protocol catalog, projects yields, calculates diversification scores, and flags high-risk concentrations.
- **`query_trail_heat`** — Programmatic Trail Heat query endpoint with advanced filtering (score range, status, category, chain, hot flag), sorting (score/tvl/name/change7d), and pagination. Retains methodology/freshness labels instead of presenting catalog heuristics as guaranteed live data.
- **Enhanced `get_trail_heat`** — Now accepts optional `protocolId`, `category`, `top`, and `hot` filter parameters for quick filtered queries without switching to `query_trail_heat`.

## Architecture

- **Transport**: stdio (client spawns process, communicates via stdin/stdout)
- **Runtime**: Node.js (ES2022, ESM)
- **Dependencies**: `@modelcontextprotocol/sdk`, `zod` (runtime validation)
- **Error handling**: Dust Storm pattern — typed degraded failures; never label missing financial data as success
- **Timeout**: 15s default per API call (25s for yield simulation)

## Development

```bash
npm run dev      # Watch mode (auto-rebuild on changes)
npm run build    # Production build
npm run start    # Run server directly
```

## Links

- [FarmDash Agents Hub](https://www.farmdash.one/agents)
- [Signal Architect OpenAPI (54 primary operations)](https://www.farmdash.one/agents/swap/openapi.yaml)
- [Futures Strategist OpenAPI (12 operations)](https://www.farmdash.one/agents/futures/openapi.yaml)
- [Canonical OpenAPI Suite (75 total operations across 4 documents)](https://www.farmdash.one/agents/openapi.yaml)
- [Agent Report](https://www.farmdash.one/agent-report.md)
- [llms.txt](https://www.farmdash.one/llms.txt)

## License

MIT

### Redirect security

Configure `FARMDASH_BASE_URL` as the final API origin, normally `https://www.farmdash.one/api`. The MCP client rejects redirects, including same-origin redirects, with a non-retryable `redirect_policy_blocked` error. A custom `fetchImpl` is trusted transport code and must honor the standard Fetch `redirect: "manual"` option; a replacement that ignores it can send data before the client can inspect the response.
