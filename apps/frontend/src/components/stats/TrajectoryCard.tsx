// v2 §5.3 — regression slope of adherence over months. Informative 2-5 months.

import type { TrajectoryFinding } from '@tracker/shared'
import { presentSufficiency } from '../../lib/stats-presentation'
import { FindingShell } from './FindingShell'

type Props = { finding: TrajectoryFinding }

export function TrajectoryCard({ finding }: Props) {
  const sufficiency = presentSufficiency(finding.sufficiency)
  const isNull = sufficiency.kind === 'reported' && finding.pValue >= 0.05

  return (
    <FindingShell
      testId="finding-trajectory"
      title="Trajectory"
      estimatorLabel="OLS regression slope over months"
      sufficiency={sufficiency}
      power={finding.power}
      dataQuality={finding.dataQuality}
      rawCounts={finding.rawCounts}
      isNull={isNull}
      minimumDetectableEffect={finding.minimumDetectableEffect}
      effectSizeLabel={
        sufficiency.kind === 'reported'
          ? `Slope: ${finding.slope >= 0 ? '+' : ''}${(finding.slope * 100).toFixed(1)} pts/month (R²=${finding.rSquared.toFixed(2)}, p=${finding.pValue.toFixed(3)})`
          : undefined
      }
    >
      {!isNull && (
        <p className="finding-card__narrative">
          Adherence is trending {finding.slope > 0 ? 'upward' : 'downward'} over this window.
        </p>
      )}
    </FindingShell>
  )
}
