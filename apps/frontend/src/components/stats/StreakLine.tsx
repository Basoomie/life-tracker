// v2 §3.2 / §5.4 — streaks are a display affordance, shown as plain fact, never
// framed as something fragile to protect. No "keep it going," no reference to a
// broken streak or a single missed day anywhere near this component.

import type { StreakFinding } from '@tracker/shared'

type Props = { finding: StreakFinding }

export function StreakLine({ finding }: Props) {
  const unit = finding.streakType === 'daily' ? 'day' : 'period'
  const plural = (n: number) => `${unit}${n === 1 ? '' : 's'}`

  return (
    <div className="streak-line" data-testid="streak-line">
      <span className="streak-line__item">Current streak: {finding.currentStreak} {plural(finding.currentStreak)}</span>
      <span className="streak-line__item">Longest: {finding.longestStreak} {plural(finding.longestStreak)}</span>
    </div>
  )
}
