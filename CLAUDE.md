# CLAUDE.md — Project Constraints & Working Agreement

This file governs how you (Claude Code) work on this project. Read it at the start of **every** session. `/docs/design.md` is the authoritative specification; this file is the non-negotiable working rules. If anything you're about to do conflicts with either, stop and flag it instead of proceeding.

---

## The spec is authoritative

- `/docs/design.md` defines what this system is and how it must behave. Build **from the spec**. Do not re-derive, reinterpret, or "improve" settled decisions. If the spec is ambiguous or seems wrong, **ask** — do not silently choose.
- When you implement a behavior the spec describes, the spec's wording is the source of truth for how it should work.

## Core design principles (from the spec — never violate)

1. **Never silently mutate the user's data or schedule.** Nothing moves, closes, completes, or changes without either an explicit user action or a clearly-defined, logged rule. When in doubt, do less and surface the decision to the user.
2. **Event-sourced, derived state.** The event log is the source of truth. Current state is _derived_ by replaying events. Events are **immutable** — corrections are new events, never edits-in-place. Do not store derived values as if they were source truth (blocked-status, streaks, adherence, derived parent %, etc. are computed, not stored).
3. **History is immutable; config changes are forward-only.** Editing a template affects future occurrences only; past/materialized occurrences are frozen (they snapshot their fields). Day-start changes append to a timeline and never re-bucket past days.
4. **Capture everything v2 might want.** Record timestamps (both recorded-at and applies-to), skips, excuses, reschedules, reasons, ad-hoc flags, planned-vs-actual — even though v2 isn't built. Cheap now, impossible to backfill.

## Naming & rename-proofing (hard rule)

- **"life-tracker" is a display/branding label ONLY.** It must never appear in internal identifiers.
- Database name and Docker volume names: **neutral/generic** (e.g. `app`, `tracker`) — never the branded name.
- Table / schema / module names: named for **what they hold** (`items`, `events`, `occurrences`, `sessions`), never `life_tracker_*`.
- Keep all branding in a single config/env location so a future rename is a cosmetic change, not a migration.

## Multi-user scoping (hard rule)

- v1 is single-user, but **every user-owned entity carries `user_id` from day one** (items, occurrences, events, sessions, categories, reasons, config). v1 always uses the same user.
- Never write a query or schema that assumes a single user in a way that would require a migration to add multi-user later.

## Stack (locked — do not substitute)

- **Frontend:** React + TypeScript, built with Vite. No SSR meta-framework. PWA-ready but not PWA yet.
- **Backend:** Node + TypeScript, Fastify.
- **Database:** Postgres, accessed via direct / light-layer SQL. **No heavy ORM** — keep window functions and date math readable.
- **Shared types:** domain types (Item, Occurrence, Event, etc.) defined **once** and shared across frontend and backend. The API must not be able to drift from the client.
- **One self-contained Docker Compose stack** (app + Postgres), matching the NAS conventions in `/docs/design.md` §13.3.

## Testing discipline (STRICT — no exceptions)

- **Tests are derived from the spec's stated behaviors, and named after the spec's rules.** A reviewer skimming the test list should read the design back. A behavior in the spec with no test is incomplete work.
- **Strict green gate:** no step/layer is complete until its **entire** suite — unit, integration, AND Playwright E2E — passes. Do **not** begin the next layer while the current one is red. Do not declare a step done on red.
- **Flaky tests are defects, not noise.** If a test is nondeterministic, root-cause it:
  - Real app-level race/nondeterminism → **fix the app.**
  - Test-harness timing → **fix the test** (proper waits, stable selectors).
  - You may **NOT** paper over flakiness with retries, blind `sleep`s, disabling the test, `.skip`, or marking it non-blocking. Determinism is a requirement of the app itself (an event-sourced system is naturally deterministic — flakiness here is usually a real bug).
- Run the full suite at the end of each step and report results before declaring the step complete.

## Working rhythm

- Build in the sequence defined in `/docs/design.md` §14.2. One layer at a time.
- At the end of each step: run tests, report the test-name list and results, and stop for the user to review and commit. Do not steamroll into the next step.
- Prefer small, reviewable changes. The user reviews but does not write code — optimize your output for **readability and reviewability**: clear names, comments where the _why_ is non-obvious, no cleverness that obscures intent.
- If you hit a genuine fork not covered by the spec, present the options and the tradeoff and let the user decide. Don't guess on anything load-bearing.

# CLAUDE.md — v2 Amendment

---

## v2: Stats, Insights & Review — Additional Hard Rules

`docs/design-v2.md` is the authoritative spec for v2. **`docs/design.md` (v1) remains authoritative for the substrate** and is a prerequisite — every v2 calculator depends on v1's semantics (event log, day-start-timeline bucketing, derived-vs-declared parent %, not-due-child exclusion, excused-skips-the-chain, lazy materialization). Read both.

### The governing principle

v1's principle was _"never silently mutate the user's data or schedule."_ v2's is its epistemic twin:

> **The system never asserts more than the record supports.**

### 1. The Layer Rule (never violate)

- **Layer 1 (descriptive) always shows**, with raw counts attached.
- **Layer 1.5 (data quality) always shows** — it is fact about logging, and it is the lens every inference must be read through.
- **Layer 2 (inferential) is gated** by per-insight sufficiency thresholds; shows "not yet" until met.
- **Layer 3 (AI) may ONLY narrate what Layers 1 / 1.5 / 2 have released. It never infers on its own.**

> **Never gate a fact. Always gate an inference.**

**The AI must NEVER be handed the raw event log and asked to "find patterns."** Statistics happen in code, deterministically, with explicit declared thresholds. The LLM synthesizes and advises _on top of_ computed, threshold-cleared findings. The prompt-construction layer must be **structurally incapable** of passing an un-cleared finding through.

