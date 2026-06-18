# Pricewise — live demo runbook

Three terminals. The dashboard shows **real settled charges** on Tempo Moderato.

## Layout

| Terminal | Runs | Purpose |
|----------|------|---------|
| **A** | `npm run dev` | Server + live dashboard at http://localhost:3000/ |
| **B** | `npm run agent -- --account regular …` | Fire the **regular** (discounted) agent on demand |
| **C** | `npm run agent -- --account newagent …` | Fire the **newagent** (full-price) agent on demand |

Identities are mppx keychain accounts (`npx mppx account list`), resolved by name via `--account`.
Open the dashboard (Terminal A's URL) on the projector before starting.

## Commands

| Command | What it does | Dashboard effect |
|---------|--------------|------------------|
| `npm run agent -- --account newagent --quote` | Show the 402 price for a new caller — **$0.10 (100000)** | terminal only · no row |
| `npm run agent -- --account regular --quote` | Show the 402 price for the regular — **$0.085 (85000), loyalty: tier 3 −15%** | terminal only · no row |
| `npm run agent -- --account regular --settle` | Real on-chain charge at **85000**; prints receipt + tx | **new discounted row + counters tick** |
| `npm run agent -- --account newagent --settle` | Real on-chain charge at **100000**; prints receipt + tx | **new full-price row + counters tick** |
| `npm run agent -- --account regular --discover` | The *informed* path: reads `/openapi.json` → `x-identity-pricing`, asserts identity, settles at tier price. Prints a discovered→identified→settled trace. | **new discounted row + counters tick** |

- **Default mode is `--quote`** (free, safe) — an accidental run never spends funds.
- Each run is **one-shot**; re-run manually to control timing. No auto-loop.

## Suggested flow

1. `--quote` both accounts to show the **price difference** live (free rehearsal, no rows).
2. `--account regular --settle` then `--account newagent --settle` to drop two rows on the dashboard — the discounted row is highlighted with a `−15%` badge next to the full-price one.

## Funded accounts (distinct wallets — that's the point)

- **newagent** — zero history → full price
- **regular**  — boot-seeded (`PRICEWISE_SEED_ACCOUNT=regular`, count 15) → tier 3 (15% off)

Create + fund: `npx mppx account create --account <name>` then `npx mppx account fund --account <name> --network testnet`.
Addresses are whatever the keychain holds — list them with `npx mppx account list`.

## Narration reminder

The discount story is the **recipient-received amount**: regular pays **$0.085** vs new's **$0.10**.
The payer also burns **~0.006 pathUSD in tx fees** on top of the charge — that's a network fee,
**separate** from the discount, so don't fold it into the discount math.

- `--quote` = free rehearsal (no funds move).
- `--settle` = spends testnet funds (real transfer on Moderato).
