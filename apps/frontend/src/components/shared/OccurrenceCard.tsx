import { useState } from 'react'
import type { ReactNode } from 'react'
import type { OccurrenceNode } from '../../lib/occurrence-tree'

type Props = {
  node: OccurrenceNode
  depth: number
  renderLeaf: (occ: OccurrenceNode['occ']) => ReactNode
}

// Recursive card wrapper for an occurrence that has ≥1 materialized child
// today. Wraps the existing per-view row renderer rather than duplicating
// checkbox/timing/actions markup — OccurrenceRow itself is untouched.
export function OccurrenceCard({ node, depth, renderLeaf }: Props) {
  const [expanded, setExpanded] = useState(false)
  const { occ, children } = node
  const itemId = occ.itemId

  const completedChildren = children.filter((c) => c.occ.completionState.isComplete).length
  const totalChildren = children.length
  const pct = Math.round(occ.completionState.derivedPercent ?? 0)

  const cardClasses = [
    'occ-card',
    depth === 0 ? (expanded ? 'occ-card--expanded' : '') : 'occ-card--nested',
  ].filter(Boolean).join(' ')

  return (
    <div className={cardClasses} data-testid={`occ-card-${itemId}`} data-expanded={expanded}>
      <div className="occ-card__header">
        {renderLeaf(occ)}
        <button
          className="occ-card__toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${occ.snapshot.name}` : `Expand ${occ.snapshot.name}`}
          data-testid={`occ-card-toggle-${itemId}`}
        >
          <span aria-hidden="true">{expanded ? '▲' : '▼'}</span>
        </button>
      </div>

      <div className="occ-card__progress">
        <div className="occ-card__progress-track">
          <div className="occ-card__progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="occ-card__progress-label" data-testid={`occ-card-progress-${itemId}`}>
          {completedChildren}/{totalChildren}
        </span>
      </div>

      {expanded && (
        <div className="occ-card__children" data-testid={`occ-card-children-${itemId}`}>
          {children.map((child) =>
            child.children.length > 0 ? (
              <OccurrenceCard key={child.occ.itemId} node={child} depth={depth + 1} renderLeaf={renderLeaf} />
            ) : (
              <div key={child.occ.itemId} className="occ-card__leaf">
                {renderLeaf(child.occ)}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
