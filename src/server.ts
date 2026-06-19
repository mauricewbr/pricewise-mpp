import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Mppx, tempo } from 'mppx/hono'
import { Credential, Challenge } from 'mppx'
import { priceFor } from './pricing/engine'
import { loyalty } from './pricing/rules'
import { getActivePlan, setActivePlan, activatePlanById, listPlans, validatePlan } from './pricing/plan'
import { store } from './store'
import { toAddress } from './identity'
import { resolveAccount } from 'mppx/cli'
import { buildOpenApiDoc, prose, llmsTxt } from './discovery'

// NOTE — adapted from the original spec snippet to match the shipped mppx@0.7.0 API:
// `mppx/hono`'s `mppx.charge(opts)` returns a Hono *MiddlewareHandler*, not a
// function you `await ...(c.req.raw)`. So there is no `result.status === 402`
// / `result.challenge` / `result.withReceipt(...)`. The middleware itself emits
// the 402 + challenge when unpaid, verifies the credential when paid, calls
// `next()`, and attaches the `Payment-Receipt` header to the response.
// We still compute the price *before* the charge by building the charge
// middleware per-request with the computed amount.

type Variables = {
  amount: number
  breakdown: { amount: number; note: string }[]
  resource: string
  challengeId?: string
  boundDiscount: boolean
}

const secretKey = process.env.MPP_SECRET_KEY ?? generateDevSecret()
const recipient = process.env.RECIPIENT_ADDRESS as `0x${string}` | undefined
if (!recipient) {
  throw new Error(
    'RECIPIENT_ADDRESS is required. Create a funded testnet account with ' +
      '`npx mppx account create`, then put its address in .env (see .env.example).',
  )
}

const mppx = Mppx.create({
  secretKey,
  methods: [
    tempo.charge({
      testnet: true, // resolves Moderato chain id (42431) + pathUSD currency for us
      currency: '0x20c0000000000000000000000000000000000000', // pathUSD on Moderato
      recipient,
    }),
  ],
})

// Optionally pre-seed a returning persona so it already has a loyalty tier for the demo.
// The account is resolved by name from the OS keychain (PRICEWISE_SEED_ACCOUNT); in-memory
// only, no real charges. Unset PRICEWISE_SEED_ACCOUNT to boot with no seeded history.
const seedAccount = process.env.PRICEWISE_SEED_ACCOUNT
if (seedAccount) {
  const seedCount = Number(process.env.PRICEWISE_SEED_COUNT ?? '15')
  try {
    const { address } = await resolveAccount(seedAccount)
    store.seed(address, seedCount)
    console.log(`[seed] ${toAddress(address)} -> ${seedCount} prior purchases (account "${seedAccount}")`)
  } catch (e) {
    console.warn(
      `[seed] skipped — could not resolve account "${seedAccount}" from keychain: ${(e as Error).message}`,
    )
  }
}

// Activity starts EMPTY by default — every row should be a real settled charge. Set
// PRICEWISE_SEED_DEMO_EVENTS=1 to pre-fill a few illustrative rows (e.g. for a screenshot).
if (process.env.PRICEWISE_SEED_DEMO_EVENTS === '1') {
  store.seedDemoEvents()
  console.log('[seed] demo activity rows loaded (PRICEWISE_SEED_DEMO_EVENTS=1)')
}

// Static pages, read once at boot. Inlined/self-contained — no CDN or build step.
const dashboardHtml = readFileSync(
  fileURLToPath(new URL('../public/index.html', import.meta.url)),
  'utf8',
)
const consoleHtml = readFileSync(
  fileURLToPath(new URL('../public/console.html', import.meta.url)),
  'utf8',
)
const titleHtml = readFileSync(
  fileURLToPath(new URL('../public/title.html', import.meta.url)),
  'utf8',
)

const app = new Hono<{ Variables: Variables }>()

// --- Pages (free, unpaid — never wrap these in mppx.charge) ---
app.get('/', (c) => c.html(dashboardHtml))
app.get('/console', (c) => c.html(consoleHtml))
app.get('/title', (c) => c.html(titleHtml))
app.get('/api/events', (c) => c.json({ events: store.recentEvents() }))
app.get('/api/stats', (c) => c.json(store.stats()))

