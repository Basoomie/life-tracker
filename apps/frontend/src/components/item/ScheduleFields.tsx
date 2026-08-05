// §5.5 — the editable fields of ONE schedule (slot): its recurrence rule, its anchor,
// and its timing.
//
// Extracted from ItemFormModal so the same markup serves the item's first slot and
// every slot added after it — one definition, not one per position.
//
// Test ids are parameterised by `idPrefix`. The first slot passes 'if-', which
// reproduces the ids this form has always used (`if-rec-daily`, `if-timing-point`, …);
// additional slots pass 'if-slot-N-'. That keeps the single-slot case — the common one —
// byte-identical in the DOM as well as on screen.

import type { Bucket, ItemSchedule, RecurrenceRule, TimingPrecision } from '@tracker/shared'

export type RecurrenceType = 'daily' | 'days_of_week' | 'interval_day' | 'interval_week' | 'monthly'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// One slot as the form holds it: strings and widget-shaped values, converted to and
// from the API's RecurrenceRule at the edges.
export type SlotDraft = {
  key: string                 // stable React key for the row
  scheduleId: string | null   // null = added in this session, not yet saved
  label: string
  recType: RecurrenceType
  recDays: number[]
  recEvery: number
  anchorDay: string
  timingPrecision: TimingPrecision
  timingBucketId: string | null
  timingStartTime: string
  timingEndTime: string
  plannedDurationMin: string
}

let draftSeq = 0

export function emptySlot(anchorDay: string, defaultBucketId: string | null): SlotDraft {
  return {
    key: `new-${draftSeq++}`,
    scheduleId: null,
    label: '',
    recType: 'daily',
    recDays: [],
    recEvery: 2,
    anchorDay,
    timingPrecision: 'none',
    timingBucketId: defaultBucketId,
    timingStartTime: '',
    timingEndTime: '',
    plannedDurationMin: '',
  }
}

export function buildRecurrenceRule(slot: SlotDraft): RecurrenceRule {
  if (slot.recType === 'daily')         return { type: 'daily' }
  if (slot.recType === 'days_of_week')  return { type: 'days_of_week', days: [...slot.recDays].sort((a, b) => a - b) }
  if (slot.recType === 'interval_day')  return { type: 'interval', unit: 'day', every: slot.recEvery }
  if (slot.recType === 'interval_week') return { type: 'interval', unit: 'week', every: slot.recEvery }
  return { type: 'monthly' }
}

export function recTypeFromRule(rule: RecurrenceRule): RecurrenceType {
  if (rule.type === 'daily')        return 'daily'
  if (rule.type === 'days_of_week') return 'days_of_week'
  if (rule.type === 'monthly')      return 'monthly'
  if (rule.type === 'interval')     return rule.unit === 'day' ? 'interval_day' : 'interval_week'
  return 'daily'
}

/** Turn a saved schedule into the draft the form edits. */
export function slotFromSchedule(schedule: ItemSchedule, fallbackAnchor: string): SlotDraft {
  const base = emptySlot(fallbackAnchor, schedule.timingBucketId)
  return {
    ...base,
    key: schedule.id,
    scheduleId: schedule.id,
    label: schedule.label ?? '',
    recType: schedule.recurrenceRule ? recTypeFromRule(schedule.recurrenceRule) : 'daily',
    recDays: schedule.recurrenceRule?.type === 'days_of_week' ? schedule.recurrenceRule.days : [],
    recEvery: schedule.recurrenceRule?.type === 'interval' ? schedule.recurrenceRule.every : 2,
    // §5.1 — matches scheduleAnchorDate()'s UTC fallback for slots with no explicit anchor.
    anchorDay: schedule.anchorDay ?? fallbackAnchor,
    timingPrecision: schedule.timingPrecision,
    timingBucketId: schedule.timingBucketId,
    timingStartTime: (schedule.timingStartTime ?? '').slice(0, 5),
    timingEndTime: (schedule.timingEndTime ?? '').slice(0, 5),
    plannedDurationMin: schedule.plannedDurationMin?.toString() ?? '',
  }
}

