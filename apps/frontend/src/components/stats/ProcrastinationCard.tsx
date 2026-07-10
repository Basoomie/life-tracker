// v2 §3.4 — pure counting from the event log; reschedule/backfill patterns.

import type { ProcrastinationFinding } from '@tracker/shared'

type Props = { finding: ProcrastinationFinding }

export function ProcrastinationCard({ finding }: Props) {
  return (
    <div className="procrastination-card" data-testid="procrastination-card">
      <span className="procrastination-card__item">Rescheduled {finding.rescheduleCount}×</span>
      {finding.longestRescheduleChain > 0 && (
        <span className="procrastination-card__item">Longest push chain: {finding.longestRescheduleChain}</span>
      )}
      {finding.backfillStats.count > 0 && (
        <span className="procrastination-card__item">
          Backfilled {finding.backfillStats.count}× — median {finding.backfillStats.medianLagDays}d late
          (max {finding.backfillStats.maxLagDays}d)
        </span>
      )}
    </div>
  )
}
