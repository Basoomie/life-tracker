// §12.2 — Now view tier classification.
// Pure function; `now` is injected so tests can control time deterministically.

import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'

export type Tier = 'active' | 'imminent' | 'unscheduled'

export type TieredOccurrences = {
  active: OccurrenceWithState[]
  imminent: OccurrenceWithState[]
  unscheduled: OccurrenceWithState[]
}

// HH:MM → total minutes from midnight
function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// Is nowMin within [startHHmm, endHHmm)?  Handles midnight wrap (end < start).
function isInRange(nowMin: number, start: string, end: string): boolean {
  const s = toMin(start)
  const e = toMin(end)
  if (e > s) return nowMin >= s && nowMin < e      // normal range
  return nowMin >= s || nowMin < e                  // wraps past midnight
}

// Minutes from nowMin until targetMin (wraps to next 24h if target is earlier)
function minutesUntil(nowMin: number, targetMin: number): number {
  return targetMin >= nowMin ? targetMin - nowMin : 24 * 60 - nowMin + targetMin
}

function bucketIdForNow(buckets: Bucket[], nowMin: number): string | null {
  for (const b of buckets) {
    if (isInRange(nowMin, b.startTime, b.endTime)) return b.id
  }
  return null
}

// §12.1 Active tier ordering: range > point > bucket
const TIMING_ORDER: Record<string, number> = { range: 0, point: 1, bucket: 2, none: 3 }

/**
 * §12.2 — Partition today's occurrences into three tiers.
 *
 * @param imminentWindowMin  Lookahead window for imminent tier (default 90 min).
 * @param alwaysShowNext     Show the next upcoming item even beyond the window.
 */
export function tierOccurrences(
  occurrences: OccurrenceWithState[],
  buckets: Bucket[],
  now: Date,
  imminentWindowMin = 90,
  alwaysShowNext = false
): TieredOccurrences {
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const curBucketId = bucketIdForNow(buckets, nowMin)

  // §12.2: blocked items hidden; completed active items leave Now
  const actionable = occurrences.filter(
    (o) => !o.isBlocked && !o.completionState.isComplete
  )

  const active: OccurrenceWithState[] = []
  const imminentCandidates: { occ: OccurrenceWithState; minsUntil: number }[] = []
  const unscheduled: OccurrenceWithState[] = []

  for (const occ of actionable) {
    const p = occ.snapshot.timingPrecision

    if (p === 'none') {
      unscheduled.push(occ)
      continue
    }

    if (p === 'range') {
      const start = occ.snapshot.timingStartTime
      const end   = occ.snapshot.timingEndTime
      if (!start || !end) { unscheduled.push(occ); continue }

      if (isInRange(nowMin, start, end)) {
        active.push(occ)
      } else {
        const startMin = toMin(start)
        const endMin   = toMin(end)
        // Past the range? Fall to unscheduled (still actionable today)
        const inPast = endMin > startMin
          ? nowMin >= endMin
          : false // wrapped ranges are either active or upcoming
        if (inPast) {
          // Window has passed — don't surface in Now view; visible in List/Calendar
        } else {
          imminentCandidates.push({ occ, minsUntil: minutesUntil(nowMin, startMin) })
        }
      }
      continue
    }

    if (p === 'point') {
      const start = occ.snapshot.timingStartTime
      if (!start) { unscheduled.push(occ); continue }

      const startMin = toMin(start)
      if (nowMin >= startMin) {
        // Point's time has arrived — active
        active.push(occ)
      } else {
        imminentCandidates.push({ occ, minsUntil: minutesUntil(nowMin, startMin) })
      }
      continue
    }

    if (p === 'bucket') {
      const bId = occ.snapshot.timingBucketId
      if (!bId) { unscheduled.push(occ); continue }

      if (bId === curBucketId) {
        active.push(occ)
      } else {
        const bucket = buckets.find((b) => b.id === bId)
        if (!bucket) { unscheduled.push(occ); continue }

        const bStart = toMin(bucket.startTime)
        const bEnd   = toMin(bucket.endTime)
        // Is the bucket in the future or the past?
        const bucketIsPast = bEnd > bStart
          ? nowMin >= bEnd
          : false // wrapped buckets never "past" in the same way
        if (bucketIsPast) {
          // Bucket has passed — don't surface in Now view; visible in List/Calendar
        } else {
          imminentCandidates.push({ occ, minsUntil: minutesUntil(nowMin, bStart) })
        }
      }
      continue
    }
  }

  // §12.2: imminent = within window OR alwaysShowNext shows the soonest one
  imminentCandidates.sort((a, b) => a.minsUntil - b.minsUntil)

  const imminent: OccurrenceWithState[] = []
  let shownNext = false
  for (const { occ, minsUntil } of imminentCandidates) {
    if (minsUntil <= imminentWindowMin) {
      imminent.push(occ)
    } else if (alwaysShowNext && !shownNext) {
      imminent.push(occ)
      shownNext = true
    }
  }

  // §12.1: sort active by range > point > bucket
  active.sort(
    (a, b) =>
      (TIMING_ORDER[a.snapshot.timingPrecision] ?? 3) -
      (TIMING_ORDER[b.snapshot.timingPrecision] ?? 3)
  )

  // Manual drag-and-drop order (Item.sortOrder), not input order.
  unscheduled.sort((a, b) => a.sortOrder - b.sortOrder)

  return { active, imminent, unscheduled }
}

// ── Display helpers ─────────────────────────────────────────────────────────

export function formatTimingLabel(occ: OccurrenceWithState, buckets: Bucket[]): string {
  const { timingPrecision, timingStartTime, timingEndTime, timingBucketId } = occ.snapshot
  if (timingPrecision === 'range' && timingStartTime && timingEndTime) {
    return `${timingStartTime} – ${timingEndTime}`
  }
  if (timingPrecision === 'point' && timingStartTime) {
    return `@ ${timingStartTime}`
  }
  if (timingPrecision === 'bucket' && timingBucketId) {
    const b = buckets.find((x) => x.id === timingBucketId)
    return b ? b.name : ''
  }
  return ''
}
