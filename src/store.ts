// In-memory store. No database — a Map plus an append-only event log.
//
// Identity in (a bare `0x…` hint or a `did:pkh:…:0x…` source DID) is always run
// through `toAddress`, so history keys on the bare lowercased address. That makes
// the pre-payment hint and the post-payment payer DID land on the same key.

import { toAddress } from './identity'

export interface Breakdown {
  amount: number
  note: string
}

export interface PurchaseEvent {
  source?: string
  amount: number
  resource: string
  breakdown: Breakdown[]
  at: number // epoch ms
}

export interface SourceHistory {
  purchases: number
  totalSpend: number
}

/** Shape the dashboard reads (event log row, normalized). */
export interface EventRow {
  source?: string
  resource: string
  amount: number
  breakdown: Breakdown[]
  ts: number
}

export interface Stats {
  revenue: number
  count: number
  avgPrice: number
}

const events: PurchaseEvent[] = []
const histories = new Map<string, SourceHistory>()

const RECENT_WINDOW_MS = 60_000

export const store = {
  /** Append-only event log. A later phase's dashboard reads this; don't build it now. */
  events,

  /** Per-address totals; zeros if unknown. Accepts a bare address or a source DID. */
  history(id?: string): SourceHistory {
    const addr = toAddress(id)
    if (!addr) return { purchases: 0, totalSpend: 0 }
    return histories.get(addr) ?? { purchases: 0, totalSpend: 0 }
  },

  /** Record a settled purchase: append to the log and bump the payer's history. */
  recordPurchase(
    id: string | undefined,
    amount: number,
    resource: string,
    breakdown: Breakdown[],
  ): void {
    const addr = toAddress(id)
    events.push({ source: addr, amount, resource, breakdown, at: Date.now() })
    if (addr) {
      const h = histories.get(addr) ?? { purchases: 0, totalSpend: 0 }
      h.purchases += 1
      h.totalSpend += amount
      histories.set(addr, h)
    }
  },

  /**
   * Pre-load a persona's history without real charges (demo seeding).
   * Sets totals directly so the address already has a loyalty tier.
   */
  seed(address: string, purchases: number): void {
    const addr = toAddress(address)
    if (!addr) return
    histories.set(addr, {
      purchases,
      totalSpend: Math.round(purchases * 0.1 * 1e4) / 1e4,
    })
  },

  /** How many events landed in the last 60s. */
  recentRequestCount(): number {
    const cutoff = Date.now() - RECENT_WINDOW_MS
    let count = 0
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].at < cutoff) break
      count++
    }
    return count
  },

  /** Newest-first settled-purchase rows for the dashboard readout. */
  recentEvents(limit = 50): EventRow[] {
    return [...events]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map(({ source, resource, amount, breakdown, at }) => ({
        source,
        resource,
        amount,
        breakdown,
        ts: at,
      }))
  },

  /** Aggregate counters over all settled events. */
  stats(): Stats {
    const count = events.length
    const revenue = events.reduce((sum, e) => sum + e.amount, 0)
    return {
      revenue: Math.round(revenue * 1e6) / 1e6,
      count,
      avgPrice: count ? Math.round((revenue / count) * 1e6) / 1e6 : 0,
    }
  },

  /**
   * Seed a few pre-settled demo rows so the dashboard is never empty on stage.
   * These represent PRIOR REAL settlements (not fake quotes) — they only populate
   * the readout's event log; they do not touch loyalty history. Idempotent.
   */
  seedDemoEvents(): void {
    if (seededDemo) return
    seededDemo = true
    const now = Date.now()
    const rows: PurchaseEvent[] = [
      {
        source: '0xe459f654eea8c657a18fc6ed3eae159dba9dbb7b', // regular persona (discounted)
        resource: 'foo',
        amount: 0.085,
        breakdown: [
          { amount: 0.1, note: 'base' },
          { amount: 0.085, note: 'loyalty: tier 3 −15%' },
        ],
        at: now - 5 * 60_000,
      },
      {
        source: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', // new caller (full price)
        resource: 'bar',
        amount: 0.1,
        breakdown: [
          { amount: 0.1, note: 'base' },
          { amount: 0.1, note: 'loyalty: new caller' },
        ],
        at: now - 4 * 60_000,
      },
      {
        source: '0xe459f654eea8c657a18fc6ed3eae159dba9dbb7b', // regular persona again
        resource: 'baz',
        amount: 0.085,
        breakdown: [
          { amount: 0.1, note: 'base' },
          { amount: 0.085, note: 'loyalty: tier 3 −15%' },
        ],
        at: now - 3 * 60_000,
      },
    ]
    events.push(...rows)
  },
}

let seededDemo = false
