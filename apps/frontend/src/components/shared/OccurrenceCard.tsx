import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, useSortable,
  arrayMove, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { OccurrenceNode } from '../../lib/occurrence-tree'
import { api } from '../../lib/api'

type Props = {
  node: OccurrenceNode
  depth: number
  renderLeaf: (occ: OccurrenceNode['occ']) => ReactNode
  refresh: () => void
}

// Recursive card wrapper for an occurrence that has ≥1 materialized child
// today. Wraps the existing per-view row renderer rather than duplicating
// checkbox/timing/actions markup — OccurrenceRow itself is untouched.
//
// Children are manually reorderable via drag-and-drop, scoped to this card's
// own DndContext — that's what confines a drag to one parent's list without
// extra validation code (no shared DndContext exists between sibling cards).
export function OccurrenceCard({ node, depth, renderLeaf, refresh }: Props) {
  const [expanded, setExpanded] = useState(false)
  // Optimistic reorder: set immediately on drop, cleared once the server
  // round-trip resolves (refresh() brings fresh, authoritative sortOrder) or
  // reverted on failure.
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null)
  const { occ, children } = node
  const itemId = occ.itemId

  const displayChildren = orderOverride
    ? orderOverride
        .map((id) => children.find((c) => c.occ.itemId === id))
        .filter((c): c is OccurrenceNode => c !== undefined)
    : children

  const completedChildren = children.filter((c) => c.occ.completionState.isComplete).length
  const totalChildren = children.length
  const pct = Math.round(occ.completionState.derivedPercent ?? 0)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = displayChildren.findIndex((c) => c.occ.itemId === active.id)
    const newIndex = displayChildren.findIndex((c) => c.occ.itemId === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const newOrderIds = arrayMove(displayChildren, oldIndex, newIndex).map((c) => c.occ.itemId)
    setOrderOverride(newOrderIds)

    try {
      await api.items.reorderChildren(itemId, newOrderIds)
      refresh()
    } catch {
      setOrderOverride(null)
    }
  }

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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={displayChildren.map((c) => c.occ.itemId)}
            strategy={verticalListSortingStrategy}
          >
            <div className="occ-card__children" data-testid={`occ-card-children-${itemId}`}>
              {displayChildren.map((child) => (
                <DraggableChild
                  key={child.occ.itemId}
                  child={child}
                  depth={depth}
                  renderLeaf={renderLeaf}
                  refresh={refresh}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

type DraggableChildProps = {
  child: OccurrenceNode
  depth: number
  renderLeaf: (occ: OccurrenceNode['occ']) => ReactNode
  refresh: () => void
}

function DraggableChild({ child, depth, renderLeaf, refresh }: DraggableChildProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: child.occ.itemId })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`occ-card__draggable${isDragging ? ' occ-card__draggable--dragging' : ''}`}
    >
      <button
        className="occ-card__drag-handle"
        aria-label={`Drag to reorder ${child.occ.snapshot.name}`}
        data-testid={`occ-card-drag-handle-${child.occ.itemId}`}
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <div className="occ-card__draggable-content">
        {child.children.length > 0 ? (
          <OccurrenceCard node={child} depth={depth + 1} renderLeaf={renderLeaf} refresh={refresh} />
        ) : (
          <div className="occ-card__leaf">{renderLeaf(child.occ)}</div>
        )}
      </div>
    </div>
  )
}
