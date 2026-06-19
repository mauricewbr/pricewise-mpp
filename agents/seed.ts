import { resolveAccount } from 'mppx/cli'
import { priceUnitsForCount, type PricingPlan } from '../src/pricing/plan'

// Seed a keychain account's STARTING settled-purchase count so a live threshold crossing
// can be demoed. The crossing itself must come from real settles (recordPurchase) — this
// only sets the starting count. Tier/threshold numbers are derived from the server's
// CURRENT ACTIVE PLAN (fetched live), so seeding reflects whatever plan is active now.
// Usage: npm run seed -- --account <name> <count>

const args = process.argv.slice(2)
const accIdx = args.indexOf('--account')
const name = accIdx >= 0 ? args[accIdx + 1] : process.env.MPPX_ACCOUNT
const nArg = args.find((a) => /^\d+$/.test(a))
if (!name || nArg === undefined) {
  console.error('Usage: npm run seed -- --account <name> <count>   (account and count are required)')
  process.exit(1)
}
const n = Number(nArg)
const address = await resolveAccount(name)
  .then((a) => a.address)
  .catch((e) => {
    console.error(`[seed] could not resolve account "${name}": ${e.message}`)
    console.error('       list available accounts with: npx mppx account list')
    process.exit(1)
  })
const baseUrl = process.env.SERVER_URL ?? 'http://localhost:3000'

// Pull the live active plan so the derived tier/next-threshold line matches the server.
const plan = (await fetch(`${baseUrl}/api/plan`)
  .then((r) => r.json())
  .catch(() => null)) as PricingPlan | null
if (!plan) {
  console.error(`[seed] could not read the active plan from ${baseUrl}/api/plan — is the server running?`)
  process.exit(1)
}

const tierIndex = (count: number) => plan.tiers.filter((t) => count >= t.threshold).length
const nextTier = plan.tiers.find((t) => t.threshold > n)
const priceNow = priceUnitsForCount(plan, n)
const nextLine = nextTier
  ? `${nextTier.threshold - n} more settled purchase${nextTier.threshold - n === 1 ? '' : 's'} → ${nextTier.price} base units`
  : 'already at the deepest tier'

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

console.log(`[seed] ${name} ${address}`)
console.log(`[seed] seeded at ${n} → tier ${tierIndex(n)} (${priceNow} base units); ${nextLine}`)
console.log('[seed] starting count only — real settled purchases do the crossing.')