// --- Discovery (free, unpaid) ---
// Rebuilt PER REQUEST from the current active plan so an operator edit is reflected on
// the very next GET with no restart. offers[] advertise the plan's base price as the
// worst case; the discount lives only in x-loyalty/x-identity-pricing and the live 402.
// no-store so a client/intermediary can't serve stale pricing terms after an edit.
app.get('/openapi.json', (c) => {
  const plan = getActivePlan()
  const doc = buildOpenApiDoc(
    mppx,
    mppx.charge({ amount: String(plan.basePrice / 1e6), description: prose(plan) }),
  )
  c.header('Cache-Control', 'no-store')
  return c.json(doc)
})
app.get('/llms.txt', (c) => c.text(llmsTxt()))

// --- Pricing plan (free, unpaid; for the console to read/write later) ---
app.get('/api/plan', (c) => c.json(getActivePlan()))
app.get('/api/plans', (c) => c.json({ plans: listPlans() }))
app.post('/api/plan', async (c) => {
  const body = await c.req.json().catch(() => null)
  const result = validatePlan(body)
  if (!result.ok) return c.json({ error: result.error }, 400)
  setActivePlan(result.plan)
  console.log(`[plan] active plan set: ${result.plan.name} (base ${result.plan.basePrice}, ${result.plan.tiers.length} tiers)`)
  return c.json(result.plan)
})
app.post('/api/plans/:id/activate', (c) => {
  const plan = activatePlanById(c.req.param('id'))
  if (!plan) return c.json({ error: 'No plan with that id.' }, 404)
  console.log(`[plan] re-activated: ${plan.name} (${plan.id})`)
  return c.json(plan)
})

// --- Admin seed (DEV/DEMO ONLY, gated) ---
// Sets a wallet's starting settled-purchase count so a live threshold crossing can
// be demoed. This mutates loyalty pricing state, so it's disabled unless
// PRICEWISE_ALLOW_SEED=1. It only sets the STARTING count — real settles do the crossing.
if (process.env.PRICEWISE_ALLOW_SEED === '1') {
  app.post('/admin/seed', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { address?: string; purchases?: number }
    const addr = toAddress(body.address)
    if (!addr || typeof body.purchases !== 'number' || body.purchases < 0) {
      return c.json({ error: 'address and non-negative purchases required' }, 400)
    }
    store.seed(addr, body.purchases)
    console.log(`[admin] seeded ${addr} -> ${body.purchases} prior purchases`)
    return c.json({ ok: true, address: addr, purchases: body.purchases })
  })
}

const toUnits = (dollars: number) => String(Math.round(dollars * 1e6))

/** Parse the incoming credential without throwing on the first (unpaid) leg. */
function tryCredential(req: Request) {
  try {
    return Credential.fromRequest(req)
  } catch {
    return null
  }
}

/**
 * Read the server-bound metadata from a credential's challenge. On the wire the
 * binding lives in the base64url `opaque` string (parsed `meta` is undefined),
 * so decode it. The `id` HMAC already guarantees `opaque` is untampered.
 */
function boundMeta(challenge: { opaque?: string; meta?: Record<string, string> }):
  | Record<string, string>
  | undefined {
  if (challenge.meta) return challenge.meta
  if (!challenge.opaque) return undefined
  try {
    return JSON.parse(Buffer.from(challenge.opaque, 'base64url').toString())
  } catch {
    return undefined
  }
}

/** Breakdown for a discounted price, derived from the bound base-unit amount. */
function discountBreakdown(boundPrice: string): { amount: number; note: string }[] {
  const planBase = getActivePlan().basePrice / 1e6
  const dollars = Number(boundPrice) / 1e6
  const pct = Math.round((1 - dollars / planBase) * 100)
  return [
    { amount: planBase, note: 'base' },
    { amount: dollars, note: `loyalty: −${pct}% (identity-verified)` },
  ]
}

