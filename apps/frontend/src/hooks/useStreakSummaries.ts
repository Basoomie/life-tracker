// v2 §3.2.5 — the ambient streak badges shown on Now, List and the Calendar
// detail panel.
//
// One request for every recurring item, keyed by itemId for row lookup. Fetching
// per row would put an N-request waterfall on the app's most-used surface.
//
// Failure is deliberately silent: the badge is a supporting detail, and a stats
// outage must never stop the user from ticking things off. Rows just render
// without it.

import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'
import type { ItemStreakSummary } from '@tracker/shared'

export type StreakSummaryMap = Map<string, ItemStreakSummary>

export function useStreakSummaries(): { streaks: StreakSummaryMap; refresh: () => void } {
  const [streaks, setStreaks] = useState<StreakSummaryMap>(() => new Map())

  const refresh = useCallback(() => {
    api.stats
      .streakSummaries()
      .then((finding) => {
        setStreaks(new Map(finding.items.map((i) => [i.itemId, i])))
      })
      .catch(() => {/* non-fatal — rows render without a badge */})
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { streaks, refresh }
}
