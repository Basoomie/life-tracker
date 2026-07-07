import type { ReactNode } from 'react'

type Props = {
  tier: 'active' | 'imminent' | 'unscheduled'
  count: number
  emptyText: string
  children: ReactNode
}

const CONFIG = {
  active:      { label: 'Now',          icon: '●' },
  imminent:    { label: 'Coming up',    icon: '◎' },
  unscheduled: { label: 'Anytime today', icon: '○' },
}

export function TierSection({ tier, count, emptyText, children }: Props) {
  const { label, icon } = CONFIG[tier]
  return (
    <section className={`tier-section tier-section--${tier}`} data-testid={`tier-${tier}`}>
      <header className="tier-header">
        <span aria-hidden="true">{icon}</span>
        <span className="tier-label">{label}</span>
        <span className="tier-count">{count}</span>
      </header>
      {count === 0
        ? <p className="tier-empty">{emptyText}</p>
        : children}
    </section>
  )
}
