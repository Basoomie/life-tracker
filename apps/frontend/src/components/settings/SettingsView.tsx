// §7, §6.6, §6.7 — Settings screen: categories, reasons, buckets, day-start, appearance.
//
// Data is fetched fresh on mount (no caching needed at v1 single-user scale).
// All mutations go through the API and update local state from the response —
// never silently mutate (§CLAUDE.md rule 1).

import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import { ConfigurableListSection } from './ConfigurableListSection'
import { BucketSection } from './BucketSection'
import { DayStartSection } from './DayStartSection'
import { PreferencesSection } from './PreferencesSection'
import type { Category, Reason, Bucket, DayStartEntry } from '@tracker/shared'
import type { Theme } from '../../hooks/useTheme'

type Props = {
  theme: Theme
  onToggleTheme: () => void
}

type State = {
  categories: Category[]
  reasons: Reason[]
  buckets: Bucket[]
  dayStartEntries: DayStartEntry[]
  loading: boolean
  error: string | null
}

/** Returns the effective HH:MM day-start for today from a timeline. */
function getEffectiveDayStart(entries: DayStartEntry[]): string {
  const today = new Date().toISOString().slice(0, 10)
  const applicable = entries
    .filter((e) => e.startsOn <= today)
    .sort((a, b) => {
      if (b.startsOn !== a.startsOn) return b.startsOn.localeCompare(a.startsOn)
      return String(b.recordedAt).localeCompare(String(a.recordedAt))
    })
  return applicable[0]?.value ?? '00:00'
}

export function SettingsView({ theme, onToggleTheme }: Props) {
  const [state, setState] = useState<State>({
    categories: [],
    reasons: [],
    buckets: [],
    dayStartEntries: [],
    loading: true,
    error: null,
  })

  useEffect(() => {
    Promise.all([
      api.categories.list(),
      api.reasons.list(),
      api.buckets.list(),
      api.dayStart.list(),
    ])
      .then(([categories, reasons, buckets, dayStartEntries]) => {
        setState({ categories, reasons, buckets, dayStartEntries, loading: false, error: null })
      })
      .catch((err) => {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load settings',
        }))
      })
  }, [])

  // ── Category handlers ─────────────────────────────────────────────────────────

  async function handleAddCategory(name: string) {
    const cat = await api.categories.create(name)
    setState((prev) => ({ ...prev, categories: [...prev.categories, cat] }))
  }

  async function handleRenameCategory(id: string, name: string) {
    const updated = await api.categories.rename(id, name)
    setState((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => (c.id === id ? updated : c)),
    }))
  }

  async function handleArchiveCategory(id: string) {
    await api.categories.archive(id)
    setState((prev) => ({
      ...prev,
      categories: prev.categories.filter((c) => c.id !== id),
    }))
  }

  // ── Reason handlers ───────────────────────────────────────────────────────────

  async function handleAddReason(name: string) {
    const reason = await api.reasons.create(name)
    setState((prev) => ({ ...prev, reasons: [...prev.reasons, reason] }))
  }

  async function handleRenameReason(id: string, name: string) {
    const updated = await api.reasons.rename(id, name)
    setState((prev) => ({
      ...prev,
      reasons: prev.reasons.map((r) => (r.id === id ? updated : r)),
    }))
  }

  async function handleArchiveReason(id: string) {
    await api.reasons.archive(id)
    setState((prev) => ({
      ...prev,
      reasons: prev.reasons.filter((r) => r.id !== id),
    }))
  }

  // ── Bucket handlers ───────────────────────────────────────────────────────────

  async function handleUpdateBucketBoundaries(id: string, startTime: string, endTime: string) {
    const updated = await api.buckets.updateBoundaries(id, startTime, endTime)
    setState((prev) => ({
      ...prev,
      buckets: prev.buckets.map((b) => (b.id === id ? updated : b)),
    }))
  }

  // ── Day-start handlers ────────────────────────────────────────────────────────

  async function handleAppendDayStart(value: string, effectiveFrom: string) {
    const entry = await api.dayStart.append(value, effectiveFrom)
    setState((prev) => ({
      ...prev,
      dayStartEntries: [...prev.dayStartEntries, entry].sort((a, b) =>
        a.startsOn.localeCompare(b.startsOn)
      ),
    }))
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (state.loading) {
    return (
      <div className="settings-loading">
        <span className="spinner" aria-hidden="true" />&ensp;Loading settings…
      </div>
    )
  }

  if (state.error) {
    return (
      <div className="settings-load-error" role="alert">
        {state.error}
      </div>
    )
  }

  const effectiveDayStart = getEffectiveDayStart(state.dayStartEntries)

  return (
    <div className="settings-view">
      {/* §7 — Categories */}
      <ConfigurableListSection
        title="Categories"
        items={state.categories}
        onAdd={handleAddCategory}
        onRename={handleRenameCategory}
        onArchive={handleArchiveCategory}
        testId="categories-section"
      />

      {/* §7 — Reasons (separate list from categories) */}
      <ConfigurableListSection
        title="Reasons"
        items={state.reasons}
        onAdd={handleAddReason}
        onRename={handleRenameReason}
        onArchive={handleArchiveReason}
        testId="reasons-section"
      />

      {/* §6.6 — Buckets */}
      <BucketSection
        buckets={state.buckets}
        dayStart={effectiveDayStart}
        onUpdateBoundaries={handleUpdateBucketBoundaries}
      />

      {/* §6.7 — Day-start timeline */}
      <DayStartSection
        entries={state.dayStartEntries}
        onAppend={handleAppendDayStart}
      />

      {/* Appearance preferences */}
      <PreferencesSection theme={theme} onToggleTheme={onToggleTheme} />
    </div>
  )
}
