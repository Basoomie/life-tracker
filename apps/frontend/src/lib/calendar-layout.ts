// §12.4 — Calendar layout computations (pure — no React/DOM).
// Produces pixel positions so proportional rendering is deterministic and testable.

import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'

export const PX_PER_HOUR = 60     // base unit; 24h grid = 1440px total
export const TOTAL_PX   = 24 * PX_PER_HOUR  // 1440px

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// Returns minutes elapsed since day-start (0 to 1440).
// Handles wrap-past-midnight (e.g. day-start 04:00, item at 01:00 → 21*60 min)
function fromDayStart(hhmm: string, dayStartMin: number): number {
  const m = toMin(hhmm)
  const diff = m - dayStartMin
  return diff >= 0 ? diff : diff + 1440
}

export type GridBlock = {
  occ: OccurrenceWithState
  topPx: number
  heightPx: number
  leftPct: number    // 0–100; for overlap column splitting
  widthPct: number   // 0–100
  kind: 'range' | 'point' | 'bucket'
}

export type DayLayout = {
  gutter: OccurrenceWithState[]   // none-timed items → unscheduled gutter
  blocks: GridBlock[]             // range + point + bucket → time grid
}

type Interval = {
  occ: OccurrenceWithState
  startMin: number
  endMin: number   // endMin > startMin always (may exceed 1440 for cross-midnight)
  kind: GridBlock['kind']
}

// Standard sweep-line column assignment for overlapping intervals.
function assignColumns(
  intervals: Interval[]
): Map<OccurrenceWithState, { col: number; totalCols: number }> {
  const sorted = [...intervals].sort((a, b) => a.startMin - b.startMin)

  const colEnds: number[] = []  // colEnds[i] = end minute of last block assigned to column i
  const colOf = new Map<OccurrenceWithState, number>()

  for (const iv of sorted) {
    let col = colEnds.findIndex((end) => end <= iv.startMin)
    if (col === -1) col = colEnds.length
    colEnds[col] = iv.endMin
    colOf.set(iv.occ, col)
  }

  // totalCols per item = 1 + max col index among all items that overlap with it
  const result = new Map<OccurrenceWithState, { col: number; totalCols: number }>()
  for (const iv of sorted) {
    const col = colOf.get(iv.occ)!
    let maxCol = col
    for (const other of sorted) {
      if (other.occ === iv.occ) continue
      const otherCol = colOf.get(other.occ)!
      if (iv.startMin < other.endMin && other.startMin < iv.endMin) {
        maxCol = Math.max(maxCol, otherCol)
      }
    }
    result.set(iv.occ, { col, totalCols: maxCol + 1 })
  }
  return result
}

export function computeDayLayout(
  occs: OccurrenceWithState[],
  buckets: Bucket[],
  dayStartHHMM: string  // e.g. '04:00'
): DayLayout {
  const dayStartMin = toMin(dayStartHHMM)
  const gutter: OccurrenceWithState[] = []
  const intervals: Interval[] = []

  for (const occ of occs) {
    const { timingPrecision, timingStartTime, timingEndTime, timingBucketId } = occ.snapshot

    if (timingPrecision === 'none') {
      gutter.push(occ)
      continue
    }

    if (timingPrecision === 'range' && timingStartTime && timingEndTime) {
      const startMin = fromDayStart(timingStartTime, dayStartMin)
      let endMin = fromDayStart(timingEndTime, dayStartMin)
      if (endMin <= startMin) endMin += 1440
      intervals.push({ occ, startMin, endMin, kind: 'range' })
      continue
    }

    if (timingPrecision === 'point' && timingStartTime) {
      const startMin = fromDayStart(timingStartTime, dayStartMin)
      // Treat point as 30-min span for overlap detection only; heightPx is clamped separately
      intervals.push({ occ, startMin, endMin: startMin + 30, kind: 'point' })
      continue
    }

    if (timingPrecision === 'bucket' && timingBucketId) {
      const bucket = buckets.find((b) => b.id === timingBucketId)
      if (bucket) {
        const startMin = fromDayStart(bucket.startTime, dayStartMin)
        let endMin = fromDayStart(bucket.endTime, dayStartMin)
        if (endMin <= startMin) endMin += 1440
        intervals.push({ occ, startMin, endMin, kind: 'bucket' })
      } else {
        gutter.push(occ)
      }
      continue
    }

    gutter.push(occ)
  }

  const colAssignments = assignColumns(intervals)

  const blocks: GridBlock[] = intervals.map((iv) => {
    const { col, totalCols } = colAssignments.get(iv.occ) ?? { col: 0, totalCols: 1 }
    const topPx = (iv.startMin / 1440) * TOTAL_PX
    let heightPx = ((iv.endMin - iv.startMin) / 1440) * TOTAL_PX
    if (iv.kind === 'point') heightPx = Math.max(heightPx, 20) // visible minimum for point markers
    return {
      occ: iv.occ,
      topPx,
      heightPx,
      leftPct: (col / totalCols) * 100,
      widthPct: (1 / totalCols) * 100,
      kind: iv.kind,
    }
  })

  return { gutter, blocks }
}

// Position of the "now" line, in px from top of the grid.
export function nowLinePx(now: Date, dayStartHHMM: string): number {
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  const elapsed = fromDayStart(`${h}:${m}`, toMin(dayStartHHMM))
  return (elapsed / 1440) * TOTAL_PX
}
