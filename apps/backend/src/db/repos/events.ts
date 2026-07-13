import type { Pool } from 'pg'
import type { TrackerEvent, EventType } from '@tracker/shared'

// Raw row shape from the DB; payload arrives as a parsed JS object (pg auto-parses JSONB)
interface EventRow {
  id: string
  user_id: string
  event_type: EventType
  recorded_at: Date
  applies_to_day: string | null
  occurrence_id: string | null
  item_id: string | null
  payload: Record<string, unknown>
}

function toEvent(row: EventRow): TrackerEvent {
  return {
    id: row.id,
    userId: row.user_id,
    eventType: row.event_type,
    recordedAt: row.recorded_at,
    appliesToDay: row.applies_to_day,
    occurrenceId: row.occurrence_id,
    itemId: row.item_id,
    payload: row.payload,
  } as TrackerEvent
}

export type InsertEventData = {
  userId: string
  eventType: EventType
  occurrenceId?: string | null
  itemId?: string | null
  appliesToDay?: string | null
  payload?: Record<string, unknown>
  recordedAt?: Date   // optional; defaults to NOW() when omitted
}

export async function insertEvent(
  pool: Pool,
  data: InsertEventData
): Promise<TrackerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (user_id, event_type, occurrence_id, item_id, applies_to_day, recorded_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      data.userId,
      data.eventType,
      data.occurrenceId ?? null,
      data.itemId ?? null,
      data.appliesToDay ?? null,
      data.recordedAt ?? new Date(),
      JSON.stringify(data.payload ?? {}),
    ]
  )
  return toEvent(rows[0])
}

// All events for a user on a specific day (for replaying daily state)
export async function findEventsByDay(
  pool: Pool,
  userId: string,
  day: string   // YYYY-MM-DD
): Promise<TrackerEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT * FROM events
     WHERE user_id = $1 AND applies_to_day = $2
     ORDER BY recorded_at`,
    [userId, day]
  )
  return rows.map(toEvent)
}

// Full event stream for a specific occurrence, in chronological order
export async function findEventsByOccurrence(
  pool: Pool,
  occurrenceId: string,
  userId: string
): Promise<TrackerEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT * FROM events
     WHERE occurrence_id = $1 AND user_id = $2
     ORDER BY recorded_at`,
    [occurrenceId, userId]
  )
  return rows.map(toEvent)
}

// Template-level events for an item (no occurrence_id), e.g. edits, soft-deletes
export async function findTemplateEventsByItem(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<TrackerEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT * FROM events
     WHERE item_id = $1 AND user_id = $2 AND occurrence_id IS NULL
     ORDER BY recorded_at`,
    [itemId, userId]
  )
  return rows.map(toEvent)
}

// All events that belong to a specific session (identified by payload.sessionId).
// Covers session_started, session_paused, session_resumed, session_stopped,
// session_created, and session_edited — all share sessionId in their payload.
export async function findEventsBySessionId(
  pool: Pool,
  sessionId: string,
  userId: string
): Promise<TrackerEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT * FROM events
     WHERE user_id = $1 AND payload->>'sessionId' = $2
     ORDER BY recorded_at`,
    [userId, sessionId]
  )
  return rows.map(toEvent)
}

// Bulk: events for a set of occurrence IDs, grouped by occurrenceId.
// Used by the stats observation layer to avoid N+1 queries across a window.
export async function findEventsByOccurrenceIds(
  pool: Pool,
  occurrenceIds: string[],
  userId: string
): Promise<Map<string, TrackerEvent[]>> {
  if (occurrenceIds.length === 0) return new Map()
  const { rows } = await pool.query<EventRow>(
    `SELECT * FROM events
     WHERE occurrence_id = ANY($1::uuid[]) AND user_id = $2
     ORDER BY occurrence_id, recorded_at`,
    [occurrenceIds, userId]
  )
  const result = new Map<string, TrackerEvent[]>()
  for (const row of rows) {
    const occId = row.occurrence_id!
    if (!result.has(occId)) result.set(occId, [])
    result.get(occId)!.push(toEvent(row))
  }
  return result
}

// ── Session reconstruction ────────────────────────────────────────────────────

export type SessionSummaryRow = {
  sessionId: string
  itemId: string
  appliesToDay: string
  durationMin: number
  startedAt: Date
  source: 'live' | 'manual'
}

