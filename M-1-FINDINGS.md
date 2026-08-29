# M-1 Findings — 2026-08-29 (IN PROGRESS)

Status legend: **[observed]** = seen running. **[verified statically]** = confirmed from
package/type definitions or a clean typecheck, not yet from a running system.
**[untested]** = not yet exercised. Nothing here should graduate to a verdict while it
still says untested.

## Setup deltas from the plan

- **The app runs the new frontend system.** There is no
  `packages/app/src/components/catalog/EntityPage.tsx`; §6a's instruction does not apply.
  The scorecard is enabled declaratively in `app-config.yaml` under `app.extensions`
  (`entity-card:tech-insights/scorecards`,
  `entity-content:tech-insights/scorecards-content`). **[verified statically]** —
  `@backstage-community/plugin-tech-insights@1.4.0` ships an `/alpha` export declared as
  `@backstage/FrontendPlugin` and exposes both extension ids.
- **Database left on `better-sqlite3` / `:memory:`** by choice. Consequences: facts are
  lost on every backend restart, and §7's "when did it drift" question is not answerable.
  Recorded as untested-by-choice, not as a Backstage limitation — the facts-between-
  timestamps API exists (`GET /api/tech-insights/facts/range`).
  The §3 side-finding about each plugin getting its own database is therefore **[untested]**.
- **The probe entity is registered from a local file**
  ([examples/m1-payments-test-repo.yaml](examples/m1-payments-test-repo.yaml)), not a
  GitHub repo. So §7's "baseline is git-versioned, reviewable, attributable" property is
  asserted, not observed.
- Harbor is in-cluster with `expose.type: clusterIP` — base URL is `http://harbor`
  (port 80), not `:30002` as the plan assumes.

## Drift detection on Backstage

- Baseline storage mechanism used: `devsecops/harbor-baseline` annotation on the catalog
  entity, holding a JSON object of the tracked fields.
- Did json-rules-engine support per-entity baselines? **No** — confirmed from the check
  schema: `value:` in `techInsights.factChecker.checks.*.rule.conditions` is a literal in
  `app-config.yaml` with no entity context. **[verified statically]**; the 30-minute probe
  of §6c has not been run against a live instance.
- Workaround implemented as §6c prescribes: the comparison lives in the retriever
  ([harborFactRetriever.ts](packages/backend/src/modules/techInsightsHarborFactRetriever/harborFactRetriever.ts)),
  which emits `autoScanMatchesBaseline` / `autoScanObserved` / `autoScanBaseline` (and the
  same triple for `public`) plus `driftedFieldCount`. The two checks read the precomputed
  booleans.
- **The consequence, which is the actual finding:** the fact checker is not doing the
  checking. All drift logic is TypeScript in the retriever; json-rules-engine is a boolean
  pass-through. Tech Insights is serving as scheduler + fact store + UI shell, not as a
  comparison engine.
- Lines of TypeScript for the working drift path: ~190 including schema and comments, for
  two boolean fields against one Harbor endpoint.
- Extra finding already visible in the code: **a fact retriever cannot distinguish "Harbor
  unreachable" from "project deleted"** without extra work. Both surface as a failed fetch.
  The retriever emits `observationFailed` so a red check cannot be silently manufactured by
  an outage, but deciding what a check *should* say in that state is unresolved — and it is
  the same ambiguity §8b is about.
- What the scorecard renders on drift: **[untested]**
- Cost of a field-level diff UI: **[untested]** — depends on whether `autoScanObserved` /
  `autoScanBaseline` surface anywhere in the supplied card or only via the facts API.
- Verdict on drift: **not yet — do not fill this in until §7 has been run.**

## Per-binding operational state

- Where `phase` / `failure_count` / `next_sync_at` would live: **[untested]** — §8a not started.

## Decommissioning and orphans

- Existing mechanism: **[untested]** — §8b not started.

## Things Backstage gives free that v0.3 would have to build

- Catalog, ownership, auth, UI shell, TechDocs.
- Scheduling with multi-instance coordination (`SchedulerService`), including cadence,
  timeout, initial delay and fact lifecycle (TTL / maxItems) as *configuration*, not code.
- Fact history with timestamps and a range query API — free, and not in design-v0.3.
- Declarative check definition in `app-config.yaml` — though see the caveat above about how
  little of the checking it is actually doing here.

## Things v0.3 needs that Backstage actively resists

- Per-entity comparison baselines in checks (§6c) — the rules engine has no entity context.
- (Pending §8a/§8b.)

## DECISION

[ ] Not enough signal yet — §7, §8a and §8b are the remaining evidence.

## One-paragraph justification

_To be written after §7 and §8._
