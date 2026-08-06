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
import { occurrenceKey, sortableKey, orderedItemIds } from '../../lib/occurrence-key'

type Props = {
  node: OccurrenceNode
  depth: number
  // `progress` is the parent's derived-% bar; the view must forward it to
  // OccurrenceRow so it renders inside the row (see OccurrenceRow's `progress`
  // prop for why). Children are rendered with it omitted.
  renderLeaf: (occ: OccurrenceNode['occ'], progress?: ReactNode) => ReactNode
  // Patches sortOrder locally for the reordered children — deliberately NOT
  // a full refresh(): both views' refresh() flips a loading flag that
  // unmounts the whole tree while it refetches, which would collapse every
  // expanded card (not just this one) after every single drag. Reordering
  // never changes anything else the client can't already compute itself
  // (unlike completing a child, which needs the server-computed parent
  // derived %), so a local patch is both correct and avoids that unmount.
  // Shared with SortableList's root-level reorder — same shape either way.
  onReordered: (orderedItemIds: string[]) => void
  // Now/List leave this unset (collapsed by default). Calendar's detail
  // panel passes true — opening the panel is already a deliberate "tell me
  // more" click, so a second click just to see children would be redundant.
  defaultExpanded?: boolean
}

// Recursive card wrapper for an occurrence that has ≥1 materialized child
// today. Wraps the existing per-view row renderer rather than duplicating
// checkbox/timing/actions markup — OccurrenceRow itself is untouched.
//
// Children are manually reorderable via drag-and-drop, scoped to this card's
// own DndContext — that's what confines a drag to one parent's list without
// extra validation code (no shared DndContext exists between sibling cards).
export function OccurrenceCard({ node, depth, renderLeaf, onReordered, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  // Optimistic reorder: set immediately on drop, cleared once onReordered's
  // local state patch lands (or reverted on API failure).
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null)
  const { occ, children } = node
  const itemId = occ.itemId

  // §5.5 — keyed by (item, schedule): a child due in two slots today is two rows
  // here, so an item-id override would collapse them into one.
  const displayChildren = orderOverride
    ? orderOverride
        .map((key) => children.find((c) => sortableKey(c.occ) === key))
        .filter((c): c is OccurrenceNode => c !== undefined)
    : children

  // §8.1 — an excused child is out of the derived-% denominator on the server,
  // so it must be out of this label's denominator too; otherwise the count and
  // the bar next to it describe two different sets of children.
  const countedChildren = children.filter((c) => c.occ.disposition.type !== 'excused')
  const completedChildren = countedChildren.filter((c) => c.occ.completionState.isComplete).length
  const totalChildren = countedChildren.length
  const pct = Math.round(occ.completionState.derivedPercent ?? 0)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = displayChildren.findIndex((c) => sortableKey(c.occ) === active.id)
    const newIndex = displayChildren.findIndex((c) => sortableKey(c.occ) === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(displayChildren, oldIndex, newIndex)
    setOrderOverride(reordered.map((c) => sortableKey(c.occ)))

    // reorder-children speaks in item ids and validates the posted list is exactly
    // the current children — so a multi-slot child contributes its id once.
    const newOrderIds = orderedItemIds(reordered.map((c) => c.occ))

    try {
      await api.items.reorderChildren(itemId, newOrderIds)
      onReordered(newOrderIds)
      setOrderOverride(null)
    } catch {
      setOrderOverride(null)
    }
  }

  const cardClasses = [
    'occ-card',
    depth === 0 ? (expanded ? 'occ-card--expanded' : '') : 'occ-card--nested',
  ].filter(Boolean).join(' ')

  // Handed to the row so it sits on its own full-width line *within* the row's
  // flex flow — which is what lets narrow screens order it above the wrapped
  // action buttons instead of below them.
  const progress = (
    <div className="occ-row__progress">
      <div className="occ-row__progress-track">
        <div className="occ-row__progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="occ-row__progress-label" data-testid={`occ-card-progress-${itemId}`}>
        {completedChildren}/{totalChildren}
      </span>
    </div>
  )

  return (
    <div className={cardClasses} data-testid={`occ-card-${itemId}`} data-expanded={expanded}>
      <div className="occ-card__header">
        {renderLeaf(occ, progress)}
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

      {expanded && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={displayChildren.map((c) => sortableKey(c.occ))}
            strategy={verticalListSortingStrategy}
          >
            <div className="occ-card__children" data-testid={`occ-card-children-${itemId}`}>
              {displayChildren.map((child) => (
                <DraggableChild
                  key={occurrenceKey(child.occ)}
                  child={child}
                  depth={depth}
                  renderLeaf={renderLeaf}
                  onReordered={onReordered}
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
  renderLeaf: (occ: OccurrenceNode['occ'], progress?: ReactNode) => ReactNode
  onReordered: (orderedItemIds: string[]) => void
}

function DraggableChild({ child, depth, renderLeaf, onReordered }: DraggableChildProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: sortableKey(child.occ) })

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
          <OccurrenceCard node={child} depth={depth + 1} renderLeaf={renderLeaf} onReordered={onReordered} />
        ) : (
          <div className="occ-card__leaf">{renderLeaf(child.occ)}</div>
        )}
      </div>
    </div>
  )
}
