// Typed fetch layer — thin wrappers over the /api routes.
// No classes, no caching layer — just typed functions.

import type {
  OccurrenceWithState,
  Bucket,
  Category,
  Reason,
  Item,
  ItemPrerequisite,
  Occurrence,
  DayStartEntry,
  DispositionBody,
  CarryForwardBody,
  StartSessionBody,
  AdHocCaptureBody,
  CreateItemBody,
  UpdateItemBody,
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
  // 204 No Content (e.g. archive/delete endpoints) — no body to parse
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

export const api = {
  occurrences: {
    today: () =>
      apiFetch<OccurrenceWithState[]>('/occurrences/today'),
    range: (start: string, end: string) =>
      apiFetch<OccurrenceWithState[]>(`/occurrences?start=${start}&end=${end}`),
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

  items: {
    list: () => apiFetch<Item[]>('/items'),
    get: (id: string) =>
      apiFetch<Item & { children: Item[]; prerequisites: ItemPrerequisite[] }>(`/items/${id}`),
    create: (body: CreateItemBody) =>
      apiFetch<Item>('/items', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: UpdateItemBody) =>
      apiFetch<Item>(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    archive: (id: string) =>
      apiFetch<void>(`/items/${id}`, { method: 'DELETE' }),
    addPrerequisite: (id: string, prerequisiteItemId: string) =>
      apiFetch<ItemPrerequisite>(`/items/${id}/prerequisites`, {
        method: 'POST', body: JSON.stringify({ prerequisiteItemId }),
      }),
    removePrerequisite: (id: string, prereqId: string) =>
      apiFetch<void>(`/items/${id}/prerequisites/${prereqId}`, { method: 'DELETE' }),
  },

  adHoc: {
    capture: (body: AdHocCaptureBody) =>
      apiFetch<{ item: Item; occurrence: Occurrence; sessionId: string }>('/ad-hoc', {
        method: 'POST', body: JSON.stringify(body),
      }),
  },

  buckets: {
    list: () => apiFetch<Bucket[]>('/buckets'),
    create: (name: string, startTime: string, endTime: string, sortOrder?: number) =>
      apiFetch<Bucket>('/buckets', {
        method: 'POST',
        body: JSON.stringify({ name, startTime, endTime, sortOrder }),
      }),
    updateBoundaries: (id: string, startTime: string, endTime: string) =>
      apiFetch<Bucket>(`/buckets/${id}/boundaries`, {
        method: 'PATCH',
        body: JSON.stringify({ startTime, endTime }),
      }),
  },

  categories: {
    list: () => apiFetch<Category[]>('/categories'),
    create: (name: string) =>
      apiFetch<Category>('/categories', { method: 'POST', body: JSON.stringify({ name }) }),
    rename: (id: string, name: string) =>
      apiFetch<Category>(`/categories/${id}/rename`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    archive: (id: string) =>
      apiFetch<void>(`/categories/${id}`, { method: 'DELETE' }),
  },

  reasons: {
    list: () => apiFetch<Reason[]>('/reasons'),
    create: (name: string) =>
      apiFetch<Reason>('/reasons', { method: 'POST', body: JSON.stringify({ name }) }),
    rename: (id: string, name: string) =>
      apiFetch<Reason>(`/reasons/${id}/rename`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    archive: (id: string) =>
      apiFetch<void>(`/reasons/${id}`, { method: 'DELETE' }),
  },

  dayStart: {
    list: () => apiFetch<DayStartEntry[]>('/day-start'),
    append: (value: string, effectiveFrom: string) =>
      apiFetch<DayStartEntry>('/day-start', {
        method: 'POST',
        body: JSON.stringify({ value, effectiveFrom }),
      }),
  },

  preferences: {
    get: () => apiFetch<Record<string, string>>('/preferences'),
    set: (key: string, value: string) =>
      apiFetch<{ ok: boolean }>(`/preferences/${key}`, {
        method: 'PUT', body: JSON.stringify({ value }),
      }),
  },
}
