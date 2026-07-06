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
}

export async function insertEvent(
  pool: Pool,
  data: InsertEventData
): Promise<TrackerEvent> {
  const { rows } = await pool.query<EventRow>(
    `INSERT INTO events (user_id, event_type, occurrence_id, item_id, applies_to_day, payload)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      data.userId,
      data.eventType,
      data.occurrenceId ?? null,
      data.itemId ?? null,
      data.appliesToDay ?? null,
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
