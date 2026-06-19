// Discovery layer: serve an OpenAPI 3.1 document so agents/registries can find
// Pricewise, its base price (x-payment-info.offers[]), and its loyalty ladder
// (x-loyalty). Advisory only — the live 402 challenge stays authoritative.
//
// Stage 2: everything here derives from the CURRENT ACTIVE PLAN (src/pricing/plan.ts),
// read on each call — the same plan the engine and the source-binding read. So an
// operator edit to the plan is reflected on the very next GET /openapi.json with no
// restart, and the advertised tiers can never drift from what actually settles.
//
// Two deviations from the spec's assumed shapes, forced by mppx@0.7.0:
//  1. `generate()`/`discovery()` expose no hook for a custom root-level `x-loyalty`,
//     so we build the base doc with the SDK's `generate()` and MERGE x-loyalty + prose
//     in ourselves (the "merge-wrapper" path).
//  2. The SDK emits a FLAT `x-payment-info`; we normalize it into an `offers[]` array.
// Auto-introspection also can't see our charge (per-request dynamic pricing), so we hand
// `generate()` an explicit base-price charge handler built from the active plan.

import { generate } from 'mppx/discovery'
import { getActivePlan, type PricingPlan } from './pricing/plan'

const PATHUSD = '0x20c0000000000000000000000000000000000000'
const REPO = 'https://github.com/mauricewbr/pricewise-mpp'

const round2 = (n: number): number => Math.round(n * 100) / 100
const dollars = (units: number): string => (units / 1e6).toFixed(2)

function maxDiscount(plan: PricingPlan): number {
  return plan.tiers.reduce((m, t) => Math.max(m, round2(1 - t.price / plan.basePrice)), 0)
}

/** One-sentence prose pointer for LLM agents that don't parse x-loyalty. */
export function prose(plan: PricingPlan = getActivePlan()): string {
  const pct = Math.round(maxDiscount(plan) * 100)
  return (
    `Per-call $${dollars(plan.basePrice)} (${plan.basePrice} base units). ` +
    `Returning callers earn up to ${pct}% off by settled purchase history — see x-loyalty.`
  )
}

// Rule-derived tier ladder — the single computed source for both x-loyalty and
// x-identity-pricing, so the two facets can never disagree.
function tierLadder(plan: PricingPlan) {
  return plan.tiers.map((t, i) => ({
    tier: i + 1,
    threshold: t.threshold,
    discount: round2(1 - t.price / plan.basePrice),
    effectiveAmount: String(t.price),
  }))
}

function loyaltyExtension(plan: PricingPlan) {
  return {
    type: 'reward-only',
    basis: 'settled-purchase-count',
    currency: PATHUSD,
    baseAmount: String(plan.basePrice),
    tiers: tierLadder(plan),
    maxDiscount: maxDiscount(plan),
    note:
      "Discount accrues to a wallet's settled purchase history; advisory — " +
      'the live 402 challenge is authoritative.',
  }
}

/** llms.txt body served at /llms.txt — reflects the active plan. */
export function llmsTxt(plan: PricingPlan = getActivePlan()): string {
  const pct = Math.round(maxDiscount(plan) * 100)
  const tiers = plan.tiers
    .map((t) => `  - tier @ ${t.threshold} purchases → ${t.price} base units`)
    .join('\n')
  return [
    '# Pricewise',
    '',
    'Seller-side dynamic pricing on MPP (Machine Payments Protocol), settling on Tempo.',
    '',
    '## Pricing',
    `- Base price: $${dollars(plan.basePrice)} per call (${plan.basePrice} base units, pathUSD).`,
    `- Reward-only loyalty: up to ${pct}% off for returning wallets, by settled purchase history:`,
    tiers || '  - (flat — no loyalty tiers configured)',
    '- Advisory only — the live 402 challenge is authoritative.',
    '',
    '## Discovery',
    '- OpenAPI: /openapi.json (x-payment-info.offers[] base price, x-loyalty tier ladder).',
    '',
    `Source: ${REPO}`,
    '',
  ].join('\n')
}

type Doc = Record<string, unknown>

/**
 * Build the OpenAPI discovery document from the active plan. `baseChargeHandler` is a
 * charge middleware created at the plan's BASE price — generate() reads its discovery
 * metadata for offers[]. Call this per request so edits are reflected with no restart.
 */
export function buildOpenApiDoc(mppx: unknown, baseChargeHandler: unknown): Doc {
  const plan = getActivePlan()
  const doc = generate(mppx as never, {
    info: { title: 'Pricewise', version: '1.0.0' },
    routes: [{ handler: baseChargeHandler as never, method: 'GET', path: '/data/{resource}' }],
    serviceInfo: {
      categories: ['data', 'api'],
      docs: { homepage: REPO, apiReference: `${REPO}#discovery`, llms: '/llms.txt' },
    },
  }) as Doc

  // Merge: normalize offers[] (advertise the plan base as worst-case), prose, x-loyalty.
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>> | undefined
  const op = paths?.['/data/{resource}']?.get
  if (op) {
    const pay = (op['x-payment-info'] as Record<string, unknown>) ?? {}
    const amount =
      typeof pay.amount === 'string' && /^\d+$/.test(pay.amount) ? pay.amount : String(plan.basePrice)
    pay.amount = amount
    pay.offers = [
      {
        amount,
        currency: (pay.currency as string) ?? PATHUSD,
        description: (pay.description as string) ?? prose(plan),
        intent: (pay.intent as string) ?? 'charge',
        method: (pay.method as string) ?? 'tempo',
      },
    ]
    op['x-payment-info'] = pay
    op.description = prose(plan)
  }

  doc['x-loyalty'] = loyaltyExtension(plan)

  // Mechanism signal: how to obtain the conditional price (not just the schedule).
  // Reuses the same plan-derived tier array as x-loyalty — no duplicated numbers.
  doc['x-identity-pricing'] = {
    mechanism: 'assert-identity-on-request',
    identityHeader: 'X-Agent',
    basis: 'settled-purchase-count',
    note:
      'Assert your wallet via X-Agent to receive your tier price; the discounted ' +
      "challenge is bound to that source and only settles if your payment credential's " +
      'verified source matches. Base price applies to unidentified or unverified callers.',
    tiers: tierLadder(plan),
  }
  return doc
}
