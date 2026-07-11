// Manual drag-and-drop order for top-level (parentless) items — same
// mechanism as OccurrenceCard's child reordering, but for a flat list
// instead of a card's nested children. Order lives on Item.sortOrder (see
// reorder-root), so it's global per item: reordering here is visible in
// every view that shows unscheduled items, not scoped to this list instance.
//
// Unlike OccurrenceCard's children (always rendered unfiltered), the items
// passed in here are routinely a filtered/tiered subset — Now view's
// "actionable today" tier, List view's active filters, Calendar's per-day
// gutter. So a drag only tells the server "put this item after that one"
// (reorder-root), never the full sibling set.
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
import type { OccurrenceWithState } from '@tracker/shared'
import { api } from '../../lib/api'

type Props = {
  items: OccurrenceWithState[]   // already sorted by sortOrder; root items only
  renderItem: (occ: OccurrenceWithState) => ReactNode
  onReordered: (orderedItemIds: string[]) => void
}

export function SortableList({ items, renderItem, onReordered }: Props) {
  // Optimistic reorder: set immediately on drop, cleared once onReordered's
  // local state patch lands (or reverted on API failure) — same pattern as
  // OccurrenceCard's orderOverride.
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null)

  const displayItems = orderOverride
    ? orderOverride
        .map((id) => items.find((o) => o.itemId === id))
        .filter((o): o is OccurrenceWithState => o !== undefined)
    : items

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = displayItems.findIndex((o) => o.itemId === active.id)
    const newIndex = displayItems.findIndex((o) => o.itemId === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(displayItems, oldIndex, newIndex)
    const newOrderIds = reordered.map((o) => o.itemId)
    setOrderOverride(newOrderIds)

    const movedItemId = active.id as string
    const droppedAtIndex = reordered.findIndex((o) => o.itemId === movedItemId)
    const afterItemId = droppedAtIndex === 0 ? null : reordered[droppedAtIndex - 1].itemId

    try {
      await api.items.reorderRoot(movedItemId, afterItemId)
      onReordered(newOrderIds)
      setOrderOverride(null)
    } catch {
      setOrderOverride(null)
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={displayItems.map((o) => o.itemId)} strategy={verticalListSortingStrategy}>
        {displayItems.map((occ) => (
          <SortableRow key={occ.itemId} itemId={occ.itemId} name={occ.snapshot.name}>
            {renderItem(occ)}
          </SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  )
}

type RowProps = { itemId: string; name: string; children: ReactNode }

// Reuses OccurrenceCard's drag-handle styling — the classes aren't scoped to
// being inside a card, just a generic "draggable row with a handle" shape.
function SortableRow({ itemId, name, children }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: itemId })

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
        aria-label={`Drag to reorder ${name}`}
        data-testid={`root-drag-handle-${itemId}`}
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <div className="occ-card__draggable-content">{children}</div>
    </div>
  )
}
