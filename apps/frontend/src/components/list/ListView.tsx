// §12.3 — List view: flat sorted list per time-range; priority-flip grouping.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRangeData } from '../../hooks/useRangeData'
import { useOccurrenceActions } from '../../hooks/useOccurrenceActions'
import { OccurrenceRow } from '../now/OccurrenceRow'
import { DispositionModal } from '../now/DispositionModal'
import { SessionManagerModal } from '../now/SessionManagerModal'
import { ConfirmModal } from '../shared/ConfirmModal'
import { OccurrenceCard } from '../shared/OccurrenceCard'
import { SortableList } from '../shared/SortableList'
import { FilterBar } from '../FilterBar'
import { sortByTiming, groupByPriority, splitTimed } from '../../lib/list-sort'
import { applyFilters, makeDefaultFilters, serializeFilters, deserializeFilters } from '../../lib/filters'
import { getRangeDates, getDaysInRange, formatDayLabel, todayStr } from '../../lib/date-range'
import { buildOccurrenceTree, type OccurrenceNode } from '../../lib/occurrence-tree'
import { api } from '../../lib/api'
import type { RangeKey } from '../../lib/date-range'
import type { OccurrenceWithState, Category, Reason } from '@tracker/shared'

type Props = {
  onEditItem: (itemId: string) => void
}

export function ListView({ onEditItem }: Props) {
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

  useEffect(() => { localStorage.setItem('tracker:list-range', range) }, [range])
  useEffect(() => { localStorage.setItem('tracker:list-customDate', customDate) }, [customDate])
  useEffect(() => { localStorage.setItem('tracker:list-priorityFlip', String(priorityFlip)) }, [priorityFlip])
  useEffect(() => { localStorage.setItem('tracker:list-filters', serializeFilters(filters)) }, [filters])

  const { start, end } = useMemo(() => getRangeDates(range, undefined, customDate), [range, customDate])

  const {
    occurrences,
    buckets,
    loading,
    error,
    refresh,
    setOccurrences,
  } = useRangeData(start, end)

  useEffect(() => {
    api.categories.list().then(setCategories).catch(() => {})
    api.reasons.list().then(setReasons).catch(() => {})
  }, [])

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
    handleArchive,
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

  // Days in selected range (single element for today/tomorrow, multiple for week/month)
  const days = useMemo(() => getDaysInRange(start, end), [start, end])
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

  function renderRow(occ: OccurrenceWithState, isChild = false) {
    const occId = occ.id ?? occ.itemId
    return (
      <OccurrenceRow
        key={occId}
        occ={occ}
        buckets={buckets}
        isChild={isChild}
        isToday={occ.appliesToDay === todayStr()}
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
        onManageSessions={() => setSessionManagerTarget(occ)}
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
      return <OccurrenceCard key={occ.id ?? occ.itemId} node={node} depth={0} renderLeaf={(o) => renderRow(o)} onReordered={handleReordered} />
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
      </div>

      {/* Filter bar */}
      {showFilters && (
        <FilterBar
          filters={filters}
          categories={categories}
          onChange={setFilters}
        />
      )}

      {/* Content */}
      {loading ? (
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
