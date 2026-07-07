// §7 / §8.3 — Reusable reason select; filters out archived entries client-side.
// Used in DispositionModal and anywhere a skip/excuse reason must be chosen.

import type { Reason } from '@tracker/shared'

type Props = {
  value: string | null
  onChange: (id: string | null) => void
  reasons: Reason[]
  id?: string
  testId?: string
  placeholder?: string
}

export function ReasonPicker({
  value,
  onChange,
  reasons,
  id,
  testId,
  placeholder = 'None',
}: Props) {
  const active = reasons.filter((r) => !r.archivedAt)
  return (
    <select
      id={id}
      className="field__select"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      data-testid={testId}
    >
      <option value="">{placeholder}</option>
      {active.map((r) => (
        <option key={r.id} value={r.id}>{r.name}</option>
      ))}
    </select>
  )
}
