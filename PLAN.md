# PLAN: Rigorous Confidence Build for `symphony-beads`

Date: 2026-03-18
Owner: Pairing (you + agent)
Status: Draft v1

## Goal
Move the project from "works in many cases" to **high-confidence, evidence-backed** quality.

## Confidence Standard (Definition of Done)
A change is considered trustworthy only when all of the following are true:

1. `bun run fmt` passes
2. `bun run lint` passes (0 errors)
3. `bun run typecheck` passes (0 errors)
4. `bun run test` passes
5. CLI smoke checks pass for key commands
6. Docs and behavior are aligned (no command drift)

---

## Current Findings (Baseline)

### Strong points
- Clear architecture and module boundaries
- Good unit test coverage footprint (271 tests passing)
- Lint is clean

### Gaps blocking confidence
- Typecheck currently fails (strict TS contract broken)
- Runtime bug: `status` path references undefined `liveSnap`
- Drift between docs and implementation (`tui` vs `kanban`, `server.ts` mention)
- No CI enforcement of quality gates

---

## Execution Plan

## Phase 1 — Stabilize Baseline (now)
Objective: make local quality gates pass and remove obvious runtime drift.

1. Fix TypeScript errors to zero
   - Align type definitions and actual config shape
   - Repair failing test type fixtures
   - Fix unsafe casts where needed

2. Fix runtime blocker
   - Repair `cmdStatus` flow (`liveSnap` undefined)
   - Ensure command works in JSON and text modes

3. Resolve documentation drift
   - Align README command naming with CLI (`kanban`/`tui` decision)
   - Remove/adjust architecture items that do not exist

4. Validate
   - Run:
     - `bun run fmt`
     - `bun run lint`
     - `bun run typecheck`
     - `bun run test`

**Exit criteria:** all four commands pass locally.

---

## Phase 2 — Prove Behavior (integration confidence)
Objective: prove orchestration behavior under realistic command outputs.

1. Add integration harness with stubbed `bd`, `gh`, `pi`
2. Add deterministic scenario tests for:
   - dispatch from `open`/`in_progress`
   - PR merged -> close issue
   - changes requested -> reopen issue + re-dispatch
   - deferred issues not dispatched
   - stale lock and workspace collision handling
3. Add CLI smoke tests covering core commands

**Exit criteria:** reproducible integration suite passes in CI and locally.

---

## Phase 3 — Enforce in CI
Objective: prevent regressions from re-entering.

1. Add CI workflow (PR + main):
   - install deps
   - run `fmt` check
   - run `lint`
   - run `typecheck`
   - run `test`
2. Make CI required for merge
3. Publish gate results in PR checks

**Exit criteria:** all merges are gate-protected.

---

## Phase 4 — Failure-Mode Hardening
Objective: confidence under non-happy paths.

1. Add tests for:
   - hook failures/timeouts
   - runner timeouts/stalls
   - malformed JSON from dependency CLIs
   - partial command failures and retries
2. Add explicit error taxonomy in docs
3. Ensure all failures are observable via logs/status

**Exit criteria:** failure scenarios are tested and documented.

---

## Phase 5 — Release Confidence Report
Objective: evidence packet for each release.

Create a release report template including:
- Gate results (fmt/lint/typecheck/test)
- Integration pass/fail summary
- Known risks and mitigations
- Go/No-Go decision

**Exit criteria:** every release has a confidence artifact.

---

## Working Method (pairing rules)
1. Small scoped changes
2. One objective per commit
3. Run full gates before handoff
4. If a gate fails, fix before proceeding
5. Keep docs in lockstep with behavior

---

## Immediate Next Action (when we resume)
Start Phase 1, step 1: fix TypeScript errors to zero, then re-run all gates.
