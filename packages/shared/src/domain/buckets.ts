// §6.6 — The bucket cycle: ordering, seams, tiling validation, and day-start re-anchoring.
//
// A valid bucket set is a *cycle*: each bucket ends exactly where the next one starts,
// the loop closes, and the spans sum to one full day (1440 minutes). Exactly one seam
// in that cycle is the **day boundary** — the one whose clock time equals the day-start.
//
// The clock time where two buckets meet is a **seam**, and the seam — not the bucket —
// is the unit of editing. "Early Morning ends at 09:00" and "Morning starts at 09:00"
// are one fact stored twice; moving one copy without the other is exactly what makes a
// set un-tileable, so every edit here moves both (applySeamMove).
//
// The day-boundary seam is not editable as a seam: it moves when the day-start moves
// (planDayStartReanchor, §6.7). That is what keeps the two configs — which the spec
// requires to "stay consistent" — consistent by construction rather than by luck.
//
// Pure functions over plain bucket records: no DB, no I/O, so both the API (which is
// authoritative) and the settings UI (which previews) can use the same rules.

import type { Bucket } from '../types/entities'

const MINUTES_PER_DAY = 1440

/** True for a well-formed 'HH:MM' 24-hour clock string. */
export function isHHMM(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value)
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Forward distance in minutes from `from` to `to` around the clock, 0–1439.
 * Zero means the two times are the same instant of the day.
 */
