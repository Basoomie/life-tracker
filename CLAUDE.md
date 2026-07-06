# CLAUDE.md — Project Constraints & Working Agreement

This file governs how you (Claude Code) work on this project. Read it at the start of **every** session. `/docs/design.md` is the authoritative specification; this file is the non-negotiable working rules. If anything you're about to do conflicts with either, stop and flag it instead of proceeding.

---

## The spec is authoritative

- `/docs/design.md` defines what this system is and how it must behave. Build **from the spec**. Do not re-derive, reinterpret, or "improve" settled decisions. If the spec is ambiguous or seems wrong, **ask** — do not silently choose.
- When you implement a behavior the spec describes, the spec's wording is the source of truth for how it should work.

## Core design principles (from the spec — never violate)

1. **Never silently mutate the user's data or schedule.** Nothing moves, closes, completes, or changes without either an explicit user action or a clearly-defined, logged rule. When in doubt, do less and surface the decision to the user.
2. **Event-sourced, derived state.** The event log is the source of truth. Current state is *derived* by replaying events. Events are **immutable** — corrections are new events, never edits-in-place. Do not store derived values as if they were source truth (blocked-status, streaks, adherence, derived parent %, etc. are computed, not stored).
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
- Prefer small, reviewable changes. The user reviews but does not write code — optimize your output for **readability and reviewability**: clear names, comments where the *why* is non-obvious, no cleverness that obscures intent.
- If you hit a genuine fork not covered by the spec, present the options and the tradeoff and let the user decide. Don't guess on anything load-bearing.
