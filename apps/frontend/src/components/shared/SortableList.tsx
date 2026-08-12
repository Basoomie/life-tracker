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
import { occurrenceKey, sortableKey, orderedItemIds } from '../../lib/occurrence-key'
import { isRootItem } from '../../lib/occurrence-tree'

type Props = {
  items: OccurrenceWithState[]   // already sorted by sortOrder
  renderItem: (occ: OccurrenceWithState) => ReactNode
  onReordered: (orderedItemIds: string[]) => void
}

export function SortableList({ items, renderItem, onReordered }: Props) {
  // Optimistic reorder: set immediately on drop, cleared once onReordered's
  // local state patch lands (or reverted on API failure) — same pattern as
  // OccurrenceCard's orderOverride.
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null)
  // A failed reorder used to revert in silence, which looks exactly like a drag
  // that never registered — the reason a 400 from reorder-root took a long
  // debugging session to find. Failures are shown.
  const [error, setError] = useState<string | null>(null)

  // §4.1 — reorder-root only accepts genuinely top-level items, so only those
  // are draggable. A detached child (due today, parent not) renders below them
  // as a plain row: dragging it would post its id to reorder-root and be
  // refused, and leaving it in the sortable set would also let it become some
  // other row's afterItemId, failing that drag too.
  const rootItems = items.filter(isRootItem)
  const detachedChildren = items.filter((o) => !isRootItem(o))

  // §5.5 — keyed by (item, schedule): a two-slot item is two rows here, so an
  // item-id override would collapse them into one.
  const displayItems = orderOverride
    ? orderOverride
        .map((key) => rootItems.find((o) => sortableKey(o) === key))
        .filter((o): o is OccurrenceWithState => o !== undefined)
    : rootItems

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = displayItems.findIndex((o) => sortableKey(o) === active.id)
    const newIndex = displayItems.findIndex((o) => sortableKey(o) === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(displayItems, oldIndex, newIndex)
    setOrderOverride(reordered.map(sortableKey))

    // The endpoint reorders the ITEM (Item.sortOrder), so the dragged row and its
    // landing neighbour both resolve to item ids. A neighbour that is another slot of
    // the same item is skipped: "after myself" is not a move.
    const moved = reordered[reordered.findIndex((o) => sortableKey(o) === active.id)]
    let afterItemId: string | null = null
    for (let i = reordered.findIndex((o) => sortableKey(o) === active.id) - 1; i >= 0; i--) {
      if (reordered[i].itemId !== moved.itemId) { afterItemId = reordered[i].itemId; break }
    }

    try {
      setError(null)
      await api.items.reorderRoot(moved.itemId, afterItemId)
      onReordered(orderedItemIds(reordered))
      setOrderOverride(null)
    } catch (e) {
      setOrderOverride(null)
      setError(e instanceof Error ? e.message : 'Could not save the new order')
    }
  }

  return (
    <>
      {error && (
        <div className="sortable-list__error" role="alert" data-testid="reorder-error">
          {error}
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={displayItems.map(sortableKey)} strategy={verticalListSortingStrategy}>
          {displayItems.map((occ) => (
            <SortableRow
              key={occurrenceKey(occ)}
              sortId={sortableKey(occ)}
              itemId={occ.itemId}
              name={occ.snapshot.name}
            >
              {renderItem(occ)}
            </SortableRow>
          ))}
        </SortableContext>
      </DndContext>
      {/* §4.1 — after the draggable top-level rows, never interleaved with them:
          their position is their parent's business, not this list's. */}
      {detachedChildren.map((occ) => (
        <div key={occurrenceKey(occ)} data-testid={`detached-child-${occ.itemId}`}>
          {renderItem(occ)}
        </div>
      ))}
    </>
  )
}

type RowProps = { sortId: string; itemId: string; name: string; children: ReactNode }

// Reuses OccurrenceCard's drag-handle styling — the classes aren't scoped to
// being inside a card, just a generic "draggable row with a handle" shape.
function SortableRow({ sortId, itemId, name, children }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: sortId })

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
