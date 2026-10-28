import { z } from 'zod';
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const usd = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,8})?$/).refine(v => Number(v) > 0, 'USD limit must be positive');
export const FuturesPolicySchema = z.object({
  ownerAddress: address, agentAddress: address, apiWalletAddress: address, accountAddress: address,
  vaultAddress: address.nullable(), network: z.enum(['mainnet', 'testnet']), sessionId: z.string().min(1).max(128),
  allowedMarkets: z.array(z.string().regex(/^[A-Z0-9]{1,16}$/)).nonempty().max(50),
  allowedActions: z.array(z.enum(['futures.open', 'futures.reduce', 'futures.close', 'futures.cancel', 'futures.protective_order'])).nonempty().max(50),
  allowedOrderTypes: z.array(z.enum(['market', 'limit', 'stop_loss', 'take_profit', 'cancel'])).nonempty().max(50),
  allowedDirections: z.array(z.enum(['long', 'short'])).nonempty().max(50),
  maxOrderNotionalUsd: usd, maxAggregateExposureUsd: usd, maxSessionNewRiskNotionalUsd: usd,
  maxLeverage: z.number().int().min(1).max(100),
  maxRiskPerTrade: usd.describe('Conservative full-notional USD admission metric; not guaranteed realized loss'),
  maxSessionLossUsd: usd, maxDailyLossUsd: usd,
  validAfter: z.number().int().nonnegative().describe('Unix seconds'), validUntil: z.number().int().positive().describe('Unix seconds'),
  nonce: z.string().regex(/^[1-9]\d{0,77}$/), policyVersion: z.literal(1),
}).strict();
