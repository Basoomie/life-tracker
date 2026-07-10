// v2 §9.5.1 — Stats container: Global ("where should I look?") and Per-item
// ("what's going on with this?") are two different tools answering different
// questions, not primary/secondary. This component is just the sub-nav + window
// + item selector chrome around them. No AI narration here — Stats is the
// daily-glance surface (§6.4).

import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import type { Item } from '@tracker/shared'
import { STATS_WINDOW_OPTIONS, getStatsWindow, type StatsWindowKey } from '../../lib/stats-presentation'
import { GlobalStatsView } from './GlobalStatsView'
import { ItemStatsView } from './ItemStatsView'

type SubView = 'global' | 'item'

const WINDOW_KEYS = new Set(STATS_WINDOW_OPTIONS.map((o) => o.key))

export function StatsView() {
  // §9 view-state persistence (same tracker:<view>-<key> convention as List/Calendar) —
  // switching tabs must not reset the surface back to its defaults.
  const [subView, setSubView] = useState<SubView>(() => {
    const saved = localStorage.getItem('tracker:stats-subView')
    return saved === 'item' ? 'item' : 'global'
  })
  const [windowKey, setWindowKey] = useState<StatsWindowKey>(() => {
    const saved = localStorage.getItem('tracker:stats-windowKey')
    return saved && WINDOW_KEYS.has(saved as StatsWindowKey) ? (saved as StatsWindowKey) : 'last-3-months'
  })
  const [items, setItems] = useState<Item[]>([])
  const [selectedItemId, setSelectedItemId] = useState<string | null>(() =>
    localStorage.getItem('tracker:stats-selectedItemId')
  )

  useEffect(() => {
    api.items.list().then(setItems).catch(() => {})
  }, [])

  useEffect(() => { localStorage.setItem('tracker:stats-subView', subView) }, [subView])
  useEffect(() => { localStorage.setItem('tracker:stats-windowKey', windowKey) }, [windowKey])
  useEffect(() => {
    if (selectedItemId) localStorage.setItem('tracker:stats-selectedItemId', selectedItemId)
    else localStorage.removeItem('tracker:stats-selectedItemId')
  }, [selectedItemId])

  // Restored 'item' sub-view with no restored item id (e.g. cleared storage
  // mid-session) has nothing to show — fall back to Global rather than a blank pane.
  const effectiveSubView: SubView = subView === 'item' && !selectedItemId ? 'global' : subView

  const window = getStatsWindow(windowKey)

  function handleSelectItem(itemId: string) {
    setSelectedItemId(itemId)
    setSubView('item')
  }

  return (
    <div className="stats-view" data-testid="stats-view">
      <div className="stats-view__toolbar">
        <div className="stats-subnav" role="tablist" aria-label="Stats view">
          <button
            className={`stats-subnav__tab${effectiveSubView === 'global' ? ' stats-subnav__tab--active' : ''}`}
            onClick={() => setSubView('global')}
            data-testid="stats-subnav-global"
          >
            Global
          </button>
          <button
            className={`stats-subnav__tab${effectiveSubView === 'item' ? ' stats-subnav__tab--active' : ''}`}
            onClick={() => selectedItemId && setSubView('item')}
            disabled={!selectedItemId}
            data-testid="stats-subnav-item"
          >
            Per-item
          </button>
        </div>

        <select
          className="stats-window-select"
          value={windowKey}
          onChange={(e) => setWindowKey(e.target.value as StatsWindowKey)}
          data-testid="stats-window-select"
          aria-label="Stats window"
        >
          {STATS_WINDOW_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>

        {effectiveSubView === 'item' && (
          <select
            className="stats-item-select"
            value={selectedItemId ?? ''}
            onChange={(e) => setSelectedItemId(e.target.value || null)}
            data-testid="stats-item-select"
            aria-label="Item"
          >
            <option value="" disabled>Choose an item…</option>
            {items.filter((i) => i.archivedAt === null).map((i) => (
              <option key={i.id} value={i.id}>{i.name}</option>
            ))}
          </select>
        )}
      </div>

      {effectiveSubView === 'global' && (
        <GlobalStatsView window={window} onSelectItem={handleSelectItem} />
      )}
      {effectiveSubView === 'item' && selectedItemId && (
        <ItemStatsView itemId={selectedItemId} window={window} onBack={() => setSubView('global')} />
      )}
    </div>
  )
}
