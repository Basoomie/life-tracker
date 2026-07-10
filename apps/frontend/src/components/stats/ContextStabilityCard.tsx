// v2 §5.3 — variance of session start-times; not a permutation test, so there's
// no significance/null branch — just the estimate, its power, and its MDE.

import type { ContextStabilityFinding } from '@tracker/shared'
import { presentSufficiency } from '../../lib/stats-presentation'
import { FindingShell } from './FindingShell'

type Props = { finding: ContextStabilityFinding }

export function ContextStabilityCard({ finding }: Props) {
  const sufficiency = presentSufficiency(finding.sufficiency)
  const hour = finding.circularMeanHour
  const hourLabel = `${Math.floor(hour) % 24}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`

  return (
    <FindingShell
      testId="finding-context-stability"
      title="Context stability"
      estimatorLabel="Circular variance of session start-times"
      sufficiency={sufficiency}
      power={finding.power}
      dataQuality={finding.dataQuality}
      rawCounts={finding.rawCounts}
      minimumDetectableEffect={finding.minimumDetectableEffect}
      effectSizeLabel={
        sufficiency.kind === 'reported'
          ? `Variance: ${finding.circularVariance.toFixed(2)} (0 = always the same time, 1 = maximally spread)`
          : undefined
      }
    >
      <p className="finding-card__narrative">Typically starts around {hourLabel}.</p>
    </FindingShell>
  )
}
