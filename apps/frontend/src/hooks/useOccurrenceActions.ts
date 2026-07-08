// Shared handler logic reused by List and Calendar views.
// NowView owns its own copy to avoid touching existing passing tests.

import { useState, useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import { api } from '../lib/api'
import { saveSessions, loadSessions } from '../lib/sessions'
import type { OccurrenceWithState } from '@tracker/shared'
import type { SessionState } from '../components/now/TimerControl'

export type OccurrenceActions = {
  sessions: Map<string, SessionState>
  dispositionTarget: OccurrenceWithState | null
  setDispositionTarget: (occ: OccurrenceWithState | null) => void
  handleComplete: (occ: OccurrenceWithState) => Promise<void>
  handleUncomplete: (occ: OccurrenceWithState) => Promise<void>
  handleTimerStart: (occ: OccurrenceWithState) => Promise<void>
  handleTimerPause: (occ: OccurrenceWithState) => Promise<void>
  handleTimerResume: (occ: OccurrenceWithState) => Promise<void>
  handleTimerStop: (occ: OccurrenceWithState) => Promise<void>
  handleSkip: (occ: OccurrenceWithState, reasonId: string | null, comment: string | null) => Promise<void>
  handleExcuse: (occ: OccurrenceWithState, reasonId: string | null, comment: string | null) => Promise<void>
  handleCarryForward: (occ: OccurrenceWithState, targetDay: string, reasonId: string | null, comment: string | null) => Promise<void>
  handleArchive: (occ: OccurrenceWithState) => Promise<void>
}

export function useOccurrenceActions(
  setOccurrences: Dispatch<SetStateAction<OccurrenceWithState[]>>,
  refresh: () => void
): OccurrenceActions {
  const [sessions, setSessions] = useState<Map<string, SessionState>>(() => loadSessions())
  const [dispositionTarget, setDispositionTarget] = useState<OccurrenceWithState | null>(null)

  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

  const handleComplete = useCallback(async (occ: OccurrenceWithState) => {
    const updated = occ.id
      ? await api.occurrences.complete(occ.id)
      : await api.occurrences.completeByItemDay(occ.itemId, occ.appliesToDay)
    setOccurrences((prev) => prev.map((o) => {
      if (o.id !== null && o.id === updated.id) return updated
      if (o.id === null && o.itemId === updated.itemId && o.appliesToDay === updated.appliesToDay) return updated
      return o
    }))
    if (occ.snapshot.parentId) refresh()
  }, [setOccurrences, refresh])

  const handleUncomplete = useCallback(async (occ: OccurrenceWithState) => {
    if (!occ.id) return
    const updated = await api.occurrences.uncomplete(occ.id)
    setOccurrences((prev) => prev.map((o) => (o.id !== null && o.id === updated.id ? updated : o)))
    if (occ.snapshot.parentId) refresh()
  }, [setOccurrences, refresh])

  const handleTimerStart = useCallback(async (occ: OccurrenceWithState) => {
    const { sessionId, occurrenceId } = await api.sessions.start({ itemId: occ.itemId })
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(occurrenceId, {
        sessionId,
        occurrenceId,
        status: 'running',
        startedAt: new Date(),
        pausedAt: null,
        accumulatedMs: 0,
      })
      return next
    })
  }, [])

  const handleTimerPause = useCallback(async (occ: OccurrenceWithState) => {
    const occId = occ.id ?? occ.itemId
    const session = sessions.get(occId)
    if (!session) return
    await api.sessions.pause(session.sessionId)
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(occId, { ...session, status: 'paused', pausedAt: new Date() })
      return next
    })
  }, [sessions])

  const handleTimerResume = useCallback(async (occ: OccurrenceWithState) => {
    const occId = occ.id ?? occ.itemId
    const session = sessions.get(occId)
    if (!session || !session.pausedAt) return
    await api.sessions.resume(session.sessionId)
    const pausedMs = session.accumulatedMs + (new Date().getTime() - session.pausedAt.getTime())
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(occId, { ...session, status: 'running', pausedAt: null, accumulatedMs: pausedMs })
      return next
    })
  }, [sessions])

  const handleTimerStop = useCallback(async (occ: OccurrenceWithState) => {
    const occId = occ.id ?? occ.itemId
    const session = sessions.get(occId)
    if (!session) return
    await api.sessions.stop(session.sessionId)
    setSessions((prev) => {
      const next = new Map(prev)
      next.delete(occId)
      return next
    })
    refresh()
  }, [sessions, refresh])

  const handleSkip = useCallback(async (occ: OccurrenceWithState, reasonId: string | null, comment: string | null) => {
    if (!occ.id) return
    const updated = await api.occurrences.skip(occ.id, { reasonId, comment })
    setOccurrences((prev) => prev.map((o) => (o.id !== null && o.id === updated.id ? updated : o)))
  }, [setOccurrences])

  const handleExcuse = useCallback(async (occ: OccurrenceWithState, reasonId: string | null, comment: string | null) => {
    if (!occ.id) return
    const updated = await api.occurrences.excuse(occ.id, { reasonId, comment })
    setOccurrences((prev) => prev.map((o) => (o.id !== null && o.id === updated.id ? updated : o)))
  }, [setOccurrences])

  const handleCarryForward = useCallback(async (occ: OccurrenceWithState, targetDay: string, reasonId: string | null, comment: string | null) => {
    if (!occ.id) return
    await api.occurrences.carryForward(occ.id, { targetDay, reasonId, comment })
    refresh()
  }, [refresh])

  const handleArchive = useCallback(async (occ: OccurrenceWithState) => {
    await api.items.archive(occ.itemId)
    refresh()
  }, [refresh])

  return {
    sessions,
    dispositionTarget,
    setDispositionTarget,
    handleComplete,
    handleUncomplete,
    handleTimerStart,
    handleTimerPause,
    handleTimerResume,
    handleTimerStop,
    handleSkip,
    handleExcuse,
    handleCarryForward,
    handleArchive,
  }
}
