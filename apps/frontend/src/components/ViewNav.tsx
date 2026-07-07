// Tab navigation between Now / List / Calendar views.

export type ViewKey = 'now' | 'list' | 'calendar'

type Props = {
  active: ViewKey
  onChange: (v: ViewKey) => void
}

const TABS: { key: ViewKey; label: string }[] = [
  { key: 'now',      label: 'Now' },
  { key: 'list',     label: 'List' },
  { key: 'calendar', label: 'Calendar' },
]

export function ViewNav({ active, onChange }: Props) {
  return (
    <nav className="view-nav" aria-label="Views">
      {TABS.map(({ key, label }) => (
        <button
          key={key}
          className={`view-nav__tab${active === key ? ' view-nav__tab--active' : ''}`}
          onClick={() => onChange(key)}
          aria-current={active === key ? 'page' : undefined}
          data-testid={`view-nav-${key}`}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}
