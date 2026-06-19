import Anthropic from '@anthropic-ai/sdk'
import { Mppx, tempo } from 'mppx/client'
import { resolveAccount } from 'mppx/cli'
import { MODERATO_CHAIN_ID } from '../src/chain'

// A real Claude agent (Anthropic Messages API) that, given only a goal + its wallet +
// an endpoint, discovers the service's pricing mechanism from its discovery doc and
// decides on its own to assert its wallet identity to earn its tier discount.
//
// Honest framing: this proves a real agent CAN discover and act on the mechanism end to
// end — not that arbitrary agents already do. The decision is genuinely the model's: the
// tools expose capability only, and the prompt names neither the mechanism, the header,
// nor "read the discovery doc".
//
// Manual tool-use loop (not the Tool Runner) so every reasoning step + tool call prints
// for the audience. Model: claude-opus-4-8. NOTE: temperature is removed on Opus 4.8
// (sending it 400s), so the spec's `temperature: 0` isn't available — we disable thinking
// instead, which is more repeatable AND surfaces the model's reasoning as visible text.

const MODEL = 'claude-opus-4-8'
const TURN_CAP = 8 // a confused agent can't loop forever

const args = process.argv.slice(2)
const accIdx = args.indexOf('--account')
const accountName = accIdx >= 0 ? args[accIdx + 1] : (process.env.MPPX_ACCOUNT ?? 'regular')
const urlIdx = args.indexOf('--url')
const baseUrl = urlIdx >= 0 ? args[urlIdx + 1] : (process.env.SERVER_URL ?? 'http://localhost:3000')
const pure = args.includes('--pure')
const repeatIdx = args.indexOf('--repeat')
const repeat = repeatIdx >= 0 ? Math.max(1, Number(args[repeatIdx + 1]) || 1) : 1
const dataUrl = `${baseUrl}/data/foo`

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[live] ANTHROPIC_API_KEY is required — set it in .env (see .env.example).')
  process.exit(1)
}
const anthropic = new Anthropic() // reads ANTHROPIC_API_KEY from env

// One keychain account signs every payment. For the honest demo this is `regular`
// (already tier 3), so a successful run shows the 100000 -> 85000 drop.
const account = await resolveAccount(accountName).catch((e) => {
  console.error(`[live] could not resolve account "${accountName}": ${e.message}`)
  console.error('       list available accounts with: npx mppx account list')
  process.exit(1)
})

// Reuse the same mppx client settle pattern as agents/run.ts (same SDK, not a fork).
// mode: 'pull' — the client signs but the server broadcasts, so no funds move on a misstep.
const mppx = Mppx.create({
  methods: [tempo({ account, expectedChainId: MODERATO_CHAIN_ID, mode: 'pull' })],
  polyfill: false,
})

// --- trace flags for the final summary ---
let discoveredFacet = false
let assertedIdentity = false
let paidAmount: number | undefined
let txRef: string | undefined
const paidSeq: number[] = [] // each settled price, in order (for --repeat runs)

function usd(n: number): string {
  let s = n.toFixed(6).replace(/0+$/, '')
  if (s.endsWith('.')) s = s.slice(0, -1)
  const dot = s.indexOf('.')
  if (dot === -1) s += '.00'
  else { const dec = s.length - dot - 1; if (dec < 2) s += '0'.repeat(2 - dec) }
  return '$' + s
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return hit ? headers[hit] : undefined
}

// Receipt has no amount — read the settled amount the server recorded (same as run.ts fix).
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

// The advertised base price, read from the live active plan (falls back to $0.10).
async function activeBaseDollars(): Promise<number> {
  try {
    const plan = (await fetch(`${baseUrl}/api/plan`).then((r) => r.json())) as { basePrice?: number }
    return typeof plan.basePrice === 'number' ? plan.basePrice / 1e6 : 0.1
  } catch {
    return 0.1
  }
}

// --- Tools: capability only. They do NOT encode the pricing mechanism. ---
const tools: Anthropic.Tool[] = [
  {
    name: 'fetch_url',
    description:
      'Perform a plain HTTP GET (no payment). Returns {status, headers, body}. Use it to read any ' +
      'URL — including the data endpoint, which may respond 402 Payment Required, and any documents ' +
      'the service publishes about itself.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to GET.' },
        headers: {
          type: 'object',
          description: 'Optional request headers (flat string map).',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'pay_and_fetch',
    description:
      'Perform an HTTP GET that automatically settles any 402 charge from your wallet, then returns ' +
      'the paid response. Returns {status, paidAmount, receipt, body}. Any headers you pass are sent ' +
      'on the request as-is.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to GET and pay for.' },
        headers: {
          type: 'object',
          description: 'Optional request headers (flat string map).',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['url'],
    },
  },
]

async function fetchUrl(input: { url: string; headers?: Record<string, string> }): Promise<string> {
  const res = await fetch(input.url, { headers: input.headers ?? {} })
  const body = await res.text()
  if (/openapi(\.json)?/i.test(input.url)) discoveredFacet = true
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => (headers[k] = v))
  return JSON.stringify({ status: res.status, headers, body: body.slice(0, 8000) })
}

