import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'
import type { SessionState } from './TimerControl'
import { TimerControl } from './TimerControl'
import { formatTimingLabel } from '../../lib/now-ordering'
import { formatDayLabel } from '../../lib/date-range'

type Props = {
  occ: OccurrenceWithState
  buckets: Bucket[]
  isChild?: boolean
  // Live timer controls (start/pause/resume/stop) only make sense for the
  // current day's occurrences — a non-today occurrence still shows its logged-time
  // total, just read-only, via TimerControl's readOnly branch. Skip/excuse/
  // carry-forward, by contrast, are valid on any day (matches backend, which
  // never restricted them to today). Defaults to true since NowView only ever
  // shows today.
  isToday?: boolean
  session: SessionState | undefined
  onComplete: () => void
  onUncomplete: () => void
  onTimerStart: () => void
  onTimerPause: () => void
  onTimerResume: () => void
  onTimerStop: () => void
  onDisposition: () => void
  // Undoes a skip/excuse/carry-forward (disposition back to 'pending'). Only
  // rendered when the occurrence actually carries one of those three statuses.
  onClearDisposition?: () => void
  onEdit?: () => void
  onArchive?: () => void
  // §9.1 — opens the session manager (add/edit/delete individual logged
  // windows). Unlike the live TimerControl, this isn't gated on isToday or
  // completion — manual sessions are explicitly for backdating and for
  // occurrences you've already completed.
  onManageSessions?: () => void
}

// Skip/excuse/carry-forward are the three user-settable "no longer active
// today" statuses (completed has its own green checkmark treatment; auto_closed
// is a system action, not something the user set and un-sets). Deliberately
// distinct visual language per status — not just one generic "greyed out" —
// so the three are each recognizable at a glance:
//   skipped     — read as a miss (danger-tinted), matching "breaks streak" in
//                 the disposition picker.
//   excused     — neutral grey, never red: v2's single-miss-constraint ethos
//                 says an excused day is explicitly NOT a failure signal, so it
//                 must not look like one.
//   rescheduled — informational accent tint, not a judgment either way; it's
//                 just been moved.
const DISPOSITION_META: Record<string, { label: string; icon: string }> = {
  skipped: { label: 'Skipped', icon: '✗' },
  excused: { label: 'Excused', icon: '∅' },
  rescheduled: { label: 'Carried forward', icon: '→' },
}

export function OccurrenceRow({
  occ,
  buckets,
  isChild,
  isToday = true,
  session,
  onComplete,
  onUncomplete,
  onTimerStart,
  onTimerPause,
  onTimerResume,
  onTimerStop,
  onDisposition,
  onClearDisposition,
  onEdit,
  onArchive,
  onManageSessions,
}: Props) {
  const isComplete = occ.completionState.isComplete
  const timingLabel = formatTimingLabel(occ, buckets)
  const derivedPct = occ.completionState.derivedPercent

  const dispositionMeta = DISPOSITION_META[occ.disposition.type]
  // Skipped/excused/carried-forward: no longer active for today. Visually
  // distinct from both "pending" and "completed," and not interactive — the
  // only action left on the row is undoing the status via onClearDisposition.
  const isDispositioned = dispositionMeta !== undefined

  const rowClasses = [
    'occ-row',
    isChild ? 'occ-row--child' : '',
    occ.isBlocked ? 'occ-row--blocked' : '',
    isDispositioned ? `occ-row--dispositioned occ-row--${occ.disposition.type}` : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={rowClasses} data-testid={`occ-row-${occ.id ?? occ.itemId}`} data-item-id={occ.itemId} data-disposition={occ.disposition.type}>
      {/* Completion checkbox — replaced by a static status icon once
          skipped/excused/carried-forward; no longer a toggle. */}
      {isDispositioned ? (
        <span
          className={`occ-check occ-check--${occ.disposition.type}`}
          aria-hidden="true"
          data-testid="occ-disposition-icon"
        >
          {dispositionMeta.icon}
        </span>
      ) : (
        <button
          className={`occ-check${isComplete ? ' occ-check--checked' : ''}`}
          onClick={isComplete ? onUncomplete : onComplete}
          aria-label={isComplete ? `Unmark ${occ.snapshot.name} as done` : `Mark ${occ.snapshot.name} as done`}
          aria-pressed={isComplete}
          data-testid="occ-check"
        >
          {isComplete && (
            <svg className="occ-check__icon" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      )}

      {/* Row body */}
      <div className="occ-body">
        <div className={`occ-name${isComplete ? ' occ-name--completed' : ''}${isDispositioned ? ' occ-name--dispositioned' : ''}`}>
          {occ.snapshot.name}
        </div>
        <div className="occ-meta">
          {isDispositioned && (
            <span
              className={`occ-disposition-badge occ-disposition-badge--${occ.disposition.type}`}
              data-testid="occ-disposition-badge"
            >
              {dispositionMeta.icon} {dispositionMeta.label}
              {occ.disposition.type === 'rescheduled' && occ.disposition.rescheduledToDay && (
                <> → {formatDayLabel(occ.disposition.rescheduledToDay)}</>
              )}
            </span>
          )}
          {timingLabel && (
            <span className="occ-timing">
              <span className="occ-timing__dot" aria-hidden="true" />
              {timingLabel}
            </span>
          )}
          {derivedPct !== null && (
            <span className="occ-percent" data-testid="derived-pct">
              {Math.round(derivedPct)}%
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="occ-actions">
        {occ.id && (
          <TimerControl
            session={session}
            loggedMinutes={occ.loggedMinutes}
            onStart={onTimerStart}
            onPause={onTimerPause}
            onResume={onTimerResume}
            onStop={onTimerStop}
            readOnly={isComplete || !isToday || isDispositioned}
          />
        )}
        {onManageSessions && occ.id && (
          <button
            className="disp-btn"
            onClick={onManageSessions}
            aria-label={`Manage logged time for ${occ.snapshot.name}`}
            data-testid="occ-manage-time-btn"
            title="Manage logged time"
          >
            🕒
          </button>
        )}
        {onEdit && (
          <button
            className="disp-btn"
            onClick={onEdit}
            aria-label="Edit item template"
            data-testid="occ-edit-btn"
            title="Edit item"
          >
            ✎
          </button>
        )}
        {onArchive && (
          <button
            className="disp-btn disp-btn--danger"
            onClick={onArchive}
            aria-label="Delete task"
            data-testid="occ-archive-btn"
            title="Delete task"
          >
            🗑
          </button>
        )}
        {occ.id && isDispositioned && (
          // Undoing an existing skip/excuse/carry-forward is valid on any day —
          // unlike *setting* one, "clear" just appends a disposition_cleared event
          // and has no isToday restriction server-side (clearDispositionByUser).
          // Gating this on isToday would strand yesterday's auto-skips forever.
          <button
            className="disp-btn"
            onClick={onClearDisposition}
            aria-label={`Remove ${dispositionMeta.label.toLowerCase()} status from ${occ.snapshot.name}`}
            data-testid="occ-restore-btn"
            title={`Remove "${dispositionMeta.label}" status`}
          >
            ↺
          </button>
        )}
        {occ.id && !isDispositioned && (
          // Skip/excuse/carry-forward are valid on any day, not just today — the
          // backend (skipOccurrenceByUser/excuseOccurrenceByUser/carryForward) has
          // never enforced an isToday restriction; only this button used to.
          <button
            className="disp-btn"
            onClick={onDisposition}
            aria-label="More options"
            data-testid="occ-disposition-btn"
            title="Skip / excuse / carry forward"
          >
            ···
          </button>
        )}
      </div>
    </div>
  )
}
