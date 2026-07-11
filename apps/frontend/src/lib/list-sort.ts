// §12.3 — Sorting and grouping logic for the List view.
// Both functions are pure — no side effects.

import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'

const PRECISION_ORDER: Record<string, number> = { range: 0, point: 1, bucket: 2, none: 3 }
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }

function startMinutes(occ: OccurrenceWithState, buckets: Bucket[]): number {
  const { timingPrecision, timingStartTime, timingBucketId } = occ.snapshot
  if ((timingPrecision === 'range' || timingPrecision === 'point') && timingStartTime) {
    const [h, m] = timingStartTime.split(':').map(Number)
    return h * 60 + m
  }
  if (timingPrecision === 'bucket' && timingBucketId) {
    const b = buckets.find((x) => x.id === timingBucketId)
    if (b) {
      const [h, m] = b.startTime.split(':').map(Number)
      return h * 60 + m
    }
  }
  return Infinity
}

// §12.3 default: timing early→late (unscheduled at the bottom), priority as tie-break.
// Sort purely by clock time; none-timed items go last regardless of precision type.
export function sortByTiming(
  occs: OccurrenceWithState[],
  buckets: Bucket[]
): OccurrenceWithState[] {
  return [...occs].sort((a, b) => {
    const precA = a.snapshot.timingPrecision
    const precB = b.snapshot.timingPrecision

    // none-timed always last
    if (precA === 'none' && precB !== 'none') return 1
    if (precB === 'none' && precA !== 'none') return -1
    // Both unscheduled: manual drag-and-drop order (Item.sortOrder), not
    // input order — see reorder-root's live, filter-agnostic ordering.
    if (precA === 'none' && precB === 'none') return a.sortOrder - b.sortOrder

    // Both timed: sort by earliest effective clock time
    const startA = startMinutes(a, buckets)
    const startB = startMinutes(b, buckets)
    if (startA !== startB) return startA - startB

    // Same start: precision order as secondary (range > point > bucket)
    const ordA = PRECISION_ORDER[precA] ?? 3
    const ordB = PRECISION_ORDER[precB] ?? 3
    if (ordA !== ordB) return ordA - ordB

    // Priority as final tie-break
    const priA = a.snapshot.priority ? (PRIORITY_ORDER[a.snapshot.priority] ?? 3) : 3
    const priB = b.snapshot.priority ? (PRIORITY_ORDER[b.snapshot.priority] ?? 3) : 3
    return priA - priB
  })
}

// Splits an already-sorted (sortByTiming) list into timed and untimed
// occurrences, preserving relative order within each group. Untimed items
// are manually reorderable via drag-and-drop; timed ones are not (their
// order is derived from clock time, not draggable).
export function splitTimed(
  occs: OccurrenceWithState[]
): { timed: OccurrenceWithState[]; untimed: OccurrenceWithState[] } {
  const timed: OccurrenceWithState[] = []
  const untimed: OccurrenceWithState[] = []
  for (const o of occs) {
    (o.snapshot.timingPrecision === 'none' ? untimed : timed).push(o)
  }
  return { timed, untimed }
}

export type PriorityGroups = {
  high: OccurrenceWithState[]
  medium: OccurrenceWithState[]
  low: OccurrenceWithState[]
  unset: OccurrenceWithState[]
}

// §12.3 priority-flip: regroup by High / Medium / Low / Unset.
export function groupByPriority(occs: OccurrenceWithState[]): PriorityGroups {
  const groups: PriorityGroups = { high: [], medium: [], low: [], unset: [] }
  for (const occ of occs) {
    const p = occ.snapshot.priority
    if (p === 'high') groups.high.push(occ)
    else if (p === 'medium') groups.medium.push(occ)
    else if (p === 'low') groups.low.push(occ)
    else groups.unset.push(occ)
  }
  return groups
}
