import { useState, useEffect } from 'react'

export type SessionState = {
  sessionId: string
  occurrenceId: string
  status: 'running' | 'paused'
  startedAt: Date
  pausedAt: Date | null
  accumulatedMs: number
}

function getElapsedMs(session: SessionState, now: Date): number {
  const total = now.getTime() - session.startedAt.getTime() - session.accumulatedMs
  if (session.status === 'paused' && session.pausedAt) {
    return total - (now.getTime() - session.pausedAt.getTime())
  }
  return total
}

function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

type Props = {
  session: SessionState | undefined
  // §9.1 — minutes already logged against this occurrence from prior, finalized
  // start/stop cycles today. Re-starting the timer is additive: this figure plus
  // the live-running session's own elapsed time is what's shown while running,
  // and it's what remains visible once the timer is stopped again.
  loggedMinutes: number
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  disabled?: boolean
}

export function TimerControl({ session, loggedMinutes, onStart, onPause, onResume, onStop, disabled }: Props) {
  const [tick, setTick] = useState(0)

  // Re-render every second while a timer is running
  useEffect(() => {
    if (!session || session.status !== 'running') return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [session])

  const loggedMs = loggedMinutes * 60000

  if (!session) {
    return (
      <div className="timer-control">
        {loggedMs > 0 && (
          <span
            className="timer-logged"
            aria-label={`Logged today: ${formatMs(loggedMs)}`}
            data-testid="timer-logged"
          >
            {formatMs(loggedMs)}
          </span>
        )}
        <button
          className="timer-btn timer-btn--start"
          onClick={onStart}
          disabled={disabled}
          aria-label="Start timer"
          data-testid="timer-start"
          title="Start timer"
        >
          ▶
        </button>
      </div>
    )
  }

  // Cumulative so the figure doesn't reset each time the timer is stopped and
  // re-started — it's today's running total, not just this session's.
  const elapsedMs = loggedMs + getElapsedMs(session, new Date())
  const label = formatMs(elapsedMs)
  const isRunning = session.status === 'running'

  return (
    <div className="timer-control" data-testid="timer-running">
      <span
        className="timer-elapsed"
        aria-live="polite"
        aria-label={`Elapsed: ${label}`}
        data-testid="timer-elapsed"
      >
        {label}
      </span>
      {isRunning ? (
        <button
          className="timer-btn timer-btn--pause"
          onClick={onPause}
          aria-label="Pause timer"
          data-testid="timer-pause"
          title="Pause"
        >
          ⏸
        </button>
      ) : (
        <button
          className="timer-btn timer-btn--resume"
          onClick={onResume}
          aria-label="Resume timer"
          data-testid="timer-resume"
          title="Resume"
        >
          ▶
        </button>
      )}
      <button
        className="timer-btn timer-btn--stop"
        onClick={onStop}
        aria-label="Stop timer"
        data-testid="timer-stop"
        title="Stop"
      >
        ■
      </button>
    </div>
  )
}
