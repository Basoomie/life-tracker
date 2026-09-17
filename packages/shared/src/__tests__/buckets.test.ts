// §6.6 / §6.7 — Bucket tiling, seam editing, and day-start re-anchoring.
//
// Test names read back the spec's rules: buckets "tile the day-start window with no
// gaps and no overlaps" (§6.6), they "live inside the day-start framing" with the first
// beginning at day-start and the last ending at the next (§6.6), and both configs are
// "editable and validated to stay consistent" (§6.6/§6.7).

import { describe, it, expect } from 'vitest'
import type { Bucket } from '../types/entities'
import {
  buildBucketCycle,
  validateBucketTiling,
  validateSeamMove,
  applySeamMove,
  planDayStartReanchor,
} from '../domain/buckets'

// Minimal bucket factory — only the fields the tiling rules read.
function bucket(name: string, startTime: string, endTime: string): Bucket {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    userId: 'u1',
    name,
    startTime,
    endTime,
    sortOrder: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

// The seeded set (seed.ts): five buckets tiling the 04:00 → 04:00 window.
function seededSet(): Bucket[] {
  return [
    bucket('Early Morning', '04:00', '09:00'),
    bucket('Morning', '09:00', '12:00'),
    bucket('Afternoon', '12:00', '17:00'),
    bucket('Evening', '17:00', '22:00'),
    bucket('Night', '22:00', '04:00'),
  ]
}

function seamBetween(buckets: Bucket[], dayStart: string, beforeName: string) {
  const result = buildBucketCycle(buckets, dayStart)
  if (!result.ok) throw new Error(`expected a cycle, got: ${result.error}`)
  const seam = result.cycle.seams.find((s) => s.beforeName === beforeName)
  if (!seam) throw new Error(`no seam after "${beforeName}"`)
  return { cycle: result.cycle, seam }
}

describe('§6.6 — buckets tile the day-start window with no gaps and no overlaps', () => {
  it('§6.6 a set that tiles the window exactly is valid', () => {
    expect(validateBucketTiling(seededSet(), '04:00')).toBeNull()
  })

  it('§6.6 a single bucket spanning the whole day tiles the window', () => {
    expect(validateBucketTiling([bucket('All Day', '04:00', '04:00')], '04:00')).toBeNull()
  })

  it('§6.6 a gap between two buckets is rejected', () => {
    const buckets = seededSet()
    buckets[0] = bucket('Early Morning', '04:00', '08:00') // Morning still starts at 09:00
    expect(validateBucketTiling(buckets, '04:00')).toMatch(/Gap or overlap/)
  })

  it('§6.6 an overlap between two buckets is rejected', () => {
    const buckets = seededSet()
    buckets[0] = bucket('Early Morning', '04:00', '10:00') // runs past Morning's 09:00 start
    expect(validateBucketTiling(buckets, '04:00')).toMatch(/Gap or overlap/)
  })

  it('§6.6 two buckets claiming the same start time are rejected', () => {
    const buckets = [...seededSet(), bucket('Duplicate', '09:00', '12:00')]
    expect(validateBucketTiling(buckets, '04:00')).toMatch(/both start at 09:00/)
  })

  it('§6.6 a closed loop that wraps the clock more than once is rejected', () => {
    // Every end matches a start and the loop closes, but the spans total 48 hours:
    // some hours are tiled twice and the set still "looks" contiguous pairwise.
    const buckets = [
      bucket('A', '00:00', '12:00'),
      bucket('B', '12:00', '06:00'),
      bucket('C', '06:00', '18:00'),
      bucket('D', '18:00', '00:00'),
    ]
    expect(validateBucketTiling(buckets, '00:00')).toMatch(/not one day/)
  })

  it('§6.6 buckets on two separate loops are rejected', () => {
    const buckets = [
      bucket('A', '00:00', '06:00'),
      bucket('B', '06:00', '00:00'),
      bucket('C', '09:00', '13:00'),
      bucket('D', '13:00', '09:00'),
    ]
    expect(validateBucketTiling(buckets, '00:00')).toMatch(/separate loop/)
  })
})

describe('§6.6 — the first bucket begins at day-start and the last ends at the next', () => {
  it('§6.6 a valid cycle anchored elsewhere than the day-start is rejected', () => {
    // The reported defect: the day-start moved to 03:00 and left the 04:00-anchored
    // set stranded. The cycle is intact, but it no longer tiles *this* day.
    const error = validateBucketTiling(seededSet(), '03:00')
    expect(error).toMatch(/but the day starts at 03:00/)
  })

  it('§6.6 a drifted set is still a cycle, so one seam move can repair it', () => {
    const result = buildBucketCycle(seededSet(), '03:00')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cycle.anchored).toBe(false)
    // Day-start order still works: the walk starts at the bucket nearest 03:00.
    expect(result.cycle.ordered.map((b) => b.name)).toEqual([
      'Early Morning', 'Morning', 'Afternoon', 'Evening', 'Night',
    ])
  })

  it('§6.6 seams are listed in day-start order with the wrap seam marked as the day boundary', () => {
    const result = buildBucketCycle(seededSet(), '04:00')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.cycle.seams.map((s) => s.time)).toEqual([
      '09:00', '12:00', '17:00', '22:00', '04:00',
    ])
    expect(result.cycle.seams.filter((s) => s.isDayBoundary).map((s) => s.time)).toEqual(['04:00'])
    expect(result.cycle.anchored).toBe(true)
  })
})

