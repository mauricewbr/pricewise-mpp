import type { PricingContext, PricingRule } from './types'
export function priceFor(ctx: PricingContext, base: number, rules: PricingRule[]) {
  let amount = base
  const breakdown = [{ amount: base, note: 'base' }]
  for (const rule of rules) {
    const adj = rule.apply(ctx, amount)
    amount = adj.amount
    breakdown.push({ amount: adj.amount, note: `${rule.name}: ${adj.note}` })
  }
  return { amount: Math.max(0.01, Math.round(amount * 1e4) / 1e4), breakdown }
}
