// §12.4 — Proportional time grid for a single day.
// Core requirement: a 2.5h block renders 2.5× the height of a 1h block.

import { useEffect, useRef, useState } from 'react'
import { OccurrenceRow } from '../now/OccurrenceRow'
import { computeDayLayout, nowLinePx, TOTAL_PX, PX_PER_HOUR } from '../../lib/calendar-layout'
import type { GridBlock, DayLayout } from '../../lib/calendar-layout'
import type { OccurrenceWithState, Bucket } from '@tracker/shared'
import type { SessionState } from '../now/TimerControl'

type Props = {
  day: string       // YYYY-MM-DD
  isToday: boolean
  occs: OccurrenceWithState[]
  buckets: Bucket[]
  dayStart: string  // HH:MM
  now: Date
  sessions: Map<string, SessionState>
  onComplete: (occ: OccurrenceWithState) => void
  onUncomplete: (occ: OccurrenceWithState) => void
  onTimerStart: (occ: OccurrenceWithState) => void
  onTimerPause: (occ: OccurrenceWithState) => void
  onTimerResume: (occ: OccurrenceWithState) => void
  onTimerStop: (occ: OccurrenceWithState) => void
  onDisposition: (occ: OccurrenceWithState) => void
  onEdit: (itemId: string) => void
  onArchive: (occ: OccurrenceWithState) => void
}

// Hour labels on the time axis (every 2 hours for readability)
function buildHourLabels(dayStart: string): Array<{ label: string; topPx: number }> {
  const [sh] = dayStart.split(':').map(Number)
  const labels = []
  for (let i = 0; i < 24; i += 2) {
    const h = (sh + i) % 24
    const topPx = i * PX_PER_HOUR
    labels.push({ label: `${String(h).padStart(2, '0')}:00`, topPx })
  }
  return labels
}

function blockTitle(block: GridBlock): string {
  const { timingStartTime, timingEndTime, name } = block.occ.snapshot
  if (block.kind === 'range' && timingStartTime && timingEndTime) {
    return `${name} ${timingStartTime}–${timingEndTime}`
  }
  if (block.kind === 'point' && timingStartTime) return `${name} @ ${timingStartTime}`
  return name
}