function minutesBetween(from: string, to: string): number {
  return (hhmmToMinutes(to) - hhmmToMinutes(from) + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

/**
 * The length of a span running `from` → `to`. Same as minutesBetween, except that a
 * span ending where it started is a *full* day (1440), not a zero-length one — a
 * single bucket covering 04:00→04:00 tiles the whole day.
 */
export function spanMinutes(from: string, to: string): number {
  const d = minutesBetween(from, to)
  return d === 0 ? MINUTES_PER_DAY : d
}

/** Minutes from the day-start to `hhmm`, 0–1439. The day-start itself is offset 0. */
export function offsetFromDayStart(hhmm: string, dayStart: string): number {
  return minutesBetween(dayStart, hhmm)
}

// ── The cycle ─────────────────────────────────────────────────────────────────

export type BucketSeam = {
  /** The bucket that ends at this seam. */
  beforeBucketId: string
  beforeName: string
  /** The bucket that starts at this seam. */
  afterBucketId: string
  afterName: string
  /** Clock time (HH:MM) where the two meet. */
  time: string
  /** True when this seam sits on the day-start — the one seam the day-start owns. */
  isDayBoundary: boolean
}

export type BucketCycle = {
  /** Buckets in day-start order: the one nearest the day boundary first. */
  ordered: Bucket[]
  /** Seam after ordered[i]; the last entry wraps from the last bucket back to the first. */
  seams: BucketSeam[]
  /** True when some seam sits exactly on the day-start (i.e. the set tiles *this* day). */
  anchored: boolean
}

export type BucketCycleResult =
  | { ok: true; cycle: BucketCycle }
  | { ok: false; error: string }

/**
 * §6.6 — Walk the bucket set as a cycle.
 *
 * `dayStart` only decides where the walk *starts* (and therefore which seam is the wrap
 * seam) — a set can form a perfectly good cycle while being anchored somewhere other
 * than the current day-start. That is the difference between "broken" (no cycle at all:
 * a real gap or overlap) and "drifted" (a valid cycle whose day boundary moved out from
 * under it), and only the second is repairable by moving one seam.
 */
export function buildBucketCycle(buckets: Bucket[], dayStart: string): BucketCycleResult {
  if (buckets.length === 0) {
    return { ok: false, error: 'No buckets are defined, so no part of the day is covered.' }
  }

  // Each clock time may be claimed as a start by at most one bucket.
  const byStart = new Map<string, Bucket>()
  for (const b of buckets) {
    const clash = byStart.get(b.startTime)
    if (clash) {
      return {
        ok: false,
        error: `Buckets "${clash.name}" and "${b.name}" both start at ${b.startTime}.`,
      }
    }
    byStart.set(b.startTime, b)
  }

  // Start the walk at whichever bucket begins nearest the day-start.
  const first = [...buckets].sort(
    (a, b) => offsetFromDayStart(a.startTime, dayStart) - offsetFromDayStart(b.startTime, dayStart)
  )[0]

  const ordered: Bucket[] = []
  const seen = new Set<string>()
  let cur = first
  let covered = 0

  while (!seen.has(cur.id)) {
    seen.add(cur.id)
    ordered.push(cur)
    covered += spanMinutes(cur.startTime, cur.endTime)
    const next = byStart.get(cur.endTime)
    if (!next) {
      return {
        ok: false,
        error: `Gap or overlap: bucket "${cur.name}" ends at ${cur.endTime}, but no bucket starts then.`,
      }
    }
    cur = next
  }

  // A shorter loop that closes on itself leaves other buckets unvisited.
  if (cur !== first || ordered.length !== buckets.length) {
    const orphan = buckets.find((b) => !seen.has(b.id))
    return {
      ok: false,
      error:
        'Buckets do not form a single cycle' +
        (orphan
          ? `; "${orphan.name}" (${orphan.startTime}→${orphan.endTime}) is on a separate loop.`
          : '.'),
    }
  }

  // A closed loop can still wrap the clock more than once (every span is taken mod
  // one day), which would tile some hours twice and others not at all.
  if (covered !== MINUTES_PER_DAY) {
    return {
      ok: false,
      error: `Buckets cover ${covered} minutes, which is not one day (${MINUTES_PER_DAY}).`,
    }
  }

  const seams: BucketSeam[] = ordered.map((b, i) => {
    const after = ordered[(i + 1) % ordered.length]
    return {
      beforeBucketId: b.id,
      beforeName: b.name,
      afterBucketId: after.id,
      afterName: after.name,
      time: b.endTime,
      isDayBoundary: b.endTime === dayStart,
    }
  })

  return {
    ok: true,
    cycle: { ordered, seams, anchored: seams.some((s) => s.isDayBoundary) },
  }
}

/**
 * §6.6 — Validate that a set of buckets tiles the day-start window exactly:
 * a closed cycle covering one full day, anchored on the day-start.
 *
 * @returns null if valid; an error string describing the problem.
 */
export function validateBucketTiling(buckets: Bucket[], dayStart: string): string | null {
  if (buckets.length === 0) return null

  const result = buildBucketCycle(buckets, dayStart)
  if (!result.ok) return result.error

  if (!result.cycle.anchored) {
    const first = result.cycle.ordered[0]
    return (
      `Buckets run ${first.startTime} → ${first.startTime}, but the day starts at ${dayStart}. ` +
      `The ${dayStart}–${first.startTime} window falls outside the day they tile.`
    )
  }

  return null
}

// ── Moving a seam ─────────────────────────────────────────────────────────────

/** The bucket whose span contains `hhmm` (start inclusive, end exclusive). */
export function bucketContaining(cycle: BucketCycle, hhmm: string): Bucket {
  for (const b of cycle.ordered) {
    const d = minutesBetween(b.startTime, hhmm)
    if (d < spanMinutes(b.startTime, b.endTime)) return b
  }
  // Unreachable: a cycle covers the full day, so some bucket contains every time.
  return cycle.ordered[0]
}

/**
 * The geometric constraint on a seam: it must land strictly inside the span the two
 * adjacent buckets share, or one of them would come out empty (or inverted, which
 * would silently unwind the rest of the cycle).
 */
function validateSeamRange(before: Bucket, after: Bucket, newTime: string): string | null {
  const room = spanMinutes(before.startTime, after.endTime)
  const offset = minutesBetween(before.startTime, newTime)
  if (offset === 0 || offset >= room) {
    return (
      `The seam between "${before.name}" and "${after.name}" must fall strictly between ` +
      `${before.startTime} and ${after.endTime} — the span those two buckets share. Got ${newTime}.`
    )
  }
  return null
}

/**
 * §6.6 — Can this seam move to `newTime`?
 *
 * The day-boundary seam is refused on principle, not on geometry: it belongs to the
 * day-start setting, and letting it be dragged here would move the day boundary without
 * appending to the day-start timeline (§6.7) — silently re-bucketing days.
 */
export function validateSeamMove(
  cycle: BucketCycle,
  seam: BucketSeam,
  newTime: string
): string | null {
  if (!isHHMM(newTime)) return `"${newTime}" is not a valid HH:MM time.`

  if (seam.isDayBoundary) {
    return (
      `The seam at ${seam.time} is the day boundary. Change it in the day-start setting — ` +
      'the buckets re-anchor with it (§6.7).'
    )
  }

  const before = cycle.ordered.find((b) => b.id === seam.beforeBucketId)!
  const after = cycle.ordered.find((b) => b.id === seam.afterBucketId)!
  return validateSeamRange(before, after, newTime)
}

/**
 * §6.6 — Produce the proposed bucket set with `seam` moved to `newTime`.
 *
 * Both adjacent buckets move together — that is the whole point of editing seams rather
 * than buckets. Buckets not adjacent to the seam are returned untouched. Callers must
 * validate first (validateSeamMove / validateBucketTiling); this applies, it does not judge.
 */
export function applySeamMove(buckets: Bucket[], seam: BucketSeam, newTime: string): Bucket[] {
  return buckets.map((b) => {
    if (b.id === seam.beforeBucketId) return { ...b, endTime: newTime }
    if (b.id === seam.afterBucketId) return { ...b, startTime: newTime }
    return b
  })
}

// ── Day-start re-anchoring (§6.7) ─────────────────────────────────────────────

export type ReanchorStatus =
  /** The wrap seam moved: the first bucket's start and the last bucket's end follow the day-start. */
  | 'moved'
  /** A seam already sits on the new day-start; nothing to do. */
  | 'already-anchored'
  /** No buckets are configured. */
  | 'no-buckets'
  /** The set is not a cycle, so there is no wrap seam to move. The day-start change still stands. */
  | 'not-a-cycle'
  /** The new day-start would land inside a bucket that is not at the edge. Refuse the change. */
  | 'blocked'

export type ReanchorPlan = {
  status: ReanchorStatus
  /** The full proposed bucket set. Identical to the input unless status is 'moved'. */
  buckets: Bucket[]
  /** The two buckets whose boundaries move. Empty unless status is 'moved'. */
  changed: Bucket[]
  /** Where the wrap seam sat before the move. Null when there was no cycle. */
  previousSeamTime: string | null
  /** The bucket that now starts at the new day-start. Null unless status is 'moved'. */
  firstBucketId: string | null
  /** The bucket that now ends at the new day-start. Null unless status is 'moved'. */
  lastBucketId: string | null
  /** Set only when status is 'blocked' — the reason to refuse the day-start change. */
  error: string | null
}

/**
 * §6.7 — Plan how the bucket set follows a day-start change.
 *
 * The day-start defines the window and the buckets partition it, so moving the window's
 * edge must move the buckets' edge with it or the set stops tiling (the spec's
 * changeover seam). Only the two *edge* buckets move — the first stretches or shrinks at
 * its start, the last at its end — and every interior seam stays where the user put it.
 *
 * `previousDayStart` only locates the wrap seam. A set that has already drifted out of
 * anchor (a day-start changed before this rule existed) still has a well-defined wrap
 * seam, so applying any day-start change repairs it.
 */
export function planDayStartReanchor(
  buckets: Bucket[],
  previousDayStart: string,
  newDayStart: string
): ReanchorPlan {
  const base: ReanchorPlan = {
    status: 'no-buckets',
    buckets,
    changed: [],
    previousSeamTime: null,
    firstBucketId: null,
    lastBucketId: null,
    error: null,
  }

  if (buckets.length === 0) return base

  const result = buildBucketCycle(buckets, previousDayStart)
  if (!result.ok) {
    // Nothing coherent to re-anchor. Refusing the day-start change here would strand the
    // user (they would need the day-start to fix the buckets and the buckets to fix the
    // day-start), so the change stands and the caller reports the state.
    return { ...base, status: 'not-a-cycle' }
  }

  const cycle = result.cycle
  const wrapSeam = cycle.seams[cycle.seams.length - 1]

  if (wrapSeam.time === newDayStart) {
    return { ...base, status: 'already-anchored', previousSeamTime: wrapSeam.time }
  }

  const before = cycle.ordered[cycle.ordered.length - 1]
  const after = cycle.ordered[0]
  const rangeError = validateSeamRange(before, after, newDayStart)
  if (rangeError) {
    const inside = bucketContaining(cycle, newDayStart)
    return {
      ...base,
      status: 'blocked',
      previousSeamTime: wrapSeam.time,
      error:
        `A day-start of ${newDayStart} falls inside bucket "${inside.name}" ` +
        `(${inside.startTime}→${inside.endTime}). Only the buckets at the edge of the day can ` +
        `follow the day-start, so it must fall strictly between ${before.startTime} and ` +
        `${after.endTime}. Move that seam in the bucket settings first.`,
    }
  }

  const proposed = applySeamMove(buckets, wrapSeam, newDayStart)
  return {
    status: 'moved',
    buckets: proposed,
    changed: proposed.filter(
      (b) => b.id === wrapSeam.beforeBucketId || b.id === wrapSeam.afterBucketId
    ),
    previousSeamTime: wrapSeam.time,
    // The wrap seam runs last bucket → first bucket, so its two sides are exactly the
    // buckets that now end and start at the new day-start.
    firstBucketId: wrapSeam.afterBucketId,
    lastBucketId: wrapSeam.beforeBucketId,
    error: null,
  }
}
