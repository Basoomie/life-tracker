// Session state persistence — shared between NowView and useOccurrenceActions.
// Both views write here on any session change; both read here on mount.
// Sessions older than 24h are discarded to avoid stale-session confusion.

import type { SessionState } from '../components/now/TimerControl'

const KEY = 'tracker:active-sessions'

type SerializedSession = {
  k: string
  sessionId: string
  occurrenceId: string
  status: 'running' | 'paused'
  startedAt: string
  pausedAt: string | null
  accumulatedMs: number
}

export function saveSessions(sessions: Map<string, SessionState>): void {
  const data: SerializedSession[] = [...sessions.entries()].map(([k, s]) => ({
    k,
    sessionId: s.sessionId,
    occurrenceId: s.occurrenceId,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    pausedAt: s.pausedAt?.toISOString() ?? null,
    accumulatedMs: s.accumulatedMs,
  }))
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    // storage full — not critical
  }
}

export function loadSessions(): Map<string, SessionState> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as SerializedSession[]
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return new Map(
      raw
        .filter((s) => new Date(s.startedAt).getTime() > cutoff)
        .map(({ k, ...s }) => [
          k,
          {
            sessionId: s.sessionId,
            occurrenceId: s.occurrenceId,
            status: s.status,
            startedAt: new Date(s.startedAt),
            pausedAt: s.pausedAt ? new Date(s.pausedAt) : null,
            accumulatedMs: s.accumulatedMs,
          },
        ])
    )
  } catch {
    return new Map()
  }
}