export function TimeGrid({
  day,
  isToday,
  occs,
  buckets,
  dayStart,
  now,
  sessions,
  onComplete,
  onUncomplete,
  onTimerStart,
  onTimerPause,
  onTimerResume,
  onTimerStop,
  onDisposition,
  onEdit,
  onArchive,
}: Props) {
  const layout: DayLayout = computeDayLayout(occs, buckets, dayStart)
  const hourLabels = buildHourLabels(dayStart)
  const nowPx = isToday ? nowLinePx(now, dayStart) : null
  const [selected, setSelected] = useState<OccurrenceWithState | null>(null)
  const [showGutter, setShowGutter] = useState(true)
  const panelRef = useRef<HTMLDivElement>(null)

  // Close detail panel when clicking outside
  useEffect(() => {
    if (!selected) return
    function onPointerDown(e: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setSelected(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [selected])

  // Keep detail panel in sync after complete/uncomplete updates the occurrence
  useEffect(() => {
    if (!selected) return
    const latest = occs.find((o) =>
      o.id !== null ? o.id === selected.id : o.itemId === selected.itemId
    )
    if (latest && latest !== selected) setSelected(latest)
  }, [occs, selected])

  return (
    <div className="cal-day" data-testid={`cal-day-${day}`}>
      {/* Grid column — time grid + its detail panel, grouped so the unscheduled gutter can sit beside it as a sidebar */}
      <div className="cal-grid-col">
        {/* Time grid — primary element */}
        <div className="cal-grid-wrap">
          {/* Hour axis */}
          <div className="cal-time-axis" aria-hidden="true" style={{ height: `${TOTAL_PX}px` }}>
            {hourLabels.map(({ label, topPx }) => (
              <span
                key={label}
                className="cal-hour-label"
                style={{ top: `${topPx}px` }}
              >
                {label}
              </span>
            ))}
          </div>

          {/* Grid inner */}
          <div className="cal-grid" style={{ height: `${TOTAL_PX}px` }}>
            {/* Hour lines */}
            {hourLabels.map(({ topPx, label }) => (
              <div key={label} className="cal-hour-line" style={{ top: `${topPx}px` }} />
            ))}

            {/* Now indicator */}
            {nowPx !== null && (
              <div
                className="cal-now-line"
                style={{ top: `${nowPx}px` }}
                data-testid="cal-now-line"
                aria-label="Current time"
              />
            )}

            {/* Blocks */}
            {layout.blocks.map((block) => {
              const occId = block.occ.id ?? block.occ.itemId
              const isSelected = selected?.id === block.occ.id && selected?.itemId === block.occ.itemId
              return (
                <button
                  key={occId}
                  className={[
                    'cal-block',
                    `cal-block--${block.kind}`,
                    block.occ.completionState.isComplete ? 'cal-block--done' : '',
                    isSelected ? 'cal-block--selected' : '',
                  ].filter(Boolean).join(' ')}
                  style={{
                    top:    `${block.topPx}px`,
                    height: `${block.heightPx}px`,
                    left:   `${block.leftPct}%`,
                    width:  `${block.widthPct}%`,
                  }}
                  onClick={() => setSelected(isSelected ? null : block.occ)}
                  title={blockTitle(block)}
                  data-testid={`cal-block-${occId}`}
                  data-kind={block.kind}
                  data-top-px={Math.round(block.topPx)}
                  data-height-px={Math.round(block.heightPx)}
                  aria-label={blockTitle(block)}
                >
                  <span className="cal-block__name">{block.occ.snapshot.name}</span>
                  {block.kind === 'range' && block.occ.snapshot.timingStartTime && (
                    <span className="cal-block__time">
                      {block.occ.snapshot.timingStartTime}
                      {block.occ.snapshot.timingEndTime ? `–${block.occ.snapshot.timingEndTime}` : ''}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Detail panel — shown when a block is selected */}
        {selected && (
          <div ref={panelRef} className="cal-detail-panel" data-testid="cal-detail-panel">
            <OccurrenceRow
              occ={selected}
              buckets={buckets}
              isToday={isToday}
              session={sessions.get(selected.id ?? selected.itemId)}
              onComplete={() => onComplete(selected)}
              onUncomplete={() => onUncomplete(selected)}
              onTimerStart={() => onTimerStart(selected)}
              onTimerPause={() => onTimerPause(selected)}
              onTimerResume={() => onTimerResume(selected)}
              onTimerStop={() => { onTimerStop(selected); setSelected(null) }}
              onDisposition={() => { onDisposition(selected); setSelected(null) }}
              onEdit={() => onEdit(selected.itemId)}
              onArchive={() => { onArchive(selected); setSelected(null) }}
            />
          </div>
        )}
      </div>

      {/* Unscheduled gutter — beside the grid on wide layouts, below it on narrow ones */}
      {layout.gutter.length > 0 && (
        <div className="cal-gutter" data-testid={`cal-gutter-${day}`}>
          <button
            className="tier-header tier-header--btn cal-gutter__header"
            onClick={() => setShowGutter((v) => !v)}
            aria-expanded={showGutter}
          >
            <span className="tier-label">Unscheduled</span>
            <span className="tier-count">{layout.gutter.length}</span>
            <span className="tier-header__chevron" aria-hidden="true">{showGutter ? '▲' : '▼'}</span>
          </button>
          {showGutter && layout.gutter.map((occ) => {
            const occId = occ.id ?? occ.itemId
            return (
              <OccurrenceRow
                key={occId}
                occ={occ}
                buckets={buckets}
                isToday={isToday}
                session={sessions.get(occId)}
                onComplete={() => onComplete(occ)}
                onUncomplete={() => onUncomplete(occ)}
                onTimerStart={() => onTimerStart(occ)}
                onTimerPause={() => onTimerPause(occ)}
                onTimerResume={() => onTimerResume(occ)}
                onTimerStop={() => onTimerStop(occ)}
                onDisposition={() => onDisposition(occ)}
                onEdit={() => onEdit(occ.itemId)}
                onArchive={() => onArchive(occ)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
