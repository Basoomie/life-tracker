// §4c-ii — Full-edit form: the complete item configuration with progressive disclosure.
// Edit mode: same form pre-populated; changes are forward-only (§5.3).

import { useState, useEffect, useRef } from 'react'
import type { Category, Bucket, Item, ItemPrerequisite, ItemWithSchedules } from '@tracker/shared'
import { isRecurringItem } from '@tracker/shared'
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
import { todayStr } from '../../lib/date-range'
import {
  ScheduleFields,
  emptySlot,
  slotFromSchedule,
  buildRecurrenceRule,
  slotTimingBody,
  describeSchedules,
  type SlotDraft,
} from './ScheduleFields'

type Props = {
  itemId: string | null   // null = create mode
  categories: Category[]
  buckets: Bucket[]
  onSaved: (item: Item) => void
  onClose: () => void
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

  // §5.5 — the item's schedules (slots). Always at least one: an item with no slot
  // has no "when". Slot 0 is the item's first slot, created with the item itself;
  // the rest are managed through the schedule routes.
  const [slots, setSlots] = useState<SlotDraft[]>(
    () => [emptySlot(todayStr(), buckets[0]?.id ?? null)]
  )
  // Saved slots the user removed in this session; archived on submit (§5.5).
  const [removedScheduleIds, setRemovedScheduleIds] = useState<string[]>([])
  // §5.5 — a parent carries at most one slot, so "+ Add another time" is unavailable
  // for an item that has children.
  const [hasChildren, setHasChildren] = useState(false)

  // Quota (item-level, across all slots — §5.2)
  const [quotaEnabled, setQuotaEnabled] = useState(false)
  const [quotaCount, setQuotaCount] = useState(3)
  const [quotaPeriod, setQuotaPeriod] = useState<'week' | 'month'>('week')

  // One-time day
  const [day, setDay] = useState(todayStr)

  // Relationships
  const [allItems, setAllItems] = useState<ItemWithSchedules[]>([])
  const [selectedPrereqIds, setSelectedPrereqIds] = useState<string[]>([])
  const [initialPrereqIds, setInitialPrereqIds] = useState<string[]>([])
  const [parentId, setParentId] = useState<string | null>(null)

  // Disposition — §8.1 default: one-time tasks default to 'require_manual' (a
  // missed one-off usually means "haven't gotten to it," not "choosing to skip
  // it"); recurring habits keep the spec's stated default of 'skip'. Matches
  // the backend default in routes/items.ts. `dispositionTouched` tracks whether
  // the user has manually picked a value, so toggling Type in create mode can
  // keep swapping the default without ever clobbering an explicit choice.
  const [dispositionPolicy, setDispositionPolicy] = useState<DispositionPolicy>('require_manual')
  const [dispositionTouched, setDispositionTouched] = useState(false)

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
        // §5.5 — recurrence and timing live on the item's schedules; the form edits
        // them as a list. "Recurring" is an item-level choice: any slot with a rule.
        // Matches scheduleAnchorDate()'s UTC fallback for slots with no explicit anchor.
        const fallbackAnchor = new Date(data.createdAt).toISOString().slice(0, 10)
        setIsRecurring(isRecurringItem(data.schedules))
        setSlots(
          data.schedules.length > 0
            ? data.schedules.map((s) => slotFromSchedule(s, fallbackAnchor))
            : [emptySlot(fallbackAnchor, buckets[0]?.id ?? null)]
        )
        setHasChildren(data.children.length > 0)
        if (data.quotaTarget) {
          setQuotaEnabled(true)
          setQuotaCount(data.quotaTarget.count)
          setQuotaPeriod(data.quotaTarget.period)
        }
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

  // Prerequisites: non-habit tasks only (§4.2); exclude self and archived.
  // §5.5 — "is a habit" means any slot recurs; isRecurringItem is the shared rule the
  // server enforces, so the picker can't offer something the API would reject.
  const prereqCandidates = allItems.filter(
    (it) => !isRecurringItem(it.schedules) && it.id !== itemId && !it.archivedAt
  )

  // Parents: any non-archived item except self
  const parentCandidates = allItems.filter(
    (it) => it.id !== itemId && !it.archivedAt
  )

  // §4.1 — the selected parent, for the read-only schedule caption below the
  // picker. May be absent while allItems is still loading.
  const selectedParent = parentId
    ? parentCandidates.find((it) => it.id === parentId) ?? null
    : null

  // §8.1 — switching Type in create mode re-defaults the disposition policy
  // (skip for recurring, require_manual for one-time), unless the user already
  // picked one explicitly. Edit mode never touches this — dispositionPolicy
  // there reflects the item's saved config, loaded once above.
  function handleTypeChange(recurring: boolean) {
    setIsRecurring(recurring)
    if (!isEdit && !dispositionTouched) {
      setDispositionPolicy(recurring ? 'skip' : 'require_manual')
    }
  }

  // ── §5.5 Slot editing ──────────────────────────────────────────────────────

  function patchSlot(index: number, patch: Partial<SlotDraft>) {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  function addSlot() {
    setSlots((prev) => [...prev, emptySlot(todayStr(), buckets[0]?.id ?? null)])
  }

  function removeSlot(index: number) {
    setSlots((prev) => {
      const slot = prev[index]
      // A saved slot is archived on submit, not deleted now — removal is forward-only
      // and its past occurrences must survive (§5.5).
      if (slot.scheduleId) setRemovedScheduleIds((ids) => [...ids, slot.scheduleId!])
      return prev.filter((_, i) => i !== index)
    })
  }

  // §5.5 — only recurring items can carry several slots (a one-time task happens
  // once), and a parent carries at most one so its children stay unambiguous.
  const canAddSlot = isRecurring && !hasChildren

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
      const quotaTarget: QuotaTarget | null =
        isRecurring && quotaEnabled ? { count: quotaCount, period: quotaPeriod } : null

      // Everything that describes the habit rather than one of its slots (§5.5).
      const itemFields = {
        name: name.trim(),
        description: description.trim() || null,
        categoryId: categoryId || null,
        valence: (valence as Valence) || null,
        priority: (priority as Priority) || null,
        quotaTarget,
        parentId: parentId || null,
        dispositionPolicy,
      }

      const ruleFor = (slot: SlotDraft): RecurrenceRule | null =>
        isRecurring ? buildRecurrenceRule(slot) : null

      let savedItem: Item
      if (isEdit) {
        // §5.5 — item fields only. Slot fields go through the schedule routes below,
        // uniformly for one slot or several, so there is one code path either way.
        savedItem = await api.items.update(itemId!, itemFields as UpdateItemBody)
      } else {
        // The item and its FIRST slot are created together; the rest are added after.
        const createBody: CreateItemBody = {
          ...itemFields,
          recurrenceRule: ruleFor(slots[0]),
          anchorDay: isRecurring ? slots[0].anchorDay : undefined,
          ...slotTimingBody(slots[0]),
          creationSource: 'planned',
          ...(!isRecurring && { day }),
        }
        savedItem = await api.items.create(createBody)
      }

      // ── §5.5 Sync schedules ────────────────────────────────────────────────
      // Same diff-and-apply shape as the prerequisite sync below.
      const itemIdForSlots = savedItem.id
      for (const scheduleId of removedScheduleIds) {
        await api.items.schedules.remove(itemIdForSlots, scheduleId)
      }
      for (const [index, slot] of slots.entries()) {
        const body = {
          label: slot.label.trim() || null,
          recurrenceRule: ruleFor(slot),
          anchorDay: isRecurring ? slot.anchorDay : null,
          ...slotTimingBody(slot),
        }
        if (slot.scheduleId) {
          await api.items.schedules.update(itemIdForSlots, slot.scheduleId, body)
        } else if (isEdit || index > 0) {
          // On create, slot 0 was already written by POST /items above.
          await api.items.schedules.add(itemIdForSlots, body)
        }
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
                    onChange={() => handleTypeChange(false)}
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
                    onChange={() => handleTypeChange(true)}
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

              {/* §5.5 — the item's schedules (slots). One is the common case and looks
                  exactly as it always has; "+ Add another time" reveals the rest. */}
              {slots.map((slot, i) => (
                <div
                  key={slot.key}
                  className={i > 0 ? 'form-subsection form-slot' : 'form-subsection'}
                  data-testid={`if-slot-${i}`}
                >
                  {i > 0 && (
                    <div className="form-slot__header">
                      <span className="form-section__label">Time {i + 1}</span>
                      <button
                        type="button"
                        className="form-slot__remove"
                        onClick={() => removeSlot(i)}
                        data-testid={`if-remove-schedule-${i}`}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                  <ScheduleFields
                    slot={slot}
                    idPrefix={i === 0 ? 'if-' : `if-slot-${i}-`}
                    showRecurrence={isRecurring}
                    showLabel={i > 0}
                    buckets={buckets}
                    onChange={(patch) => patchSlot(i, patch)}
                  />
                </div>
              ))}

              {canAddSlot && (
                <button
                  type="button"
                  className="form-add-slot"
                  onClick={addSlot}
                  data-testid="if-add-schedule"
                >
                  + Add another time
                </button>
              )}

              {/* §5.5 — a parent carries at most one slot, so its children always have
                  an unambiguous slot to belong to. Explained rather than silently absent. */}
              {isRecurring && hasChildren && (
                <p className="form-note" data-testid="if-add-schedule-blocked">
                  This item has sub-items, so it can only have one time (§5.5) — a parent
                  with two times a day leaves no defined answer for which one a sub-item
                  belongs to.
                </p>
              )}

              {/* Quota target (§5.2) — an item-level target ACROSS all its slots,
                  which is why it sits outside the per-slot fields. */}
              {isRecurring && (
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
                    {/* The parent's own schedule, read-only. A child due on a day
                        its parent isn't is legal (§4.1 — each node has its own
                        recurrence) but is usually a mismatched anchor day, and
                        finding out meant opening the parent — which isn't
                        reachable at all unless it happens to be due on a day
                        you're looking at. The answer is cheap to show here:
                        parentCandidates already carries every item's slots. */}
                    {selectedParent && (
                      <p className="field__caption" data-testid="if-parent-schedule">
                        {selectedParent.name} · {describeSchedules(
                          selectedParent.schedules,
                          new Date(selectedParent.createdAt).toISOString().slice(0, 10)
                        )}
                      </p>
                    )}
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
                          onClick={() => { setDispositionPolicy(val); setDispositionTouched(true) }}
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
