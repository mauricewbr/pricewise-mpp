// Stage 2 — the loyalty schedule as a runtime, session-editable plan.
//
// The engine, the discovery facet, and the source-binding all read the SINGLE active
// plan here (no second copy of the numbers anywhere). State is in-memory and session-
// scoped: it resets to DEFAULT_PLAN on every boot and is never persisted to disk, so a
// fat-fingered rehearsal edit can't leak into the live demo. The default reproduces
// stage-1 behaviour exactly (base 100000; tiers 5→95000, 10→90000, 15→85000).
//
// Prices and thresholds are in pathUSD base units (6 decimals): 100000 = $0.10.

export interface PlanTier {
  threshold: number // settled-purchase count to reach this tier
  price: number // discounted per-call price in base units
}

export interface PricingPlan {
  id: string
  name: string
  active: boolean
  basePrice: number // base-unit worst-case price
  tiers: PlanTier[] // ascending threshold, strictly descending price
}

export const DEFAULT_PLAN: PricingPlan = {
  id: 'default',
  name: 'Default',
  active: true,
  basePrice: 100000,
  tiers: [
    { threshold: 5, price: 95000 },
    { threshold: 10, price: 90000 },
    { threshold: 15, price: 85000 },
  ],
}

const clone = (p: PricingPlan): PricingPlan => ({
  ...p,
  tiers: p.tiers.map((t) => ({ ...t })),
})

// Session state — restored to the default on every boot (module init).
let activePlan: PricingPlan = clone(DEFAULT_PLAN)
const created: PricingPlan[] = []

export function getActivePlan(): PricingPlan {
  return activePlan
}

export function listPlans(): PricingPlan[] {
  return [DEFAULT_PLAN, ...created]
}

export function setActivePlan(plan: PricingPlan): void {
  activePlan = plan
  if (plan.id !== DEFAULT_PLAN.id && !created.some((p) => p.id === plan.id)) {
    created.push(plan)
  }
}

/**
 * Price (base units) for a settled-purchase count under a plan: the highest tier whose
 * threshold <= count, else the base price. Tiers are validated ascending, so the last
 * match is the lowest price. Exact integer arithmetic — no dollar round-trip.
 */
export function priceUnitsForCount(plan: PricingPlan, count: number): number {
  let price = plan.basePrice
  for (const t of plan.tiers) if (count >= t.threshold) price = t.price
  return price
}

type ValidationResult = { ok: true; plan: PricingPlan } | { ok: false; error: string }

const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0

/**
 * Validate a plan submitted by the operator. Messages name the problem in the seller's
 * terms (no apology). Small thresholds (1/2/3) are allowed — the demo relies on them so a
 * fresh agent can climb tiers via repeated calls.
 */
export function validatePlan(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Plan must be a JSON object with basePrice and tiers.' }
  }
  const body = input as { name?: unknown; basePrice?: unknown; tiers?: unknown }

  if (!isPosInt(body.basePrice)) {
    return { ok: false, error: 'Base price must be a whole number of base units greater than zero (e.g. 100000 for $0.10).' }
  }
  const basePrice = body.basePrice

  if (!Array.isArray(body.tiers)) {
    return { ok: false, error: 'Tiers must be a list (it can be empty for a flat price).' }
  }

  const tiers: PlanTier[] = []
  for (let i = 0; i < body.tiers.length; i++) {
    const raw = body.tiers[i] as { threshold?: unknown; price?: unknown }
    const n = i + 1
    if (!isPosInt(raw.threshold)) {
      return { ok: false, error: `Tier ${n} threshold must be a whole number of purchases greater than zero.` }
    }
    if (!isPosInt(raw.price)) {
      return { ok: false, error: `Tier ${n} price must be a whole number of base units greater than zero.` }
    }
    if (raw.price > basePrice) {
      return { ok: false, error: `Tier ${n} price must not exceed the base price (a discount can't be above base).` }
    }
    if (i > 0) {
      if (raw.threshold <= tiers[i - 1].threshold) {
        return { ok: false, error: `Tier ${n} threshold must be higher than tier ${i}'s threshold.` }
      }
      if (raw.price >= tiers[i - 1].price) {
        return { ok: false, error: `Tier ${n} price must be lower than tier ${i}'s price.` }
      }
    }
    tiers.push({ threshold: raw.threshold, price: raw.price })
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Custom plan'
  return {
    ok: true,
    plan: { id: `plan-${Date.now()}`, name, active: true, basePrice, tiers },
  }
}
