// v2 §3.2 / §5.4 — streaks are a display affordance, shown as plain fact, never
// framed as something fragile to protect. No "keep it going," no reference to a
// broken streak or a single missed day anywhere near this component.
//
// §3.2.1 — the current day's state is rendered SEPARATELY from the count, because
// an unfinished day is neither a hit nor a miss. Reporting "12 days · today not yet
// done" is the whole reason the finding carries that flag.
//
// §3.2.4 — the two numbers answer different questions and are labelled as such:
// current streak is anchored to today and ignores the selected window; longest is
// scoped to it.

import type { StreakFinding } from '@tracker/shared'

type Props = { finding: StreakFinding }

export function StreakLine({ finding }: Props) {
  const unit = finding.streakType === 'daily' ? 'day' : 'period'
  const plural = (n: number) => `${unit}${n === 1 ? '' : 's'}`
  const progress = finding.currentPeriodProgress

  return (
    <div className="streak-line" data-testid="streak-line">
      <span className="streak-line__item">
        Current streak: {finding.currentStreak} {plural(finding.currentStreak)}
      </span>
      {progress && (
        <span className="streak-line__item" data-testid="streak-line-progress">
          This {progress.period}: {progress.completed} of {progress.target}
        </span>
      )}
      {finding.currentDayPending && (
        <span className="streak-line__item streak-line__item--pending" data-testid="streak-line-pending">
          Today not yet done
        </span>
      )}
      <span className="streak-line__item">
        Longest in window: {finding.longestStreak} {plural(finding.longestStreak)}
      </span>
    </div>
  )
}
