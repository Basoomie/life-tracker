// §12.3 — List view: flat sorted list per time-range; priority-flip grouping.

import { useState, useEffect, useMemo, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useRangeData, useOverdueData, useDayStartEntries } from '../../hooks/useRangeData'
import { useOccurrenceActions } from '../../hooks/useOccurrenceActions'
import { useStreakSummaries } from '../../hooks/useStreakSummaries'
import { OccurrenceRow } from '../now/OccurrenceRow'
import { DispositionModal } from '../now/DispositionModal'
import { SessionManagerModal } from '../now/SessionManagerModal'
import { ConfirmModal } from '../shared/ConfirmModal'
import { OccurrenceCard } from '../shared/OccurrenceCard'
import { SortableList } from '../shared/SortableList'
import { FilterBar } from '../FilterBar'
import { InactiveItemsPanel } from './InactiveItemsPanel'
import { sortByTiming, groupByPriority, splitTimed } from '../../lib/list-sort'
import { applyFilters, makeDefaultFilters, serializeFilters, deserializeFilters } from '../../lib/filters'
import { getRangeDates, getDaysInRange, formatDayLabel, todayStr } from '../../lib/date-range'
import { buildOccurrenceTree, detachedParentName, type OccurrenceNode } from '../../lib/occurrence-tree'
import { occurrenceKey } from '../../lib/occurrence-key'
import { api } from '../../lib/api'
import { bucketTimestamp } from '@tracker/shared'
import type { RangeKey } from '../../lib/date-range'
import type { OccurrenceWithState, Category, Reason } from '@tracker/shared'

type Props = {
  onEditItem: (itemId: string) => void
  // §5.6 — bumped by the app when an item is saved, so the inactive panel picks up a
  // rename made in the edit modal instead of showing the old name.
  itemsVersion?: number
}