type RawSessionEventRow = {
  event_type: string
  recorded_at: Date
  applies_to_day: string
  item_id: string
  payload: Record<string, unknown>
}

// Reconstruct completed sessions from the event log for a date window.
// Live sessions: session_started + session_stopped pair (incomplete omitted).
// Manual sessions: latest session_created or session_edited per sessionId.
// Optionally filtered to a single item.
export async function findSessionSummaries(
  pool: Pool,
  userId: string,
  startDay: string,
  endDay: string,
  itemId?: string
): Promise<SessionSummaryRow[]> {
  const params: (string | null)[] = [userId, startDay, endDay]
  let extra = ''
  if (itemId) {
    params.push(itemId)
    extra = ` AND item_id = $${params.length}`
  }

  const { rows } = await pool.query<RawSessionEventRow>(
    `SELECT event_type, recorded_at, applies_to_day, item_id, payload
     FROM events
     WHERE user_id = $1
       AND applies_to_day >= $2 AND applies_to_day <= $3
       AND event_type IN ('session_started','session_stopped','session_created','session_edited','session_deleted')
       ${extra}
     ORDER BY recorded_at`,
    params
  )

  // Group events by sessionId
  const bySession = new Map<string, RawSessionEventRow[]>()
  for (const row of rows) {
    const sid = row.payload['sessionId'] as string
    if (!bySession.has(sid)) bySession.set(sid, [])
    bySession.get(sid)!.push(row)
  }

  const results: SessionSummaryRow[] = []
  for (const [sessionId, events] of bySession) {
    if (events.some(e => e.event_type === 'session_deleted')) continue

    // "source" reflects how the session originated (a real timer vs typed in
    // after the fact) — independent of whether it was later corrected.
    const startEvent = events.find(e => e.event_type === 'session_started')
    const source: 'live' | 'manual' = startEvent ? 'live' : 'manual'

    // The LATEST finalizing event wins — a session_edited always supersedes
    // whatever it corrects, whether that was an earlier manual entry OR a
    // live session_stopped (PATCH can edit either kind). Rows arrive in
    // chronological order, so "latest in the array" = "latest in time".
    const finalizers = events.filter(
      e => e.event_type === 'session_stopped' || e.event_type === 'session_created' || e.event_type === 'session_edited'
    )
    if (finalizers.length === 0) continue   // still in progress, no finalizer yet

    const latest = finalizers[finalizers.length - 1]
    if (latest.event_type === 'session_stopped') {
      if (!startEvent) continue   // defensive: a stop with no matching start is unusable
      results.push({
        sessionId,
        itemId: latest.item_id,
        appliesToDay: latest.applies_to_day,
        durationMin: latest.payload['durationMin'] as number,
        startedAt: startEvent.recorded_at,
        source,
      })
    } else {
      const p = latest.payload as { startedAt: string; durationMin: number }
      results.push({
        sessionId,
        itemId: latest.item_id,
        appliesToDay: latest.applies_to_day,
        durationMin: p.durationMin,
        startedAt: new Date(p.startedAt),
        source,
      })
    }
  }

  return results
}

export type SessionDetail = {
  sessionId: string
  startedAt: Date
  endedAt: Date
  durationMin: number
  source: 'live' | 'manual'
}