describe('§6.6 — bucket boundaries are editable (as seams)', () => {
  it('§6.6 moving a seam moves both adjacent buckets and keeps the set tiling', () => {
    const buckets = seededSet()
    const { cycle, seam } = seamBetween(buckets, '04:00', 'Early Morning')

    expect(validateSeamMove(cycle, seam, '10:00')).toBeNull()

    const moved = applySeamMove(buckets, seam, '10:00')
    expect(moved.find((b) => b.name === 'Early Morning')!.endTime).toBe('10:00')
    expect(moved.find((b) => b.name === 'Morning')!.startTime).toBe('10:00')
    expect(validateBucketTiling(moved, '04:00')).toBeNull()
  })

  it('§6.6 buckets not adjacent to the moved seam are untouched', () => {
    const buckets = seededSet()
    const { seam } = seamBetween(buckets, '04:00', 'Early Morning')
    const moved = applySeamMove(buckets, seam, '10:00')

    for (const name of ['Afternoon', 'Evening', 'Night']) {
      expect(moved.find((b) => b.name === name)).toEqual(buckets.find((b) => b.name === name))
    }
  })

  it('§6.6 a seam move that would leave a bucket empty is rejected', () => {
    const buckets = seededSet()
    const { cycle, seam } = seamBetween(buckets, '04:00', 'Early Morning')

    // 04:00 would empty Early Morning; 12:00 would empty Morning.
    expect(validateSeamMove(cycle, seam, '04:00')).toMatch(/strictly between 04:00 and 12:00/)
    expect(validateSeamMove(cycle, seam, '12:00')).toMatch(/strictly between 04:00 and 12:00/)
  })

  it('§6.6 a seam move past its neighbours is rejected', () => {
    const buckets = seededSet()
    const { cycle, seam } = seamBetween(buckets, '04:00', 'Early Morning')
    expect(validateSeamMove(cycle, seam, '18:00')).toMatch(/strictly between 04:00 and 12:00/)
  })

  it('§6.6 the day-boundary seam is not editable as a seam; it belongs to the day-start', () => {
    const buckets = seededSet()
    const { cycle, seam } = seamBetween(buckets, '04:00', 'Night')
    expect(seam.isDayBoundary).toBe(true)
    expect(validateSeamMove(cycle, seam, '03:00')).toMatch(/day boundary/)
  })

  it('§6.6 in a drifted set the wrap seam is editable, which is how the set is repaired', () => {
    const buckets = seededSet()
    const { cycle, seam } = seamBetween(buckets, '03:00', 'Night')
    expect(seam.isDayBoundary).toBe(false) // it sits at 04:00, the day starts at 03:00

    expect(validateSeamMove(cycle, seam, '03:00')).toBeNull()
    expect(validateBucketTiling(applySeamMove(buckets, seam, '03:00'), '03:00')).toBeNull()
  })

  it('§6.6 a malformed time is rejected rather than silently wrapping the clock', () => {
    const buckets = seededSet()
    const { cycle, seam } = seamBetween(buckets, '04:00', 'Early Morning')
    expect(validateSeamMove(cycle, seam, '25:00')).toMatch(/not a valid HH:MM/)
    expect(validateSeamMove(cycle, seam, 'noon')).toMatch(/not a valid HH:MM/)
  })
})

