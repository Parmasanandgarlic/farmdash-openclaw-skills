# Security Policy

## Zero-Custody Architecture

FarmDash Agent OS is strictly **zero-custody**:
- FarmDash **never** requests, accepts, transmits, or stores customer private keys, seed phrases, or mnemonic phrases.
- Default execution authority is **`USER_SIGNED`**: FarmDash researches, quotes, simulates, and returns unsigned payloads; the user's own wallet locally signs and broadcasts transactions.
- Optional **`BOUNDED_AUTONOMOUS`** workflows require explicit, owner-signed, revocable policy grants and remain strictly fail-closed against `/api/v1/agent/status` and `/execution-truth.json`.
- Commercial access (Scout, Pioneer, Syndicate, or x402 USDC) grants API capacity only — never wallet signing authority.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `5.x`   | Yes       |
| `< 5.0` | No        |

## Reporting a Vulnerability

Please report security issues responsibly via email to **michael@farmdash.one** with:
1. Affected endpoint, MCP tool name, or skill manifest.
2. Minimal reproduction steps (without funded mainnet transactions or real private keys).
3. Observed vs. expected fail-closed behavior.

We acknowledge security reports within 48 hours and publish remediation notes in `CHANGELOG.md`.
