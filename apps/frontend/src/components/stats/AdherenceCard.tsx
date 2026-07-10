// v2 §3.1 — raw-including-excused adherence is the DEFAULT headline (excused is
// metadata about a miss, not grounds to stop counting it); excuse rate is shown
// alongside so a low number reads as explained, not hidden. Parents ALWAYS ship
// with a per-child breakdown — it's the default, not a drill-down.

import type { AdherenceFinding } from '@tracker/shared'
import { formatPercent } from '../../lib/stats-presentation'

type Props = {
  finding: AdherenceFinding
  // itemId -> display name, for the parent's per-child breakdown rows.
  childNames?: Record<string, string>
}

export function AdherenceCard({ finding, childNames = {} }: Props) {
  const isParent = finding.type === 'parent_adherence'
  const headline = isParent ? finding.meanDerivedPercent : finding.rawAdherence
  const secondary = isParent ? finding.meanDerivedExclExcused : finding.adherenceExclExcused
  const misses = !isParent ? finding.rawCounts.dueCount - finding.rawCounts.completedCount : null
  const excusedCount = finding.rawCounts.excusedCount

  return (
    <div className="adherence-card" data-testid="adherence-card">
      <div className="adherence-card__headline">
        <span className="adherence-card__pct" data-testid="adherence-headline">{formatPercent(headline)}</span>
        <span className="adherence-card__label">adherence (raw, including excused)</span>
      </div>

      <div className="adherence-card__secondary" data-testid="adherence-secondary">
        Excluding excused: {formatPercent(secondary)}
        {!isParent && misses !== null && misses > 0 && (
          <> — excused {excusedCount} of {misses} miss{misses === 1 ? '' : 'es'}</>
        )}
        {isParent && <> — excuse rate {formatPercent(finding.excuseRate)}</>}
      </div>

      {isParent && (
        <div className="adherence-card__children" data-testid="adherence-children">
          <div className="adherence-card__children-title">Per-child breakdown</div>
          {finding.children.map((child) => (
            <div
              key={child.itemId}
              className="adherence-card__child-row"
              data-testid={`adherence-child-${child.itemId}`}
            >
              <span className="adherence-card__child-name">{childNames[child.itemId] ?? 'Untitled'}</span>
              <span className="adherence-card__child-pct">{formatPercent(child.rawAdherence)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
