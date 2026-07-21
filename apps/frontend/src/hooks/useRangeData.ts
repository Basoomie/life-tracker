// Fetches occurrences for a date range + stable config (buckets, day-start).

import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react'
import { api } from '../lib/api'
import { getEffectiveDayStart } from '@tracker/shared'
import type { OccurrenceWithState, Bucket, DayStartEntry } from '@tracker/shared'

export type RangeDataResult = {
  occurrences: OccurrenceWithState[]
  buckets: Bucket[]
  loading: boolean
  error: string | null
  refresh: () => void
  setOccurrences: Dispatch<SetStateAction<OccurrenceWithState[]>>
}

// Returns the effective day-start value for a given day (most recent entry <= day).
// Delegates to the shared package's canonical lookup (also used by the backend's
// bucketing) so frontend and backend can never drift on this again — the '00:00'
// (midnight) fallback matches the spec's documented default when unconfigured (§6.7).
export function effectiveDayStart(entries: DayStartEntry[], day: string): string {
  return getEffectiveDayStart(entries, day) ?? '00:00'
}

// Fetched independently of any range — List/Calendar need this *before* they can
// even compute which range to request (§6.7: "today" is day-start-bucketed via
// bucketTimestamp(now, dayStartEntries), so the range depends on this loading first).
export function useDayStartEntries(): DayStartEntry[] {
  const [dayStartEntries, setDayStartEntries] = useState<DayStartEntry[]>([])

  useEffect(() => {
    api.dayStart.list().then(setDayStartEntries).catch(() => {})
  }, [])

  return dayStartEntries
}

// `enabled` lets a caller that conditionally switches between this hook and
// another data source (e.g. ListView's Overdue mode, see useOverdueData below)
// skip the network call when this hook isn't the active one — React's rules
// of hooks forbid calling a hook conditionally, but the fetch inside it can
// still be gated.
export function useRangeData(start: string, end: string, enabled = true): RangeDataResult {
  const [occurrences, setOccurrences] = useState<OccurrenceWithState[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // showLoading is true only for a genuine range change (new page of data,
  // where resetting scroll/expand state is expected). Post-action refresh()
  // calls pass false so the tree stays mounted — flipping `loading` would
  // unmount it via the views' loading-gate render and collapse every
  // expanded OccurrenceCard (its expand state is local useState).
  const fetchOccurrences = useCallback(async (showLoading: boolean) => {
    if (!enabled) return
    try {
      if (showLoading) setLoading(true)
      const data = await api.occurrences.range(start, end)
      setOccurrences(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [start, end, enabled])

  // Stable config — fetched once
  useEffect(() => {
    api.buckets.list().then(setBuckets).catch(() => {})
  }, [])

  // Refetch when range changes
  useEffect(() => { fetchOccurrences(true) }, [fetchOccurrences])

  const refresh = useCallback(() => { fetchOccurrences(false) }, [fetchOccurrences])

  return { occurrences, buckets, loading, error, refresh, setOccurrences }
}

// §8 amendment — the "Overdue" backlog: fetches via a dedicated endpoint
// (materialized-but-pending rows only) instead of a date range, since a plain
// range fetch of "everything before today" would make getOccurrencesInRange
// expand every recurring item's rule across the app's full history just to
// surface a handful of untouched one-time tasks. Mirrors useRangeData's
// shape (including the `enabled` gate) so ListView can wire it into the same
// useOccurrenceActions() calls without double-fetching in both modes.
export function useOverdueData(before: string, enabled = true): RangeDataResult {
  const [occurrences, setOccurrences] = useState<OccurrenceWithState[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchOccurrences = useCallback(async (showLoading: boolean) => {
    if (!enabled) return
    try {
      if (showLoading) setLoading(true)
      const data = await api.occurrences.overdue(before)
      setOccurrences(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [before, enabled])

  useEffect(() => {
    api.buckets.list().then(setBuckets).catch(() => {})
  }, [])

  useEffect(() => { fetchOccurrences(true) }, [fetchOccurrences])

  const refresh = useCallback(() => { fetchOccurrences(false) }, [fetchOccurrences])

  return { occurrences, buckets, loading, error, refresh, setOccurrences }
}
