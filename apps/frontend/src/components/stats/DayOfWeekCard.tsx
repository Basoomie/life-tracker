// v2 §5.3 (k=7) / §5.3.1 scope note — day-of-week applies to daily habits only;
// a 4x/week habit must render as a permanent "not detectable" state, never as
// still-accumulating (§9.5.1). Per-day means render as a TABLE, deliberately —
// the governing presentation rule (§9.5) warns exactly against a crisp bar chart
// lending unearned visual confidence to a result this test's power (often
// 20-60%, per §5.1.1) doesn't support.

import type { DayOfWeekFinding } from '@tracker/shared'
import { presentDayOfWeekSufficiency } from '../../lib/stats-presentation'
import { FindingShell } from './FindingShell'

type Props = { finding: DayOfWeekFinding }

export function DayOfWeekCard({ finding }: Props) {
  const sufficiency = presentDayOfWeekSufficiency(finding.scopeStatus, finding.sufficiency)
  const isReported = sufficiency.kind === 'reported'
  const isNull = isReported && finding.pValue !== null && finding.pValue >= 0.05

  return (
    <FindingShell
      testId="finding-day-of-week"
      title="Day-of-week pattern"
      estimatorLabel="Within-period permutation test (k=7)"
      sufficiency={sufficiency}
      power={finding.power}
      dataQuality={finding.dataQuality}
      rawCounts={finding.rawCounts}
      isNull={isNull}
      minimumDetectableEffect={finding.minimumDetectableEffect}
      effectSizeLabel={
        finding.effectSize !== null
          ? `Largest pairwise effect: d=${finding.effectSize.toFixed(2)}${finding.pValue !== null ? `, p=${finding.pValue.toFixed(3)}` : ''}`
          : undefined
      }
    >
      {isReported && finding.dayMeans && (
        <table className="day-of-week-table" data-testid="day-of-week-table">
          <thead>
            <tr><th>Day</th><th>Adherence</th><th>n</th></tr>
          </thead>
          <tbody>
            {finding.dayMeans.map((d) => (
              <tr key={d.dayOfWeek}>
                <td>{d.label}</td>
                <td>{Math.round(d.mean * 100)}%</td>
                <td>{d.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </FindingShell>
  )
}
