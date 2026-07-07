// Fetches occurrences for a date range + stable config (buckets, day-start).

import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react'
import { api } from '../lib/api'
import type { OccurrenceWithState, Bucket, DayStartEntry } from '@tracker/shared'

export type RangeDataResult = {
  occurrences: OccurrenceWithState[]
  buckets: Bucket[]
  dayStartEntries: DayStartEntry[]
  loading: boolean
  error: string | null
  refresh: () => void
  setOccurrences: Dispatch<SetStateAction<OccurrenceWithState[]>>
}

// Returns the effective day-start value for a given day (most recent entry <= day).
export function effectiveDayStart(entries: DayStartEntry[], day: string): string {
  const sorted = [...entries].sort((a, b) => b.startsOn.localeCompare(a.startsOn))
  const entry = sorted.find((e) => e.startsOn <= day)
  return entry?.value ?? '04:00'
}

export function useRangeData(start: string, end: string): RangeDataResult {
  const [occurrences, setOccurrences] = useState<OccurrenceWithState[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [dayStartEntries, setDayStartEntries] = useState<DayStartEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchOccurrences = useCallback(async () => {
    try {
      setLoading(true)
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
    api.dayStart.list().then(setDayStartEntries).catch(() => {})
  }, [])

  // Refetch when range changes
  useEffect(() => { fetchOccurrences() }, [fetchOccurrences])

  const refresh = useCallback(() => { fetchOccurrences() }, [fetchOccurrences])

  return { occurrences, buckets, dayStartEntries, loading, error, refresh, setOccurrences }
}
