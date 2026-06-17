import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import { MODERATO_CHAIN_ID } from '../src/chain'
import { NEW_AGENT_ADDRESS, REGULAR_AGENT_ADDRESS } from '../src/personas'

// One-shot demo CLI. Two personas × two modes:
//   npm run agent -- <new|regular> [--quote|--settle]
//     --quote  (default) read the 402 challenge price only; NO payment, NO dashboard row
//     --settle real pay -> retry -> 200; settles on-chain and adds a dashboard row
// Private keys come from .env (see .env.example); never hardcode them here.

function keyFromEnv(name: string): `0x${string}` {
  const k = process.env[name]
  if (!k) throw new Error(`${name} is required — set it in .env (see .env.example).`)
  return k as `0x${string}`
}

const personas = {
  new: { account: privateKeyToAccount(keyFromEnv('NEW_AGENT_PRIVATE_KEY')), expected: NEW_AGENT_ADDRESS },
  regular: { account: privateKeyToAccount(keyFromEnv('REGULAR_AGENT_PRIVATE_KEY')), expected: REGULAR_AGENT_ADDRESS },
} as const

const args = process.argv.slice(2)
const which = (args.find((a) => a === 'new' || a === 'regular') ?? 'regular') as keyof typeof personas
const mode: 'quote' | 'settle' = args.includes('--settle') ? 'settle' : 'quote' // default: quote (free/safe)

const { account, expected } = personas[which]
if (account.address.toLowerCase() !== expected.toLowerCase()) {
  console.warn(
    `[warn] ${which} key derives ${account.address}, but personas.ts expects ${expected}. ` +
      `Update src/personas.ts or your .env key so the server seeds the right address.`,
  )
}

const baseUrl = process.env.SERVER_URL ?? 'http://localhost:3000'
const url = `${baseUrl}/data/foo`

function usd(n: number): string {
  let s = n.toFixed(6).replace(/0+$/, '')
  if (s.endsWith('.')) s = s.slice(0, -1)
  const dot = s.indexOf('.')
  if (dot === -1) s += '.00'
  else { const dec = s.length - dot - 1; if (dec < 2) s += '0'.repeat(2 - dec) }
  return '$' + s
}

const BASE_UNITS = 100_000 // full price ($0.10) in pathUSD base units (6 decimals)

// Free read of the 402 challenge via plain fetch — never moves funds.
async function readChallenge(): Promise<{ amount: number; dollars: number; note: string } | null> {
  const res = await fetch(url, { headers: { 'X-Agent': account.address } })
  if (res.status !== 402) {
    console.log(`[warn] expected a 402 challenge, got HTTP ${res.status}`)
    return null
  }
  const wa = res.headers.get('www-authenticate') ?? ''
  const m = wa.match(/request="([^"]+)"/)
  if (!m) {
    console.log('[warn] no challenge found in WWW-Authenticate header')
    return null
  }
  const req = JSON.parse(Buffer.from(m[1], 'base64').toString()) as { amount: string }
  const amount = Number(req.amount)
  const pct = Math.round((1 - amount / BASE_UNITS) * 100)
  const note = pct > 0 ? `loyalty: tier ${Math.round(pct / 5)} −${pct}%` : 'new caller'
  return { amount, dollars: amount / 1e6, note }
}

console.log(`\n=== Pricewise agent · persona=${which} · mode=${mode} ===`)
console.log(`[agent] address = ${account.address}`)

if (mode === 'quote') {
  const q = await readChallenge()
  if (q) {
    console.log(`[quote] ${which} → quoted ${usd(q.dollars)} (${q.amount})  ${q.note}`)
    console.log('[quote] no payment made — free rehearsal path, no dashboard row')
  }
} else {
  const q = await readChallenge()
  if (q) console.log(`[settle] charging ${which} → ${usd(q.dollars)} (${q.amount})  ${q.note}`)

  // Client SDK: tempo(...) returns the charge method; polyfill:false keeps global fetch intact.
  // expectedChainId pins Moderato (no `testnet` flag on the client API).
  const mppx = Mppx.create({
    methods: [tempo({ account, expectedChainId: MODERATO_CHAIN_ID })],
    polyfill: false,
  })
  const res = await mppx.fetch(url, { headers: { 'X-Agent': account.address } })
  const body = await res.json().catch(() => '<non-JSON body>')

  let receipt: { status?: string; reference?: string } | undefined
  const receiptB64 = res.headers.get('Payment-Receipt')
  if (receiptB64) {
    try {
      receipt = JSON.parse(Buffer.from(receiptB64, 'base64').toString())
    } catch {
      /* leave undefined */
    }
  }
  console.log(`[settle] status  = ${res.status}`)
  console.log(`[settle] receipt = ${receipt?.status ?? '?'}`)
  console.log(`[settle] tx      = ${receipt?.reference ?? '?'}`)
  console.log(`[settle] body    = ${JSON.stringify(body)}`)
}
