import type { CSSProperties } from 'react'
import type { OccurrenceWithState, ItemStreakSummary } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'
import type { SessionState } from './TimerControl'
import { TimerControl } from './TimerControl'
import { StreakBadge } from '../shared/StreakBadge'
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
  // v2 §3.2.5 — the ambient streak badge. Absent for one-time items (a streak is
  // a property of a recurrence) and while the summary request is still in flight.
  streak?: ItemStreakSummary
}

// Statuses that get a badge instead of reading as a plain open row (completed
// has its own green checkmark treatment). Deliberately distinct visual language
// per status — not just one generic "greyed out" — so each is recognizable at
// a glance:
//   skipped     — read as a miss (danger-tinted), matching "breaks streak" in
//                 the disposition picker.
//   excused     — neutral grey, never red: v2's single-miss-constraint ethos
//                 says an excused day is explicitly NOT a failure signal, so it
//                 must not look like one.
//   rescheduled — informational accent tint, not a judgment either way; it's
//                 just been moved.
//   auto_closed — neutral, and always accompanied by the % it closed at (§8.1:
//                 "marked complete at whatever the derived child % was"). The
//                 end-of-day job DID close this occurrence; without a badge the
//                 row is pixel-identical to a pending one and the record and the
//                 screen disagree.
const DISPOSITION_META: Record<string, { label: string; icon: string }> = {
  skipped: { label: 'Skipped', icon: '✗' },
  excused: { label: 'Excused', icon: '∅' },
  rescheduled: { label: 'Carried forward', icon: '→' },
  auto_closed: { label: 'Auto-closed', icon: '⊘' },
}

// The three the USER set, and can therefore un-set (↺). auto_closed is
// deliberately absent: it's a system action, so there is nothing of the user's
// to undo — and unlike the other three the row stays interactive, because the
// correction path for a day that closed at the wrong % is to log what actually
// happened (§6.4 never blocks backfill), not to "clear" the close-out.
const CLEARABLE_DISPOSITIONS = new Set(['skipped', 'excused', 'rescheduled'])

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
  streak,
}: Props) {
  const isComplete = occ.completionState.isComplete
  const timingLabel = formatTimingLabel(occ, buckets)
  const derivedPct = occ.completionState.derivedPercent
  // §6.2 — derived and declared coexist and may disagree; v1 must not collapse
  // them. A parent the user ticked reads "100% · logged 76%": the declared value
  // is what they asserted, the derived one is what the children actually say.
  const declaredPct = occ.completionState.declaredPercent
  const showBothPercents =
    derivedPct !== null && declaredPct !== null && Math.round(declaredPct) !== Math.round(derivedPct)
  // Drives the 0→100 colour ramp. It tracks the *leading* number — the one the
  // ramp is actually colouring — which is the declared value whenever the pair
  // is shown; the subordinate "· logged X%" keeps its own tertiary grey (§6.2),
  // so the ramp never gets to overstate a parent the user hasn't declared done.
  const headlinePct = showBothPercents ? Math.round(declaredPct!) : Math.round(derivedPct ?? 0)

  const dispositionMeta = DISPOSITION_META[occ.disposition.type]
  // Skipped/excused/carried-forward: no longer active for today. Visually
  // distinct from both "pending" and "completed," and not interactive — the
  // only action left on the row is undoing the status via onClearDisposition.
  const isDispositioned = CLEARABLE_DISPOSITIONS.has(occ.disposition.type)
  const isAutoClosed = occ.disposition.type === 'auto_closed'

  const rowClasses = [
    'occ-row',
    isChild ? 'occ-row--child' : '',
    occ.isBlocked ? 'occ-row--blocked' : '',
    isDispositioned ? `occ-row--dispositioned occ-row--${occ.disposition.type}` : '',
    isAutoClosed ? 'occ-row--auto_closed' : '',
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
          {dispositionMeta && (
            <span
              className={`occ-disposition-badge occ-disposition-badge--${occ.disposition.type}`}
              data-testid="occ-disposition-badge"
            >
              {dispositionMeta.icon} {dispositionMeta.label}
              {occ.disposition.type === 'rescheduled' && occ.disposition.rescheduledToDay && (
                <> → {formatDayLabel(occ.disposition.rescheduledToDay)}</>
              )}
              {isAutoClosed && occ.disposition.derivedPercentAtClose !== null && (
                <> at {Math.round(occ.disposition.derivedPercentAtClose)}%</>
              )}
            </span>
          )}
          {timingLabel && (
            <span className="occ-timing">
              <span className="occ-timing__dot" aria-hidden="true" />
              {timingLabel}
            </span>
          )}
          {streak && <StreakBadge summary={streak} />}
          {derivedPct !== null && (
            <span
              className="occ-percent"
              data-testid="derived-pct"
              style={{ '--occ-pct': headlinePct } as CSSProperties}
            >
              {showBothPercents ? (
                <>
                  {Math.round(declaredPct!)}%
                  <span className="occ-percent__derived"> · logged {Math.round(derivedPct)}%</span>
                </>
              ) : (
                <>{Math.round(derivedPct)}%</>
              )}
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
