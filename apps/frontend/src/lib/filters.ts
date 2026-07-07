// §12.5 — Filter state and application logic for List and Calendar views.
// Filter state lives in the view component (view state — no data mutation).

import type { OccurrenceWithState } from '@tracker/shared'
import type { Priority, Valence, TimingPrecision } from '@tracker/shared'

export type FilterState = {
  priorities: Set<Priority | 'unset'>     // empty = all
  categories: Set<string>                  // categoryId; empty = all
  valences: Set<Valence | 'unset'>        // empty = all
  precisions: Set<TimingPrecision>         // empty = all
  completion: 'all' | 'incomplete' | 'complete'
  blocked: 'all' | 'unblocked' | 'blocked'
}

export function makeDefaultFilters(): FilterState {
  return {
    priorities: new Set(),
    categories: new Set(),
    valences: new Set(),
    precisions: new Set(),
    completion: 'all',
    blocked: 'all',
  }
}

// §12.5 — filters combine with AND semantics.
export function applyFilters(
  occs: OccurrenceWithState[],
  filters: FilterState
): OccurrenceWithState[] {
  return occs.filter((occ) => {
    if (filters.priorities.size > 0) {
      const p: Priority | 'unset' = occ.snapshot.priority ?? 'unset'
      if (!filters.priorities.has(p)) return false
    }
    if (filters.categories.size > 0) {
      const c = occ.snapshot.categoryId ?? ''
      if (!filters.categories.has(c)) return false
    }
    if (filters.valences.size > 0) {
      const v: Valence | 'unset' = occ.snapshot.valence ?? 'unset'
      if (!filters.valences.has(v)) return false
    }
    if (filters.precisions.size > 0) {
      if (!filters.precisions.has(occ.snapshot.timingPrecision)) return false
    }
    if (filters.completion === 'incomplete' && occ.completionState.isComplete) return false
    if (filters.completion === 'complete' && !occ.completionState.isComplete) return false
    if (filters.blocked === 'unblocked' && occ.isBlocked) return false
    if (filters.blocked === 'blocked' && !occ.isBlocked) return false
    return true
  })
}

export function isDefaultFilters(f: FilterState): boolean {
  return (
    f.priorities.size === 0 &&
    f.categories.size === 0 &&
    f.valences.size === 0 &&
    f.precisions.size === 0 &&
    f.completion === 'all' &&
    f.blocked === 'all'
  )
}

export function serializeFilters(f: FilterState): string {
  return JSON.stringify({
    priorities: [...f.priorities],
    categories: [...f.categories],
    valences:   [...f.valences],
    precisions: [...f.precisions],
    completion: f.completion,
    blocked:    f.blocked,
  })
}

export function deserializeFilters(s: string): FilterState {
  try {
    const raw = JSON.parse(s) as Record<string, unknown>
    return {
      priorities: new Set((raw.priorities as string[] | undefined) ?? []) as FilterState['priorities'],
      categories: new Set((raw.categories as string[] | undefined) ?? []),
      valences:   new Set((raw.valences as string[] | undefined) ?? []) as FilterState['valences'],
      precisions: new Set((raw.precisions as string[] | undefined) ?? []) as FilterState['precisions'],
      completion: (raw.completion as FilterState['completion']) ?? 'all',
      blocked:    (raw.blocked    as FilterState['blocked'])    ?? 'all',
    }
  } catch {
    return makeDefaultFilters()
  }
}
