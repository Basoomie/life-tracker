// §5.6 — The inactive list.
//
// Unlike every other surface in List/Now/Calendar, this one renders ITEMS, not
// occurrences — an inactive item has no occurrences by definition, which is exactly
// why it cannot be a filter over the occurrence list and needs a panel of its own.
//
// What it has to answer, in order: what did I switch off, when did it used to happen,
// and how do I get it back? Hence the schedule summary on every row: the whole point
// of pausing rather than deleting is that the configuration survived, so the list
// should show that it did.

import { useState, useEffect, useCallback } from 'react'
import { api } from '../../lib/api'
import { useDayStartEntries } from '../../hooks/useRangeData'
import { describeSchedules } from '../item/ScheduleFields'
import { formatDayLabel } from '../../lib/date-range'
import { bucketTimestamp } from '@tracker/shared'
import type { ItemWithSchedules, DayStartEntry } from '@tracker/shared'

/**
 * §6.7 — Which logical day a deactivation happened on.
 *
 * `deactivatedAt` arrives as an absolute UTC timestamp, so slicing the ISO string
 * would report a UTC calendar date: pause something at 6pm in Phoenix and the row
 * would claim tomorrow. Every other "what day was this?" in the app goes through
 * bucketTimestamp against the day-start timeline, and so does this one.
 */
function logicalDayOf(timestamp: unknown, dayStartEntries: DayStartEntry[]): string | null {
  const date = new Date(String(timestamp))
  if (Number.isNaN(date.getTime())) return null
  return bucketTimestamp(date, dayStartEntries)
}

type Props = {
  onEditItem: (itemId: string) => void
  // Bumped by the app whenever an item is saved, so a rename made in the edit modal
  // shows up here instead of leaving a stale name on the row the user just edited.
  itemsVersion?: number
  // Lets the parent view keep its "Inactive (n)" count in step without fetching twice.
  onCountChange?: (count: number) => void
}

export function InactiveItemsPanel({ onEditItem, itemsVersion, onCountChange }: Props) {
  const dayStartEntries = useDayStartEntries()
  const [items, setItems] = useState<ItemWithSchedules[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-row, not global: reactivating one item should not freeze the others.
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.items.list('inactive')
      setItems(result)
      setError(null)
      onCountChange?.(result.length)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load inactive tasks')
    }
  }, [onCountChange])

  useEffect(() => { void load() }, [load, itemsVersion])

  async function handleReactivate(item: ItemWithSchedules) {
    setBusyId(item.id)
    try {
      const result = await api.items.reactivate(item.id)
      setError(null)
      // Drop every item the call switched back on, not just the one clicked:
      // reactivating a parent brings its cascaded children with it (§5.6), and they
      // are rows in this very list.
      const restored = new Set(result.affected.map((i) => i.id))
      setItems((prev) => {
        const next = (prev ?? []).filter((i) => !restored.has(i.id))
        onCountChange?.(next.length)
        return next
      })
    } catch (e) {
      // The server refuses reactivating a child while its parent is still paused
      // (§5.6). That refusal carries the reason and the fix, so show it verbatim
      // rather than replacing it with a generic failure.
      setError(e instanceof Error ? e.message : 'Could not reactivate that task')
    } finally {
      setBusyId(null)
    }
  }

  if (error && items === null) {
    return (
      <div className="now-view__error" role="alert">
        {error}
        <br />
        <button className="btn btn--ghost" style={{ marginTop: 'var(--space-3)' }} onClick={() => void load()}>
          Retry
        </button>
      </div>
    )
  }

  if (items === null) {
    return (
      <div className="now-view__loading">
        <span className="spinner" aria-hidden="true" />&ensp;Loading…
      </div>
    )
  }

  return (
    <div className="inactive-panel" data-testid="inactive-panel">
      <p className="inactive-panel__intro">
        These keep everything — their times, category and history — but aren't scheduled.
        Reactivating one picks up from today; the days it was off don't count against it.
      </p>

      {error && (
        <div className="inactive-panel__error" role="alert" data-testid="inactive-error">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="list-empty" data-testid="inactive-empty">
          Nothing is inactive. Pause a task with ⏸ to park it here instead of deleting it.
        </div>
      ) : (
        <div className="list-section">
          {items.map((item) => (
            <div key={item.id} className="inactive-row" data-testid={`inactive-row-${item.id}`}>
              <div className="inactive-row__main">
                <div className="inactive-row__name">{item.name}</div>
                <div className="inactive-row__meta">
                  {/* §5.1 — the item's creation day is the anchor a slot falls back to
                      on the server, so it is the honest fallback to display too. */}
                  {describeSchedules(item.schedules, String(item.createdAt).slice(0, 10))}
                  {logicalDayOf(item.deactivatedAt, dayStartEntries) && (
                    <> · inactive since {formatDayLabel(logicalDayOf(item.deactivatedAt, dayStartEntries)!)}</>
                  )}
                </div>
              </div>
              <div className="inactive-row__actions">
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => onEditItem(item.id)}
                  data-testid={`inactive-edit-${item.id}`}
                >
                  Edit
                </button>
                <button
                  className="btn btn--sm"
                  onClick={() => void handleReactivate(item)}
                  disabled={busyId === item.id}
                  data-testid={`inactive-reactivate-${item.id}`}
                >
                  {busyId === item.id ? 'Reactivating…' : 'Reactivate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
