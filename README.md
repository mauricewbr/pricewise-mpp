# Pricewise

**Identity-conditional pricing for the agent economy, built on MPP, discoverable for agents, and configurable by the seller in real time.**

Pricewise lets an API charge a different price depending on *who is asking*. A returning agent earns a loyalty discount; a stranger pays full price. It's built entirely on [MPP](https://mpp.dev) and settles on Tempo's Moderato testnet. It requires **no changes to the MPP protocol** as the mechanism is expressed with primitives MPP already provides.

---

## The idea in one paragraph

MPP says *what a resource costs*, but not *what it costs for this specific caller*. Hence, price is fixed at challenge time, identity arrives later with the payment. Pricewise closes this gap: an agent asserts its identity on the request, the server prices for that identity and **binds the discounted price to the asserted wallet inside the payment challenge**. The discount only settles if the paying credential's **verified** source matches the bound wallet. A forged identity claim therefore buys nothing because paying the discounted challenge requires actually controlling the claimed wallet. It's built to keep everything in one round trip. The buying agent has an incentive to follow Pricewise's identity assertion due to potentially lower prices, a seller has an incentive to use Pricewise to differentiate via more attractive pricing for loyal buyers. 

## What's in the demo

1. **A real agent discovers and uses the discounted price.** Given only a goal ("get the data, pay as little as possible") and a wallet and told nothing about the pricing mechanism, a Claude agent can figure it out. It hits the endpoint, reads the discovery document, finds the identity-pricing mechanism, reasons that asserting its identity lowers its price, and pays the reduced price. (`agents/live.ts`)
2. **Forged identity is rejected.** An agent asserting a wallet it doesn't control is denied at settlement. (`--as` flag)
3. **The seller defines pricing live.** A B2B console (`/console`) where the operator creates or activates a pricing plan; the service re-advertises the new terms in its discovery document, and a fresh agent discovers and climbs the tiers the seller just created.

## Run it

Requirements: Node, an `mppx` keychain with funded Moderato testnet accounts, an `ANTHROPIC_API_KEY` (for the live agent). Copy `.env.example` → `.env` and fill it in. Keys live in the OS keychain (resolved by `--account <name>`), not in `.env`.

```bash
npm install
npm run dev                 # server + console at http://localhost:3000/console
```

Demo commands:
```bash
# Stage 1: real Claude agent discovers and uses the discount
npm run live -- --account regular

# Soundness: forged identity claim is denied at settlement
npm run agent -- --account newagent --as regular --settle

# Deterministic version of the discovery agent (demo fallback)
npm run agent -- --account regular --discover

# Stage 2: create/activate a plan in /console, then run a fresh agent against it
npm run seed -- --account regular 0
npm run live -- --repeat 6

# Free price quote (no payment)
npm run agent -- --account regular --quote
```

## How the soundness works (the centerpiece)

- **Leg 1 (no credential):** server prices from the asserted identity; if discounted, it binds `{source, price}` into the challenge `opaque`, which is HMAC'd into the challenge `id`, i.e. tamper-evident.
- **Leg 2 (credential present):** server honors the *presented* challenge, decodes the bound `{source, price}`, and requires `verified-credential-source == bound-source` (and single-use) before settling. Mismatch or replay → the discount is denied and the caller falls back to base price.
- A forger can't produce a credential whose verified source is the victim's wallet, so the discounted challenge is unsettleable by anyone but the bound wallet. This holds whether the client pays in pull or push mode; in our pull-mode demo the transaction is never even broadcast on a rejected forgery.

## Discoverability

The service publishes its pricing in its own discovery document (`GET /openapi.json`): `offers[]` advertises the base price as worst case, and `x-identity-pricing` / `x-loyalty` advertise the identity-pricing mechanism and the tier schedule. The schedule is derived from a single source (the active plan), the discovery facet and the engine never drift. When the seller changes the active plan, the facet reflects it on the next request.

## Stack

MPP (`mppx@0.7.0`), Tempo Moderato testnet (pathUSD), Hono, TypeScript, Anthropic API (live agent).
