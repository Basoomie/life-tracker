import { useState, useEffect } from 'react'
import type { HealthResponse } from '@tracker/shared'

type ConnectionState = 'checking' | 'connected' | 'disconnected'

export function App() {
  const [state, setState] = useState<ConnectionState>('checking')

  useEffect(() => {
    fetch('/health')
      .then((res) => res.json() as Promise<HealthResponse>)
      .then((data) => setState(data.status === 'ok' ? 'connected' : 'disconnected'))
      .catch(() => setState('disconnected'))
  }, [])

  const label =
    state === 'checking'
      ? 'Checking...'
      : state === 'connected'
        ? 'Connected'
        : 'Not connected'

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>Tracker</h1>
      <p>
        Backend status: <strong data-testid="connection-status">{label}</strong>
      </p>
    </div>
  )
}
