# Contributing to FarmDash Agent OS

This repository is the verified public distribution mirror of **FarmDash Agent OS** (`mcp-server` + 10 OpenClaw skills).

## Running Locally

Requires **Node.js 26.x** (`26.13.1` recommended):

```bash
cd mcp-server
npm ci
npm run build
npm run smoke
```

## Verification Expectations

All pull requests and releases are verified by automated CI (`MCP Server CI`) covering:
1. TypeScript compilation (`npm run build`).
2. Runtime MCP tool-introspection smoke test (`npm run smoke`).
3. Upstream provenance and byte-parity verification (`UPSTREAM.json`).

## Reporting Bugs & Feature Requests

- Open an issue on this repository for MCP schema questions, client compatibility (Claude Desktop, Cursor, Antigravity, Codex, OpenClaw), or skill manual feedback.
- For live runtime status and execution gates, always check `https://www.farmdash.one/api/v1/agent/status` and `https://www.farmdash.one/execution-truth.json`.
