import type { PricingRule } from './types'

// Phase 1: a single no-op rule so the engine is exercised but pricing stays flat.
// Loyalty/surge rules arrive in Phase 2 — do not add them here yet.
export const passthrough: PricingRule = {
  name: 'passthrough',
  apply: (_ctx, current) => ({ amount: current, note: 'flat' }),
}
