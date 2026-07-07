// §12.5 — Shared filter bar. Filter state lives in the calling view (view state only).

import type { FilterState } from '../lib/filters'
import { makeDefaultFilters, isDefaultFilters } from '../lib/filters'
import type { Category } from '@tracker/shared'
import type { Priority, Valence, TimingPrecision } from '@tracker/shared'

type Props = {
  filters: FilterState
  categories: Category[]
  onChange: (f: FilterState) => void
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

const PRIORITIES: Array<{ key: Priority | 'unset'; label: string }> = [
  { key: 'high',   label: 'High' },
  { key: 'medium', label: 'Med' },
  { key: 'low',    label: 'Low' },
  { key: 'unset',  label: 'No priority' },
]

const VALENCES: Array<{ key: Valence | 'unset'; label: string }> = [
  { key: 'productive',   label: 'Productive' },
  { key: 'unproductive', label: 'Unproductive' },
  { key: 'neutral',      label: 'Neutral' },
  { key: 'unset',        label: 'No valence' },
]

const PRECISIONS: Array<{ key: TimingPrecision; label: string }> = [
  { key: 'range',  label: 'Range' },
  { key: 'point',  label: 'Point' },
  { key: 'bucket', label: 'Bucket' },
  { key: 'none',   label: 'Unscheduled' },
]

export function FilterBar({ filters, categories, onChange }: Props) {
  const isDefault = isDefaultFilters(filters)
  return (
    <div className="filter-bar" data-testid="filter-bar" role="group" aria-label="Filters">

      {/* Priority */}
      <div className="filter-group">
        <span className="filter-group__label">Priority</span>
        <div className="filter-pills">
          {PRIORITIES.map(({ key, label }) => (
            <button
              key={key}
              className={`filter-pill${filters.priorities.has(key) ? ' filter-pill--active' : ''}`}
              onClick={() => onChange({ ...filters, priorities: toggle(filters.priorities, key) })}
              aria-pressed={filters.priorities.has(key)}
              data-testid={`filter-priority-${key}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Category — only render if there are categories */}
      {categories.length > 0 && (
        <div className="filter-group">
          <span className="filter-group__label">Category</span>
          <div className="filter-pills">
            {categories.map((cat) => (
              <button
                key={cat.id}
                className={`filter-pill${filters.categories.has(cat.id) ? ' filter-pill--active' : ''}`}
                onClick={() => onChange({ ...filters, categories: toggle(filters.categories, cat.id) })}
                aria-pressed={filters.categories.has(cat.id)}
                data-testid={`filter-category-${cat.id}`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Valence */}
      <div className="filter-group">
        <span className="filter-group__label">Valence</span>
        <div className="filter-pills">
          {VALENCES.map(({ key, label }) => (
            <button
              key={key}
              className={`filter-pill${filters.valences.has(key) ? ' filter-pill--active' : ''}`}
              onClick={() => onChange({ ...filters, valences: toggle(filters.valences, key) })}
              aria-pressed={filters.valences.has(key)}
              data-testid={`filter-valence-${key}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Timing precision */}
      <div className="filter-group">
        <span className="filter-group__label">Timing</span>
        <div className="filter-pills">
          {PRECISIONS.map(({ key, label }) => (
            <button
              key={key}
              className={`filter-pill${filters.precisions.has(key) ? ' filter-pill--active' : ''}`}
              onClick={() => onChange({ ...filters, precisions: toggle(filters.precisions, key) })}
              aria-pressed={filters.precisions.has(key)}
              data-testid={`filter-precision-${key}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Completion state */}
      <div className="filter-group">
        <span className="filter-group__label">Done</span>
        <div className="filter-pills">
          {(['all', 'incomplete', 'complete'] as const).map((val) => (
            <button
              key={val}
              className={`filter-pill${filters.completion === val ? ' filter-pill--active' : ''}`}
              onClick={() => onChange({ ...filters, completion: val })}
              aria-pressed={filters.completion === val}
              data-testid={`filter-completion-${val}`}
            >
              {val === 'all' ? 'All' : val === 'incomplete' ? 'Todo' : 'Done'}
            </button>
          ))}
        </div>
      </div>

      {/* Blocked */}
      <div className="filter-group">
        <span className="filter-group__label">Blocked</span>
        <div className="filter-pills">
          {(['all', 'unblocked', 'blocked'] as const).map((val) => (
            <button
              key={val}
              className={`filter-pill${filters.blocked === val ? ' filter-pill--active' : ''}`}
              onClick={() => onChange({ ...filters, blocked: val })}
              aria-pressed={filters.blocked === val}
              data-testid={`filter-blocked-${val}`}
            >
              {val === 'all' ? 'All' : val === 'unblocked' ? 'Available' : 'Blocked'}
            </button>
          ))}
        </div>
      </div>

      {/* Reset */}
      {!isDefault && (
        <div className="filter-group filter-group--reset">
          <button
            className="btn btn--ghost filter-reset-btn"
            onClick={() => onChange(makeDefaultFilters())}
            data-testid="filter-reset"
          >
            Reset filters
          </button>
        </div>
      )}

    </div>
  )
}