/** The timing/duration half of a slot, as the API expects it. */
export function slotTimingBody(slot: SlotDraft) {
  // §6.8 — a range implies its duration; don't ask twice.
  const dur = parseInt(slot.plannedDurationMin, 10)
  return {
    timingPrecision: slot.timingPrecision,
    timingBucketId: slot.timingPrecision === 'bucket' ? (slot.timingBucketId || null) : null,
    timingStartTime: (slot.timingPrecision === 'point' || slot.timingPrecision === 'range')
      ? (slot.timingStartTime || null) : null,
    timingEndTime: slot.timingPrecision === 'range' ? (slot.timingEndTime || null) : null,
    plannedDurationMin: slot.timingPrecision === 'range'
      ? null : (isNaN(dur) || dur <= 0 ? null : dur),
  }
}

type Props = {
  slot: SlotDraft
  /** Test-id / DOM-id prefix. 'if-' for the first slot; 'if-slot-N-' for the rest. */
  idPrefix: string
  /** One-time items have no recurrence rule, so the rule builder is hidden. */
  showRecurrence: boolean
  /** Additional slots can be labelled and removed; the first cannot. */
  showLabel: boolean
  buckets: Bucket[]
  onChange: (patch: Partial<SlotDraft>) => void
}

export function ScheduleFields({
  slot, idPrefix, showRecurrence, showLabel, buckets, onChange,
}: Props) {
  const id = (suffix: string) => `${idPrefix}${suffix}`

  return (
    <>
      {showLabel && (
        <div className="field" style={{ maxWidth: 260 }}>
          <label className="field__label" htmlFor={id('label')}>Label (optional)</label>
          <input
            id={id('label')}
            className="field__input"
            type="text"
            placeholder="e.g. Morning block"
            value={slot.label}
            onChange={(e) => onChange({ label: e.target.value })}
            data-testid={id('label')}
          />
        </div>
      )}

      {/* Recurrence is hidden for a one-time task — it happens once, on a chosen day.
          The wrapper carries the test id so "is the recurrence builder showing?" stays
          answerable per slot. */}
      {showRecurrence && (
        <div className="form-subsection" data-testid={id('recurrence-section')}>
          <div className="form-section__label">Repeats (§5.1)</div>

          <div className="field" style={{ maxWidth: 200 }}>
            <label className="field__label" htmlFor={id('anchor-day')}>Starts on</label>
            <input
              id={id('anchor-day')}
              className="field__input"
              type="date"
              value={slot.anchorDay}
              onChange={(e) => onChange({ anchorDay: e.target.value })}
              data-testid={id('anchor-day')}
            />
          </div>

          <div className="qa-radio-group qa-radio-group--wrap">
            {([
              ['daily',         'Every day'],
              ['days_of_week',  'Specific days'],
              ['interval_day',  'Every N days'],
              ['interval_week', 'Every N weeks'],
              ['monthly',       'Monthly'],
            ] as [RecurrenceType, string][]).map(([val, label]) => (
              <label
                key={val}
                data-testid={id(`rec-${val}`)}
                className={`qa-radio${slot.recType === val ? ' qa-radio--active' : ''}`}
              >
                <input
                  type="radio"
                  name={id('rec-type')}
                  value={val}
                  checked={slot.recType === val}
                  onChange={() => onChange({ recType: val })}
                  className="sr-only"
                />
                {label}
              </label>
            ))}
          </div>

          {slot.recType === 'days_of_week' && (
            <div className="day-picker" data-testid={id('days-of-week')}>
              {DAY_LABELS.map((d, i) => (
                <label
                  key={i}
                  data-testid={id(`day-${d.toLowerCase()}`)}
                  className={`day-chip${slot.recDays.includes(i) ? ' day-chip--active' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={slot.recDays.includes(i)}
                    onChange={() =>
                      onChange({
                        recDays: slot.recDays.includes(i)
                          ? slot.recDays.filter((x) => x !== i)
                          : [...slot.recDays, i],
                      })
                    }
                    className="sr-only"
                  />
                  {d}
                </label>
              ))}
            </div>
          )}

          {(slot.recType === 'interval_day' || slot.recType === 'interval_week') && (
            <div className="field" style={{ maxWidth: 180 }}>
              <label className="field__label" htmlFor={id('rec-every')}>
                Every N {slot.recType === 'interval_day' ? 'days' : 'weeks'}
              </label>
              <input
                id={id('rec-every')}
                className="field__input"
                type="number"
                min="2"
                value={slot.recEvery}
                onChange={(e) =>
                  onChange({ recEvery: Math.max(2, parseInt(e.target.value, 10) || 2) })
                }
                data-testid={id('rec-every')}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Timing precision (§6.5) — applies to one-time tasks too ─────────── */}
      <div className="form-section__label">Timing (§6.5)</div>
      <div className="qa-radio-group qa-radio-group--wrap" data-testid={id('timing-group')}>
        {([
          ['none',   'None'],
          ['bucket', 'Bucket'],
          ['point',  'Clock time'],
          ['range',  'Range'],
        ] as [TimingPrecision, string][]).map(([val, label]) => (
          <label
            key={val}
            data-testid={id(`timing-${val}`)}
            className={`qa-radio${slot.timingPrecision === val ? ' qa-radio--active' : ''}`}
          >
            <input
              type="radio"
              name={id('timing')}
              value={val}
              checked={slot.timingPrecision === val}
              onChange={() => onChange({ timingPrecision: val })}
              className="sr-only"
            />
            {label}
          </label>
        ))}
      </div>

      {slot.timingPrecision === 'bucket' && (
        <div className="field form-subsection">
          <label className="field__label" htmlFor={id('bucket')}>Bucket (§6.6)</label>
          <select
            id={id('bucket')}
            className="field__select"
            value={slot.timingBucketId ?? ''}
            onChange={(e) => onChange({ timingBucketId: e.target.value || null })}
            data-testid={id('bucket')}
          >
            <option value="">— none —</option>
            {buckets.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      )}

      {(slot.timingPrecision === 'point' || slot.timingPrecision === 'range') && (
        <div className="form-row form-subsection">
          <div className="field">
            <label className="field__label" htmlFor={id('start-time')}>Start time</label>
            <input
              id={id('start-time')}
              className="field__input"
              type="time"
              value={slot.timingStartTime}
              onChange={(e) => onChange({ timingStartTime: e.target.value })}
              data-testid={id('start-time')}
            />
          </div>
          {slot.timingPrecision === 'range' && (
            <div className="field">
              <label className="field__label" htmlFor={id('end-time')}>End time</label>
              <input
                id={id('end-time')}
                className="field__input"
                type="time"
                value={slot.timingEndTime}
                onChange={(e) => onChange({ timingEndTime: e.target.value })}
                data-testid={id('end-time')}
              />
            </div>
          )}
        </div>
      )}

      {/* §6.8 — planned duration: hidden for range (it's implied by the range) */}
      {slot.timingPrecision !== 'range' && (
        <div
          className="field form-subsection"
          style={{ maxWidth: 220 }}
          data-testid={id('duration-section')}
        >
          <label className="field__label" htmlFor={id('duration')}>
            Planned duration (min, optional)
          </label>
          <input
            id={id('duration')}
            className="field__input"
            type="number"
            min="1"
            placeholder="e.g. 30"
            value={slot.plannedDurationMin}
            onChange={(e) => onChange({ plannedDurationMin: e.target.value })}
            data-testid={id('duration')}
          />
        </div>
      )}
    </>
  )
}
