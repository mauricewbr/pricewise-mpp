import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import { MODERATO_CHAIN_ID } from '../src/chain'
import { NEW_AGENT_ADDRESS, REGULAR_AGENT_ADDRESS } from '../src/personas'

// Two fixed-key demo personas. Stable keys -> stable addresses -> stable identity.
//   new     — fresh wallet, no seeded history (full price)
//   regular — seeded server-side with prior purchases (discounted)
// Private keys come from .env (see .env.example); never hardcode them here.
// Usage: npm run agent -- <new|regular>   (defaults to regular)

function keyFromEnv(name: string): `0x${string}` {
  const k = process.env[name]
  if (!k) throw new Error(`${name} is required — set it in .env (see .env.example).`)
  return k as `0x${string}`
}

const personas = {
  new: { account: privateKeyToAccount(keyFromEnv('NEW_AGENT_PRIVATE_KEY')), expected: NEW_AGENT_ADDRESS },
  regular: { account: privateKeyToAccount(keyFromEnv('REGULAR_AGENT_PRIVATE_KEY')), expected: REGULAR_AGENT_ADDRESS },
} as const

const which = (process.argv[2] ?? 'regular') as keyof typeof personas
if (which !== 'new' && which !== 'regular') {
  throw new Error(`Usage: npm run agent -- <new|regular> (got "${process.argv[2]}")`)
}

const { account, expected } = personas[which]
if (account.address.toLowerCase() !== expected.toLowerCase()) {
  console.warn(
    `[warn] ${which} key derives ${account.address}, but personas.ts expects ${expected}. ` +
      `Update src/personas.ts or your .env key so the server seeds the right address.`,
  )
}

const baseUrl = process.env.SERVER_URL ?? 'http://localhost:3000'
const url = `${baseUrl}/data/foo`

// Client SDK: tempo(...) returns the charge method; polyfill:false keeps global fetch intact.
// The client picks the chain from the server's challenge; the shipped client API has no
// `testnet` flag (the web doc was wrong), so we pin Moderato via `expectedChainId` — it
// rejects challenges on any other chain and signs on this one if the challenge omits an id.
const mppx = Mppx.create({
  methods: [tempo({ account, expectedChainId: MODERATO_CHAIN_ID })],
  polyfill: false,
})

console.log(`[agent] persona = ${which}`)
console.log('[agent] address =', account.address)
console.log('[agent] GET', url)

// mppx.fetch transparently handles the 402 -> pay -> retry flow.
// The custom header carries the persona's identity (drives the loyalty discount).
const res = await mppx.fetch(url, {
  headers: { 'X-Agent': account.address },
})

console.log('[agent] status  =', res.status)
console.log('[agent] receipt =', res.headers.get('Payment-Receipt'))
const body = await res.json().catch(() => '<non-JSON body>')
console.log('[agent] body    =', body)
