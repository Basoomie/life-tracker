// Fetches today's occurrences + buckets and polls every 30s for live state.
//
// "Today" is the caller's responsibility (§6.7 — day-start-bucketed, computed
// client-side via bucketTimestamp, same as List/Calendar) rather than this hook
// asking the server independently — that asymmetry used to let Now disagree with
// List/Calendar about which day "today" was.

import { useState, useEffect, useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import { api } from '../lib/api'
import { tierOccurrences, type TieredOccurrences } from '../lib/now-ordering'
import { buildOccurrenceTree } from '../lib/occurrence-tree'
import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'

const POLL_MS = 30_000
const CLOCK_TICK_MS = 60_000  // re-tier every minute as time advances

export type NowDataResult = {
  tiers: TieredOccurrences
  occurrences: OccurrenceWithState[]
  buckets: Bucket[]
  loading: boolean
  error: string | null
  refresh: () => void
  setOccurrences: Dispatch<SetStateAction<OccurrenceWithState[]>>
}

export function useNowData(
  today: string,   // YYYY-MM-DD — day-start-bucketed, computed by the caller
  imminentWindowMin = 90,
  alwaysShowNext = false
): NowDataResult {
  const [occurrences, setOccurrences] = useState<OccurrenceWithState[]>([])
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())

  const fetchOccurrences = useCallback(async () => {
    try {
      const data = await api.occurrences.range(today, today)
      setOccurrences(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [today])

  // Buckets are stable config — fetch once
  useEffect(() => {
    api.buckets.list()
      .then(setBuckets)
      .catch(() => {/* non-fatal; tiers degrade gracefully without buckets */})
  }, [])

  // Initial occurrence fetch + polling
  useEffect(() => {
    fetchOccurrences()
    const id = setInterval(fetchOccurrences, POLL_MS)
    return () => clearInterval(id)
  }, [fetchOccurrences])

  // Advance the clock tick so tiers recalculate as time moves
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])

  // Children never get their own tier slot — they render nested inside their
  // parent's card. Only roots (occurrences with no same-day parent) are tiered.
  const roots = useMemo(
    () => buildOccurrenceTree(occurrences, buckets).map((n) => n.occ),
    [occurrences, buckets]
  )

  const tiers = useMemo(
    () => tierOccurrences(roots, buckets, now, imminentWindowMin, alwaysShowNext),
    [roots, buckets, now, imminentWindowMin, alwaysShowNext]
  )

  // Deliberately does NOT flip `loading` — that would unmount the tree (see
  // views' loading-gate render) and collapse every expanded OccurrenceCard,
  // since each card's expand state is local useState lost on unmount. This
  // is called after actions (complete, timer stop, etc.) that need fresh
  // server data but shouldn't visually reset the view.
  const refresh = useCallback(() => {
    setNow(new Date())
    fetchOccurrences()
  }, [fetchOccurrences])

  return { tiers, occurrences, buckets, loading, error, refresh, setOccurrences }
}
