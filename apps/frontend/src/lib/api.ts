// Typed fetch layer — thin wrappers over the /api routes.
// No classes, no caching layer — just typed functions.

import type {
  OccurrenceWithState,
  Bucket,
  Category,
  Reason,
  Item,
  Occurrence,
  DispositionBody,
  CarryForwardBody,
  StartSessionBody,
  AdHocCaptureBody,
} from '@tracker/shared'

const BASE = '/api'

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error((err as { message?: string }).message ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  occurrences: {
    today: () =>
      apiFetch<OccurrenceWithState[]>('/occurrences/today'),
    complete: (id: string) =>
      apiFetch<OccurrenceWithState>(`/occurrences/${id}/complete`, { method: 'POST' }),
    uncomplete: (id: string) =>
      apiFetch<OccurrenceWithState>(`/occurrences/${id}/uncomplete`, { method: 'POST' }),
    skip: (id: string, body: DispositionBody) =>
      apiFetch<OccurrenceWithState>(`/occurrences/${id}/skip`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    excuse: (id: string, body: DispositionBody) =>
      apiFetch<OccurrenceWithState>(`/occurrences/${id}/excuse`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    carryForward: (id: string, body: CarryForwardBody) =>
      apiFetch<OccurrenceWithState>(`/occurrences/${id}/carry-forward`, {
        method: 'POST', body: JSON.stringify(body),
      }),
  },

  sessions: {
    start: (body: StartSessionBody) =>
      apiFetch<{ sessionId: string; occurrenceId: string }>('/sessions/start', {
        method: 'POST', body: JSON.stringify(body),
      }),
    pause: (sessionId: string) =>
      apiFetch<{ ok: boolean }>(`/sessions/${sessionId}/pause`, { method: 'POST' }),
    resume: (sessionId: string) =>
      apiFetch<{ ok: boolean }>(`/sessions/${sessionId}/resume`, { method: 'POST' }),
    stop: (sessionId: string) =>
      apiFetch<{ sessionId: string; durationMin: number }>(`/sessions/${sessionId}/stop`, {
        method: 'POST',
      }),
  },

  adHoc: {
    capture: (body: AdHocCaptureBody) =>
      apiFetch<{ item: Item; occurrence: Occurrence; sessionId: string }>('/ad-hoc', {
        method: 'POST', body: JSON.stringify(body),
      }),
  },

  buckets: {
    list: () => apiFetch<Bucket[]>('/buckets'),
  },

  categories: {
    list: () => apiFetch<Category[]>('/categories'),
  },

  reasons: {
    list: () => apiFetch<Reason[]>('/reasons'),
  },

  preferences: {
    get: () => apiFetch<Record<string, string>>('/preferences'),
    set: (key: string, value: string) =>
      apiFetch<{ ok: boolean }>(`/preferences/${key}`, {
        method: 'PUT', body: JSON.stringify({ value }),
      }),
  },
}
