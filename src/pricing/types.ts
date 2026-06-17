export interface PricingContext {
  source?: `0x${string}`
  resource: string
  now: Date
  recentRequests: number
  history: { purchases: number; totalSpend: number }
}
export interface Adjustment { amount: number; note: string }
export interface PricingRule {
  name: string
  apply(ctx: PricingContext, current: number): Adjustment
}