async function payAndFetch(input: { url: string; headers?: Record<string, string> }): Promise<string> {
  // The agent's headers are passed through UNCHANGED. We never auto-inject X-Agent —
  // asserting identity must be the agent's own decision.
  const claimed = headerValue(input.headers, 'x-agent')
  if (claimed) {
    assertedIdentity = true
    if (claimed.toLowerCase() !== account.address.toLowerCase()) {
      console.warn(
        `[live][warn] asserted X-Agent ${claimed} != signer ${account.address} — that is the ` +
          'forge path; the discount will be denied. (Honest demo asserts the signer\'s own address.)',
      )
    }
  }
  const res = await mppx.fetch(input.url, { headers: input.headers ?? {} }).catch((e: Error) => e)
  if (res instanceof Error) {
    return JSON.stringify({ status: 402, error: `payment rejected: ${res.message}` })
  }
  const body = await res.text()
  let receipt: { status?: string; reference?: string } | undefined
  const rb = res.headers.get('Payment-Receipt')
  if (rb) {
    try {
      receipt = JSON.parse(Buffer.from(rb, 'base64').toString())
    } catch {
      /* leave undefined */
    }
  }
  if (res.status === 200) {
    paidAmount = await settledAmountFor(account.address)
    if (paidAmount != null) paidSeq.push(paidAmount)
    txRef = receipt?.reference
  }
  return JSON.stringify({ status: res.status, paidAmount, receipt, body: body.slice(0, 4000) })
}

const SYSTEM =
  'You are an autonomous agent operating a wallet. You have two tools: fetch_url (a plain GET) ' +
  'and pay_and_fetch (a GET that settles any required payment from your wallet). Reason out loud ' +
  'before each action: state what you are about to do and why. Be economical — do not pay more ' +
  'than you can justify. When you have the data, stop and report what you paid.'

const guidedTask =
  `You need to retrieve data from a paid API endpoint at ${dataUrl}. You control a wallet with ` +
  `address ${account.address} and can pay for requests. Your goal is to obtain the data while ` +
  `paying as little as possible. Investigate the service thoroughly BEFORE paying — payments are ` +
  `final and cannot be refunded, so understand the full pricing picture first. Services often ` +
  `publish a machine-readable self-description of their API; look for one. Some services offer ` +
  `better prices to identifiable returning customers. Obtain the data at the lowest price you can justify.`

const pureTask =
  `Retrieve the data from ${dataUrl}, paying as little as possible. You control a wallet ` +
  `(address ${account.address}) that can pay for requests.`

// --repeat N: a pricing-observation task. The agent makes N separate paid retrievals,
// asserting its identity each time, and reports the price per call — so the audience
// watches the per-call price change live as its own settled-purchase history grows.
const repeatSuffix =
  ` This is a pricing-observation task: you must make ${repeat} SEPARATE paid retrievals of ` +
  `the resource, not just one. Each of the ${repeat} calls is required even though the payload ` +
  `repeats — the point is to observe how the per-call price changes as your purchase history ` +
  `grows. After each paid call, report the exact amount you paid. Do not stop early.`

const baseTask = pure ? pureTask : guidedTask
const task = repeat > 1 ? baseTask + repeatSuffix : baseTask

console.log(
  `\n=== Pricewise LIVE agent · model=${MODEL} · account=${accountName} · prompt=${pure ? 'pure' : 'guided'}` +
    `${repeat > 1 ? ` · repeat=${repeat}` : ''} ===`,
)
console.log(`[live] wallet  = ${account.address}`)
console.log(`[live] endpoint = ${dataUrl}`)
console.log(`[live] goal     = "${task}"\n`)

const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }]

// Give a repeat run room: discovery + one turn per paid call + headroom for the agent
// to reason about the changing price between calls.
const turnCap = Math.max(TURN_CAP, repeat + 10)

let converged = false
try {
for (let turn = 1; turn <= turnCap; turn++) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'disabled' }, // reasoning surfaces as visible text; most repeatable on Opus 4.8
    system: SYSTEM,
    tools,
    messages,
  })

  for (const block of res.content) {
    if (block.type === 'text' && block.text.trim()) console.log(`[claude] ${block.text.trim()}`)
  }

  if (res.stop_reason !== 'tool_use') {
    converged = true
    break
  }

  messages.push({ role: 'assistant', content: res.content })
  const toolResults: Anthropic.ToolResultBlockParam[] = []
  for (const block of res.content) {
    if (block.type !== 'tool_use') continue
    console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`)
    const input = block.input as { url: string; headers?: Record<string, string> }
    const out =
      block.name === 'fetch_url'
        ? await fetchUrl(input)
        : block.name === 'pay_and_fetch'
          ? await payAndFetch(input)
          : JSON.stringify({ error: `unknown tool ${block.name}` })
    console.log(`[result] ${out.length > 400 ? out.slice(0, 400) + '…' : out}`)
    toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out })
  }
  messages.push({ role: 'user', content: toolResults })
}
} catch (e) {
  // Stage-safe: never dump a stack trace on a projector. One clean line + the fallback.
  if (e instanceof Anthropic.APIError) {
    console.error(`\n[live] Anthropic API error (${e.status ?? '?'}): ${e.message}`)
  } else {
    console.error(`\n[live] error: ${(e as Error).message}`)
  }
  console.error(
    '[live] live agent unavailable — fall back to the scripted agent: ' +
      'npm run agent -- --account regular --discover',
  )
  process.exit(1)
}

const baseDollars = await activeBaseDollars()
console.log(
  `\n[live-agent] discovered facet=${discoveredFacet ? 'yes' : 'no'} · asserted identity=` +
    `${assertedIdentity ? 'yes' : 'no'} · base ${usd(baseDollars)} → paid ` +
    `${paidAmount != null ? usd(paidAmount) : 'n/a'} · tx ${txRef ?? 'n/a'}`,
)
if (repeat > 1 && paidSeq.length) {
  console.log(`[live-agent] price per call: ${paidSeq.map(usd).join(' → ')} (${paidSeq.length}/${repeat} settled)`)
}
if (!converged) {
  console.log(
    '[live-agent] did not converge within the turn cap — fall back to the scripted agent: ' +
      'npm run agent -- --account regular --discover',
  )
}
