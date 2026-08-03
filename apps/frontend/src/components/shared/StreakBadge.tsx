// v2 §3.2.5 — the ambient streak badge shown on Now, List and the Calendar
// detail row.
//
// Presentation is spec-constrained, not a style choice:
//   • The 30-day adherence rate is ALWAYS rendered next to the streak. §5.4's
//     position is that the rate is the real signal and the streak is decoration,
//     so a streak that resets is read beside the truth that adherence is 88%.
//   • A zero renders in exactly the same weight and colour as any other value.
//     There is no danger state, no warning tint, and no hiding it — absence would
//     read as punishment and red would read as an alarm on a single miss.
//   • No streak-protection framing: nothing here says "keep it going", counts down
//     to losing anything, or mentions a streak that ended.
//
// Deliberately terse (`12d · 88%`) because it sits in a row that already carries a
// name, timing and percentage. The honest long form — including the raw counts §3
// requires beside any rate, the quota period's progress, and the fact that excused
// days did not break the chain — is the accessible label and the tooltip. The
// per-item Stats surface renders the same facts in full prose via StreakLine.

import type { ItemStreakSummary } from '@tracker/shared'

type Props = { summary: ItemStreakSummary }

const UNIT = {
  daily: { short: 'd', long: (n: number) => (n === 1 ? 'day' : 'days') },
  quota: { short: 'w', long: (n: number) => (n === 1 ? 'period' : 'periods') },
} as const

function ratePercent(summary: ItemStreakSummary): number {
  return Math.round(summary.adherenceRate30d * 100)
}

function describe(summary: ItemStreakSummary): string {
  const unit = UNIT[summary.streakType]
  const parts = [`Current streak ${summary.currentStreak} ${unit.long(summary.currentStreak)}.`]

  if (summary.currentPeriodProgress) {
    const p = summary.currentPeriodProgress
    parts.push(`This ${p.period}: ${p.completed} of ${p.target}.`)
  }
  if (summary.currentDayPending) {
    parts.push('Today is not done yet.')
  }

  parts.push(
    `${ratePercent(summary)}% adherence over the last 30 days (${summary.adherenceDueCount30d} due).`
  )
  if (summary.excusedCount30d > 0) {
    const n = summary.excusedCount30d
    parts.push(`${n} excused ${n === 1 ? 'day' : 'days'} did not break the chain.`)
  }

  return parts.join(' ')
}

export function StreakBadge({ summary }: Props) {
  const label = describe(summary)
  const progress = summary.currentPeriodProgress

  return (
    <span
      className="streak-badge"
      data-testid={`streak-badge-${summary.itemId}`}
      data-streak={summary.currentStreak}
      title={label}
      aria-label={label}
    >
      <span className="streak-badge__value">
        {summary.currentStreak}
        {UNIT[summary.streakType].short}
      </span>
      {progress && (
        <span className="streak-badge__progress">
          {progress.completed}/{progress.target}
        </span>
      )}
      <span className="streak-badge__rate">{ratePercent(summary)}%</span>
    </span>
  )
}
