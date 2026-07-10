// v2 §6.3 / §9.4.1 — "The known-good levers are a starting kit, not a ceiling."
// Seeded: context stability / stable cues, friction reduction, repetition in a
// stable context, not over-reacting to misses.
//
// These are REAL, checkable sources — chosen by actually resolving them against
// PubMed before writing this file (not recalled from memory, which is exactly the
// failure mode §9.4 exists to catch). Each candidate below is expected to pass
// verifyCandidate() against the live API. They still go through
// proposeEvidenceEntry() like anything else — no privileged bypass (§9.4.1).
//
// Note the honest asymmetry between the two sources used:
//   - Gardner, Lally & Wardle (2012), Br J Gen Pract, PMID 23211256, is tagged only
//     "Journal Article" in PubMed (it's a short viewpoint piece, not a formal review)
//     — so three of the four claims below honestly claim the weakest tier,
//     'mechanistic_plausibility_only', even though the piece is widely treated as
//     authoritative. That IS the system working as designed: it never asserts more
//     than the record supports.
//   - Adriaanse et al. (2011), Appetite, is a real meta-analysis (PubMed tags it
//     both "Meta-Analysis" and "Systematic Review") — claimed here as 'meta_analysis'.

import type { EvidenceCandidate } from '@tracker/shared'

export const KNOWN_GOOD_LEVERS: EvidenceCandidate[] = [
  // ── Context stability / stable cues ──────────────────────────────────────────
  {
    claim:
      'Anchoring a habit to a consistent situational cue (same time, same place, same preceding action) helps performance become automatic, because the cue itself comes to trigger the behaviour rather than requiring a fresh decision each time.',
    mechanism:
      'Repetition in a stable context builds a learned association between the cue and the action (associative/cue-based learning); once formed, the cue triggers the behaviour with reduced reliance on conscious motivation.',
    sourceIdentifierType: 'pmid',
    sourceIdentifier: '23211256',
    claimedEvidenceQuality: 'mechanistic_plausibility_only',
    groundedJustification:
      'The article states habits are "actions that are triggered automatically in response to contextual cues that have been associated with their performance," and that "mere repetition of a simple action in a consistent context leads, through associative learning," to automatic performance.',
  },

  // ── Repetition in a stable context ──────────────────────────────────────────
  {
    claim:
      'Repeating a simple action in the same context leads to it becoming automatic on an asymptotic curve — fast initial gains that slow to a plateau over roughly two months — rather than at a fixed day-count threshold.',
    mechanism:
      'Automaticity accrues gradually with each repetition in a stable context; simpler actions require fewer repetitions to plateau than complex, multi-step routines.',
    sourceIdentifierType: 'pmid',
    sourceIdentifier: '23211256',
    claimedEvidenceQuality: 'mechanistic_plausibility_only',
    groundedJustification:
      'The article reports automaticity gains showed "an asymptotic increase, with an initial acceleration that slowed to a plateau after an average of 66 days," and notes "simpler actions become habitual more quickly" than elaborate routines.',
  },

  // ── Not over-reacting to misses (§5.4's single-miss constraint) ─────────────
  {
    claim:
      'Missing a single occasion to perform a habitual behaviour does not meaningfully derail habit formation; automatic performance resumes after the lapse.',
    mechanism:
      'Habit strength accumulates over many repetitions, so one missed instance is a small perturbation against the accumulated cue-behaviour association, not a reset of it.',
    sourceIdentifierType: 'pmid',
    sourceIdentifier: '23211256',
    claimedEvidenceQuality: 'mechanistic_plausibility_only',
    groundedJustification:
      'The article states: "Missing the occasional opportunity to perform the behaviour did not seriously impair the habit formation process: automaticity gains soon resumed after one missed performance."',
  },

  // ── Friction reduction ───────────────────────────────────────────────────────
  {
    claim:
      'Forming a concrete if-then plan (an implementation intention specifying when, where, and how a behaviour will be performed) increases the likelihood the behaviour is actually carried out — particularly for starting or increasing a wanted behaviour, less so for suppressing an unwanted one.',
    mechanism:
      'An implementation intention delegates control of the behaviour to an anticipated situational cue at the planning stage, reducing the in-the-moment friction and decision cost of initiating it.',
    sourceIdentifierType: 'doi',
    sourceIdentifier: '10.1016/j.appet.2010.10.012',
    claimedEvidenceQuality: 'meta_analysis',
    groundedJustification:
      'A meta-analysis of 23 studies found implementation intentions moderately effective at increasing healthy food consumption (Cohen\'s d = 0.51) and less strongly effective at reducing unhealthy eating (d = 0.29) — if-then plans work better for initiating a wanted behaviour than for suppressing an unwanted one.',
  },
]
