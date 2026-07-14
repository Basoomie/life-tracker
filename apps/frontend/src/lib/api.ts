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
  User,
  DispositionBody,
  CarryForwardBody,
  StartSessionBody,
  ManualSessionBody,
  EditSessionBody,
  SessionSummary,
  AdHocCaptureBody,
  CreateItemBody,
  UpdateItemBody,
  EvidenceEntry,
  ApproveEvidenceBody,
  DateWindow,
  AdherenceFinding,
  StreakFinding,
  TimeStatsFinding,
  ProcrastinationFinding,
  DataQualityFinding,
  AdHocShareFinding,
  ContextStabilityFinding,
  AutocorrelationFinding,
  TrajectoryFinding,
  DayOfWeekFinding,
  TwoConditionFinding,
  Review,
  ReviewCadence,
} from '@tracker/shared'

async function typedFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error((err as { message?: string }).message ?? `HTTP ${res.status}`)
  }
  // 204 No Content (e.g. archive/delete endpoints) — no body to parse
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

// Routes under /api
const apiFetch = <T>(path: string, init?: RequestInit) => typedFetch<T>(`/api${path}`, init)
// Auth routes at /auth/* and /me (not under /api)
const authFetch = <T>(path: string, init?: RequestInit) => typedFetch<T>(path, init)

export const api = {
  auth: {
    me: () => authFetch<User>('/me', { credentials: 'include' }),
    login: (email: string, password: string) =>
      authFetch<{ user: User }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      }),
    logout: () =>
      authFetch<{ ok: boolean }>('/auth/logout', {
        method: 'POST',
        credentials: 'include',
      }),
    changePassword: (currentPassword: string, newPassword: string) =>
      authFetch<{ ok: boolean }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
        credentials: 'include',
      }),
  },

  occurrences: {
    range: (start: string, end: string) =>
      apiFetch<OccurrenceWithState[]>(`/occurrences?start=${start}&end=${end}`),
    complete: (id: string) =>
      apiFetch<OccurrenceWithState>(`/occurrences/${id}/complete`, { method: 'POST' }),
    completeByItemDay: (itemId: string, appliesToDay: string) =>
      apiFetch<OccurrenceWithState>('/occurrences/complete-by-item-day', {
        method: 'POST',
        body: JSON.stringify({ itemId, appliesToDay }),
      }),
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
    clearDisposition: (id: string) =>
      apiFetch<OccurrenceWithState>(`/occurrences/${id}/clear-disposition`, { method: 'POST' }),
    sessions: (id: string) =>
      apiFetch<SessionSummary[]>(`/occurrences/${id}/sessions`),
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
    manual: (body: ManualSessionBody) =>
      apiFetch<{ sessionId: string; occurrenceId: string; durationMin: number }>('/sessions/manual', {
        method: 'POST', body: JSON.stringify(body),
      }),
    edit: (sessionId: string, body: EditSessionBody) =>
      apiFetch<{ sessionId: string; durationMin: number }>(`/sessions/${sessionId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    delete: (sessionId: string) =>
      apiFetch<{ ok: boolean }>(`/sessions/${sessionId}`, { method: 'DELETE' }),
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
    reorderRoot: (itemId: string, afterItemId: string | null) =>
      apiFetch<Item[]>(`/items/${itemId}/reorder-root`, {
        method: 'PATCH', body: JSON.stringify({ afterItemId }),
      }),
    reorderChildren: (parentId: string, childItemIds: string[]) =>
      apiFetch<Item[]>(`/items/${parentId}/reorder-children`, {
        method: 'PATCH', body: JSON.stringify({ childItemIds }),
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

  evidence: {
    pendingApproval: () => apiFetch<EvidenceEntry[]>('/evidence/pending-approval'),
    approve: (id: string, body: ApproveEvidenceBody) =>
      apiFetch<EvidenceEntry>(`/evidence/${id}/approve`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    reject: (id: string) =>
      apiFetch<EvidenceEntry>(`/evidence/${id}/reject`, { method: 'POST' }),
  },

  // v2 §3/§4/§5 — Stats: Layer 1 (descriptive), Layer 1.5 (data quality), Layer 2 (inference).
  // Every route takes the same DateWindow query shape.
  stats: {
    itemAdherence: (itemId: string, w: DateWindow) =>
      apiFetch<AdherenceFinding>(`/stats/items/${itemId}/adherence?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemStreaks: (itemId: string, w: DateWindow) =>
      apiFetch<StreakFinding>(`/stats/items/${itemId}/streaks?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemTime: (itemId: string, w: DateWindow) =>
      apiFetch<TimeStatsFinding>(`/stats/items/${itemId}/time?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemProcrastination: (itemId: string, w: DateWindow) =>
      apiFetch<ProcrastinationFinding>(`/stats/items/${itemId}/procrastination?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemQuality: (itemId: string, w: DateWindow) =>
      apiFetch<DataQualityFinding>(`/stats/items/${itemId}/quality?startDay=${w.startDay}&endDay=${w.endDay}`),
    crossItemTime: (w: DateWindow) =>
      apiFetch<AdHocShareFinding>(`/stats/time?startDay=${w.startDay}&endDay=${w.endDay}`),
    userQuality: (w: DateWindow) =>
      apiFetch<DataQualityFinding>(`/stats/quality?startDay=${w.startDay}&endDay=${w.endDay}`),
    categoryTime: (categoryId: string, w: DateWindow) =>
      apiFetch<TimeStatsFinding>(`/stats/categories/${categoryId}/time?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemContextStability: (itemId: string, w: DateWindow) =>
      apiFetch<ContextStabilityFinding>(`/stats/items/${itemId}/context-stability?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemAutocorrelation: (itemId: string, w: DateWindow) =>
      apiFetch<AutocorrelationFinding>(`/stats/items/${itemId}/autocorrelation?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemTrajectory: (itemId: string, w: DateWindow) =>
      apiFetch<TrajectoryFinding>(`/stats/items/${itemId}/trajectory?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemDayOfWeek: (itemId: string, w: DateWindow) =>
      apiFetch<DayOfWeekFinding>(`/stats/items/${itemId}/day-of-week?startDay=${w.startDay}&endDay=${w.endDay}`),
    itemWeekdayVsWeekend: (itemId: string, w: DateWindow) =>
      apiFetch<TwoConditionFinding>(`/stats/items/${itemId}/weekday-vs-weekend?startDay=${w.startDay}&endDay=${w.endDay}`),
  },

  // v2 §9.5.2 — Reviews: read-only list + detail.
  reviews: {
    list: (cadence?: ReviewCadence) =>
      apiFetch<Review[]>(`/reviews${cadence ? `?cadence=${cadence}` : ''}`),
    get: (id: string) => apiFetch<Review>(`/reviews/${id}`),
  },
}
