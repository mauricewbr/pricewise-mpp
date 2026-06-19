import type { PricingRule } from './types'
import { getActivePlan, priceUnitsForCount } from './plan'

// Kept around (harmless) but no longer the active rule — see `loyalty` below.
export const passthrough: PricingRule = {
  name: 'passthrough',
  apply: (_ctx, current) => ({ amount: current, note: 'flat' }),
}

// Reward-only loyalty, read from the CURRENT ACTIVE PLAN at price-computation time
// (no hardcoded schedule). The discounted price for a wallet is the highest tier whose
// threshold <= its settled-purchase count, else the plan's base price. Same plan the
// facet and the source-binding read — so advertised tiers can't drift from what settles.
export const loyalty: PricingRule = {
  name: 'loyalty',
  apply(ctx, _current) {
    const plan = getActivePlan()
    const count = ctx.history.purchases
    const priceUnits = priceUnitsForCount(plan, count)
    // Which tier matched, for the human-readable note.
    let tierIdx = 0
    plan.tiers.forEach((t, i) => {
      if (count >= t.threshold) tierIdx = i + 1
    })
    const amount = priceUnits / 1e6
    const pct = Math.round((1 - priceUnits / plan.basePrice) * 100)
    return {
      amount,
      note: tierIdx ? `tier ${tierIdx} −${pct}%` : 'new caller',
    }
  },
}
