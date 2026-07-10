// v2 §9.4.1 "Approval UI (minimal)" — the human relevance/fairness step.
//
// Lists entries that have ALREADY cleared verification (the fraud detector) and are
// waiting on a human judgment: does this claim fairly represent the source, and is it
// relevant? The human never has to re-check whether the source is real — that's done.
// Approve / reject. That's all.

import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { EvidenceEntry, EvidenceQuality } from '@tracker/shared'

const QUALITY_LABELS: Record<EvidenceQuality, string> = {
  meta_analysis: 'Meta-analysis',
  systematic_review: 'Systematic review',
  rct: 'Randomized controlled trial',
  observational: 'Observational study',
  mechanistic_plausibility_only: 'Mechanistic plausibility only',
}

export function EvidenceApprovalView() {
  const [entries, setEntries] = useState<EvidenceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // §9.4.1 follow-up — nudge, not gate. Open by default whenever an abstract exists
  // (set once via the `open` prop below and never reassigned by React afterward — see
  // the comment on the <details> element), so the path of least resistance is having
  // the evidence in view; the reviewer must actively collapse it to hide it.
  //
  // Deliberately refs, not React state: an earlier version tracked open/closed via
  // onToggle + useState, but Chromium fires a synthetic 'toggle' event during the
  // initial mount of an already-open <details>, which raced with React's controlled
  // re-render and desynced the tracked state from the real DOM. Reading the actual DOM
  // node's .open property at the moment Approve is clicked is simpler and can't drift.
  const detailsRefs = useRef<Record<string, HTMLDetailsElement | null>>({})

  useEffect(() => {
    api.evidence.pendingApproval()
      .then((data) => {
        setEntries(data)
        setLoading(false)
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load evidence entries')
        setLoading(false)
      })
  }, [])

  async function handleApprove(id: string) {
    setBusyId(id)
    setActionError(null)
    try {
      // Reports whether the panel was actually open in the DOM at this exact moment —
      // diagnostic only. Approval proceeds identically regardless; see evidence/pipeline.ts.
      const abstractVisible = detailsRefs.current[id]?.open ?? false
      await api.evidence.approve(id, { abstractVisible })
      setEntries((prev) => prev.filter((e) => e.id !== id))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve')
    } finally {
      setBusyId(null)
    }
  }

  async function handleReject(id: string) {
    setBusyId(id)
    setActionError(null)
    try {
      await api.evidence.reject(id)
      setEntries((prev) => prev.filter((e) => e.id !== id))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="settings-loading">
        <span className="spinner" aria-hidden="true" />&ensp;Loading evidence entries…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="settings-load-error" role="alert">
        {loadError}
      </div>
    )
  }

  return (
    <div className="evidence-view" data-testid="evidence-view">
      <div className="settings-section">
        <div className="settings-section__header">
          <h2 className="settings-section__title">Evidence awaiting approval</h2>
        </div>
        <div className="settings-section__body">
          <p className="form-note">
            Every entry below already passed verification — its source is real and its claimed
            evidence quality matches PubMed's own record. Your job is only to judge whether the
            claim fairly represents that source and is relevant.
          </p>

          {actionError && (
            <div className="cfg-section-error" role="alert">{actionError}</div>
          )}

          {entries.length === 0 ? (
            <p className="form-empty" data-testid="evidence-empty">
              Nothing awaiting approval right now.
            </p>
          ) : (
            <div className="evidence-list" data-testid="evidence-pending-list">
              {entries.map((entry) => (
                <div key={entry.id} className="evidence-card" data-testid={`evidence-entry-${entry.id}`}>
                  <div className="evidence-card__header">
                    <span className="ds-timeline__badge" data-testid={`evidence-entry-${entry.id}-quality`}>
                      {entry.actualEvidenceQuality ? QUALITY_LABELS[entry.actualEvidenceQuality] : 'Unknown'}
                    </span>
                    <span className="evidence-card__source">
                      {entry.resolvedTitle} — {entry.resolvedJournal}
                      {entry.resolvedYear ? ` (${entry.resolvedYear})` : ''}
                    </span>
                    {entry.resolvedPmid && (
                      <a
                        className="evidence-card__pubmed-link"
                        href={`https://pubmed.ncbi.nlm.nih.gov/${entry.resolvedPmid}/`}
                        target="_blank"
                        rel="noreferrer"
                        data-testid={`evidence-entry-${entry.id}-pubmed-link`}
                      >
                        View on PubMed ↗
                      </a>
                    )}
                  </div>

                  <p className="evidence-card__claim">{entry.claim}</p>
                  <p className="evidence-card__mechanism"><strong>Mechanism:</strong> {entry.mechanism}</p>
                  <p className="evidence-card__justification">
                    <strong>Claimed to report:</strong> {entry.groundedJustification}
                  </p>

                  {/* §9.4.2 — verification cannot catch a misrepresented finding; this is
                      what lets the human actually check the claim above against the
                      source, in place, instead of taking grounded_justification on faith.
                      Open by default (§9.4.1 follow-up) — a nudge, not a gate: nothing
                      here blocks Approve regardless of whether this is open or collapsed. */}
                  {entry.resolvedAbstract ? (
                    // `open` is set once, from a value that never changes across re-renders
                    // (entry.resolvedAbstract is fixed once loaded) — React only writes a DOM
                    // attribute when the prop value differs from what it wrote last render, so
                    // after the initial mount this is left alone and native summary-click
                    // toggling works unimpeded. No onToggle handler — see detailsRefs above.
                    <details
                      className="evidence-card__abstract"
                      open
                      ref={(el) => { detailsRefs.current[entry.id] = el }}
                    >
                      <summary>Check against the abstract</summary>
                      <p data-testid={`evidence-entry-${entry.id}-abstract`}>{entry.resolvedAbstract}</p>
                    </details>
                  ) : (
                    <p className="evidence-card__abstract-missing" data-testid={`evidence-entry-${entry.id}-abstract-missing`}>
                      Abstract unavailable — verify the claim on PubMed before approving.
                    </p>
                  )}

                  <div className="evidence-card__actions">
                    <button
                      className="btn btn--primary"
                      onClick={() => handleApprove(entry.id)}
                      disabled={busyId === entry.id}
                      data-testid={`evidence-entry-${entry.id}-approve`}
                    >
                      Approve
                    </button>
                    <button
                      className="btn btn--danger"
                      onClick={() => handleReject(entry.id)}
                      disabled={busyId === entry.id}
                      data-testid={`evidence-entry-${entry.id}-reject`}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
