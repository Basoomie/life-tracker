// v2 §9.5.1 — the per-item diagnostic surface: "what's going on with this?"
// Adherence with raw counts and a default (not drill-down) per-child breakdown,
// context stability / autocorrelation / trajectory / day-of-week / weekday-vs-
// weekend findings, each carrying its own power/effect/MDE/data-quality per the
// governing presentation rule.

import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type {
  Item,
  AdherenceFinding,
  StreakFinding,
  TimeStatsFinding,
  ProcrastinationFinding,
  DataQualityFinding,
  ContextStabilityFinding,
  AutocorrelationFinding,
  TrajectoryFinding,
  DayOfWeekFinding,
  TwoConditionFinding,
} from '@tracker/shared'
import { AdherenceCard } from './AdherenceCard'
import { StreakLine } from './StreakLine'
import { TimeStatsCard } from './TimeStatsCard'
import { ProcrastinationCard } from './ProcrastinationCard'
import { DataQualityStrip } from './DataQualityStrip'
import { ContextStabilityCard } from './ContextStabilityCard'
import { AutocorrelationCard } from './AutocorrelationCard'
import { TrajectoryCard } from './TrajectoryCard'
import { DayOfWeekCard } from './DayOfWeekCard'
import { TwoConditionCard } from './TwoConditionCard'

type Props = {
  itemId: string
  window: { startDay: string; endDay: string }
  onBack: () => void
}

type Data = {
  item: Item & { children: Item[] }
  adherence: AdherenceFinding
  streaks: StreakFinding
  time: TimeStatsFinding
  procrastination: ProcrastinationFinding
  quality: DataQualityFinding
  contextStability: ContextStabilityFinding
  autocorrelation: AutocorrelationFinding
  trajectory: TrajectoryFinding
  dayOfWeek: DayOfWeekFinding
  weekdayVsWeekend: TwoConditionFinding
}

export function ItemStatsView({ itemId, window, onBack }: Props) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)

    Promise.all([
      api.items.get(itemId),
      api.stats.itemAdherence(itemId, window),
      api.stats.itemStreaks(itemId, window),
      api.stats.itemTime(itemId, window),
      api.stats.itemProcrastination(itemId, window),
      api.stats.itemQuality(itemId, window),
      api.stats.itemContextStability(itemId, window),
      api.stats.itemAutocorrelation(itemId, window),
      api.stats.itemTrajectory(itemId, window),
      api.stats.itemDayOfWeek(itemId, window),
      api.stats.itemWeekdayVsWeekend(itemId, window),
    ])
      .then(([item, adherence, streaks, time, procrastination, quality, contextStability, autocorrelation, trajectory, dayOfWeek, weekdayVsWeekend]) => {
        if (cancelled) return
        setData({ item, adherence, streaks, time, procrastination, quality, contextStability, autocorrelation, trajectory, dayOfWeek, weekdayVsWeekend })
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load item stats')
      })

    return () => { cancelled = true }
  }, [itemId, window.startDay, window.endDay])

  if (error) return <div className="now-view__error" role="alert">{error}</div>

  if (data === null) {
    return (
      <div className="now-view__loading">
        <span className="spinner" aria-hidden="true" />&ensp;Loading…
      </div>
    )
  }

  const childNames = Object.fromEntries(data.item.children.map((c) => [c.id, c.name]))

  return (
    <div className="item-stats-view" data-testid="item-stats-view">
      <div className="item-stats-view__header">
        <button className="btn btn--ghost btn--sm" onClick={onBack} data-testid="item-stats-back">← Back</button>
        <h2 className="item-stats-view__title">{data.item.name}</h2>
      </div>

      <div className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">Adherence</h3>
        </div>
        <div className="settings-section__body">
          <AdherenceCard finding={data.adherence} childNames={childNames} />
          <StreakLine finding={data.streaks} />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">Time</h3>
        </div>
        <div className="settings-section__body">
          <TimeStatsCard finding={data.time} />
          <ProcrastinationCard finding={data.procrastination} />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">Logging health</h3>
        </div>
        <div className="settings-section__body">
          <DataQualityStrip quality={data.quality} variant="full" />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">Findings</h3>
        </div>
        <div className="settings-section__body item-stats-view__findings">
          <ContextStabilityCard finding={data.contextStability} />
          <AutocorrelationCard finding={data.autocorrelation} />
          <TrajectoryCard finding={data.trajectory} />
          <DayOfWeekCard finding={data.dayOfWeek} />
          <TwoConditionCard finding={data.weekdayVsWeekend} />
        </div>
      </div>
    </div>
  )
}
