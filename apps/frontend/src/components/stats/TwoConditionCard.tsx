// v2 §5.3 (k=2) — weekday-vs-weekend etc. Provably low-power under realistic
// autocorrelation (§5.1.1 Finding B); still computed and labeled with its real
// measured power rather than hidden.

import type { TwoConditionFinding } from '@tracker/shared'
import { presentSufficiency } from '../../lib/stats-presentation'
import { FindingShell } from './FindingShell'

type Props = { finding: TwoConditionFinding }

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

export function TwoConditionCard({ finding }: Props) {
  const sufficiency = presentSufficiency(finding.sufficiency)
  const isNull = sufficiency.kind === 'reported' && finding.pValue !== null && finding.pValue >= 0.05

  return (
    <FindingShell
      testId={`finding-two-condition-${finding.conditionA}-${finding.conditionB}`}
      title={`${capitalize(finding.conditionA)} vs. ${capitalize(finding.conditionB)}`}
      estimatorLabel="Within-period permutation test (k=2)"
      sufficiency={sufficiency}
      power={finding.power}
      dataQuality={finding.dataQuality}
      rawCounts={finding.rawCounts}
      isNull={isNull}
      minimumDetectableEffect={finding.minimumDetectableEffect}
      effectSizeLabel={
        finding.meanA !== null && finding.meanB !== null
          ? `${capitalize(finding.conditionA)}: ${Math.round(finding.meanA * 100)}% vs. ${capitalize(finding.conditionB)}: ${Math.round(finding.meanB * 100)}%${finding.effectSize !== null ? ` (d=${finding.effectSize.toFixed(2)})` : ''}`
          : undefined
      }
    />
  )
}
