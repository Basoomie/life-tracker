// §4c-ii — Full-edit form: the complete item configuration with progressive disclosure.
// Edit mode: same form pre-populated; changes are forward-only (§5.3).

import { useState, useEffect, useRef } from 'react'
import type { Category, Bucket, Item, ItemPrerequisite } from '@tracker/shared'
import type {
  RecurrenceRule,
  QuotaTarget,
  TimingPrecision,
  DispositionPolicy,
  Valence,
  Priority,
  UpdateItemBody,
  CreateItemBody,
} from '@tracker/shared'
import { api } from '../../lib/api'
import { CategoryPicker } from '../shared/CategoryPicker'

type Props = {
  itemId: string | null   // null = create mode
  categories: Category[]
  buckets: Bucket[]
  onSaved: (item: Item) => void
  onClose: () => void
}

type RecurrenceType = 'daily' | 'days_of_week' | 'interval_day' | 'interval_week' | 'monthly'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function buildRecurrenceRule(
  recType: RecurrenceType,
  recDays: number[],
  recEvery: number,
): RecurrenceRule {
  if (recType === 'daily')        return { type: 'daily' }
  if (recType === 'days_of_week') return { type: 'days_of_week', days: [...recDays].sort((a, b) => a - b) }
  if (recType === 'interval_day') return { type: 'interval', unit: 'day', every: recEvery }
  if (recType === 'interval_week') return { type: 'interval', unit: 'week', every: recEvery }
  return { type: 'monthly' }
}

function recTypeFromRule(rule: RecurrenceRule): RecurrenceType {
  if (rule.type === 'daily')        return 'daily'
  if (rule.type === 'days_of_week') return 'days_of_week'
  if (rule.type === 'monthly')      return 'monthly'
  if (rule.type === 'interval')     return rule.unit === 'day' ? 'interval_day' : 'interval_week'
  return 'daily'
}

