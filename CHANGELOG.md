# Changelog

All notable changes to **FarmDash Agent OS** (`mcp-server` + OpenClaw skills) are documented here.

## [5.0.0] - 2026-11-26

### Added
- **100% Parameter Documentation (Glama TDQS Upgrade):** Added explicit `.describe()` documentation to all 559 input parameters across all 98 registered MCP tools so AI models select and populate parameters with zero ambiguity.
- **Server-Side Schema Validation (`/api/mcp`):** Added structured JSON-RPC `-32602` (`Invalid params`) validation on hosted Streamable HTTP `tools/call` requests for malformed types, EVM/Solana address regexes, enums, bounds, and required execution/wallet/quote inputs.
- **Transparent Tool-Count Discovery:** Added `toolCountExplanation` to `GET /api/mcp` explaining the relationship between scoped hosted HTTP profiles (`research`, `spot-trader`, `futures-trader`, `full` = 61 live callable tools) and the 98-tool standalone stdio manifest.
- **Node 26 LTS Runtime Alignment:** Standardized `Dockerfile`, `package.json`, and `MCP Server CI` on Node `26.13.1`.
- **10 OpenClaw Skill Bundles:** Verified parity across Signal Architect, Futures Strategist, Trail Intelligence, Trail Marshal, Wagon Steward, Autonomous Operator, Camp Guard, Supply Master v3, Hedge Warden, and Ledger Keeper.

### Fixed
- Aligned `get_receipt` (`receiptId`), `get_agent_activity` (`intentId`), and `simulate_swap_execution` (`intentId`) tool descriptions with their exact camelCase schema parameter names.
- Updated `/.well-known/ai-plugin.json` to FarmDash v5.0 with live `solana_balances` and `composer_quote` endpoints.
- Enforced fail-closed zero-custody and capability-readiness invariants across all stdio and Streamable HTTP transports.
