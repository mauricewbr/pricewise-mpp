// Discovery layer: serve an OpenAPI 3.1 document so agents/registries can find
// Pricewise, its base price (x-payment-info.offers[]), and its loyalty ladder
// (x-loyalty). Advisory only — the live 402 challenge stays authoritative.
//
// Two deviations from the spec's assumed shapes, forced by mppx@0.7.0:
//  1. `generate()`/`discovery()` expose no hook for a custom root-level `x-loyalty`,
//     so we build the base doc with the SDK's `generate()` and MERGE x-loyalty +
//     prose in ourselves (the "merge-wrapper" path the spec anticipated).
//  2. The SDK emits a FLAT `x-payment-info` ({amount,currency,description,intent,
//     method}); it does not populate `offers[]`. We normalize that into an
//     `offers[]` array (per the discovery convention) while keeping the flat fields.
// Auto-introspection also can't see our charge (it runs per-request inside the
// route handler for dynamic pricing), so we hand `generate()` an explicit
// base-price charge handler.

import { generate } from 'mppx/discovery'
import { priceFor } from './pricing/engine'
import { loyalty, BASE_PRICE, LOYALTY } from './pricing/rules'

const PATHUSD = '0x20c0000000000000000000000000000000000000'
const DECIMALS = 6

const toBaseUnits = (dollars: number): string => String(Math.round(dollars * 10 ** DECIMALS))
const round2 = (n: number): number => Math.round(n * 100) / 100

const REPO = 'https://github.com/mauricewbr/pricewise-mpp'
const MAX_DISCOUNT = round2(LOYALTY.maxTier * LOYALTY.discountPerTier)

/** One-sentence prose pointer for LLM agents that don't parse x-loyalty. */
export const PROSE =
  `Per-call $${BASE_PRICE.toFixed(2)} (${toBaseUnits(BASE_PRICE)} base units). ` +
  `Returning callers earn up to ${Math.round(MAX_DISCOUNT * 100)}% off by settled ` +
  `purchase history — see x-loyalty.`

// Run the actual loyalty rule at a given purchase count so advertised tier values
// can't drift from runtime pricing.
function effectiveAt(purchases: number): { baseUnits: string; discount: number } {
  const { amount } = priceFor(
    { resource: '', now: new Date(), recentRequests: 0, history: { purchases, totalSpend: 0 } },
    BASE_PRICE,
    [loyalty],
  )
  return { baseUnits: toBaseUnits(amount), discount: round2(1 - amount / BASE_PRICE) }
}

// Rule-derived tier ladder — the single computed source for both x-loyalty and
// x-identity-pricing, so the two facets can never disagree.
function tierLadder() {
  const tiers = []
  for (let tier = 1; tier <= LOYALTY.maxTier; tier++) {
    const threshold = tier * LOYALTY.step
    const e = effectiveAt(threshold)
    tiers.push({ tier, threshold, discount: e.discount, effectiveAmount: e.baseUnits })
  }
  return tiers
}

function loyaltyExtension() {
  const tiers = tierLadder()
  return {
    type: 'reward-only',
    basis: 'settled-purchase-count',
    currency: PATHUSD,
    baseAmount: toBaseUnits(BASE_PRICE),
    tiers,
    maxDiscount: MAX_DISCOUNT,
    note:
      "Discount accrues to a wallet's settled purchase history; advisory — " +
      'the live 402 challenge is authoritative.',
  }
}

/** llms.txt stub served at /llms.txt. */
export const LLMS_TXT = [
  '# Pricewise',
  '',
  'Seller-side dynamic pricing on MPP (Machine Payments Protocol), settling on Tempo.',
  '',
  '## Pricing',
  `- Base price: $${BASE_PRICE.toFixed(2)} per call (${toBaseUnits(BASE_PRICE)} base units, pathUSD).`,
  `- Reward-only loyalty: up to ${Math.round(MAX_DISCOUNT * 100)}% off for returning wallets,`,
  `  by settled purchase history (every ${LOYALTY.step} purchases = +${Math.round(
    LOYALTY.discountPerTier * 100,
  )}%, capped at tier ${LOYALTY.maxTier}).`,
  '- Advisory only — the live 402 challenge is authoritative.',
  '',
  '## Discovery',
  '- OpenAPI: /openapi.json (x-payment-info.offers[] base price, x-loyalty tier ladder).',
  '',
  `Source: ${REPO}`,
  '',
].join('\n')

type Doc = Record<string, unknown>

/**
 * Build the OpenAPI discovery document. `baseChargeHandler` is a charge middleware
 * created at the BASE price — generate() reads its discovery metadata for offers[].
 */
export function buildOpenApiDoc(mppx: unknown, baseChargeHandler: unknown): Doc {
  const doc = generate(mppx as never, {
    info: { title: 'Pricewise', version: '1.0.0' },
    routes: [{ handler: baseChargeHandler as never, method: 'GET', path: '/data/{resource}' }],
    serviceInfo: {
      categories: ['data', 'api'],
      docs: {
        homepage: REPO,
        apiReference: `${REPO}#discovery`,
        llms: '/llms.txt',
      },
    },
  }) as Doc

  // Merge: normalize offers[], add prose description, attach x-loyalty.
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>> | undefined
  const op = paths?.['/data/{resource}']?.get
  if (op) {
    const pay = (op['x-payment-info'] as Record<string, unknown>) ?? {}
    // Authoritative worst-case base price in base units (never a discounted price).
    const amount = typeof pay.amount === 'string' && /^\d+$/.test(pay.amount)
      ? pay.amount
      : toBaseUnits(BASE_PRICE)
    pay.amount = amount
    pay.offers = [
      {
        amount,
        currency: (pay.currency as string) ?? PATHUSD,
        description: (pay.description as string) ?? PROSE,
        intent: (pay.intent as string) ?? 'charge',
        method: (pay.method as string) ?? 'tempo',
      },
    ]
    op['x-payment-info'] = pay
    op.description = PROSE
  }

  doc['x-loyalty'] = loyaltyExtension()

  // Mechanism signal: how to obtain the conditional price (not just the schedule).
  // Reuses the same rule-derived tier array as x-loyalty — no duplicated numbers.
  doc['x-identity-pricing'] = {
    mechanism: 'assert-identity-on-request',
    identityHeader: 'X-Agent',
    basis: 'settled-purchase-count',
    note:
      'Assert your wallet via X-Agent to receive your tier price; the discounted ' +
      "challenge is bound to that source and only settles if your payment credential's " +
      'verified source matches. Base price applies to unidentified or unverified callers.',
    tiers: tierLadder(),
  }
  return doc
}
