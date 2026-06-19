import type { PricingContext, PricingRule } from './types'
export function priceFor(ctx: PricingContext, base: number, rules: PricingRule[]) {
  let amount = base
  const breakdown = [{ amount: base, note: 'base' }]
  for (const rule of rules) {
    const adj = rule.apply(ctx, amount)
    amount = adj.amount
    breakdown.push({ amount: adj.amount, note: `${rule.name}: ${adj.note}` })
  }
  // Round to base-unit precision (1e6), not 4 decimals. Stage 2 plan prices are exact
  // integer base-unit amounts; the old 4-decimal round / $0.01 floor would corrupt an
  // edited price that isn't a multiple of $0.0001. Floor at 1 base unit (validation
  // already guarantees every plan price is > 0).
  return { amount: Math.max(1e-6, Math.round(amount * 1e6) / 1e6), breakdown }
}
