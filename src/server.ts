import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Mppx, tempo } from 'mppx/hono'
import { Credential } from 'mppx'
import { priceFor } from './pricing/engine'
import { loyalty } from './pricing/rules'
import { store } from './store'
import { toAddress } from './identity'
import { MODERATO_CHAIN_ID } from './chain'
import { REGULAR_AGENT_ADDRESS, REGULAR_SEED_PURCHASES } from './personas'

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

// Pre-seed the returning persona so it already has a loyalty tier for the demo.
// In-memory only — no real charges needed.
store.seed(REGULAR_AGENT_ADDRESS, REGULAR_SEED_PURCHASES)
console.log(
  `[seed] ${toAddress(REGULAR_AGENT_ADDRESS)} -> ${REGULAR_SEED_PURCHASES} prior purchases`,
)

// A few pre-settled demo rows so the dashboard is never empty on stage.
store.seedDemoEvents()

// Dashboard page, read once at boot. Inlined/self-contained — no CDN or build step.
const dashboardHtml = readFileSync(
  fileURLToPath(new URL('../public/index.html', import.meta.url)),
  'utf8',
)

const app = new Hono<{ Variables: Variables }>()

// --- Dashboard (free, unpaid — never wrap these in mppx.charge) ---
app.get('/', (c) => c.html(dashboardHtml))
app.get('/api/events', (c) => c.json({ events: store.recentEvents() }))
app.get('/api/stats', (c) => c.json(store.stats()))

app.get(
  '/data/:resource',
  // Stage 1: compute the loyalty-adjusted price from the (unverified) X-Agent hint,
  // so the discount shows up in the 402 challenge — then hand off to the charge
  // middleware with that amount.
  async (c, next) => {
    const hintAddr = toAddress(c.req.header('X-Agent'))
    console.log('[req] X-Agent =', hintAddr) // <-- header pass-through probe (test #5)
    const resource = c.req.param('resource')
    const ctx = {
      source: hintAddr,
      resource,
      now: new Date(),
      recentRequests: store.recentRequestCount(),
      history: store.history(hintAddr),
    }
    const { amount, breakdown } = priceFor(ctx, 0.1, [loyalty])
    // Visible during free challenge-only iteration (this leg runs even when unpaid).
    console.log('[price]', hintAddr ?? 'anon', amount, breakdown.map((b) => b.note))
    c.set('amount', amount)
    c.set('breakdown', breakdown)
    c.set('resource', resource)
    return mppx.charge({ amount: String(amount), description: resource })(c, next)
  },
  // Stage 2: only reached after a verified payment (the charge middleware called next()).
  async (c) => {
    const paidAddr = toAddress(Credential.fromRequest(c.req.raw).source)
    const hintAddr = toAddress(c.req.header('X-Agent'))
    console.log('[paid] source =', paidAddr) // <-- confirms .source is populated (test #1)
    if (hintAddr && paidAddr !== hintAddr) {
      // Claimed someone else's identity. Reward-only loyalty means no harm — they
      // simply don't get the claimed account's discount. Just log and credit the
      // real payer.
      console.log('[mismatch] hint', hintAddr, '!= payer', paidAddr)
    }
    store.recordPurchase(paidAddr, c.get('amount'), c.get('resource'), c.get('breakdown'))
    return c.json({ data: `payload for ${c.get('resource')}` })
  },
)

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `Pricewise listening on http://localhost:${info.port} ` +
      `(Tempo Moderato testnet, chain ${MODERATO_CHAIN_ID})`,
  )
})

function generateDevSecret(): string {
  const key = randomBytes(32).toString('base64')
  console.warn(
    '[warn] MPP_SECRET_KEY not set — generated an ephemeral dev key. ' +
      'Issued challenges will not verify across restarts. Set MPP_SECRET_KEY in .env to persist.',
  )
  return key
}

export default app
