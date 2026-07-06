export interface HealthResponse {
  status: 'ok' | 'error'
  postgres: 'connected' | 'disconnected'
}