### 2. The observation-array seam (architectural, hard)

> **Domain replay produces plain numeric observation arrays. Statistics consume them.**

- **Statistical primitives MUST be pure functions from observation arrays to statistics** — zero domain knowledge. No DB access, no event replay, no occurrence/item/day-start concepts inside them.
- All subtlety (derived %, excused handling, day-start bucketing, not-due exclusion) is applied by the **Node domain layer** _before_ the arrays are produced.
- **FORBIDDEN:** a function like `computeDayOfWeekAdherence()` that performs the SQL query, the event replay, _and_ the permutation test together. It would work and be a nightmare to unpick.
- This seam is what keeps statistics portable to another language later, and it is _also_ the seam that makes calibration testing possible.

### 3. Statistical primitives: injectable seed

- **Every statistical primitive accepts an injectable random seed.** Same seed → same result, always.
- Randomness in tests means flakiness (forbidden) or seeding. **We seed.** A permutation test without a seed is a flake factory.

### 4. Statistics are written from scratch and tested to death

- The permutation test is **not** a library dependency. A wrong permutation test silently produces confident nonsense — the exact failure this design exists to prevent.
- **Known-answer fixtures** (small cases where the exact p-value is derivable by full enumeration) are required.

### 5. Calibration tests are part of the strict gate

These run in CI alongside everything else. Most codebases don't statistically validate their own statistics; here it is mandatory, because a broken gate silently poisons **every** downstream claim and Layer 3 would then narrate the poison with confidence.

- **False-positive rate** ≤ nominal α (~5%) on synthetic no-effect data.
- **Power**: a known injected effect (d = 0.8) is detected at the claimed rate at the sample sizes we gate on.
- **Autocorrelation robustness**: false-positive rate still holds on _streaky_ synthetic noise. **This is the single most valuable test in v2** — no code review would ever catch a permutation scheme that ignores time-series structure.
- **MDE verification**: inject exactly the claimed minimum detectable effect → assert detection; inject slightly less → assert non-detection.

The **synthetic-data generator** (tunable effect size AND tunable autocorrelation) is a **first-class component**, not throwaway test scaffolding.

### 6. The single-miss constraint (substantive, not stylistic)

> **A missed day is noise. NEVER alarm on it. A broken streak is NOT a failure signal.**

Evidence-derived (Lally et al. 2010: missing one opportunity did not materially affect habit formation; perfectionism is a documented cause of quitting). A review or UI string saying _"you broke your 12-day streak"_ is **doing harm** — it reinforces the all-or-nothing thinking that makes people quit.

- Layer 2 and Layer 3 reason in **rates over windows**, never streaks.
- This applies to **UI copy as well as AI output.** Do not write streak-shaming microcopy.

### 7. The AI observes and reports. It never acts.

- No moving, rescheduling, or adjusting the user's plan. Ever.
- Rationale is not merely data-sufficiency: an AI that rearranges the schedule mutates the plan behind the user's back and **contaminates revealed-preference data with the system's own suggestions.** This is epistemic and does not go away with more data.
- If ever built, it must be **suggestions the user accepts**, never actions it takes.

### 8. Evidence standard: verify, don't request

Prompt instructions like _"cite real sources"_ **fail silently** — an LLM will produce a citation that sounds real. The user cannot tell the difference at the point of consumption.

- Recommendations are emitted as **structured objects**: `{ recommendation, mechanism, source_identifier (DOI/PMID), evidence_quality, confidence, grounded_justification }`.
- **Code verifies** each: the identifier must **programmatically resolve**; the claimed evidence-quality must **match the source's actual publication type.**
- **Unverifiable recommendations are DROPPED, never shown.**
- User-facing prose is **rendered from the verified structure**, never freely generated.
- Search is permitted **only against quality-gated sources** (PubMed/PMC, peer-reviewed journals, systematic reviews, meta-analyses). **Denylist:** forums, Reddit, productivity blogs, unsourced conventional wisdom.
- **Zero recommendations is a valid output** ("no good evidence for what to do here").
- **Gate on the standard (provenance), not on a fixed list of conclusions.** The seeded evidence base is a starting kit, not a ceiling.

### 9. Extensibility (architectural)

- **Stats are individually-defined, independently-computable functions over the event log — NOT a fixed dashboard.** Each takes `(item|category, window, filters)` → value + raw counts.
- Adding a stat = adding one calculator; it touches nothing else. Because it's a replay over history, **a stat invented later computes retroactively over data already collected.**
- A new calculator automatically becomes available to Layer 3 (which narrates whatever Layers 1/2 release) — **no prompt surgery.**

### 10. Aggregates must be meaningful

Some stats do not aggregate across items. _Context stability_ is a per-habit property — "average context stability across all habits" is near-meaningless. **Do not fabricate aggregates that have no interpretation.**

### 11. Model choice is configurable

Env var, per the existing `${VAR:?required}` convention. Don't freeze today's model into the code, for the same reason we don't freeze today's science. The design **fails safe** under model substitution: a weak model that breaks the structured-output contract yields _fewer_ recommendations (verification drops them), never _bad_ ones.

---

## Carried forward from v1, unchanged

- Strict green gate; no step complete on red.
- **Flaky tests are defects to root-cause, never tolerate.** No retries, blind sleeps, `.skip`, or non-blocking marks. (v2's seeded randomness makes this _more_ relevant, not less.)
- Never silently mutate user data.
- Event immutability; derived state, not stored truth.
- `user_id` on every user-owned entity.
- Rename-proofing: neutral internal identifiers.
- Tests derived from and named after the spec's rules.
- Build one layer at a time; stop for review; the user commits.
