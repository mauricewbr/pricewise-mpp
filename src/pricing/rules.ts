import type { PricingRule } from './types'

/** Standard per-call price in pathUSD (the worst-case / base price). */
export const BASE_PRICE = 0.1

/**
 * Loyalty parameters — the single source of truth for the discount ladder.
 * The rule below and the discovery `x-loyalty` extension both derive from these,
 * so the advertised tiers can never drift from the runtime pricing.
 */
export const LOYALTY = {
  step: 5, // settled purchases per tier
  maxTier: 3, // tier cap
  discountPerTier: 0.05, // 5% per tier (so max 15% off)
} as const

// Kept around (harmless) but no longer the active rule — see `loyalty` below.
export const passthrough: PricingRule = {
  name: 'passthrough',
  apply: (_ctx, current) => ({ amount: current, note: 'flat' }),
}

// Reward-only loyalty: a returning caller pays less. Never a surcharge.
// Every `step` prior purchases = +1 tier (capped at `maxTier`), each tier = `discountPerTier` off.
export const loyalty: PricingRule = {
  name: 'loyalty',
  apply(ctx, current) {
    const tier = Math.min(LOYALTY.maxTier, Math.floor(ctx.history.purchases / LOYALTY.step))
    const discount = tier * LOYALTY.discountPerTier
    return {
      amount: current * (1 - discount),
      note: tier ? `tier ${tier} −${Math.round(discount * 100)}%` : 'new caller',
    }
  },
}
