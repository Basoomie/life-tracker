// v2 §4 Layer 1.5 — data quality is fact, never gated, and is the interpretive
// lens every Layer 2 finding must be read through (§4.3). Used both standalone
// (the item/global "logging health" panel) and embedded in every FindingShell,
// so a null result can never render without this context beside it.

import type { DataQualityFinding } from '@tracker/shared'
import { formatPercent } from '../../lib/stats-presentation'

type Props = { quality: DataQualityFinding; variant?: 'compact' | 'full' }

export function DataQualityStrip({ quality, variant = 'compact' }: Props) {
  return (
    <div className={`dq-strip dq-strip--${variant}`} data-testid="data-quality-strip">
      <span className="dq-strip__item">
        Logged {formatPercent(quality.dispositionCoverage.rate)} of due days
        {quality.dispositionCoverage.missingRate > 0
          ? ` (${formatPercent(quality.dispositionCoverage.missingRate)} missing)`
          : ''}
      </span>

      {quality.backfillLateness && (
        <span className="dq-strip__item">
          Backfilled {quality.backfillLateness.count}× — median {quality.backfillLateness.medianLagDays}d late
        </span>
      )}

      {variant === 'full' && quality.declaredOverrideFrequency !== null && (
        <span className="dq-strip__item">
          Manual override on {formatPercent(quality.declaredOverrideFrequency)} of days
        </span>
      )}

      {variant === 'full' && quality.timeTrackingGap && (
        <span className="dq-strip__item">
          Time tracked for {formatPercent(quality.timeTrackingGap.coverageRate)} of planned-duration items
        </span>
      )}

      {quality.gapDays.length > 0 && (
        <span className="dq-strip__item dq-strip__item--warning">
          {quality.gapDays.length} gap day{quality.gapDays.length === 1 ? '' : 's'} with no record
        </span>
      )}
    </div>
  )
}
