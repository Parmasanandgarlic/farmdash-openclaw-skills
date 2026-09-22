> **Public installability:** this directory is the runnable, MIT-licensed FarmDash stdio MCP server. The npm package name `@farmdash/mcp-server` is reserved by this package metadata but is **not advertised as published** until a registry release is independently verified. Build from this public source today.

# FarmDash MCP Server (source distribution)

FarmDash Agent OS MCP Server (v5.0.0) - 84 tools for DeFi intelligence, protocol risk analysis, yield strategy simulation, and policy-bounded zero-custody workflows via [Model Context Protocol](https://modelcontextprotocol.io).

> Registry status (verified 2026-08-23): `@farmdash/mcp-server` is not published on the public npm registry. Use the source installation below. Do not present a registry quickstart unless a future release is independently visible on npm.

## Quick Start

```bash
git clone https://github.com/Parmasanandgarlic/farmdash-openclaw-skills/tree/main/mcp-server.git
cd farmdashbeta/mcp-server
npm ci
npm run build
```

## Client Configuration

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "farmdash": {
      "command": "node",
      "args": ["/absolute/path/to/farmdashbeta/mcp-server/dist/index.js"],
      "env": {
        "FARMDASH_API_KEY": "your-pioneer-or-syndicate-key"
      }
    }
  }
}
```

### Cursor

Add to Cursor Settings > MCP:

```json
{
  "farmdash": {
    "command": "node",
    "args": ["/absolute/path/to/farmdashbeta/mcp-server/dist/index.js"],
    "env": {
      "FARMDASH_API_KEY": "your-key"
    }
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
      "args": ["/absolute/path/to/farmdashbeta/mcp-server/dist/index.js"],
      "env": {
        "FARMDASH_API_KEY": "your-key"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FARMDASH_API_KEY` | No | `fd_scout_free` | Public Scout token, or a paid Pioneer/Syndicate bearer token. Paid users can issue a key at `/api/v1/agent/api-key`. |

Scout mode is the fastest path: build the MCP server from source and leave `FARMDASH_API_KEY` unset, or set it to `fd_scout_free` if your client requires an env value. When Scout reaches 30 requests per 24 hours, FarmDash returns a 402 response with route-specific x402 payment details. The configured default overage is 0.01 USDC; premium reports and compute-heavy routes publish their own price in the 402 response.
| `FARMDASH_BASE_URL` | No | `https://www.farmdash.one/api` | Override API base URL. |

## Tool Highlights (84 Total)

This section groups the principal tools. The authoritative count is the 84 `server.tool(...)` registrations in `src/index.ts`; MCP clients can retrieve the complete runtime catalog through tool discovery. Run `agent_onboard` first: it fetches the live `/api/v1/agent/status` readiness contract before returning onboarding guidance.

### Protocol Risk Analyzer (1 tool) — NEW in v5.0

| Tool | Tier | Description |
|------|------|-------------|
| `analyze_protocol_risk` | Pioneer+ | Deep risk analysis combining DeFiLlama on-chain signals with Trail Heat. Returns risk grade, TVL concentration, momentum decay, chain diversification, and historical trend signals. |

### Yield Strategy Simulator (1 tool) — NEW in v5.0

| Tool | Tier | Description |
|------|------|-------------|
| `simulate_yield_strategy` | Pioneer+ | Advanced portfolio simulation allocating capital across 81+ protocols using live DeFiLlama pool data and Trail Heat scoring. Returns projected allocations, yields, diversification score, and risk metrics. |

### Trail Heat Query (1 tool) — NEW in v5.0

| Tool | Tier | Description |
|------|------|-------------|
| `query_trail_heat` | Pioneer+ | Programmatic Trail Heat query with advanced filtering (score range, status, category, chain, hot), sorting, and pagination across 81+ protocols. |

### Signal Architect (7 principal tools)

| Tool | Tier | Description |
|------|------|-------------|
| `get_trail_heat` | Scout+ | Ranked protocol dataset (81+ protocols, 0-100 scoring) with optional filtering |
| `get_chain_breakdown` | Scout+ | Protocol distribution by blockchain |
| `get_swap_quote` | Any | Preview swap quote with fee breakdown, routing, and wallet-bound simulation intent |
| `simulate_swap_execution` | Any | Mandatory pre-execution simulation for a quote intent |
| `find_capital_route` | Any | Lower-level live route quote preview across explicit token and chain inputs |
| `execute_swap` | Any (EIP-191) | Validate the signed, simulated request and return the exact transaction payload; FarmDash does not broadcast it |
| `confirm_swap` | Session-bound | Verify the canonical-chain receipt and exact server-committed fee fields |

### Agent Intelligence (11 principal tools)

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

### Futures Strategist (7 tools)

| Tool | Tier | Description |
|------|------|-------------|
| `scan_funding_rates` | Scout+ | Hyperliquid vs Binance/Bybit funding rate arbitrage |
| `scan_market_conditions` | Scout | Technical indicators (EMA, RSI, MACD, ATR, BB, ADX) |
| `get_futures_account` | Pioneer+ | Positions, margin, equity, PnL, liquidation prices |
| `analyze_futures_strategy` | Pioneer+ | Full research pipeline with strategy recommendation |
| `calculate_position_size` | Pioneer+ | Risk-based sizing with guardrail enforcement |
| `execute_perp_order` | Syndicate | EIP-712 signed Hyperliquid order execution |
| `cancel_perp_order` | Syndicate | Batch cancel up to 50 orders |

### Virtuals ACP Tender Coordination (10 tools)

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
Gate:    analyze_futures_strategy must be called within 5 minutes
```

### Virtuals ACP Tender (EIP-712)

New integrations use the V2 sequence: `select_virtuals_provider_plan_v2`, `prepare_virtuals_tender_v2`, `authorize_virtuals_tender_v2`, customer-local job creation, `bind_virtuals_tender_job`, `reserve_virtuals_tender_funding_v2`, customer-local funding, `record_virtuals_tender_funding_v2`, and `evaluate_virtuals_tender`. The exact V2 approval binds task, disclosure, evidence, provider-plan, economic-policy, evaluator, cap, nonce, and expiry commitments. FarmDash is a separately registered evaluator and can settle only jobs that independently verify to the customer client, committed provider, confirmed funding ledger, structured V2 evidence, deterministic simulation gate, and canonical Base receipts. `hire_virtuals_specialist` is a legacy V1 compatibility path and V1 creation is disabled by default.

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
| **Syndicate** | $199/mo USDC | 50K/day | Order execution, webhooks, batch operations, volume discounts |

## Fee Model

- **Swap fee**: 45 bps default, 35 bps at $10K+ volume, 25 bps at $100K+
- **Treasury**: `0xb0Ed0d7bca24BBaD635B977C2efbE06742e33377`

## What's New in v5.0

- **`analyze_protocol_risk`** — Deep risk analysis pulling live DeFiLlama signals (TVL, momentum, chain diversification, 30-day historical trends) combined with Trail Heat scoring. Returns composite risk grade (low/moderate/elevated/high/critical) with actionable danger/warning/info signals.
- **`simulate_yield_strategy`** — Advanced portfolio simulation combining Wagon Steward wallet intelligence with Supply Master yield data. Allocates capital across 81+ protocols, projects yields, calculates diversification scores, and flags high-risk concentrations.
- **`query_trail_heat`** — Programmatic Trail Heat query endpoint with advanced filtering (score range, status, category, chain, hot flag), sorting (score/tvl/name/change7d), and pagination. Makes the 81+ protocol coverage feel alive for agents.
- **Enhanced `get_trail_heat`** — Now accepts optional `protocolId`, `category`, `top`, and `hot` filter parameters for quick filtered queries without switching to `query_trail_heat`.

## Architecture

- **Transport**: stdio (client spawns process, communicates via stdin/stdout)
- **Runtime**: Node.js (ES2022, ESM)
- **Dependencies**: `@modelcontextprotocol/sdk`, `zod` (runtime validation)
- **Error handling**: Dust Storm pattern — graceful degradation, never crashes
- **Timeout**: 15s default per API call (25s for yield simulation)

## Development

```bash
npm run dev      # Watch mode (auto-rebuild on changes)
npm run build    # Production build
npm run start    # Run server directly
```

## Links

- [FarmDash Agents Hub](https://www.farmdash.one/agents)
- [Signal Architect OpenAPI](https://www.farmdash.one/agents/swap/openapi.yaml)
- [Futures Strategist OpenAPI](https://www.farmdash.one/agents/futures/openapi.yaml)
- [Agent Report](https://www.farmdash.one/agent-report.md)
- [llms.txt](https://www.farmdash.one/llms.txt)

## License

MIT
