type Props = {
  title: string
  message: string
  confirmLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  busy,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      data-testid="confirm-modal"
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal__header">
          <h2 className="modal__title" id="confirm-title">{title}</h2>
          <button className="modal__close" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="modal__body">
          <p style={{ margin: 0 }}>{message}</p>
        </div>
        <div className="modal__footer">
          <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-modal-confirm"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
