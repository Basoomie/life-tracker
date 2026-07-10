// v2 §3.3 — time totals, planned-vs-actual delta, and the session start-time
// distribution (raw material for context stability). This IS a chart, but a
// purely descriptive one (Layer 1 counts) — thin single-hue bars, no gated
// inference riding on it, sparse axis, one direct-labeled callout (peak hour)
// rather than a number on every bar.

import type { TimeStatsFinding } from '@tracker/shared'

type Props = { finding: TimeStatsFinding }

function formatHour(h: number): string {
  const period = h < 12 ? 'am' : 'pm'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}${period}`
}

export function TimeStatsCard({ finding }: Props) {
  const byHour = Array.from({ length: 24 }, (_, h) =>
    finding.sessionStartDistribution.find((e) => e.hour === h)?.count ?? 0
  )
  const maxCount = Math.max(1, ...byHour)
  const peakHour = byHour.indexOf(Math.max(...byHour))
  const hasSessions = finding.rawCounts.sessionCount > 0

  return (
    <div className="time-stats-card" data-testid="time-stats-card">
      <div className="time-stats-card__row">
        <span className="time-stats-card__item">Total logged: {Math.round(finding.totalMin)} min</span>
        {finding.plannedDurationMin !== null && (
          <span className="time-stats-card__item">
            Planned: {finding.plannedDurationMin} min
            {finding.plannedVsActualDeltaMin !== null && (
              <> ({finding.plannedVsActualDeltaMin > 0 ? '+' : ''}{Math.round(finding.plannedVsActualDeltaMin)} min vs. plan)</>
            )}
          </span>
        )}
      </div>

      {hasSessions && (
        <div className="time-histogram" data-testid="time-histogram" aria-label="Session start times by hour of day">
          <div className="time-histogram__bars">
            {byHour.map((count, hour) => (
              <div
                key={hour}
                className="time-histogram__bar"
                style={{ height: `${Math.max(2, (count / maxCount) * 100)}%` }}
                title={`${hour}:00 — ${count} session${count === 1 ? '' : 's'}`}
              />
            ))}
          </div>
          <div className="time-histogram__axis">
            <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span>
          </div>
          <p className="time-histogram__caption">Most sessions start around {formatHour(peakHour)}.</p>
        </div>
      )}
    </div>
  )
}