export function ItemFormModal({ itemId, categories, buckets, onSaved, onClose }: Props) {
  // Core
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [valence, setValence] = useState<Valence | ''>('')
  const [priority, setPriority] = useState<Priority | ''>('')

  // Type
  const [isRecurring, setIsRecurring] = useState(false)

  // Recurrence rule
  const [recType, setRecType] = useState<RecurrenceType>('daily')
  const [recDays, setRecDays] = useState<number[]>([])       // for days_of_week
  const [recEvery, setRecEvery] = useState(2)                // for interval

  // Quota
  const [quotaEnabled, setQuotaEnabled] = useState(false)
  const [quotaCount, setQuotaCount] = useState(3)
  const [quotaPeriod, setQuotaPeriod] = useState<'week' | 'month'>('week')

  // Timing
  const [timingPrecision, setTimingPrecision] = useState<TimingPrecision>('none')
  const [timingBucketId, setTimingBucketId] = useState<string | null>(buckets[0]?.id ?? null)
  const [timingStartTime, setTimingStartTime] = useState('')
  const [timingEndTime, setTimingEndTime] = useState('')
  const [plannedDurationMin, setPlannedDurationMin] = useState('')

  // One-time day
  const [day, setDay] = useState(todayISO)

  // Relationships
  const [allItems, setAllItems] = useState<Item[]>([])
  const [selectedPrereqIds, setSelectedPrereqIds] = useState<string[]>([])
  const [initialPrereqIds, setInitialPrereqIds] = useState<string[]>([])
  const [parentId, setParentId] = useState<string | null>(null)

  // Disposition
  const [dispositionPolicy, setDispositionPolicy] = useState<DispositionPolicy>('skip')

  // UI
  const [loading, setLoading] = useState(itemId !== null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prereqError, setPrereqError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const nameRef = useRef<HTMLInputElement>(null)
  const isEdit = !!itemId

  // ── Load reference data + item (edit mode) ─────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const items = await api.items.list()
      setAllItems(items)

      if (itemId) {
        const data = await api.items.get(itemId)
        setName(data.name)
        setDescription(data.description ?? '')
        setCategoryId(data.categoryId)
        setValence(data.valence ?? '')
        setPriority(data.priority ?? '')
        setIsRecurring(!!data.recurrenceRule)
        if (data.recurrenceRule) {
          setRecType(recTypeFromRule(data.recurrenceRule))
          if (data.recurrenceRule.type === 'days_of_week') {
            setRecDays(data.recurrenceRule.days)
          }
          if (data.recurrenceRule.type === 'interval') {
            setRecEvery(data.recurrenceRule.every)
          }
        }
        if (data.quotaTarget) {
          setQuotaEnabled(true)
          setQuotaCount(data.quotaTarget.count)
          setQuotaPeriod(data.quotaTarget.period)
        }
        setTimingPrecision(data.timingPrecision)
        setTimingBucketId(data.timingBucketId)
        setTimingStartTime(data.timingStartTime ?? '')
        setTimingEndTime(data.timingEndTime ?? '')
        setPlannedDurationMin(data.plannedDurationMin?.toString() ?? '')
        setParentId(data.parentId)
        setDispositionPolicy(data.dispositionPolicy)
        const prereqIds = data.prerequisites.map((p: ItemPrerequisite) => p.prerequisiteId)
        setSelectedPrereqIds(prereqIds)
        setInitialPrereqIds(prereqIds)
      }
      setLoading(false)
    }
    init().catch(() => setLoading(false))
  }, [itemId])

  useEffect(() => {
    if (!loading) nameRef.current?.focus()
  }, [loading])

  // ── Derived lists ──────────────────────────────────────────────────────────

  // Prerequisites: non-habit tasks only (§4.2); exclude self and archived
  const prereqCandidates = allItems.filter(
    (it) => !it.recurrenceRule && it.id !== itemId && !it.archivedAt
  )

  // Parents: any non-archived item except self
  const parentCandidates = allItems.filter(
    (it) => it.id !== itemId && !it.archivedAt
  )

  function togglePrereq(id: string) {
    setSelectedPrereqIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
    setPrereqError(null)
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    setPrereqError(null)

    try {
      const recurrenceRule: RecurrenceRule | null = isRecurring
        ? buildRecurrenceRule(recType, recDays, recEvery)
        : null

      const quotaTarget: QuotaTarget | null =
        isRecurring && quotaEnabled ? { count: quotaCount, period: quotaPeriod } : null

      // §6.8 — range implies duration; don't ask twice
      const dur = parseInt(plannedDurationMin, 10)
      const resolvedDuration: number | null =
        timingPrecision === 'range' ? null : (isNaN(dur) || dur <= 0 ? null : dur)

      const baseBody = {
        name: name.trim(),
        description: description.trim() || null,
        categoryId: categoryId || null,
        valence: (valence as Valence) || null,
        priority: (priority as Priority) || null,
        recurrenceRule,
        quotaTarget,
        timingPrecision,
        timingBucketId: timingPrecision === 'bucket' ? (timingBucketId || null) : null,
        timingStartTime: (timingPrecision === 'point' || timingPrecision === 'range')
          ? (timingStartTime || null) : null,
        timingEndTime: timingPrecision === 'range' ? (timingEndTime || null) : null,
        plannedDurationMin: resolvedDuration,
        parentId: parentId || null,
        dispositionPolicy,
      }

      let savedItem: Item
      if (isEdit) {
        savedItem = await api.items.update(itemId!, baseBody as UpdateItemBody)
      } else {
        const createBody: CreateItemBody = {
          ...baseBody,
          creationSource: 'planned',
          ...(!isRecurring && { day }),
        }
        savedItem = await api.items.create(createBody)
      }

      // ── Sync prerequisites ─────────────────────────────────────────────────
      const targetId = savedItem.id
      if (isEdit) {
        const toRemove = initialPrereqIds.filter((id) => !selectedPrereqIds.includes(id))
        const toAdd = selectedPrereqIds.filter((id) => !initialPrereqIds.includes(id))
        for (const pid of toRemove) {
          await api.items.removePrerequisite(targetId, pid)
        }
        for (const pid of toAdd) {
          try {
            await api.items.addPrerequisite(targetId, pid)
          } catch (err) {
            setPrereqError(err instanceof Error ? err.message : 'Prerequisite error')
            setBusy(false)
            return
          }
        }
      } else {
        for (const pid of selectedPrereqIds) {
          try {
            await api.items.addPrerequisite(targetId, pid)
          } catch (err) {
            // Item was created; show the prereq error and let user close
            setPrereqError(
              `Item created, but a prerequisite could not be added: ${
                err instanceof Error ? err.message : 'error'
              }`
            )
            setBusy(false)
            return
          }
        }
      }

      onSaved(savedItem)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
      setBusy(false)
    }
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="modal-overlay" data-testid="item-form-modal">
        <div className="modal modal--wide">
          <div className="modal__body">
            <div className="now-view__loading">
              <span className="spinner" aria-hidden="true" />&ensp;Loading…
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Main form ──────────────────────────────────────────────────────────────
  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      data-testid="item-form-modal"
    >
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-labelledby="if-title">
        <div className="modal__header">
          <h2 className="modal__title" id="if-title">
            {isEdit ? 'Edit item' : 'New item'}
          </h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal__body modal__body--scroll">

            {/* Forward-only note in edit mode (§5.3) */}
            {isEdit && (
              <p className="form-note" data-testid="forward-only-note">
                Changes affect future occurrences only. Past and already-materialized occurrences are frozen.
              </p>
            )}

            {/* ── Core fields ───────────────────────────────────────── */}
            <div className="form-section">
              <div className="field">
                <label className="field__label" htmlFor="if-name">Name *</label>
                <input
                  id="if-name"
                  ref={nameRef}
                  className="field__input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  data-testid="if-name"
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="if-desc">Description</label>
                <textarea
                  id="if-desc"
                  className="field__textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional notes…"
                  data-testid="if-desc"
                />
              </div>

              <div className="form-row">
                <div className="field">
                  <label className="field__label" htmlFor="if-cat">Category</label>
                  <CategoryPicker
                    id="if-cat"
                    categories={categories}
                    value={categoryId}
                    onChange={setCategoryId}
                    testId="if-category"
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="if-valence">Valence</label>
                  <select
                    id="if-valence"
                    className="field__select"
                    value={valence}
                    onChange={(e) => setValence(e.target.value as Valence | '')}
                    data-testid="if-valence"
                  >
                    <option value="">— unset —</option>
                    <option value="productive">Productive</option>
                    <option value="neutral">Neutral</option>
                    <option value="unproductive">Unproductive</option>
                  </select>
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="if-priority">Priority</label>
                  <select
                    id="if-priority"
                    className="field__select"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as Priority | '')}
                    data-testid="if-priority"
                  >
                    <option value="">— unset —</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>
            </div>

            {/* ── Type: one-time vs recurring ───────────────────────── */}
            <div className="form-section">
              <div className="form-section__label">Type</div>
              <div className="qa-radio-group" data-testid="if-type-group">
                <label
                  data-testid="if-type-onetime"
                  className={`qa-radio${!isRecurring ? ' qa-radio--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="if-type"
                    value="one-time"
                    checked={!isRecurring}
                    onChange={() => setIsRecurring(false)}
                    className="sr-only"
                  />
                  One-time task
                </label>
                <label
                  data-testid="if-type-recurring"
                  className={`qa-radio${isRecurring ? ' qa-radio--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="if-type"
                    value="recurring"
                    checked={isRecurring}
                    onChange={() => setIsRecurring(true)}
                    className="sr-only"
                  />
                  Recurring habit
                </label>
              </div>

              {/* One-time: day picker */}
              {!isRecurring && (
                <div className="field form-subsection">
                  <label className="field__label" htmlFor="if-day">Due on</label>
                  <input
                    id="if-day"
                    className="field__input"
                    type="date"
                    value={day}
                    onChange={(e) => setDay(e.target.value)}
                    data-testid="if-day"
                    style={{ maxWidth: 200 }}
                  />
                </div>
              )}

              {/* Recurring: rule builder + quota */}
              {isRecurring && (
                <div className="form-subsection" data-testid="if-recurrence-section">
                  <div className="form-section__label">Schedule (§5.1)</div>

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
                        data-testid={`if-rec-${val}`}
                        className={`qa-radio${recType === val ? ' qa-radio--active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="if-rec-type"
                          value={val}
                          checked={recType === val}
                          onChange={() => setRecType(val)}
                          className="sr-only"
                        />
                        {label}
                      </label>
                    ))}
                  </div>

                  {/* Days-of-week picker */}
                  {recType === 'days_of_week' && (
                    <div className="day-picker" data-testid="if-days-of-week">
                      {DAY_LABELS.map((d, i) => (
                        <label
                          key={i}
                          data-testid={`if-day-${d.toLowerCase()}`}
                          className={`day-chip${recDays.includes(i) ? ' day-chip--active' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={recDays.includes(i)}
                            onChange={() =>
                              setRecDays((prev) =>
                                prev.includes(i)
                                  ? prev.filter((x) => x !== i)
                                  : [...prev, i]
                              )
                            }
                            className="sr-only"
                          />
                          {d}
                        </label>
                      ))}
                    </div>
                  )}

                  {/* Interval N picker */}
                  {(recType === 'interval_day' || recType === 'interval_week') && (
                    <div className="field" style={{ maxWidth: 180 }}>
                      <label className="field__label" htmlFor="if-rec-every">
                        Every N {recType === 'interval_day' ? 'days' : 'weeks'}
                      </label>
                      <input
                        id="if-rec-every"
                        className="field__input"
                        type="number"
                        min="2"
                        value={recEvery}
                        onChange={(e) =>
                          setRecEvery(Math.max(2, parseInt(e.target.value, 10) || 2))
                        }
                        data-testid="if-rec-every"
                      />
                    </div>
                  )}

                  {/* Quota target (§5.2) — only meaningful for recurring */}
                  <div style={{ marginTop: 'var(--space-3)' }} data-testid="if-quota-section">
                    <label className="form-checkbox-label">
                      <input
                        type="checkbox"
                        checked={quotaEnabled}
                        onChange={(e) => setQuotaEnabled(e.target.checked)}
                        data-testid="if-quota-enabled"
                      />
                      <span>Quota target (optional — §5.2)</span>
                    </label>
                    {quotaEnabled && (
                      <div className="form-row" style={{ marginTop: 'var(--space-2)' }} data-testid="if-quota-fields">
                        <div className="field" style={{ flex: '0 0 90px' }}>
                          <label className="field__label" htmlFor="if-quota-count">Times</label>
                          <input
                            id="if-quota-count"
                            className="field__input"
                            type="number"
                            min="1"
                            value={quotaCount}
                            onChange={(e) =>
                              setQuotaCount(Math.max(1, parseInt(e.target.value, 10) || 1))
                            }
                            data-testid="if-quota-count"
                          />
                        </div>
                        <div className="field">
                          <label className="field__label" htmlFor="if-quota-period">Per</label>
                          <select
                            id="if-quota-period"
                            className="field__select"
                            value={quotaPeriod}
                            onChange={(e) => setQuotaPeriod(e.target.value as 'week' | 'month')}
                            data-testid="if-quota-period"
                          >
                            <option value="week">Week</option>
                            <option value="month">Month</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── Timing precision (§6.5) ──────────────────────────── */}
            <div className="form-section">
              <div className="form-section__label">Timing (§6.5)</div>
              <div className="qa-radio-group qa-radio-group--wrap" data-testid="if-timing-group">
                {([
                  ['none',   'None'],
                  ['bucket', 'Bucket'],
                  ['point',  'Clock time'],
                  ['range',  'Range'],
                ] as [TimingPrecision, string][]).map(([val, label]) => (
                  <label
                    key={val}
                    data-testid={`if-timing-${val}`}
                    className={`qa-radio${timingPrecision === val ? ' qa-radio--active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="if-timing"
                      value={val}
                      checked={timingPrecision === val}
                      onChange={() => setTimingPrecision(val)}
                      className="sr-only"
                    />
                    {label}
                  </label>
                ))}
              </div>

              {timingPrecision === 'bucket' && (
                <div className="field form-subsection">
                  <label className="field__label" htmlFor="if-bucket">Bucket (§6.6)</label>
                  <select
                    id="if-bucket"
                    className="field__select"
                    value={timingBucketId ?? ''}
                    onChange={(e) => setTimingBucketId(e.target.value || null)}
                    data-testid="if-bucket"
                  >
                    <option value="">— none —</option>
                    {buckets.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {(timingPrecision === 'point' || timingPrecision === 'range') && (
                <div className="form-row form-subsection">
                  <div className="field">
                    <label className="field__label" htmlFor="if-start-time">Start time</label>
                    <input
                      id="if-start-time"
                      className="field__input"
                      type="time"
                      value={timingStartTime}
                      onChange={(e) => setTimingStartTime(e.target.value)}
                      data-testid="if-start-time"
                    />
                  </div>
                  {timingPrecision === 'range' && (
                    <div className="field">
                      <label className="field__label" htmlFor="if-end-time">End time</label>
                      <input
                        id="if-end-time"
                        className="field__input"
                        type="time"
                        value={timingEndTime}
                        onChange={(e) => setTimingEndTime(e.target.value)}
                        data-testid="if-end-time"
                      />
                    </div>
                  )}
                </div>
              )}

              {/* §6.8 — planned duration: hidden for range (it's implied by the range) */}
              {timingPrecision !== 'range' && (
                <div
                  className="field form-subsection"
                  style={{ maxWidth: 220 }}
                  data-testid="if-duration-section"
                >
                  <label className="field__label" htmlFor="if-duration">
                    Planned duration (min, optional)
                  </label>
                  <input
                    id="if-duration"
                    className="field__input"
                    type="number"
                    min="1"
                    placeholder="e.g. 30"
                    value={plannedDurationMin}
                    onChange={(e) => setPlannedDurationMin(e.target.value)}
                    data-testid="if-duration"
                  />
                </div>
              )}
            </div>

            {error && <p className="form-error">{error}</p>}
          </div>

          {/* Advanced section lives OUTSIDE the scroll body so the toggle button
              is never inside a scroll container — prevents Playwright click interception
              caused by the footer and scroll boundary coinciding at the same Y position. */}
          <div className="form-advanced">
            <button
              type="button"
              className="form-advanced__toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              data-testid="if-advanced-toggle"
              aria-expanded={showAdvanced}
            >
              Advanced options
            </button>

            {showAdvanced && (
              <div className="form-advanced__body">
                {/* Prerequisites (§4.2) */}
                <div className="form-section form-section--nested">
                  <div className="form-section__label">Prerequisites (§4.2 — task-to-task only; habits excluded)</div>
                  {prereqCandidates.length === 0 ? (
                    <p className="form-empty" data-testid="if-prereq-empty">
                      No eligible tasks yet.
                    </p>
                  ) : (
                    <div className="prereq-list" data-testid="if-prereq-list">
                      {prereqCandidates.map((it) => (
                        <label key={it.id} className="prereq-item">
                          <input
                            type="checkbox"
                            checked={selectedPrereqIds.includes(it.id)}
                            onChange={() => togglePrereq(it.id)}
                            data-testid={`prereq-${it.id}`}
                          />
                          <span>{it.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {prereqError && (
                    <p className="form-error" data-testid="prereq-error">{prereqError}</p>
                  )}
                </div>

                {/* Parent nesting (§4.1) */}
                <div className="form-section form-section--nested">
                  <div className="form-section__label">Parent item (§4.1 — makes this a child)</div>
                  <div className="field">
                    <label className="field__label" htmlFor="if-parent">Make child of</label>
                    <select
                      id="if-parent"
                      className="field__select"
                      value={parentId ?? ''}
                      onChange={(e) => setParentId(e.target.value || null)}
                      data-testid="if-parent"
                    >
                      <option value="">— top-level (no parent) —</option>
                      {parentCandidates.map((it) => (
                        <option key={it.id} value={it.id}>{it.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Disposition policy (§8.1) */}
                <div className="form-section form-section--nested">
                  <div className="form-section__label">End-of-day policy (§8.1)</div>
                  <div className="disp-options" data-testid="if-disposition-group">
                    {([
                      ['skip',           '✗', 'Skip',           'Counts as miss; breaks streak'],
                      ['excuse',         '∅', 'Excuse',         'Not counted against streak'],
                      ['auto_close',     '✓', 'Auto-close',     'Marks complete at child % automatically'],
                      ['require_manual', '!', 'Require manual', 'Stays pending until you act'],
                    ] as [DispositionPolicy, string, string, string][]).map(
                      ([val, icon, label, desc]) => (
                        <button
                          key={val}
                          type="button"
                          className={`disp-option${dispositionPolicy === val ? ' disp-option--selected' : ''}`}
                          onClick={() => setDispositionPolicy(val)}
                          data-testid={`if-disp-${val}`}
                        >
                          <span className="disp-option__icon">{icon}</span>
                          <div className="disp-option__body">
                            <div className="disp-option__name">{label}</div>
                            <div className="disp-option__desc">{desc}</div>
                          </div>
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="modal__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!name.trim() || busy}
              data-testid="if-submit"
            >
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
