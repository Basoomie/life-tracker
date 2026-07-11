// §12.2 — Now view: three tiers (Active / Imminent / Unscheduled-today).
// Owns session state for live timers; all mutations go through the API.

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useNowData } from '../../hooks/useNowData'
import { TierSection } from './TierSection'
import { OccurrenceRow } from './OccurrenceRow'
import { AdHocModal } from './AdHocModal'
import { DispositionModal } from './DispositionModal'
import { ConfirmModal } from '../shared/ConfirmModal'
import { OccurrenceCard } from '../shared/OccurrenceCard'
import { SortableList } from '../shared/SortableList'
import { buildOccurrenceTree, type OccurrenceNode } from '../../lib/occurrence-tree'
import { api } from '../../lib/api'
import { saveSessions, loadSessions } from '../../lib/sessions'
import type { OccurrenceWithState } from '@tracker/shared'
import type { Category, Reason } from '@tracker/shared'
import type { SessionState } from './TimerControl'

type Props = {
  onEditItem: (itemId: string) => void
}

export function NowView({ onEditItem }: Props) {
  const [showAdHoc, setShowAdHoc] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [imminentWindow, setImminentWindow] = useState(() => {
    const saved = localStorage.getItem('tracker:imminentWindow')
    return saved ? Number(saved) : 90
  })
  const [alwaysNext, setAlwaysNext] = useState(() => {
    return localStorage.getItem('tracker:alwaysNext') === 'true'
  })

  useEffect(() => {
    localStorage.setItem('tracker:imminentWindow', String(imminentWindow))
  }, [imminentWindow])

  useEffect(() => {
    localStorage.setItem('tracker:alwaysNext', String(alwaysNext))
  }, [alwaysNext])

  const { tiers, occurrences, buckets, loading, error, refresh, setOccurrences } =
    useNowData(imminentWindow, alwaysNext)

  // Full parent/child tree for rendering (NowView only ever shows today, so
  // no per-day bucketing needed). Children never appear as independent tier
  // rows — they nest inside their parent's OccurrenceCard.
  const treeRoots = useMemo(() => buildOccurrenceTree(occurrences, buckets), [occurrences, buckets])
  const nodeByKey = useMemo(() => {
    const map = new Map<string, OccurrenceNode>()
    function walk(node: OccurrenceNode) {
      map.set(node.occ.id ?? node.occ.itemId, node)
      node.children.forEach(walk)
    }
    treeRoots.forEach(walk)
    return map
  }, [treeRoots])

  // Only root occurrences get their own "Done today" entry; a completed
  // child stays nested in its (possibly still-incomplete) parent's card.
  const doneToday = useMemo(
    () => treeRoots.map((n) => n.occ).filter((o) => o.completionState.isComplete),
    [treeRoots]
  )

  // Auto-expand Done Today when the first item is completed in this session
  const prevDoneLengthRef = useRef(0)
  useEffect(() => {
    if (doneToday.length > 0 && prevDoneLengthRef.current === 0) {
      setShowDone(true)
    }
    prevDoneLengthRef.current = doneToday.length
  }, [doneToday.length])

  // Pending uncomplete confirmation target
  const [pendingUncompletion, setPendingUncompletion] = useState<OccurrenceWithState | null>(null)

  // Archive confirmation target
  const [pendingArchive, setPendingArchive] = useState<OccurrenceWithState | null>(null)

  // Live session state: occurrenceId → SessionState
  const [sessions, setSessions] = useState<Map<string, SessionState>>(() => loadSessions())

  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

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
    const updated = occ.id
      ? await api.occurrences.complete(occ.id)
      : await api.occurrences.completeByItemDay(occ.itemId, occ.appliesToDay)
    setOccurrences((prev) => prev.map((o) => {
      if (o.id !== null && o.id === updated.id) return updated
      if (o.id === null && o.itemId === updated.itemId && o.appliesToDay === updated.appliesToDay) return updated
      return o
    }))
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

  // ── Reorder ────────────────────────────────────────────────────────────────
  // Local patch, not refresh() — see OccurrenceCard's onReordered doc comment
  // for why (refresh() unmounts the tree via the loading flag, collapsing
  // every expanded card). Shared by child reorder (OccurrenceCard) and
  // root-level unscheduled reorder (SortableList) — both hand back the same
  // "ordered item ids" shape.
  const handleReordered = useCallback((orderedItemIds: string[]) => {
    setOccurrences((prev) => prev.map((o) => {
      const idx = orderedItemIds.indexOf(o.itemId)
      return idx === -1 ? o : { ...o, sortOrder: idx }
    }))
  }, [setOccurrences])

  // ── Archive ────────────────────────────────────────────────────────────────

  const handleArchive = useCallback(async (occ: OccurrenceWithState) => {
    await api.items.archive(occ.itemId)
    setPendingArchive(null)
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
        onUncomplete={() => setPendingUncompletion(occ)}
        onTimerStart={() => handleTimerStart(occ)}
        onTimerPause={() => handleTimerPause(occ)}
        onTimerResume={() => handleTimerResume(occ)}
        onTimerStop={() => handleTimerStop(occ)}
        onDisposition={() => setDispositionTarget(occ)}
        onEdit={() => onEditItem(occ.itemId)}
        onArchive={() => setPendingArchive(occ)}
      />
    )
  }

  // Roots with ≥1 materialized child today render as a collapsible card;
  // plain leaves render exactly as before.
  function renderNode(occ: OccurrenceWithState) {
    const node = nodeByKey.get(occ.id ?? occ.itemId)
    if (node && node.children.length > 0) {
      return <OccurrenceCard key={occ.id ?? occ.itemId} node={node} depth={0} renderLeaf={(o) => renderRow(o)} onReordered={handleReordered} />
    }
    return renderRow(occ)
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
          {tiers.active.map((occ) => renderNode(occ))}
        </TierSection>

        {/* §12.2 — Imminent tier */}
        <TierSection
          tier="imminent"
          count={tiers.imminent.length}
          emptyText="Nothing coming up soon"
        >
          {tiers.imminent.map((occ) => renderNode(occ))}
        </TierSection>

        {/* §12.2 — Unscheduled tier */}
        <TierSection
          tier="unscheduled"
          count={tiers.unscheduled.length}
          emptyText="No unscheduled tasks for today"
        >
          <SortableList items={tiers.unscheduled} renderItem={renderNode} onReordered={handleReordered} />
        </TierSection>

        {/* Done today — auto-expands on first completion; click checkbox to undo */}
        {doneToday.length > 0 && (
          <section className="tier-section tier-section--done" data-testid="tier-done">
            <button
              className="tier-header tier-header--btn"
              onClick={() => setShowDone((v) => !v)}
              aria-expanded={showDone}
            >
              <span aria-hidden="true">✓</span>
              <span className="tier-label">Done today</span>
              <span className="tier-count">{doneToday.length}</span>
              <span className="tier-header__chevron" aria-hidden="true">{showDone ? '▲' : '▼'}</span>
            </button>
            {showDone && doneToday.map((occ) => renderNode(occ))}
          </section>
        )}
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

      {/* Uncomplete confirmation modal */}
      {pendingUncompletion && (
        <ConfirmModal
          title="Mark as incomplete?"
          message={`Revert completion of "${pendingUncompletion.snapshot.name}"?`}
          confirmLabel="Yes, undo"
          onConfirm={async () => {
            await handleUncomplete(pendingUncompletion)
            setPendingUncompletion(null)
          }}
          onCancel={() => setPendingUncompletion(null)}
        />
      )}

      {/* Archive confirmation modal */}
      {pendingArchive && (
        <ConfirmModal
          title="Delete task?"
          message={`Delete "${pendingArchive.snapshot.name}"? History is preserved but the task will no longer appear.`}
          confirmLabel="Delete"
          onConfirm={() => handleArchive(pendingArchive)}
          onCancel={() => setPendingArchive(null)}
        />
      )}
    </>
  )
}
