// v2 §5.3 — lag-1 autocorrelation (streakiness), estimated directly (not a
// permutation test). First-class alone AND determines whether k=2/k=7 tests can
// work on this item at all.

import type { AutocorrelationFinding } from '@tracker/shared'
import { presentSufficiency } from '../../lib/stats-presentation'
import { FindingShell } from './FindingShell'

type Props = { finding: AutocorrelationFinding }

export function AutocorrelationCard({ finding }: Props) {
  const sufficiency = presentSufficiency(finding.sufficiency)
  const isNull = sufficiency.kind === 'reported' && finding.pValue >= 0.05

  return (
    <FindingShell
      testId="finding-autocorrelation"
      title="Autocorrelation (streakiness)"
      estimatorLabel="Lag-1 correlation"
      sufficiency={sufficiency}
      power={finding.power}
      dataQuality={finding.dataQuality}
      rawCounts={finding.rawCounts}
      isNull={isNull}
      minimumDetectableEffect={finding.minimumDetectableEffect}
      effectSizeLabel={`ρ = ${finding.lag1.toFixed(2)} (SE ${finding.standardError.toFixed(2)}, p=${finding.pValue.toFixed(3)})`}
    >
      {!isNull && (
        <p className="finding-card__narrative">
          {finding.lag1 > 0
            ? 'Misses cluster — a miss tends to be followed by another miss.'
            : 'Misses do not cluster — no evidence of streakiness.'}
        </p>
      )}
    </FindingShell>
  )
}