app.get(
  '/data/:resource',
  // Stage 1 — IDENTITY-CONDITIONAL PRICING (single round trip, source-bound).
  //
  // First leg (no credential): price from the asserted X-Agent identity and BIND
  // that source + price into the challenge via `meta` (the SDK HMACs it into the
  // challenge `id`, so it's tamper-evident). The discount shows up in the 402.
  //
  // Retry leg (credential present): honor the *presented* challenge — do NOT
  // re-derive from the (attacker-controlled) header, which would loop. For a
  // discounted (source-bound) challenge, enforce that the credential's VERIFIED
  // source matches the bound source (and the challenge isn't replayed) BEFORE the
  // charge middleware settles. On mismatch/replay we downgrade to a base-price
  // challenge, so a forged identity claim can't settle the discount.
  async (c, next) => {
    const hintAddr = toAddress(c.req.header('X-Agent'))
    console.log('[req] X-Agent =', hintAddr)
    const resource = c.req.param('resource')
    const planBase = getActivePlan().basePrice / 1e6 // current active plan's base price

    let amount: number
    let breakdown: { amount: number; note: string }[]
    let meta: Record<string, string> | undefined
    let boundDiscount = false
    const cred = tryCredential(c.req.raw)

    if (!cred) {
      // First leg: quote from the asserted identity; bind source+price if discounted.
      const ctx = {
        source: hintAddr,
        resource,
        now: new Date(),
        recentRequests: store.recentRequestCount(),
        history: store.history(hintAddr),
      }
      const quoted = priceFor(ctx, planBase, [loyalty])
      amount = quoted.amount
      breakdown = quoted.breakdown
      if (hintAddr && amount < planBase) {
        meta = { src: hintAddr, price: toUnits(amount) }
        boundDiscount = true
      }
    } else {
      // Retry leg: honor the challenge the client is actually paying.
      const challengeOk = Challenge.verify(cred.challenge, { secretKey })
      const bound = boundMeta(cred.challenge) // {src, price, _mppx_scope} (decoded from opaque)
      const boundSrc = bound?.src
      const boundPrice = bound?.price
      if (challengeOk && boundSrc && boundPrice) {
        // A source-bound discounted challenge — verify the payer controls it.
        const paidSrc = toAddress(cred.source)
        const replay = store.isConsumed(cred.challenge.id)
        if (paidSrc === boundSrc && !replay) {
          amount = Number(boundPrice) / 1e6
          breakdown = discountBreakdown(boundPrice)
          meta = { src: boundSrc, price: boundPrice }
          boundDiscount = true
        } else {
          // Forged identity claim or replay → forfeit the discount, charge base.
          console.log(
            '[identity-pricing] discount denied:',
            replay ? `challenge ${cred.challenge.id.slice(0, 10)}… replayed` : `bound ${boundSrc} != payer ${paidSrc}`,
          )
          amount = planBase
          breakdown = [
            { amount: planBase, note: 'base' },
            { amount: planBase, note: replay ? 'loyalty: challenge already used → base' : 'loyalty: identity not verified → base' },
          ]
        }
      } else {
        // Unbound (base-price) challenge being paid — honor base.
        amount = planBase
        breakdown = [{ amount: planBase, note: 'base' }]
      }
    }

    console.log('[price]', hintAddr ?? 'anon', amount, breakdown.map((b) => b.note), boundDiscount ? '(bound)' : '')
    c.set('amount', amount)
    c.set('breakdown', breakdown)
    c.set('resource', resource)
    c.set('challengeId', cred?.challenge.id)
    c.set('boundDiscount', boundDiscount)
    return mppx.charge({ amount: String(amount), description: resource, ...(meta ? { meta } : {}) })(c, next)
  },
  // Stage 2: only reached after a verified payment (the charge middleware called next()).
  async (c) => {
    const paidAddr = toAddress(Credential.fromRequest(c.req.raw).source)
    console.log('[paid] source =', paidAddr)
    // Single-use: mark the discounted challenge consumed so it can't be replayed.
    const id = c.get('challengeId')
    if (id && c.get('boundDiscount')) store.consumeChallenge(id)
    store.recordPurchase(paidAddr, c.get('amount'), c.get('resource'), c.get('breakdown'))
    return c.json({ data: `payload for ${c.get('resource')}` })
  },
)

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port })

function generateDevSecret(): string {
  const key = randomBytes(32).toString('base64')
  console.warn(
    '[warn] MPP_SECRET_KEY not set — generated an ephemeral dev key. ' +
      'Issued challenges will not verify across restarts. Set MPP_SECRET_KEY in .env to persist.',
  )
  return key
}

export default app
