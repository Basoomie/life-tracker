// v2 §9.5 presentation rule — "power travels with the number, always visible —
// never a hover-only detail." The percentage is a visible text node (not a title/
// aria-label), and low power carries a distinguishing class + data attribute, not
// merely a different color a screenshot diff might miss.

import { powerTier } from '../../lib/stats-presentation'

type Props = { power: number }

export function PowerMeter({ power }: Props) {
  const tier = powerTier(power)
  const pct = Math.max(0, Math.min(100, Math.round(power * 100)))

  return (
    <div className={`power-meter power-meter--${tier}`} data-testid="power-meter" data-power-tier={tier}>
      <div className="power-meter__track">
        <div className="power-meter__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="power-meter__label">
        {pct}% power{tier === 'weak' ? ' — weak signal' : ''}
      </span>
    </div>
  )
}
