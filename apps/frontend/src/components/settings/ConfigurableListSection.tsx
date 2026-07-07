// §7 — Generic add / rename / archive section for categories and reasons.
// Both have the same shape and operations; this component handles both.

import { useState } from 'react'

type Item = { id: string; name: string }

type Props = {
  title: string
  items: Item[]
  onAdd: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onArchive: (id: string) => Promise<void>
  testId: string
}

export function ConfigurableListSection({
  title,
  items,
  onAdd,
  onRename,
  onArchive,
  testId,
}: Props) {
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [renameBusy, setRenameBusy] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAdd() {
    const name = newName.trim()
    if (!name) return
    setAddBusy(true)
    setError(null)
    try {
      await onAdd(name)
      setNewName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add')
    } finally {
      setAddBusy(false)
    }
  }

  function startRename(item: Item) {
    setRenamingId(item.id)
    setRenameValue(item.name)
    setConfirmArchiveId(null)
    setError(null)
  }

  async function handleRename(id: string) {
    const name = renameValue.trim()
    if (!name) return
    setRenameBusy(true)
    setError(null)
    try {
      await onRename(id, name)
      setRenamingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename')
    } finally {
      setRenameBusy(false)
    }
  }

  async function handleArchiveConfirm(id: string) {
    setArchiveBusy(true)
    setError(null)
    try {
      await onArchive(id)
      setConfirmArchiveId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive')
    } finally {
      setArchiveBusy(false)
    }
  }

  const btnSm: React.CSSProperties = {
    padding: 'var(--space-1) var(--space-3)',
    fontSize: 'var(--text-xs)',
  }

  return (
    <div className="settings-section" data-testid={testId}>
      <div className="settings-section__header">
        <h2 className="settings-section__title">{title}</h2>
      </div>
      <div className="settings-section__body">
        {error && (
          <div className="cfg-section-error" role="alert">{error}</div>
        )}

        <div className="cfg-list">
          {items.length === 0 && (
            <p className="cfg-empty">No {title.toLowerCase()} yet.</p>
          )}
          {items.map((item) => (
            <div key={item.id} className="cfg-list-row" data-testid={`${testId}-row-${item.id}`}>
              {renamingId === item.id ? (
                /* inline rename form */
                <div className="cfg-rename-wrap">
                  <input
                    className="cfg-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(item.id)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    autoFocus
                    data-testid={`${testId}-row-${item.id}-rename-input`}
                  />
                  <button
                    className="btn btn--primary"
                    style={btnSm}
                    onClick={() => handleRename(item.id)}
                    disabled={!renameValue.trim() || renameBusy}
                    data-testid={`${testId}-row-${item.id}-rename-save`}
                  >
                    Save
                  </button>
                  <button
                    className="btn btn--ghost"
                    style={btnSm}
                    onClick={() => setRenamingId(null)}
                    data-testid={`${testId}-row-${item.id}-rename-cancel`}
                  >
                    Cancel
                  </button>
                </div>
              ) : confirmArchiveId === item.id ? (
                /* inline archive confirmation */
                <div className="cfg-rename-wrap">
                  <span className="cfg-list-row__name" style={{ color: 'var(--color-text-secondary)' }}>
                    Archive &ldquo;{item.name}&rdquo;?
                  </span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-tertiary)' }}>
                    History preserved.
                  </span>
                  <button
                    className="btn btn--danger"
                    style={btnSm}
                    onClick={() => handleArchiveConfirm(item.id)}
                    disabled={archiveBusy}
                    data-testid={`${testId}-row-${item.id}-archive-confirm`}
                  >
                    Archive
                  </button>
                  <button
                    className="btn btn--ghost"
                    style={btnSm}
                    onClick={() => setConfirmArchiveId(null)}
                    data-testid={`${testId}-row-${item.id}-archive-cancel-confirm`}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                /* normal display */
                <>
                  <span className="cfg-list-row__name">{item.name}</span>
                  <div className="cfg-list-row__actions">
                    <button
                      className="btn btn--ghost"
                      style={btnSm}
                      onClick={() => startRename(item)}
                      data-testid={`${testId}-row-${item.id}-rename-btn`}
                    >
                      Rename
                    </button>
                    <button
                      className="btn btn--danger"
                      style={btnSm}
                      onClick={() => {
                        setConfirmArchiveId(item.id)
                        setRenamingId(null)
                      }}
                      data-testid={`${testId}-row-${item.id}-archive-btn`}
                    >
                      Archive
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {/* add form */}
        <div className="cfg-add-row">
          <input
            className="cfg-add-input"
            type="text"
            placeholder={`Add ${title.slice(0, -1).toLowerCase()}…`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            data-testid={`${testId}-add-input`}
          />
          <button
            className="btn btn--primary"
            onClick={handleAdd}
            disabled={!newName.trim() || addBusy}
            data-testid={`${testId}-add-submit`}
          >
            {addBusy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
