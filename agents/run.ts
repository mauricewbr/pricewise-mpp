import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import { MODERATO_CHAIN_ID } from '../src/chain'

// Agent identity comes from AGENT_PRIVATE_KEY (see .env.example for a dev placeholder).
// Never hardcode a key here — keep it in .env so secrets stay out of git.
const pk = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined
if (!pk) {
  throw new Error('AGENT_PRIVATE_KEY is required — set it in .env (see .env.example).')
}
const account = privateKeyToAccount(pk)

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

console.log('[agent] address =', account.address)
console.log('[agent] GET', url)

// mppx.fetch transparently handles the 402 -> pay -> retry flow.
// The custom header rides along on the request (real end-to-end probe for test #5).
const res = await mppx.fetch(url, {
  headers: { 'X-Agent': account.address },
})

console.log('[agent] status  =', res.status)
console.log('[agent] receipt =', res.headers.get('Payment-Receipt'))
const body = await res.json().catch(() => '<non-JSON body>')
console.log('[agent] body    =', body)
