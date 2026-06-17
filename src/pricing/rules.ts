import type { PricingRule } from './types'

// Kept around (harmless) but no longer the active rule — see `loyalty` below.
export const passthrough: PricingRule = {
  name: 'passthrough',
  apply: (_ctx, current) => ({ amount: current, note: 'flat' }),
}

// Reward-only loyalty: a returning caller pays less. Never a surcharge.
// Every 5 prior purchases = +1 tier (capped at 3), each tier = 5% off (up to 15%).
export const loyalty: PricingRule = {
  name: 'loyalty',
  apply(ctx, current) {
    const tier = Math.min(3, Math.floor(ctx.history.purchases / 5)) // 0..3
    const discount = tier * 0.05 // up to 15% off
    return {
      amount: current * (1 - discount),
      note: tier ? `tier ${tier} −${Math.round(discount * 100)}%` : 'new caller',
    }
  },
}
