import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Mppx, tempo } from 'mppx/hono'
import { Credential } from 'mppx'
import { priceFor } from './pricing/engine'
import { passthrough } from './pricing/rules'
import { store } from './store'
import { MODERATO_CHAIN_ID } from './chain'

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

const app = new Hono<{ Variables: Variables }>()

app.get(
  '/data/:resource',
  // Stage 1: compute the price from request context, then hand off to the paid
  // charge middleware with that amount.
  async (c, next) => {
    const hint = c.req.header('X-Agent') as `0x${string}` | undefined
    console.log('[req] X-Agent =', hint) // <-- header pass-through probe (test #5)
    const resource = c.req.param('resource')
    const ctx = {
      source: hint,
      resource,
      now: new Date(),
      recentRequests: store.recentRequestCount(),
      history: store.history(hint),
    }
    const { amount, breakdown } = priceFor(ctx, 0.1, [passthrough])
    c.set('amount', amount)
    c.set('breakdown', breakdown)
    c.set('resource', resource)
    return mppx.charge({ amount: String(amount), description: resource })(c, next)
  },
  // Stage 2: only reached after a verified payment (the charge middleware called next()).
  async (c) => {
    const source = Credential.fromRequest(c.req.raw).source
    console.log('[paid] source =', source) // <-- confirms .source is populated (test #1)
    store.recordPurchase(source, c.get('amount'), c.get('resource'), c.get('breakdown'))
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
