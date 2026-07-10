// v2 §9.5's governing presentation rule, given one shared shell so every Layer 2
// finding gets it uniformly:
//   - a finding must LOOK as uncertain as it IS (power visibly ships with the card,
//     never hover-only; low power is visually de-emphasized via a data attribute
//     AND a class, not merely a tooltip)
//   - a null result can never render bare — MDE and Layer 1.5 data-quality context
//     are structurally part of this shell, not an optional add-on
//   - estimator + raw counts always shown

import type { ReactNode } from 'react'
import type { DataQualityFinding } from '@tracker/shared'
import { powerTier, type PresentedSufficiency } from '../../lib/stats-presentation'
import { SufficiencyBadge } from './SufficiencyBadge'
import { PowerMeter } from './PowerMeter'
import { DataQualityStrip } from './DataQualityStrip'

function humanizeKey(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim()
}

function RawCountsStrip({ counts }: { counts: Record<string, number> }) {
  return (
    <div className="finding-card__raw-counts" data-testid="finding-raw-counts">
      {Object.entries(counts).map(([k, v]) => (
        <span key={k} className="finding-card__raw-count">{humanizeKey(k)}: {v}</span>
      ))}
    </div>
  )
}

type Props = {
  testId: string
  title: string
  estimatorLabel: string
  sufficiency: PresentedSufficiency
  power: number
  dataQuality: DataQualityFinding
  rawCounts: Record<string, number>
  // True when the finding IS computable but found no effect distinguishable from
  // noise — the case §4.1 says must never render as a bare null.
  isNull?: boolean
  minimumDetectableEffect?: number | null
  // Pre-formatted by the caller (each finding type's units/labels differ) —
  // e.g. "Effect size (d): 0.42". Shown regardless of null/non-null.
  effectSizeLabel?: string
  children?: ReactNode
}

export function FindingShell({
  testId, title, estimatorLabel, sufficiency, power, dataQuality, rawCounts,
  isNull, minimumDetectableEffect, effectSizeLabel, children,
}: Props) {
  const tier = powerTier(power)

  return (
    <div
      className={`finding-card finding-card--${tier}`}
      data-testid={testId}
      data-power-tier={tier}
    >
      <div className="finding-card__header">
        <h4 className="finding-card__title">{title}</h4>
        <span className="finding-card__estimator" data-testid={`${testId}-estimator`}>{estimatorLabel}</span>
      </div>

      <SufficiencyBadge sufficiency={sufficiency} />

      {sufficiency.kind === 'reported' && (
        <div className="finding-card__body">
          <PowerMeter power={power} />

          {effectSizeLabel && <div className="finding-card__effect">{effectSizeLabel}</div>}

          {isNull && (
            <p className="finding-card__null-narrative" data-testid={`${testId}-null`}>
              No effect detected
              {minimumDetectableEffect != null
                ? `; we could have detected a difference of ${minimumDetectableEffect.toFixed(2)} or larger.`
                : '.'}
            </p>
          )}

          {children}

          <DataQualityStrip quality={dataQuality} variant="compact" />
          <RawCountsStrip counts={rawCounts} />
        </div>
      )}
    </div>
  )
}
