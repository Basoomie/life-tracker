// §3.4 — Procrastination calculator.
//
// Pure function: observation arrays → ProcrastinationFinding.  No DB access.
//
// rescheduleCount: total reschedule events for the item in the window.
// longestRescheduleChain: consecutive pushes — follows originalDay→newDay links.
// backfillStats: from retroactive_completion events (recorded-at vs applies-to gap).

import type { RescheduleObservation, BackfillObservation } from '../types'
import type { ProcrastinationFinding, DateWindow } from '@tracker/shared'

// Find the longest chain of consecutive reschedules.
// Each reschedule links originalDay → newDay.  A chain is A→B→C→...
// Returns 0 if no reschedules; 1 if one push with no follow-on; etc.
function longestChain(reschedules: RescheduleObservation[]): number {
  if (reschedules.length === 0) return 0

  // Build: originalDay → newDay map (last reschedule wins if duplicates)
  const next = new Map<string, string>()
  for (const r of reschedules) {
    next.set(r.originalDay, r.newDay)
  }

  // Find chain length starting from each possible origin
  // A valid origin is a day that is NOT the target of any other reschedule
  const targets = new Set(next.values())
  const origins = Array.from(next.keys()).filter(d => !targets.has(d))

  let longest = 0
  for (const start of origins) {
    let day = start
    let length = 0
    const visited = new Set<string>()
    while (next.has(day) && !visited.has(day)) {
      visited.add(day)
      day = next.get(day)!
      length++
    }
    if (length > longest) longest = length
  }

  // Edge case: if all origins are also targets (cycles), just count total edges
  if (origins.length === 0) longest = next.size

  return longest
}

// Compute median from a sorted array.
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * §3.4 — Compute procrastination stats for an item.
 * Pure: takes pre-built observation arrays, no DB access.
 */
export function computeProcrastination(
  itemId: string,
  userId: string,
  window: DateWindow,
  reschedules: RescheduleObservation[],
  backfills: BackfillObservation[]
): ProcrastinationFinding {
  const rescheduleCount = reschedules.length
  const chain = longestChain(reschedules)

  const totalCompletions = backfills.length  // total retroactive completions
  const lags = backfills.map(b => b.lagDays).sort((a, b) => a - b)

  return {
    type: 'procrastination',
    userId,
    itemId,
    window,
    rawCounts: {
      rescheduleCount,
      backfilledCompletions: lags.length,
      totalCompletions,
    },
    rescheduleCount,
    longestRescheduleChain: chain,
    backfillStats: {
      count: lags.length,
      medianLagDays: median(lags),
      maxLagDays: lags.length > 0 ? lags[lags.length - 1] : 0,
    },
  }
}
