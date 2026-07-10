// v2 §9.5.2 — chronological, readable review list. A zero-recommendation review
// must read as honest and complete, not broken or empty — this is the common
// case early on, so it's designed as the normal state, not an error state.

import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { Review } from '@tracker/shared'
import { RecommendationCard } from './RecommendationCard'

function formatWindow(review: Review): string {
  return `${review.window.startDay} – ${review.window.endDay}`
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

export function ReviewsView() {
  const [reviews, setReviews] = useState<Review[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.reviews.list()
      .then(setReviews)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load reviews'))
  }, [])

  if (error) return <div className="now-view__error" role="alert">{error}</div>

  if (reviews === null) {
    return (
      <div className="now-view__loading">
        <span className="spinner" aria-hidden="true" />&ensp;Loading reviews…
      </div>
    )
  }

  return (
    <div className="reviews-view" data-testid="reviews-view">
      {reviews.length === 0 ? (
        <p className="form-empty" data-testid="reviews-empty">
          No reviews yet — the first one generates once there’s enough history to say something.
        </p>
      ) : (
        <div className="review-list" data-testid="review-list">
          {reviews.map((review) => (
            <div key={review.id} className="review-card" data-testid={`review-${review.id}`}>
              <div className="review-card__header">
                <span className="review-card__cadence">{capitalize(review.cadence)}</span>
                <span className="review-card__window">{formatWindow(review)}</span>
              </div>

              <div className="review-card__prose" data-testid={`review-${review.id}-prose`}>
                {review.prose}
              </div>

              {review.recommendations.length === 0 ? (
                <p className="review-card__no-recs" data-testid={`review-${review.id}-no-recs`}>
                  No recommendations meet the evidence standard this time — that’s a complete, honest
                  result, not a gap.
                </p>
              ) : (
                <div className="review-card__recommendations" data-testid={`review-${review.id}-recommendations`}>
                  {review.recommendations.map((rec, i) => (
                    <RecommendationCard key={i} recommendation={rec} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
