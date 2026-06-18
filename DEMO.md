# Pricewise — live demo runbook

Three terminals. The dashboard shows **real settled charges** on Tempo Moderato.

## Layout

| Terminal | Runs | Purpose |
|----------|------|---------|
| **A** | `npm run dev` | Server + live dashboard at http://localhost:3000/ |
| **B** | `npm run agent -- regular …` | Fire the **regular** (discounted) agent on demand |
| **C** | `npm run agent -- new …` | Fire the **new** (full-price) agent on demand |

Open the dashboard (Terminal A's URL) on the projector before starting.

## Commands

| Command | What it does | Dashboard effect |
|---------|--------------|------------------|
| `npm run agent -- new --quote` | Show the 402 price for a new caller — **$0.10 (100000)** | terminal only · no row |
| `npm run agent -- regular --quote` | Show the 402 price for the regular — **$0.085 (85000), loyalty: tier 3 −15%** | terminal only · no row |
| `npm run agent -- regular --settle` | Real on-chain charge at **85000**; prints receipt + tx | **new discounted row + counters tick** |
| `npm run agent -- new --settle` | Real on-chain charge at **100000**; prints receipt + tx | **new full-price row + counters tick** |
| `npm run agent -- regular --discover` | The *informed* path: reads `/openapi.json` → `x-identity-pricing`, asserts identity, settles at tier price. Prints a discovered→identified→settled trace. | **new discounted row + counters tick** |

- **Default mode is `--quote`** (free, safe) — an accidental run never spends funds.
- Each run is **one-shot**; re-run manually to control timing. No auto-loop.

## Suggested flow

1. `--quote` both personas to show the **price difference** live (free rehearsal, no rows).
2. `regular --settle` then `new --settle` to drop two rows on the dashboard — the discounted row is highlighted with a `−15%` badge next to the full-price one.

## Funded personas (distinct wallets — that's the point)

- **new**     `0x6323928363B5f6ffA68F9258061bbc00f12f41bB` — zero history → full price
- **regular** `0xE459f654Eea8c657a18fc6Ed3EaE159Dba9dbb7B` — seeded 15 prior purchases → tier 3 (15% off)

Both funded via: `npx mppx account fund --account <newagent|regular> --network testnet`

## Narration reminder

The discount story is the **recipient-received amount**: regular pays **$0.085** vs new's **$0.10**.
The payer also burns **~0.006 pathUSD in tx fees** on top of the charge — that's a network fee,
**separate** from the discount, so don't fold it into the discount math.

- `--quote` = free rehearsal (no funds move).
- `--settle` = spends testnet funds (real transfer on Moderato).
