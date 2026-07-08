// §12.4 — Calendar view: proportional time-grid for today / tomorrow / this week / this month.
// Mobile (<640px): single-day focus with prev/next navigation within the range.
// Desktop: all days side-by-side (horizontal scroll for week/month).

import { useState, useEffect, useMemo } from 'react'
import { useRangeData, effectiveDayStart } from '../../hooks/useRangeData'
import { useOccurrenceActions } from '../../hooks/useOccurrenceActions'
import { DispositionModal } from '../now/DispositionModal'
import { ConfirmModal } from '../shared/ConfirmModal'
import { FilterBar } from '../FilterBar'
import { TimeGrid } from './TimeGrid'
import { applyFilters, makeDefaultFilters, serializeFilters, deserializeFilters } from '../../lib/filters'
import { getRangeDates, getDaysInRange, formatDayLabel, todayStr } from '../../lib/date-range'
import { api } from '../../lib/api'
import type { RangeKey } from '../../lib/date-range'
import type { OccurrenceWithState, Category, Reason } from '@tracker/shared'

type Props = {
  onEditItem: (itemId: string) => void
}

export function CalendarView({ onEditItem }: Props) {
  const [range, setRange] = useState<RangeKey>(() => {
    return (localStorage.getItem('tracker:cal-range') as RangeKey | null) ?? 'today'
  })
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState(() => {
    const saved = localStorage.getItem('tracker:cal-filters')
    return saved ? deserializeFilters(saved) : makeDefaultFilters()
  })
  const [categories, setCategories] = useState<Category[]>([])
  const [reasons, setReasons] = useState<Reason[]>([])
  const [now, setNow] = useState(() => new Date())
  const [pendingUncompletion, setPendingUncompletion] = useState<OccurrenceWithState | null>(null)
  const [pendingArchive, setPendingArchive] = useState<OccurrenceWithState | null>(null)

  useEffect(() => { localStorage.setItem('tracker:cal-range', range) }, [range])
  useEffect(() => { localStorage.setItem('tracker:cal-filters', serializeFilters(filters)) }, [filters])

  // Mobile single-day navigation: which day within range is focused
  const [focusedDay, setFocusedDay] = useState(() => todayStr())

  useEffect(() => {
    api.categories.list().then(setCategories).catch(() => {})
    api.reasons.list().then(setReasons).catch(() => {})
    // Advance "now" every minute for the now-indicator
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  const { start, end } = useMemo(() => getRangeDates(range), [range])

  const {
    occurrences,
    buckets,
    dayStartEntries,
    loading,
    error,
    refresh,
    setOccurrences,
  } = useRangeData(start, end)

  const {
    sessions,
    dispositionTarget,
    setDispositionTarget,
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

  const days = useMemo(() => getDaysInRange(start, end), [start, end])
  const today = todayStr()

  // Keep focusedDay clamped within range when range changes
  const clampedFocus = focusedDay < start ? start : focusedDay > end ? end : focusedDay

  // Per-day occurrence map
  const occsByDay = useMemo(() => {
    const map = new Map<string, OccurrenceWithState[]>()
    for (const day of days) map.set(day, [])
    for (const occ of occurrences) {
      const bucket = map.get(occ.appliesToDay)
      if (bucket) bucket.push(occ)
    }
    return map
  }, [occurrences, days])

  function renderDay(day: string) {
    const dayOccs = occsByDay.get(day) ?? []
    const filtered = applyFilters(dayOccs, filters)
    const dayStart = effectiveDayStart(dayStartEntries, day)
    const isToday = day === today

    return (
      <TimeGrid
        key={day}
        day={day}
        isToday={isToday}
        occs={filtered}
        buckets={buckets}
        dayStart={dayStart}
        now={now}
        sessions={sessions}
        onComplete={handleComplete}
        onUncomplete={setPendingUncompletion}
        onTimerStart={handleTimerStart}
        onTimerPause={handleTimerPause}
        onTimerResume={handleTimerResume}
        onTimerStop={handleTimerStop}
        onDisposition={setDispositionTarget}
        onEdit={onEditItem}
        onArchive={setPendingArchive}
      />
    )
  }

  function renderMobileNav() {
    const idx = days.indexOf(clampedFocus)
    const prevDay = idx > 0 ? days[idx - 1] : null
    const nextDay = idx < days.length - 1 ? days[idx + 1] : null
    return (
      <div className="cal-mobile-nav">
        <button
          className="btn btn--ghost cal-mobile-nav__btn"
          disabled={!prevDay}
          onClick={() => prevDay && setFocusedDay(prevDay)}
          aria-label="Previous day"
        >
          ‹
        </button>
        <span className="cal-mobile-nav__label">{formatDayLabel(clampedFocus)}</span>
        <button
          className="btn btn--ghost cal-mobile-nav__btn"
          disabled={!nextDay}
          onClick={() => nextDay && setFocusedDay(nextDay)}
          aria-label="Next day"
        >
          ›
        </button>
      </div>
    )
  }

  return (
    <div className="cal-view" data-testid="calendar-view">
      {/* Toolbar */}
      <div className="range-toolbar">
        <select
          className="field__select range-toolbar__select"
          value={range}
          onChange={(e) => setRange(e.target.value as RangeKey)}
          aria-label="Date range"
          data-testid="cal-range-select"
        >
          <option value="today">Today</option>
          <option value="tomorrow">Tomorrow</option>
          <option value="this-week">This Week</option>
          <option value="this-month">This Month</option>
        </select>
        <button
          className="btn btn--ghost"
          onClick={() => setShowFilters((v) => !v)}
          data-testid="cal-toggle-filters"
          aria-expanded={showFilters}
        >
          Filters
        </button>
      </div>

      {showFilters && (
        <FilterBar filters={filters} categories={categories} onChange={setFilters} />
      )}

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
        <>
          {/* Mobile: single-day with navigation — hidden on desktop via CSS */}
          <div className="cal-mobile-only">
            {renderMobileNav()}
            {renderDay(clampedFocus)}
          </div>

          {/* Desktop: all days side by side — hidden on mobile via CSS */}
          {/* data-testid="cal-grid-desktop" is the scoping anchor for E2E tests (avoids duplicate IDs with mobile-only) */}
          <div className="cal-desktop-only cal-multi-day" data-testid="cal-grid-desktop">
            {days.map((day) => (
              <div key={day} className="cal-day-col">
                {days.length > 1 && (
                  <div className={`cal-day-col__header${day === today ? ' cal-day-col__header--today' : ''}`}>
                    {formatDayLabel(day)}
                  </div>
                )}
                {renderDay(day)}
              </div>
            ))}
          </div>
        </>
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
