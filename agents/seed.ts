import { LOYALTY, BASE_PRICE, loyalty } from '../src/pricing/rules'
import { priceFor } from '../src/pricing/engine'
import { NEW_AGENT_ADDRESS, REGULAR_AGENT_ADDRESS } from '../src/personas'

// Seed a persona's STARTING settled-purchase count so a live threshold crossing can be
// demoed. The crossing itself must come from real settles (recordPurchase) — this only
// sets the starting count. All tier/threshold numbers are derived from the loyalty rule.
// Usage: npm run seed -- <new|regular> <count>

const personas = { new: NEW_AGENT_ADDRESS, regular: REGULAR_AGENT_ADDRESS } as const

const args = process.argv.slice(2)
const which = args.find((a) => a === 'new' || a === 'regular') as keyof typeof personas | undefined
const nArg = args.find((a) => /^\d+$/.test(a))
if (!which || nArg === undefined) {
  console.error('Usage: npm run seed -- <new|regular> <count>   (count is required and explicit)')
  process.exit(1)
}
const n = Number(nArg)
const address = personas[which]
const baseUrl = process.env.SERVER_URL ?? 'http://localhost:3000'

const toUnits = (d: number) => Math.round(d * 1e6)
const priceAt = (purchases: number) =>
  priceFor(
    { resource: '', now: new Date(), recentRequests: 0, history: { purchases, totalSpend: 0 } },
    BASE_PRICE,
    [loyalty],
  ).amount
const tierAt = (purchases: number) => Math.min(LOYALTY.maxTier, Math.floor(purchases / LOYALTY.step))

const tier = tierAt(n)
const price = priceAt(n)
let nextLine: string
if (tier >= LOYALTY.maxTier) {
  nextLine = `already at max tier ${LOYALTY.maxTier}`
} else {
  const nextTier = tier + 1
  const need = nextTier * LOYALTY.step - n
  nextLine = `${need} more settled purchase${need === 1 ? '' : 's'} → tier ${nextTier} (${toUnits(priceAt(nextTier * LOYALTY.step))})`
}

const res = await fetch(`${baseUrl}/admin/seed`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address, purchases: n }),
}).catch(() => null)

if (!res || !res.ok) {
  console.error(
    `[seed] failed${res ? ` (HTTP ${res.status})` : ''}. ` +
      'Is the server running with PRICEWISE_ALLOW_SEED=1?',
  )
  process.exit(1)
}

console.log(`[seed] ${which} ${address}`)
console.log(
  `[seed] seeded at ${n} → tier ${tier} (${toUnits(price)} base units); ${nextLine}`,
)
console.log('[seed] starting count only — real settled purchases do the crossing.')
