// §12.2 — Now view: three tiers (Active / Imminent / Unscheduled-today).
// Owns session state for live timers; all mutations go through the API.

import { useState, useCallback, useEffect } from 'react'
import { useNowData } from '../../hooks/useNowData'
import { TierSection } from './TierSection'
import { OccurrenceRow } from './OccurrenceRow'
import { AdHocModal } from './AdHocModal'
import { DispositionModal } from './DispositionModal'
import { api } from '../../lib/api'
import type { OccurrenceWithState } from '@tracker/shared'
import type { Category, Reason } from '@tracker/shared'
import type { SessionState } from './TimerControl'

type Props = {
  onEditItem: (itemId: string) => void
}

export function NowView({ onEditItem }: Props) {
  const [showAdHoc, setShowAdHoc] = useState(false)
  const [imminentWindow, setImminentWindow] = useState(90)
  const [alwaysNext, setAlwaysNext] = useState(false)

  const { tiers, buckets, loading, error, refresh, setOccurrences } =
    useNowData(imminentWindow, alwaysNext)

  // Live session state: occurrenceId → SessionState
  const [sessions, setSessions] = useState<Map<string, SessionState>>(new Map())

  // Disposition modal
  const [dispositionTarget, setDispositionTarget] = useState<OccurrenceWithState | null>(null)

  // Categories + reasons (for modals)
  const [categories, setCategories] = useState<Category[]>([])
  const [reasons, setReasons] = useState<Reason[]>([])

  useEffect(() => {
    api.categories.list().then(setCategories).catch(() => {})
    api.reasons.list().then(setReasons).catch(() => {})
  }, [])

  // ── Complete / uncomplete ──────────────────────────────────────────────────
  // Always refresh after completion so parent derived % stays in sync (§6.1).

  const handleComplete = useCallback(async (occ: OccurrenceWithState) => {
    if (!occ.id) return
    const updated = await api.occurrences.complete(occ.id)
    setOccurrences((prev) =>
      prev.map((o) => (o.id !== null && o.id === updated.id ? updated : o))
    )
    // If child, re-fetch so parent's derivedPercent reflects the new completion
    if (occ.snapshot.parentId) refresh()
  }, [setOccurrences, refresh])

  const handleUncomplete = useCallback(async (occ: OccurrenceWithState) => {
    if (!occ.id) return
    const updated = await api.occurrences.uncomplete(occ.id)
    setOccurrences((prev) =>
      prev.map((o) => (o.id !== null && o.id === updated.id ? updated : o))
    )
    if (occ.snapshot.parentId) refresh()
  }, [setOccurrences, refresh])

  // ── Timer ──────────────────────────────────────────────────────────────────

  const handleTimerStart = useCallback(async (occ: OccurrenceWithState) => {
    const { sessionId, occurrenceId } = await api.sessions.start({ itemId: occ.itemId })
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(occurrenceId, {
        sessionId,
        occurrenceId,
        status: 'running',
        startedAt: new Date(),
        pausedAt: null,
        accumulatedMs: 0,
      })
      return next
    })
  }, [])

  const handleTimerPause = useCallback(async (occ: OccurrenceWithState) => {
    const occId = occ.id ?? occ.itemId
    const session = sessions.get(occId)
    if (!session) return
    await api.sessions.pause(session.sessionId)
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(occId, { ...session, status: 'paused', pausedAt: new Date() })
      return next
    })
  }, [sessions])

  const handleTimerResume = useCallback(async (occ: OccurrenceWithState) => {
    const occId = occ.id ?? occ.itemId
    const session = sessions.get(occId)
    if (!session || !session.pausedAt) return
    await api.sessions.resume(session.sessionId)
    const pausedMs = session.accumulatedMs + (new Date().getTime() - session.pausedAt.getTime())
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(occId, { ...session, status: 'running', pausedAt: null, accumulatedMs: pausedMs })
      return next
    })
  }, [sessions])

  const handleTimerStop = useCallback(async (occ: OccurrenceWithState) => {
    const occId = occ.id ?? occ.itemId
    const session = sessions.get(occId)
    if (!session) return
    await api.sessions.stop(session.sessionId)
    setSessions((prev) => {
      const next = new Map(prev)
      next.delete(occId)
      return next
    })
    refresh()
  }, [sessions, refresh])

  // ── Dispositions ───────────────────────────────────────────────────────────

  const handleSkip = useCallback(async (occ: OccurrenceWithState, reasonId: string | null, comment: string | null) => {
    if (!occ.id) return
    const updated = await api.occurrences.skip(occ.id, { reasonId, comment })
    setOccurrences((prev) =>
      prev.map((o) => (o.id !== null && o.id === updated.id ? updated : o))
    )
  }, [setOccurrences])

  const handleExcuse = useCallback(async (occ: OccurrenceWithState, reasonId: string | null, comment: string | null) => {
    if (!occ.id) return
    const updated = await api.occurrences.excuse(occ.id, { reasonId, comment })
    setOccurrences((prev) =>
      prev.map((o) => (o.id !== null && o.id === updated.id ? updated : o))
    )
  }, [setOccurrences])

  const handleCarryForward = useCallback(async (occ: OccurrenceWithState, targetDay: string, reasonId: string | null, comment: string | null) => {
    if (!occ.id) return
    await api.occurrences.carryForward(occ.id, { targetDay, reasonId, comment })
    refresh()
  }, [refresh])

  // ── Ad-hoc capture ─────────────────────────────────────────────────────────

  const handleAdHocCapture = useCallback(async (
    name: string,
    categoryId: string | null,
    valence: OccurrenceWithState['snapshot']['valence']
  ) => {
    const { occurrence, sessionId } = await api.adHoc.capture({
      name,
      categoryId: categoryId ?? undefined,
      valence: valence ?? undefined,
    })
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(occurrence.id!, {
        sessionId,
        occurrenceId: occurrence.id!,
        status: 'running',
        startedAt: new Date(),
        pausedAt: null,
        accumulatedMs: 0,
      })
      return next
    })
    refresh()
  }, [refresh])

  // ── Date display ───────────────────────────────────────────────────────────

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  // ── Render helpers ─────────────────────────────────────────────────────────

  function renderRow(occ: OccurrenceWithState, isChild = false) {
    const occId = occ.id ?? occ.itemId
    return (
      <OccurrenceRow
        key={occId}
        occ={occ}
        buckets={buckets}
        isChild={isChild}
        session={sessions.get(occId)}
        onComplete={() => handleComplete(occ)}
        onUncomplete={() => handleUncomplete(occ)}
        onTimerStart={() => handleTimerStart(occ)}
        onTimerPause={() => handleTimerPause(occ)}
        onTimerResume={() => handleTimerResume(occ)}
        onTimerStop={() => handleTimerStop(occ)}
        onDisposition={() => setDispositionTarget(occ)}
        onEdit={() => onEditItem(occ.itemId)}
      />
    )
  }

  // ── Loading / error states ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="now-view__loading">
        <span className="spinner" aria-hidden="true" />&ensp;Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="now-view__error" role="alert">
        {error}
        <br />
        <button className="btn btn--ghost" style={{ marginTop: 'var(--space-3)' }} onClick={refresh}>
          Retry
        </button>
      </div>
    )
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <>
      <div className="now-view">
        <div className="now-view__toolbar">
          <span className="now-view__date">{today}</span>
          <button
            className="btn btn--ghost now-view__adhoc-btn"
            onClick={() => setShowAdHoc(true)}
            data-testid="adhoc-btn"
            aria-label="Start ad-hoc activity"
          >
            ▶ Ad-hoc
          </button>
          <div className="now-view__controls">
            <label className="now-view__toggle-label">
              <span className="toggle">
                <input
                  type="checkbox"
                  className="toggle__input"
                  checked={alwaysNext}
                  onChange={(e) => setAlwaysNext(e.target.checked)}
                  data-testid="always-next-toggle"
                />
                <span className="toggle__track" />
              </span>
              Always show next
            </label>
            <select
              className="field__select"
              style={{ fontSize: 'var(--text-xs)', padding: 'var(--space-1) var(--space-2)', width: 'auto' }}
              value={imminentWindow}
              onChange={(e) => setImminentWindow(Number(e.target.value))}
              aria-label="Imminent window"
              data-testid="imminent-window"
            >
              <option value={30}>30 min</option>
              <option value={60}>60 min</option>
              <option value={90}>90 min</option>
              <option value={120}>2 hr</option>
            </select>
          </div>
        </div>

        {/* §12.2 — Active tier */}
        <TierSection
          tier="active"
          count={tiers.active.length}
          emptyText="Nothing active right now"
        >
          {tiers.active.map((occ) => renderRow(occ))}
        </TierSection>

        {/* §12.2 — Imminent tier */}
        <TierSection
          tier="imminent"
          count={tiers.imminent.length}
          emptyText="Nothing coming up soon"
        >
          {tiers.imminent.map((occ) => renderRow(occ))}
        </TierSection>

        {/* §12.2 — Unscheduled tier */}
        <TierSection
          tier="unscheduled"
          count={tiers.unscheduled.length}
          emptyText="No unscheduled tasks for today"
        >
          {tiers.unscheduled.map((occ) => renderRow(occ))}
        </TierSection>
      </div>

      {/* Ad-hoc capture modal */}
      {showAdHoc && (
        <AdHocModal
          categories={categories}
          onCapture={handleAdHocCapture}
          onClose={() => setShowAdHoc(false)}
        />
      )}

      {/* Disposition modal */}
      {dispositionTarget && (
        <DispositionModal
          occurrenceName={dispositionTarget.snapshot.name}
          reasons={reasons}
          onSkip={(rid, cmt) => handleSkip(dispositionTarget, rid, cmt)}
          onExcuse={(rid, cmt) => handleExcuse(dispositionTarget, rid, cmt)}
          onCarryForward={(day, rid, cmt) => handleCarryForward(dispositionTarget, day, rid, cmt)}
          onClose={() => setDispositionTarget(null)}
        />
      )}
    </>
  )
}
