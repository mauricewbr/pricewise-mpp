// In-memory store. No database — a Map plus an append-only event log.
// `source` is whatever identifier the route records: a payer DID
// (`did:pkh:...`) from a verified Credential, or undefined when unknown.

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

const events: PurchaseEvent[] = []
const histories = new Map<string, SourceHistory>()

const RECENT_WINDOW_MS = 60_000

export const store = {
  /** Append-only event log. A later phase's dashboard reads this; don't build it now. */
  events,

  /** Per-source totals; zeros if the source is unknown. */
  history(source?: string): SourceHistory {
    if (!source) return { purchases: 0, totalSpend: 0 }
    return histories.get(source) ?? { purchases: 0, totalSpend: 0 }
  },

  /** Record a settled purchase: append to the log and bump the source's history. */
  recordPurchase(
    source: string | undefined,
    amount: number,
    resource: string,
    breakdown: Breakdown[],
  ): void {
    events.push({ source, amount, resource, breakdown, at: Date.now() })
    if (source) {
      const h = histories.get(source) ?? { purchases: 0, totalSpend: 0 }
      h.purchases += 1
      h.totalSpend += amount
      histories.set(source, h)
    }
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
}
