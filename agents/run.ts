import { Mppx, tempo } from 'mppx/client'
import { resolveAccount } from 'mppx/cli'
import { MODERATO_CHAIN_ID } from '../src/chain'

// One-shot demo CLI. Identity is an mppx keychain account (see `npx mppx account list`),
// resolved by name — no hardcoded addresses, no private keys in .env.
//   npm run agent -- --account <name> [--quote|--settle|--discover]
//     --quote   (default) read the 402 challenge price only; NO payment, NO dashboard row
//     --settle  real pay -> retry -> 200; settles on-chain and adds a dashboard row
//     --discover derive-then-act: read discovery, then settle accordingly

const args = process.argv.slice(2)
const accIdx = args.indexOf('--account')
const name = accIdx >= 0 ? args[accIdx + 1] : (process.env.MPPX_ACCOUNT ?? 'main')
const mode: 'quote' | 'settle' | 'discover' = args.includes('--discover')
  ? 'discover'
  : args.includes('--settle')
    ? 'settle'
    : 'quote'

// Load the keychain account as a viem account (resolveAccount: MPPX_PRIVATE_KEY env,
// else OS keychain lookup by name). Signs locally; the key never touches .env.
const account = await resolveAccount(name).catch((e) => {
  console.error(`[agent] could not resolve account "${name}": ${e.message}`)
  console.error('        list available accounts with: npx mppx account list')
  process.exit(1)
})

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

// Settle via the mppx client (402 -> pay -> retry). Asserts identity only when an
// `identityHeader` is provided; otherwise sends no identity header (pays base).
async function settle(identityHeader?: string) {
  // Client SDK: tempo(...) returns the charge method; polyfill:false keeps global fetch intact.
  // expectedChainId pins Moderato (no `testnet` flag on the client API).
  const mppx = Mppx.create({
    methods: [tempo({ account, expectedChainId: MODERATO_CHAIN_ID })],
    polyfill: false,
  })
  const headers = identityHeader ? { [identityHeader]: account.address } : {}
  const res = await mppx.fetch(url, { headers })
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

// The Payment-Receipt header carries {method,status,timestamp,reference} — no amount.
// So read the settled amount the server actually recorded from its events feed.
async function settledAmountFor(addr: string): Promise<number | undefined> {
  try {
    const { events } = (await fetch(`${baseUrl}/api/events`).then((r) => r.json())) as {
      events: { source?: string; amount: number }[]
    }
    return events.find((e) => e.source === addr.toLowerCase())?.amount
  } catch {
    return undefined
  }
}

console.log(`\n=== Pricewise agent · account=${name} · mode=${mode} ===`)
console.log(`[agent] address = ${account.address}`)

if (mode === 'quote') {
  const q = await readChallenge()
  if (q) {
    console.log(`[quote] ${name} → quoted ${usd(q.dollars)} (${q.amount})  ${q.note}`)
    console.log('[quote] no payment made — free rehearsal path, no dashboard row')
  }
} else if (mode === 'settle') {
  const q = await readChallenge()
  if (q) console.log(`[settle] charging ${name} → ${usd(q.dollars)} (${q.amount})  ${q.note}`)
  const r = await settle('X-Agent')
  console.log(`[settle] status  = ${r.status}`)
  console.log(`[settle] receipt = ${r.receipt?.status ?? '?'}`)
  console.log(`[settle] tx      = ${r.receipt?.reference ?? '?'}`)
  console.log(`[settle] body    = ${JSON.stringify(r.body)}`)
} else {
  // discover: derive-then-act. Behavior is decided BY the discovery doc, not narrated.
  const KNOWN = new Set(['assert-identity-on-request']) // mechanisms this client understands
  const doc = (await fetch(`${baseUrl}/openapi.json`).then((r) => r.json())) as any
  const idp = doc['x-identity-pricing']
  const offer = doc.paths?.['/data/{resource}']?.get?.['x-payment-info']?.offers?.[0]
  const basePrice = offer ? Number(offer.amount) / 1e6 : BASE_UNITS / 1e6

  // Recognize-or-abstain: only assert identity if we understand the advertised mechanism.
  const recognized = !!idp && KNOWN.has(idp.mechanism)
  const header: string | undefined = recognized ? (idp.identityHeader ?? 'X-Agent') : undefined

  if (recognized) {
    console.log(`[discover] recognized mechanism "${idp.mechanism}" → assert identity via "${header}"`)
    console.log(`[identify] asserting ${account.address} via ${header}`)
  } else {
    console.log(
      `[discover] ${idp ? `unrecognized mechanism "${idp.mechanism}"` : 'no x-identity-pricing'}` +
        ' → paying base price (no identity asserted)',
    )
  }

  // Single round trip: settle once with whatever discovery told us to do.
  const r = await settle(header)
  // Paid amount comes from the server's recorded settlement (receipt has no amount).
  const paid = (await settledAmountFor(account.address)) ?? basePrice
  console.log(
    `[settled] base ${usd(basePrice)} → paid ${usd(paid)} (source: /api/events)` +
      ` · receipt ${r.receipt?.status ?? '?'} · tx ${r.receipt?.reference ?? '?'}`,
  )
}
