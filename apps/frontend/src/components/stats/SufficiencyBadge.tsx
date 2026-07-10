// v2 §9.5.1 — the three sufficiency states must render distinctly: reported /
// "not yet" with progress / "not detectable for this recurrence" as a permanent,
// honestly-terminal state (never presented as still accumulating).

import type { PresentedSufficiency } from '../../lib/stats-presentation'

type Props = { sufficiency: PresentedSufficiency }

export function SufficiencyBadge({ sufficiency }: Props) {
  if (sufficiency.kind === 'reported') {
    return (
      <span className="sufficiency-badge sufficiency-badge--reported" data-testid="sufficiency-reported">
        Reported
      </span>
    )
  }

  if (sufficiency.kind === 'not_yet') {
    const more = Math.max(0, sufficiency.nNeeded - sufficiency.nObserved)
    return (
      <div className="sufficiency-badge sufficiency-badge--not-yet" data-testid="sufficiency-not-yet">
        <span className="sufficiency-badge__tag">Not yet</span>
        <span className="sufficiency-badge__detail">
          Needs {more} more observation{more === 1 ? '' : 's'} ({sufficiency.nObserved} of {sufficiency.nNeeded} so far)
        </span>
      </div>
    )
  }

  return (
    <div className="sufficiency-badge sufficiency-badge--not-applicable" data-testid="sufficiency-not-applicable">
      <span className="sufficiency-badge__tag">Not detectable for this recurrence</span>
      <span className="sufficiency-badge__detail">{sufficiency.reason}</span>
    </div>
  )
}
