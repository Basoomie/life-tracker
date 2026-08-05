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

  // §5.5 — an item with several schedules is due more than once on some days. The
  // rate above is over DAYS and treats a part-done day as a miss, so the slot counts
  // are shown whenever they differ: "1 of 2 blocks" must not read as nothing done.
  const slots = !isParent ? finding.rawCounts : null
  const showSlots = slots !== null && slots.slotsDue !== slots.dueCount

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

      {showSlots && !isParent && (
        <div className="adherence-card__secondary" data-testid="adherence-slots">
          {formatPercent(finding.slotAdherence)} of scheduled blocks
          — {slots.slotsCompleted} of {slots.slotsDue} done
          across {slots.dueCount} day{slots.dueCount === 1 ? '' : 's'}
        </div>
      )}

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
