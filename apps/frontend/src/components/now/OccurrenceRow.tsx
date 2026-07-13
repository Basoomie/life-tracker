import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'
import type { SessionState } from './TimerControl'
import { TimerControl } from './TimerControl'
import { formatTimingLabel } from '../../lib/now-ordering'

type Props = {
  occ: OccurrenceWithState
  buckets: Bucket[]
  isChild?: boolean
  // Timer + skip/excuse/carry-forward only make sense for the current day's
  // occurrences — defaults to true since NowView only ever shows today.
  isToday?: boolean
  session: SessionState | undefined
  onComplete: () => void
  onUncomplete: () => void
  onTimerStart: () => void
  onTimerPause: () => void
  onTimerResume: () => void
  onTimerStop: () => void
  onDisposition: () => void
  onEdit?: () => void
  onArchive?: () => void
  // §9.1 — opens the session manager (add/edit/delete individual logged
  // windows). Unlike the live TimerControl, this isn't gated on isToday or
  // completion — manual sessions are explicitly for backdating and for
  // occurrences you've already completed.
  onManageSessions?: () => void
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
  onEdit,
  onArchive,
  onManageSessions,
}: Props) {
  const isComplete = occ.completionState.isComplete
  const timingLabel = formatTimingLabel(occ, buckets)
  const derivedPct = occ.completionState.derivedPercent

  const rowClasses = [
    'occ-row',
    isChild ? 'occ-row--child' : '',
    occ.isBlocked ? 'occ-row--blocked' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={rowClasses} data-testid={`occ-row-${occ.id ?? occ.itemId}`} data-item-id={occ.itemId}>
      {/* Completion checkbox */}
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

      {/* Row body */}
      <div className="occ-body">
        <div className={`occ-name${isComplete ? ' occ-name--completed' : ''}`}>
          {occ.snapshot.name}
        </div>
        <div className="occ-meta">
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
        {occ.id && isToday && (
          <TimerControl
            session={session}
            loggedMinutes={occ.loggedMinutes}
            onStart={onTimerStart}
            onPause={onTimerPause}
            onResume={onTimerResume}
            onStop={onTimerStop}
            readOnly={isComplete}
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
        {occ.id && isToday && (
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