export function ListView({ onEditItem, itemsVersion }: Props) {
  const [range, setRange] = useState<RangeKey>(() => {
    return (localStorage.getItem('tracker:list-range') as RangeKey | null) ?? 'today'
  })
  const [customDate, setCustomDate] = useState<string>(() => {
    return localStorage.getItem('tracker:list-customDate') ?? todayStr()
  })
  const [priorityFlip, setPriorityFlip] = useState(() => {
    return localStorage.getItem('tracker:list-priorityFlip') === 'true'
  })
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState(() => {
    const saved = localStorage.getItem('tracker:list-filters')
    return saved ? deserializeFilters(saved) : makeDefaultFilters()
  })
  const [categories, setCategories] = useState<Category[]>([])
  const [reasons, setReasons] = useState<Reason[]>([])
  const [pendingUncompletion, setPendingUncompletion] = useState<OccurrenceWithState | null>(null)
  const [pendingArchive, setPendingArchive] = useState<OccurrenceWithState | null>(null)
  // §5.6 — the inactive list is a separate mode, not a filter: it renders ITEMS (an
  // inactive item has no occurrences), so it replaces the content area rather than
  // narrowing it. Not persisted to localStorage like range/filters — it is somewhere
  // you go deliberately, and reopening the app on it would hide today's work.
  const [showInactive, setShowInactive] = useState(false)
  const [inactiveCount, setInactiveCount] = useState<number | null>(null)
  const [pendingDeactivate, setPendingDeactivate] = useState<OccurrenceWithState | null>(null)

  useEffect(() => { localStorage.setItem('tracker:list-range', range) }, [range])
  useEffect(() => { localStorage.setItem('tracker:list-customDate', customDate) }, [customDate])
  useEffect(() => { localStorage.setItem('tracker:list-priorityFlip', String(priorityFlip)) }, [priorityFlip])
  useEffect(() => { localStorage.setItem('tracker:list-filters', serializeFilters(filters)) }, [filters])

  // §6.7 — "today" honors the user's configured day-start boundary, not raw local
  // midnight. Falls back to todayStr()'s plain local day until dayStartEntries
  // loads (bucketTimestamp(now, []) already equals that), self-correcting the
  // render once the fetch resolves.
  const dayStartEntries = useDayStartEntries()
  const today = bucketTimestamp(new Date(), dayStartEntries)
  const { start, end } = useMemo(() => getRangeDates(range, today, customDate), [range, today, customDate])

  // §8 amendment — "Overdue" queries a dedicated endpoint (materialized-but-
  // pending rows only) instead of a plain date range; see useOverdueData's
  // doc comment for why. Both hooks are always called (rules of hooks forbid
  // conditional calls) but only the active mode's `enabled` flag lets its
  // fetch actually run.
  const isOverdue = range === 'overdue'
  const rangeData = useRangeData(start, end, !isOverdue)
  const overdueData = useOverdueData(today, isOverdue)

  const {
    occurrences,
    buckets,
    loading,
    error,
    refresh,
    setOccurrences,
  } = isOverdue ? overdueData : rangeData

  useEffect(() => {
    api.categories.list().then(setCategories).catch(() => {})
    api.reasons.list().then(setReasons).catch(() => {})
  }, [])

  // §5.6 — the count on the toolbar button, fetched without opening the panel: "do I
  // have anything parked?" is the question the button exists to answer, and a bare
  // "Inactive" answers it only by making you go and look. Refetched on itemsVersion so
  // it survives an edit, and the panel keeps it in step from there via onCountChange.
  useEffect(() => {
    api.items.list('inactive')
      .then((inactive) => setInactiveCount(inactive.length))
      .catch(() => {})
  }, [itemsVersion])

  // v2 §3.2.5 — ambient streak badges. Refetched when completion or disposition
  // state changes, which is exactly what can move a chain (see NowView).
  const { streaks, refresh: refreshStreaks } = useStreakSummaries()
  const completionSignature = useMemo(
    () => occurrences.map((o) => `${o.itemId}:${o.completionState.isComplete}:${o.disposition.type}`).join('|'),
    [occurrences]
  )
  useEffect(() => {
    if (!completionSignature) return
    refreshStreaks()
  }, [completionSignature, refreshStreaks])

  const {
    sessions,
    dispositionTarget,
    setDispositionTarget,
    sessionManagerTarget,
    setSessionManagerTarget,
    handleComplete,
    handleUncomplete,
    handleTimerStart,
    handleTimerPause,
    handleTimerResume,
    handleTimerStop,
    handleSkip,
    handleExcuse,
    handleCarryForward,
    handleClearDisposition,
    handleArchive,
    handleDeactivate,
  } = useOccurrenceActions(setOccurrences, refresh)

  // Local patch, not refresh() — see OccurrenceCard's onReordered doc comment
  // for why (refresh() unmounts the tree via the loading flag, collapsing
  // every expanded card). Shared by child reorder (OccurrenceCard) and
  // root-level unscheduled reorder (SortableList).
  const handleReordered = useCallback((orderedItemIds: string[]) => {
    setOccurrences((prev) => prev.map((o) => {
      const idx = orderedItemIds.indexOf(o.itemId)
      return idx === -1 ? o : { ...o, sortOrder: idx }
    }))
  }, [setOccurrences])

  // Days in selected range (single element for today/tomorrow, multiple for week/month).
  // Overdue isn't a contiguous range — it's whatever distinct days the backlog
  // query actually returned — so its days come from the results themselves,
  // not from enumerating every date between a floor and yesterday.
  const days = useMemo(() => {
    if (isOverdue) {
      return Array.from(new Set(occurrences.map((o) => o.appliesToDay))).sort()
    }
    return getDaysInRange(start, end)
  }, [isOverdue, occurrences, start, end])
  const isMultiDay = days.length > 1

  // Per-day occurrence lookup
  const occsByDay = useMemo(() => {
    const map = new Map<string, OccurrenceWithState[]>()
    for (const day of days) map.set(day, [])
    for (const occ of occurrences) {
      const bucket = map.get(occ.appliesToDay)
      if (bucket) bucket.push(occ)
    }
    return map
  }, [occurrences, days])

  // Parent/child matching is same-day, so the tree is built per day. Filters
  // and sorting apply to roots only — once a parent passes the filter, its
  // full unfiltered children render inside its card (the progress bar stays
  // accurate to what's actually shown, rather than to a filtered subset).
  const treesByDay = useMemo(() => {
    const map = new Map<string, OccurrenceNode[]>()
    for (const day of days) map.set(day, buildOccurrenceTree(occsByDay.get(day) ?? [], buckets))
    return map
  }, [days, occsByDay, buckets])

  const nodeByKey = useMemo(() => {
    const map = new Map<string, OccurrenceNode>()
    function walk(node: OccurrenceNode) {
      map.set(node.occ.id ?? node.occ.itemId, node)
      node.children.forEach(walk)
    }
    for (const roots of treesByDay.values()) roots.forEach(walk)
    return map
  }, [treesByDay])

  function renderRow(occ: OccurrenceWithState, isChild = false, progress?: ReactNode) {
    const occId = occ.id ?? occ.itemId
    // §4.1 — scoped to the occurrence's OWN day (containment is same-day), and to
    // the unfiltered set: a parent hidden by a filter hasn't stopped being this
    // row's parent, and labelling it "detached" would be a lie about the data.
    const parentLabel = detachedParentName(occ, occsByDay.get(occ.appliesToDay) ?? [])
    return (
      <OccurrenceRow
        key={occId}
        occ={occ}
        buckets={buckets}
        isChild={isChild || parentLabel !== null}
        parentLabel={parentLabel}
        isToday={occ.appliesToDay === today}
        streak={streaks.get(occ.itemId)}
        session={sessions.get(occId)}
        onComplete={() => handleComplete(occ)}
        onUncomplete={() => setPendingUncompletion(occ)}
        onTimerStart={() => handleTimerStart(occ)}
        onTimerPause={() => handleTimerPause(occ)}
        onTimerResume={() => handleTimerResume(occ)}
        onTimerStop={() => handleTimerStop(occ)}
        onDisposition={() => setDispositionTarget(occ)}
        onClearDisposition={() => handleClearDisposition(occ)}
        onEdit={() => onEditItem(occ.itemId)}
        onDeactivate={() => setPendingDeactivate(occ)}
        onArchive={() => setPendingArchive(occ)}
        onManageSessions={() => setSessionManagerTarget(occ)}
        progress={progress}
      />
    )
  }

  // Items with children render as a collapsible card — using the backend's
  // authoritative occ.hasChildren (not just whether today's fetch happened to
  // include a materialized/due child) keeps the card/leaf choice consistent
  // across days for the same item, even when 0 children are due today.
  function renderNode(occ: OccurrenceWithState) {
    const node = nodeByKey.get(occ.id ?? occ.itemId)
    if (node && (node.children.length > 0 || occ.hasChildren)) {
      return <OccurrenceCard key={occurrenceKey(occ)} node={node} depth={0} renderLeaf={(o, progress) => renderRow(o, false, progress)} onReordered={handleReordered} />
    }
    return renderRow(occ)
  }

  // Timed occurrences render in clock order (not draggable); the untimed
  // tail is manually reorderable via drag-and-drop.
  function renderTimingGroup(occs: OccurrenceWithState[]) {
    const { timed, untimed } = splitTimed(occs)
    return (
      <>
        {timed.map((occ) => renderNode(occ))}
        {untimed.length > 0 && (
          <SortableList items={untimed} renderItem={renderNode} onReordered={handleReordered} />
        )}
      </>
    )
  }

  function renderPriorityGroups(occs: OccurrenceWithState[]) {
    const groups = groupByPriority(occs)
    const sections: Array<{ label: string; key: string; items: OccurrenceWithState[] }> = [
      { key: 'high',   label: '⬆ High',   items: groups.high },
      { key: 'medium', label: '↔ Medium', items: groups.medium },
      { key: 'low',    label: '⬇ Low',    items: groups.low },
      { key: 'unset',  label: '— No priority', items: groups.unset },
    ]
    return sections.filter((s) => s.items.length > 0).map((s) => (
      <div key={s.key} className="priority-group" data-testid={`priority-group-${s.key}`}>
        <div className="priority-group__label">{s.label}</div>
        <div className="list-section__rows">
          {renderTimingGroup(s.items)}
        </div>
      </div>
    ))
  }

  function renderContent() {
    if (isOverdue && days.length === 0) {
      return <div className="list-empty" data-testid="overdue-empty">Nothing overdue — you're all caught up.</div>
    }

    if (priorityFlip) {
      // All roots across all days grouped by priority (children stay nested
      // in their card regardless of their own priority)
      const allRoots = days.flatMap((day) => (treesByDay.get(day) ?? []).map((n) => n.occ))
      const filtered = applyFilters(allRoots, filters)
      const sorted = sortByTiming(filtered, buckets)
      return <div data-testid="list-priority-view">{renderPriorityGroups(sorted)}</div>
    }

    // Default: group by day (single-day: no header shown)
    return (
      <div data-testid="list-timing-view">
        {days.map((day) => {
          const dayRoots = (treesByDay.get(day) ?? []).map((n) => n.occ)
          const filtered = applyFilters(dayRoots, filters)
          const sorted = sortByTiming(filtered, buckets)
          if (sorted.length === 0 && isMultiDay) return null
          return (
            <div key={day} className="list-day-group">
              {isMultiDay && (
                <div className="list-day-group__header" data-testid={`day-header-${day}`}>
                  {formatDayLabel(day)}
                </div>
              )}
              <div className="list-section">
                {sorted.length === 0 ? (
                  <div className="list-empty">Nothing for this day</div>
                ) : (
                  renderTimingGroup(sorted)
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="list-view" data-testid="list-view">
      {/* Toolbar */}
      <div className="range-toolbar">
        <select
          className="field__select range-toolbar__select"
          value={range}
          onChange={(e) => { setRange(e.target.value as RangeKey); setPriorityFlip(false) }}
          aria-label="Date range"
          data-testid="range-select"
        >
          <option value="today">Today</option>
          <option value="tomorrow">Tomorrow</option>
          <option value="this-week">This Week</option>
          <option value="this-month">This Month</option>
          <option value="overdue">Overdue</option>
          <option value="custom">Custom date</option>
        </select>

        <input
          type="date"
          className="field__input range-toolbar__date"
          value={customDate}
          onChange={(e) => { setCustomDate(e.target.value); setRange('custom'); setPriorityFlip(false) }}
          aria-label="Custom date"
          data-testid="range-custom-date"
        />

        <label className="now-view__toggle-label" data-testid="priority-flip-toggle">
          <span className="toggle">
            <input
              type="checkbox"
              className="toggle__input"
              checked={priorityFlip}
              onChange={(e) => setPriorityFlip(e.target.checked)}
            />
            <span className="toggle__track" />
          </span>
          Priority view
        </label>

        <button
          className={`btn btn--ghost${showFilters ? ' btn--active' : ''}`}
          onClick={() => setShowFilters((v) => !v)}
          data-testid="toggle-filters"
          aria-expanded={showFilters}
        >
          Filters
        </button>

        {/* §5.6 — always rendered, even at zero: it is the only place inactive tasks
            live, so it has to be findable before you have any. */}
        <button
          className={`btn btn--ghost${showInactive ? ' btn--active' : ''}`}
          onClick={() => setShowInactive((v) => !v)}
          data-testid="toggle-inactive"
          aria-pressed={showInactive}
        >
          Inactive{inactiveCount ? ` (${inactiveCount})` : ''}
        </button>
      </div>

      {/* Filter bar — hidden in the inactive list, whose rows are items rather than
          occurrences and so carry none of the state the filters act on. */}
      {showFilters && !showInactive && (
        <FilterBar
          filters={filters}
          categories={categories}
          onChange={setFilters}
        />
      )}

      {/* Content */}
      {showInactive ? (
        <InactiveItemsPanel
          onEditItem={onEditItem}
          itemsVersion={itemsVersion}
          onCountChange={setInactiveCount}
        />
      ) : loading ? (
        <div className="now-view__loading">
          <span className="spinner" aria-hidden="true" />&ensp;Loading…
        </div>
      ) : error ? (
        <div className="now-view__error" role="alert">
          {error}
          <br />
          <button className="btn btn--ghost" style={{ marginTop: 'var(--space-3)' }} onClick={refresh}>
            Retry
          </button>
        </div>
      ) : (
        renderContent()
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

      {/* Session manager modal */}
      {sessionManagerTarget && (
        <SessionManagerModal
          occ={sessionManagerTarget}
          onClose={() => setSessionManagerTarget(null)}
          onChanged={refresh}
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

      {/* §5.6 — pause confirmation. Names the cascade BEFORE it happens: a parent's
          sub-tasks go with it, and consenting to that is the user's call, not an
          outcome they should find out about afterwards. */}
      {pendingDeactivate && (
        <ConfirmModal
          title="Make inactive?"
          message={
            pendingDeactivate.hasChildren
              ? `Stop scheduling "${pendingDeactivate.snapshot.name}" and its sub-tasks? Everything is kept — times, category and history — and you can switch it back on from the Inactive list. The paused days won't count against it.`
              : `Stop scheduling "${pendingDeactivate.snapshot.name}"? Everything is kept — times, category and history — and you can switch it back on from the Inactive list. The paused days won't count against it.`
          }
          confirmLabel="Make inactive"
          variant="neutral"
          onConfirm={async () => {
            const names = await handleDeactivate(pendingDeactivate)
            setPendingDeactivate(null)
            // The count reflects everything the cascade took, so the toolbar shows
            // straight away that the sub-tasks went with it.
            setInactiveCount((n) => (n ?? 0) + names.length)
          }}
          onCancel={() => setPendingDeactivate(null)}
        />
      )}

      {/* Archive confirmation modal */}
      {pendingArchive && (
        <ConfirmModal
          title="Delete task?"
          message={`Delete "${pendingArchive.snapshot.name}"? History is preserved but the task will no longer appear.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await handleArchive(pendingArchive)
            setPendingArchive(null)
          }}
          onCancel={() => setPendingArchive(null)}
        />
      )}
    </div>
  )
}
