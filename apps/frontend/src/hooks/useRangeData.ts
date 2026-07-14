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

export function useRangeData(start: string, end: string): RangeDataResult {
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
  }, [start, end])

  // Stable config — fetched once
  useEffect(() => {
    api.buckets.list().then(setBuckets).catch(() => {})
  }, [])

  // Refetch when range changes
  useEffect(() => { fetchOccurrences(true) }, [fetchOccurrences])

  const refresh = useCallback(() => { fetchOccurrences(false) }, [fetchOccurrences])

  return { occurrences, buckets, loading, error, refresh, setOccurrences }
}
