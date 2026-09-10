# FarmDash OpenClaw Skills

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

- Scout tier: free, keyless (`fd_scout_free`), 5 req/24h — enough to try every skill.
- Pioneer/Syndicate: Bearer `FARMDASH_API_KEY` for higher limits and deep tools.
- MCP manifest: https://www.farmdash.one/.well-known/mcp.json
- OpenAPI: https://www.farmdash.one/agents/openapi.yaml

Commercial disclosure: skills may surface `farmdash.one/go/*` partner routes with mandatory disclosure; never on avoid-verdicts. Details: https://www.farmdash.one/fees.

## License

MIT — see [LICENSE](LICENSE).
