// §6.6 — Bucket tiling validation.
//
// A valid bucket set must tile the day-start window exactly:
//   - The day is treated as a 1440-minute circular window anchored at dayStartHHMM.
//   - Each bucket has a start offset and an end offset (minutes from dayStart).
//   - An endTime == dayStartHHMM (mod 1440) counts as offset 1440 (full circle).
//   - Sorted by start offset: first must start at 0, each end = next start, last ends at 1440.
//
// This validation is called only on PATCH /buckets/:id/boundaries, not on POST /buckets,
// so the user can build the set incrementally.

import type { Bucket } from '@tracker/shared'

// Convert an HH:MM string to total minutes (0–1439).
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * §6.6 — Validate that a set of buckets tiles the day-start window exactly.
 *
 * Converts each bucket's boundaries to minute-offsets from dayStartHHMM.
 * Checks no gaps and no overlaps, and that the full 1440-minute cycle is covered.
 *
 * @param buckets     The full proposed bucket set (must include the edited bucket).
 * @param dayStartHHMM  The effective day-start (HH:MM).
 * @returns  null if valid; an error string describing the first problem found.
 */
export function validateBucketTiling(buckets: Bucket[], dayStartHHMM: string): string | null {
  if (buckets.length === 0) return null

  const dayStartMin = hhmmToMinutes(dayStartHHMM)

  // Compute start/end offsets (minutes from dayStart) for each bucket.
  // End offset 0 means "wraps back to dayStart" → treat as 1440 (full circle).
  const parsed = buckets.map((b) => {
    const startRaw = (hhmmToMinutes(b.startTime) - dayStartMin + 1440) % 1440
    const endRaw   = (hhmmToMinutes(b.endTime)   - dayStartMin + 1440) % 1440
    return {
      id: b.id,
      name: b.name,
      startOffset: startRaw,
      endOffset:   endRaw === 0 ? 1440 : endRaw,
    }
  })

  // Sort by start offset for sequential gap/overlap checks.
  parsed.sort((a, b) => a.startOffset - b.startOffset)

  // First bucket must start at the day boundary (offset 0).
  if (parsed[0].startOffset !== 0) {
    return `Bucket "${parsed[0].name}" does not start at the day boundary (${dayStartHHMM}); ` +
      `it starts ${parsed[0].startOffset} minutes into the window.`
  }

  // Each bucket's end must equal the next bucket's start (no gaps or overlaps).
  for (let i = 0; i < parsed.length - 1; i++) {
    if (parsed[i].endOffset !== parsed[i + 1].startOffset) {
      return `Gap or overlap between bucket "${parsed[i].name}" ` +
        `(ends at offset ${parsed[i].endOffset}) ` +
        `and "${parsed[i + 1].name}" ` +
        `(starts at offset ${parsed[i + 1].startOffset}).`
    }
  }

  // Last bucket must close the full 1440-minute cycle.
  const last = parsed[parsed.length - 1]
  if (last.endOffset !== 1440) {
    return `Bucket "${last.name}" does not close the day; ` +
      `it ends at offset ${last.endOffset} (expected 1440).`
  }

  return null
}
