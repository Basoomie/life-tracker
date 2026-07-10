// v2 §9.5.1 — the Global view: "where should I look?" A triage surface. Compact
// per-top-level-item rows, NOT the per-item view repeated N times. Also the only
// home for genuinely cross-item facts with no per-item equivalent (valence-weighted
// time allocation, ad-hoc share) — and per §10, no fabricated aggregate that has
// no interpretation (no "average context stability across items" anywhere here).

import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { Item, AdherenceFinding, DataQualityFinding, TrajectoryFinding, AdHocShareFinding } from '@tracker/shared'
import {
  hasLoggingHealthIssue,
  needsAttention,
  adherenceHeadline,
  trajectoryDirection,
  formatPercent,
  plannedShare,
  unproductiveShareOfAdHoc,
  type TrajectoryDirection,
} from '../../lib/stats-presentation'

type Props = {
  window: { startDay: string; endDay: string }
  onSelectItem: (itemId: string) => void
}

type ItemRow = {
  item: Item
  adherence: AdherenceFinding | null
  quality: DataQualityFinding | null
  trajectory: TrajectoryFinding | null
}

function trajectoryArrow(dir: TrajectoryDirection): string {
  if (dir === 'up') return '↑'
  if (dir === 'down') return '↓'
  if (dir === 'flat') return '→'
  return '—'
}

export function GlobalStatsView({ window, onSelectItem }: Props) {
  const [rows, setRows] = useState<ItemRow[] | null>(null)
  const [crossItem, setCrossItem] = useState<AdHocShareFinding | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setError(null)

    async function load() {
      try {
        const items = await api.items.list()
        const topLevel = items.filter((i) => i.parentId === null && i.archivedAt === null)

        const built = await Promise.all(topLevel.map(async (item): Promise<ItemRow> => {
          const [adherence, quality, trajectory] = await Promise.all([
            api.stats.itemAdherence(item.id, window).catch(() => null),
            api.stats.itemQuality(item.id, window).catch(() => null),
            api.stats.itemTrajectory(item.id, window).catch(() => null),
          ])
          return { item, adherence, quality, trajectory }
        }))

        const crossItemFinding = await api.stats.crossItemTime(window)

        if (!cancelled) {
          setRows(built)
          setCrossItem(crossItemFinding)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load stats')
      }
    }
    load()
    return () => { cancelled = true }
  }, [window.startDay, window.endDay])

  if (error) {
    return <div className="now-view__error" role="alert">{error}</div>
  }

  if (rows === null) {
    return (
      <div className="now-view__loading">
        <span className="spinner" aria-hidden="true" />&ensp;Loading stats…
      </div>
    )
  }

  return (
    <div className="global-stats-view" data-testid="global-stats-view">
      <div className="settings-section">
        <div className="settings-section__header">
          <h2 className="settings-section__title">Where should I look?</h2>
        </div>
        <div className="settings-section__body">
          {rows.length === 0 ? (
            <p className="form-empty" data-testid="global-stats-empty">No items to show yet.</p>
          ) : (
            <div className="global-stats-table" data-testid="global-stats-table">
              {rows.map(({ item, adherence, quality, trajectory }) => (
                <button
                  key={item.id}
                  className="global-stats-row"
                  data-testid={`global-stats-row-${item.id}`}
                  onClick={() => onSelectItem(item.id)}
                >
                  <span className="global-stats-row__name">{item.name}</span>
                  <span className="global-stats-row__adherence" data-testid={`global-stats-row-${item.id}-adherence`}>
                    {adherence ? formatPercent(adherenceHeadline(adherence)) : '—'}
                  </span>
                  <span
                    className="global-stats-row__trajectory"
                    data-testid={`global-stats-row-${item.id}-trajectory`}
                    aria-label="Trajectory direction (triage cue only — see per-item view for the full finding)"
                  >
                    {trajectory ? trajectoryArrow(trajectoryDirection(trajectory)) : '—'}
                  </span>
                  <span className="global-stats-row__flags">
                    {quality && hasLoggingHealthIssue(quality) && (
                      <span
                        className="global-stats-row__flag global-stats-row__flag--logging"
                        data-testid={`global-stats-row-${item.id}-logging-flag`}
                      >
                        Logging
                      </span>
                    )}
                    {adherence && needsAttention(adherence) && (
                      <span
                        className="global-stats-row__flag global-stats-row__flag--attention"
                        data-testid={`global-stats-row-${item.id}-attention-flag`}
                      >
                        Needs attention
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {crossItem && (
        <div className="settings-section">
          <div className="settings-section__header">
            <h2 className="settings-section__title">Time allocation</h2>
          </div>
          <div className="settings-section__body">
            <p className="cross-item-fact" data-testid="cross-item-adhoc-share">
              {formatPercent(plannedShare(crossItem))} of tracked time was planned; of the ad-hoc time,{' '}
              {formatPercent(unproductiveShareOfAdHoc(crossItem))} was unproductive.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
