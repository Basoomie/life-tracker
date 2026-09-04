type Props = {
  title: string
  message: string
  confirmLabel?: string
  busy?: boolean
  // §5.6 — not every confirmation is a destructive one. Making a task inactive is
  // reversible and is the whole point of the feature, so dressing its button in the
  // delete colour would tell the user the opposite of the truth. Defaults to 'danger'
  // because every caller that predates this one is in fact destructive.
  variant?: 'danger' | 'neutral'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  busy,
  variant = 'danger',
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
            className={variant === 'danger' ? 'btn btn--danger' : 'btn'}
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