// List individual sessions logged directly against one occurrence (not its
// subtree), excluding deleted ones — powers the session-manager UI, where a
// user edits or deletes one specific logged window without touching the
// others logged against the same occurrence.
export async function findSessionsByOccurrence(
  pool: Pool,
  occurrenceId: string,
  userId: string
): Promise<SessionDetail[]> {
  const events = await findEventsByOccurrence(pool, occurrenceId, userId)

  const bySession = new Map<string, TrackerEvent[]>()
  for (const e of events) {
    const sid = (e.payload as { sessionId?: string }).sessionId
    if (!sid) continue
    if (!bySession.has(sid)) bySession.set(sid, [])
    bySession.get(sid)!.push(e)
  }

  const results: SessionDetail[] = []
  for (const [sessionId, sessionEvents] of bySession) {
    if (sessionEvents.some((e) => e.eventType === 'session_deleted')) continue

    // "source" reflects how the session originated — independent of whether
    // it was later corrected via PATCH.
    const startEvent = sessionEvents.find((e) => e.eventType === 'session_started')
    const source: 'live' | 'manual' = startEvent ? 'live' : 'manual'

    // The LATEST finalizing event wins — an edit always supersedes whatever
    // it corrects, whether that was an earlier manual entry OR a live
    // session_stopped. Events arrive in chronological order.
    const finalizers = sessionEvents.filter(
      (e) => e.eventType === 'session_stopped' || e.eventType === 'session_created' || e.eventType === 'session_edited'
    )
    if (finalizers.length === 0) continue   // in-progress live session, no finalizer yet

    const latest = finalizers[finalizers.length - 1]
    if (latest.eventType === 'session_stopped') {
      if (!startEvent) continue   // defensive: a stop with no matching start is unusable
      const p = latest.payload as { stoppedAt: string; durationMin: number }
      results.push({
        sessionId,
        startedAt: startEvent.recordedAt,
        endedAt: new Date(p.stoppedAt),
        durationMin: p.durationMin,
        source,
      })
    } else {
      const p = latest.payload as { startedAt: string; endedAt: string; durationMin: number }
      results.push({
        sessionId,
        startedAt: new Date(p.startedAt),
        endedAt: new Date(p.endedAt),
        durationMin: p.durationMin,
        source,
      })
    }
  }

  results.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  return results
}

// Reschedule events for a date window (stats: procrastination counting).
export async function findRescheduleEventsByRange(
  pool: Pool,
  userId: string,
  startDay: string,
  endDay: string,
  itemId?: string
): Promise<Array<{ originalDay: string; newDay: string; recordedAt: Date; reasonId: string | null }>> {
  const params: (string | null)[] = [userId, startDay, endDay]
  let extra = ''
  if (itemId) {
    params.push(itemId)
    extra = ` AND item_id = $${params.length}`
  }
  const { rows } = await pool.query<{ applies_to_day: string; recorded_at: Date; payload: Record<string, unknown> }>(
    `SELECT applies_to_day, recorded_at, payload
     FROM events
     WHERE user_id = $1
       AND applies_to_day >= $2 AND applies_to_day <= $3
       AND event_type = 'rescheduled'
       ${extra}
     ORDER BY recorded_at`,
    params
  )
  return rows.map(r => ({
    originalDay: r.applies_to_day,
    newDay: r.payload['newDay'] as string,
    recordedAt: r.recorded_at,
    reasonId: (r.payload['reasonId'] as string | null) ?? null,
  }))
}

// Retroactive completions in a date window (stats: backfill lateness).
// Each row is a retroactive_completion event whose applies_to_day is in the window.
export async function findRetroactiveCompletionsByRange(
  pool: Pool,
  userId: string,
  startDay: string,
  endDay: string,
  itemId?: string
): Promise<Array<{ day: string; recordedAt: Date; itemId: string }>> {
  const params: (string | null)[] = [userId, startDay, endDay]
  let extra = ''
  if (itemId) {
    params.push(itemId)
    extra = ` AND item_id = $${params.length}`
  }
  const { rows } = await pool.query<{ applies_to_day: string; recorded_at: Date; item_id: string }>(
    `SELECT applies_to_day, recorded_at, item_id
     FROM events
     WHERE user_id = $1
       AND applies_to_day >= $2 AND applies_to_day <= $3
       AND event_type = 'retroactive_completion'
       ${extra}
     ORDER BY applies_to_day`,
    params
  )
  return rows.map(r => ({ day: r.applies_to_day, recordedAt: r.recorded_at, itemId: r.item_id }))
}

// Config-level events (no item, no occurrence), e.g. category changes, day-start
export async function findConfigEvents(
  pool: Pool,
  userId: string,
  eventType?: EventType
): Promise<TrackerEvent[]> {
  if (eventType) {
    const { rows } = await pool.query<EventRow>(
      `SELECT * FROM events
       WHERE user_id = $1 AND item_id IS NULL AND occurrence_id IS NULL
         AND event_type = $2
       ORDER BY recorded_at`,
      [userId, eventType]
    )
    return rows.map(toEvent)
  }

  const { rows } = await pool.query<EventRow>(
    `SELECT * FROM events
     WHERE user_id = $1 AND item_id IS NULL AND occurrence_id IS NULL
     ORDER BY recorded_at`,
    [userId]
  )
  return rows.map(toEvent)
}