describe('§6.7 — a day-start change re-anchors the buckets so both stay consistent', () => {
  it('§6.7 moving the day-start earlier stretches the edge buckets to follow it', () => {
    const plan = planDayStartReanchor(seededSet(), '04:00', '03:00')

    expect(plan.status).toBe('moved')
    expect(plan.previousSeamTime).toBe('04:00')
    expect(plan.buckets.find((b) => b.name === 'Early Morning')!.startTime).toBe('03:00')
    expect(plan.buckets.find((b) => b.name === 'Night')!.endTime).toBe('03:00')
    expect(validateBucketTiling(plan.buckets, '03:00')).toBeNull()
  })

  it('§6.7 only the two edge buckets move; interior seams stay where the user put them', () => {
    const before = seededSet()
    const plan = planDayStartReanchor(before, '04:00', '03:00')

    expect(plan.changed.map((b) => b.name).sort()).toEqual(['Early Morning', 'Night'])
    for (const name of ['Morning', 'Afternoon', 'Evening']) {
      expect(plan.buckets.find((b) => b.name === name)).toEqual(before.find((b) => b.name === name))
    }
  })

  it('§6.7 moving the day-start later shrinks the first bucket rather than shifting the set', () => {
    const plan = planDayStartReanchor(seededSet(), '04:00', '06:00')

    expect(plan.status).toBe('moved')
    expect(plan.buckets.find((b) => b.name === 'Early Morning')!.startTime).toBe('06:00')
    expect(plan.buckets.find((b) => b.name === 'Early Morning')!.endTime).toBe('09:00')
    expect(plan.buckets.find((b) => b.name === 'Night')!.endTime).toBe('06:00')
    expect(validateBucketTiling(plan.buckets, '06:00')).toBeNull()
  })

  it('§6.7 a day-start that would land inside a non-edge bucket is refused, not applied', () => {
    const plan = planDayStartReanchor(seededSet(), '04:00', '10:00')

    expect(plan.status).toBe('blocked')
    expect(plan.error).toMatch(/falls inside bucket "Morning"/)
    expect(plan.buckets).toEqual(seededSet()) // nothing proposed
  })

  it('§6.7 a day-start that would empty an edge bucket is refused', () => {
    // 09:00 is Early Morning's own end: re-anchoring there would leave it zero-length.
    expect(planDayStartReanchor(seededSet(), '04:00', '09:00').status).toBe('blocked')
  })

  it('§6.7 re-applying the same day-start is a no-op', () => {
    const plan = planDayStartReanchor(seededSet(), '04:00', '04:00')
    expect(plan.status).toBe('already-anchored')
    expect(plan.changed).toEqual([])
  })

  it('§6.7 applying a day-start change repairs a set that had already drifted', () => {
    // The live defect: buckets anchored at 04:00 while the day already starts at 03:00.
    const drifted = seededSet()
    expect(validateBucketTiling(drifted, '03:00')).not.toBeNull()

    const plan = planDayStartReanchor(drifted, '03:00', '03:00')
    expect(plan.status).toBe('moved')
    expect(validateBucketTiling(plan.buckets, '03:00')).toBeNull()
  })

  it('§6.7 with no buckets configured a day-start change has nothing to re-anchor', () => {
    const plan = planDayStartReanchor([], '04:00', '03:00')
    expect(plan.status).toBe('no-buckets')
    expect(plan.error).toBeNull()
  })

  it('§6.7 a set that is not a cycle does not block the day-start change', () => {
    // Refusing here would strand the user: they would need the day-start to fix the
    // buckets and the buckets to fix the day-start.
    const broken = [bucket('A', '04:00', '09:00'), bucket('B', '10:00', '04:00')]
    const plan = planDayStartReanchor(broken, '04:00', '03:00')
    expect(plan.status).toBe('not-a-cycle')
    expect(plan.error).toBeNull()
  })
})
