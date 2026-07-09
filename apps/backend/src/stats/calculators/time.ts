// §3.3 — Time calculators.
//
// Pure functions: SessionObservation[] → findings.  No DB access.
//
// computeTimeStats: per-item total, planned-vs-actual, session start-time distribution.
//   The start-time distribution is the raw material for context stability (§4.2 / Layer 2).
//
// computeAdHocShare: cross-item planned vs. unplanned time, unplanned by valence.
//   Inherently cross-item; lives here rather than in adherence or procrastination.

import type { SessionObservation } from '../types'
import type { TimeStatsFinding, AdHocShareFinding, SessionDistributionEntry, DateWindow } from '@tracker/shared'

/**
 * §3.3 — Time stats for a single item.
 * plannedDurationMin: from the item snapshot (pass null if item has no planned duration).
 * Session start-times are in UTC hours (consistent within a user's own data).
 */
export function computeTimeStats(
  itemId: string,
  userId: string,
  window: DateWindow,
  sessions: SessionObservation[],
  plannedDurationMin: number | null
): TimeStatsFinding {
  const liveSessions   = sessions.filter(s => s.source === 'live').length
  const manualSessions = sessions.filter(s => s.source === 'manual').length
  const totalMin = sessions.reduce((sum, s) => sum + s.durationMin, 0)

  // Planned-vs-actual: compare total logged time against planned duration.
  // plannedDurationMin is per-occurrence (per session day).  We sum planned across
  // the window by counting distinct days with sessions against the per-day planned.
  // Simplification: if item has a planned duration, the "plan" = plannedDuration × daysWithSessions
  // (or × daysInWindow for recurring items — using actual sessions days as the baseline).
  const plannedVsActualDeltaMin: number | null =
    plannedDurationMin !== null
      ? totalMin - plannedDurationMin * new Set(sessions.map(s => s.day)).size
      : null

  // Session start-time distribution (UTC hour → count + totalMin)
  const hourMap = new Map<number, { count: number; totalMin: number }>()
  for (const s of sessions) {
    const hour = s.startedAt.getUTCHours()
    if (!hourMap.has(hour)) hourMap.set(hour, { count: 0, totalMin: 0 })
    const entry = hourMap.get(hour)!
    entry.count++
    entry.totalMin += s.durationMin
  }
  const sessionStartDistribution: SessionDistributionEntry[] = Array.from(hourMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([hour, { count, totalMin }]) => ({ hour, count, totalMin }))

  return {
    type: 'time_stats',
    userId,
    itemId,
    window,
    rawCounts: { sessionCount: sessions.length, liveSessions, manualSessions },
    totalMin,
    plannedDurationMin,
    plannedVsActualDeltaMin,
    sessionStartDistribution,
  }
}

/**
 * §3.3 — Cross-item ad-hoc share: planned vs. unplanned time, unplanned by valence.
 * sessions is the full user session set for the window (all items).
 */
export function computeAdHocShare(
  userId: string,
  window: DateWindow,
  sessions: SessionObservation[]
): AdHocShareFinding {
  let totalTrackedMin = 0, plannedMin = 0, adHocMin = 0
  let plannedSessions = 0, adHocSessions = 0
  const valence = { productive: 0, unproductive: 0, neutral: 0, unclassified: 0 }

  for (const s of sessions) {
    totalTrackedMin += s.durationMin
    if (s.isAdHoc) {
      adHocSessions++
      adHocMin += s.durationMin
      // Unplanned time split by valence
      const v = s.valence
      if (v === 'productive')   valence.productive   += s.durationMin
      else if (v === 'unproductive') valence.unproductive += s.durationMin
      else if (v === 'neutral') valence.neutral       += s.durationMin
      else                      valence.unclassified  += s.durationMin
    } else {
      plannedSessions++
      plannedMin += s.durationMin
    }
  }

  const adHocShare = totalTrackedMin === 0 ? 0 : adHocMin / totalTrackedMin

  return {
    type: 'adhoc_share',
    userId,
    window,
    rawCounts: { totalSessions: sessions.length, plannedSessions, adHocSessions },
    totalTrackedMin,
    plannedMin,
    adHocMin,
    adHocShare,
    adHocByValence: valence,
  }
}
