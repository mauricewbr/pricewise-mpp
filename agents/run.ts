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
// --discover: read the discovery doc, then settle via the informed path.
// --settle: settle directly. default: quote (free/safe).
const mode: 'quote' | 'settle' | 'discover' = args.includes('--discover')
  ? 'discover'
  : args.includes('--settle')
    ? 'settle'
    : 'quote'

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

// Settle via the mppx client (402 -> pay -> retry), asserting identity via X-Agent.
async function settle() {
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
  return { status: res.status, receipt, body }
}

console.log(`\n=== Pricewise agent · persona=${which} · mode=${mode} ===`)
console.log(`[agent] address = ${account.address}`)

if (mode === 'quote') {
  const q = await readChallenge()
  if (q) {
    console.log(`[quote] ${which} → quoted ${usd(q.dollars)} (${q.amount})  ${q.note}`)
    console.log('[quote] no payment made — free rehearsal path, no dashboard row')
  }
} else if (mode === 'settle') {
  const q = await readChallenge()
  if (q) console.log(`[settle] charging ${which} → ${usd(q.dollars)} (${q.amount})  ${q.note}`)
  const r = await settle()
  console.log(`[settle] status  = ${r.status}`)
  console.log(`[settle] receipt = ${r.receipt?.status ?? '?'}`)
  console.log(`[settle] tx      = ${r.receipt?.reference ?? '?'}`)
  console.log(`[settle] body    = ${JSON.stringify(r.body)}`)
} else {
  // discover: the *informed* path — learn the mechanism from discovery, then act on it.
  const doc: any = await fetch(`${baseUrl}/openapi.json`).then((r) => r.json())
  const idp = doc['x-identity-pricing']
  const header: string = idp?.identityHeader ?? 'X-Agent'
  const offer = doc.paths?.['/data/{resource}']?.get?.['x-payment-info']?.offers?.[0]
  const basePrice = offer ? Number(offer.amount) / 1e6 : BASE_UNITS / 1e6

  // 1) discovered mechanism
  console.log(`[discover] mechanism="${idp?.mechanism}" via header "${header}" (basis: ${idp?.basis})`)
  // 2) decide to identify (returning persona with a funded durable key)
  console.log(`[identify] asserting ${account.address} via ${header}`)
  // 3) act: settle along the identity-asserted path
  const q = await readChallenge()
  const r = await settle()
  // 4) trace: base vs paid
  const paid = q ? q.dollars : basePrice
  console.log(
    `[settled] base ${usd(basePrice)} → paid ${usd(paid)}` +
      (q && q.note.startsWith('loyalty') ? ` (${q.note})` : '') +
      ` · receipt ${r.receipt?.status ?? '?'} · tx ${r.receipt?.reference ?? '?'}`,
  )
}
