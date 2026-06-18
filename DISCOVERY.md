# Pricewise — discoverability

Pricewise advertises itself to agents and registries via an OpenAPI 3.1 document.
All discovery surfaces are **unpaid** — discovery is advisory; the live 402 challenge
is always authoritative.

## Endpoints (free / unpaid)

| Endpoint | What it exposes |
|----------|-----------------|
| `GET /openapi.json` | OpenAPI 3.1 doc. `/data/{resource}` carries `x-payment-info.offers[]` (base/worst-case price `100000` = $0.10, pathUSD). Root `x-service-info` (categories + docs links), root `x-loyalty` (tier ladder), and root `x-identity-pricing` (the conditional-pricing *mechanism*). |
| `GET /llms.txt` | Plain-text summary for LLM agents. |

Three discoverability layers, in priority order:

1. **`x-payment-info.offers[]`** — the base price every agent can find (`100000`). Never personalized; the discount is **not** encoded here.
2. **`x-loyalty`** — machine-readable tier ladder (thresholds, discounts, effective amounts), derived from `src/pricing/rules.ts` so it can't drift from runtime pricing.
3. **`x-identity-pricing`** — the *mechanism* signal: how to obtain the conditional price. Assert your wallet via `X-Agent`; the discounted challenge is **bound to that source** (HMAC'd into the challenge id) and only settles if the payment credential's **verified** source matches. A forged claim can't pay the discounted challenge — it falls back to base. Reuses the same rule-derived tiers as `x-loyalty`.
4. **Prose pointer** — one sentence in the operation `description` (and `llms.txt`) so an LLM agent that doesn't parse the extensions still learns the program exists.

The reference agent (`npm run agent -- regular --discover`) consumes this end-to-end:
reads `x-identity-pricing`, asserts identity, and settles at its tier price — proving the facet is machine-consumable.

## Registering with MPPScan (manual — do NOT auto-register)

The service can be listed in the MPP services registry so agents discover it:

- Register at **https://mppscan.com/register**, or
- Open a PR to the **MPP Services directory**,

pointing either at the deployed `/openapi.json` URL (once hosted) or the repo:
`https://github.com/mauricewbr/pricewise-mpp`.

This is a deliberate manual step — Pricewise does not self-register.

## Framing note (for the pitch)

Discoverable loyalty only sways agents optimizing cost across **repeated** calls — the
same durable repeat-buyers loyalty already targets. `offers[]` makes the base price
findable to everyone; `x-loyalty` makes the tier ladder machine-comparable for agents
that parse it (a "we designed the discovery layer right" signal more than a day-one
reach claim, since the extension is custom); the prose line is the universal fallback an
LLM agent reads. State this plainly — not every agent weighs the tiers.
