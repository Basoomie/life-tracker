// §7 — Reusable category select; filters out archived entries client-side.
// Used in AdHocModal, item forms, and anywhere a category must be chosen.

import type { Category } from '@tracker/shared'

type Props = {
  value: string | null
  onChange: (id: string | null) => void
  categories: Category[]
  id?: string
  testId?: string
  placeholder?: string
}

export function CategoryPicker({
  value,
  onChange,
  categories,
  id,
  testId,
  placeholder = 'None',
}: Props) {
  const active = categories.filter((c) => !c.archivedAt)
  return (
    <select
      id={id}
      className="field__select"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      data-testid={testId}
    >
      <option value="">{placeholder}</option>
      {active.map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </select>
  )
}
