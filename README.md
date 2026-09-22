# FarmDash OpenClaw Skills

## Public FarmDash MCP server

This repository includes the runnable MIT-licensed FarmDash stdio MCP adapter in [`mcp-server/`](./mcp-server). It exposes the same 84-tool contract published at `https://www.farmdash.one/.well-known/mcp.json` and calls the live FarmDash API without receiving customer private keys.

Build and verify from a clean checkout:

```bash
git clone https://github.com/Parmasanandgarlic/farmdash-openclaw-skills.git
cd farmdash-openclaw-skills
npm ci --prefix mcp-server
npm run build --prefix mcp-server
npm run smoke --prefix mcp-server
node mcp-server/dist/index.js
```

For MCP clients, configure `node` with the absolute path to `mcp-server/dist/index.js`. `FARMDASH_API_KEY` is optional for Scout. The package metadata uses `@farmdash/mcp-server`, but **do not use an npm install command until registry publication is independently verified**. Public source + Docker are the current installable surfaces.


10 open agent skills for DeFi intelligence on [FarmDash](https://www.farmdash.one/agents) — read-only, zero-custody, fail-closed. No private keys, no seed phrases, no auto-execution. Ever.

| Skill | What it does |
|---|---|
| `farmdash-trail-intelligence` | Rank DeFi protocols, airdrops, points programs; Trail Heat + FarmScore inputs; sybil-policy risk |
| `farmdash-signal-architect` | Swap planning with explicitly user-signed payloads (EIP-191/EIP-712) |
| `farmdash-futures-strategist` | Perps planning with explicitly user-signed payloads |
| `farmdash-hedge-warden` | Hedge design and risk guards |
| `farmdash-ledger-keeper` | Portfolio books and position tracking |
| `farmdash-supply-master` | Supply / liquidity stewardship |
| `farmdash-trail-marshal` | Rotation planning across trails |
| `farmdash-wagon-steward` | Wagon (portfolio convoy) stewardship |
| `farmdash-camp-guard` | Safety policy enforcement |
| `farmdash-autonomous-operator` | Supervised operator routines (human-gated) |

`FARMDASH_AGENT_OPERATING_MODEL.md` is the shared operating contract all ten skills run under.

## Install

Copy any skill directory into your agent's skills path (e.g. OpenClaw / Claude Code skills), or point your harness at this repo. Each skill is self-contained: `SKILL.md` (agent manual) + `SKILL.json` (tool manifest).

## API access

- Scout tier: free, keyless (`fd_scout_free`), 30 req/24h per IP. New agents can also receive a bounded first-value grant for eligible cheap discovery routes so shared cloud egress does not consume another principal's onboarding allowance.
- Pioneer/Syndicate: Bearer `FARMDASH_API_KEY` for higher limits and deep tools.
- MCP manifest: https://www.farmdash.one/.well-known/mcp.json
- OpenAPI: https://www.farmdash.one/agents/openapi.yaml

Commercial disclosure: skills may surface `farmdash.one/go/*` partner routes with mandatory disclosure; never on avoid-verdicts. Details: https://www.farmdash.one/fees.

## License

MIT — see [LICENSE](LICENSE).
