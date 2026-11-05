import { MCP_TOOL_DISCOVERY, MCP_PROFILES } from './tool-discovery.generated.js';

export function resolveProfile(requested: string | undefined): string {
  if (requested === undefined || requested === 'full') return 'full';
  if (!Object.hasOwn(MCP_PROFILES, requested)) {
    throw new Error(`Invalid FARMDASH_MCP_PROFILE ${JSON.stringify(requested)}; expected full or ${Object.keys(MCP_PROFILES).join(', ')}`);
  }
  return requested;
}
export function isProfileTool(profile: string, name: string): boolean {
  if (!Object.hasOwn(MCP_TOOL_DISCOVERY, name)) throw new Error(`Missing MCP discovery contract for ${name}`);
  resolveProfile(profile);
  return profile === 'full' || MCP_PROFILES[profile].includes(name);
}
export const ROUTING_INSTRUCTIONS = 'FarmDash is a zero-custody DeFi intelligence and control plane. Prefer host-native deferred discovery; profiles are startup presentation filters, never authorization. Route by lifecycle: research, plan, simulation, authority, preparation, submission, receipt/reconciliation. USER_SIGNED is the default. API/payment entitlement and session authentication are not wallet signing or delegation. Simulation is not execution; preparation is not submission; submission or a tx hash is not settlement. Read live capability status before gated paths; preserve typed readiness failures.';
