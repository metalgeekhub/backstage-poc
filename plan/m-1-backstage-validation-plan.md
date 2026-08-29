# M-1: Backstage Validation Weekend — Execution Plan

**Precondition:** `npx @backstage/create-app@latest` has been run and `yarn start` works.
Harbor is installed on the cluster and reachable.
**Timebox:** 2 days. **Deliverable:** a written verdict, not working software.

---

## 0. The question this weekend answers

Not "is Backstage good." It is:

> Can Backstage detect that a Harbor project's configuration changed *after* onboarding,
> compare it to a per-service baseline captured *at* onboarding, attribute it to a catalog
> entity, and surface it usefully — and is there anywhere sane to put per-binding
> operational state and orphan records?

Three sub-questions, in decreasing order of how likely they are to be the thing that
decides it:

1. **Where does the per-entity baseline live?** (§6)
2. **Where does mutable per-binding state live** — `phase`, `failure_count`, `next_sync_at`? (§8)
3. **Where does the orphan record live** when an entity is deleted? (§8)

Question 1 is the one design-v0.3 §14 asks. Questions 2 and 3 are the ones more likely to
actually kill it. Do not run out of time before reaching §8.

---

## 1. Timebox and abort criteria

| Step | Budget | Abort if |
|---|---|---|
| 2. Harbor recon | 45 min | Can't reach the API from your laptop after 45 min — fix networking another day, don't burn Saturday |
| 3. Postgres | 30 min | — |
| 4. One real entity | 30 min | — |
| 5. Scaffolder action | 2 h | Can't write back to `catalog-info.yaml` at all → note it, move on, use a hand-written annotation |
| 6. Tech Insights + fact retriever | 3–4 h | **Do not abort.** This is the experiment. |
| 7. Break it and look | 1 h | — |
| 8. Orphan + binding-state probe | 1 h | — |
| 9. Verdict write-up | 1 h | — |

If you are behind at Saturday evening: **skip step 5 entirely**, hand-write the baseline
annotation into `catalog-info.yaml`, and go straight to step 6. Provisioning via scaffolder
is the part your design doc already concedes is solved. Observation is not.

---

## 2. Harbor recon — capture the shape of the truth

Confirm reachability from the machine running Backstage, not from inside the cluster:

```bash
export HARBOR=http://<node-ip>:30002
export HCREDS=admin:Harbor12345

curl -s -u $HCREDS $HARBOR/api/v2.0/health | jq
curl -s -u $HCREDS $HARBOR/api/v2.0/projects | jq
```

Create a throwaway project by hand, then dump everything Harbor will tell you about it:

```bash
curl -s -u $HCREDS -X POST $HARBOR/api/v2.0/projects \
  -H 'Content-Type: application/json' \
  -d '{"project_name":"m1-probe","metadata":{"public":"false","auto_scan":"true"}}'

curl -s -u $HCREDS $HARBOR/api/v2.0/projects/m1-probe | jq | tee harbor-baseline.json
```

**Save that file.** It is the ground truth for the rest of the weekend.

Pick exactly **two** drift candidates from it and write them down. Good choices:

- `metadata.auto_scan` — boolean, easy to flip in the UI, security-relevant
- `metadata.public` — boolean, security-relevant
- retention policy — richer, but lives on a *separate* endpoint (`/api/v2.0/retentions/{id}`),
  which is itself a useful finding: one logical "config" spans multiple API calls

If you use retention, note the extra call. Your `ToolIntegration.observe()` returning one
`Observation` assumes you can gather config in a bounded number of requests — verify that
assumption here, cheaply.

**Checkpoint:** you have `harbor-baseline.json` and two named fields.

---

## 3. Switch to Postgres

Non-negotiable. Tech Insights persists facts; in-memory SQLite discards them on restart and
the entire experiment depends on facts surviving between polls.

```bash
docker run -d --name backstage-pg -p 5432:5432 -e POSTGRES_PASSWORD=secret postgres:16
```

In `app-config.yaml`, replace the `better-sqlite3` backend database client with `pg`
against `localhost:5432`. Restart, confirm the demo catalog still loads, then confirm
databases were created:

```bash
docker exec -it backstage-pg psql -U postgres -c '\l'
```

You should see several `backstage_plugin_*` databases. Note that **each plugin gets its own
database** — this is relevant to your ADR-02 reasoning about shared schemas, and worth a line
in the verdict.

---

## 4. One real entity

Make a scratch GitHub repo with a `catalog-info.yaml`:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payments-test-repo
  annotations:
    harbor.io/project: m1-probe
    devsecops/harbor-baseline: '{"auto_scan":"true","public":"false"}'
spec:
  type: service
  lifecycle: production
  owner: guests
```

Register it via **Create → Register existing component**. Guest auth is fine all weekend;
do not set up GitHub OAuth, it is not what you're evaluating.

That `devsecops/harbor-baseline` annotation is standing in for your `binding.desired_config`
column. Everything downstream tests whether that substitution is viable.

**Checkpoint:** the entity page renders and both annotations are visible in the entity YAML view.

---

## 5. Scaffolder custom action (optional — cut this first if behind)

Goal: a template that creates a Harbor project *and* records the baseline, so provisioning
and baseline capture are one atomic-ish act rather than two.

Shape (not copy-paste — see §10 on API churn):

- Create a backend module registered against the scaffolder's actions extension point.
- The action takes `projectName` and config inputs, POSTs to `/api/v2.0/projects`,
  then GETs the created project back.
- It writes the returned config into the workspace's `catalog-info.yaml` as the
  `devsecops/harbor-baseline` annotation, and the scaffolder's existing
  `publish:github:pull-request` action opens a PR.

**Things to record while doing this, they matter more than the code:**

- Can the action write the *result of its own call* into the entity file, or does the
  template author have to hardcode expected values? If the latter, your baseline is what
  someone *intended*, not what Harbor actually did — a materially weaker drift baseline.
- What happens on partial failure — Harbor project created, PR fails? Is there any record?
  Compare to your §7 "each binding in its own transaction, partial success is normal."
- Is there any equivalent of `origin = CREATED | ADOPTED | LINKED`? (Expect: no.)

**Fallback if this eats more than 2 hours:** hand-write the annotation, note "scaffolder
write-back unverified" in the verdict, move on.

---

## 6. Tech Insights — the actual experiment

### 6a. Install

From `backstage/community-plugins` (**not** the main repo — check the workspace README for
current package names and registration syntax):

- `@backstage-community/plugin-tech-insights-backend`
- `@backstage-community/plugin-tech-insights-backend-module-jsonfc` (the fact checker)
- `@backstage-community/plugin-tech-insights` (frontend scorecard card)

Add the scorecard card to the entity page in `packages/app/src/components/catalog/EntityPage.tsx`.

Get the built-in `entityOwnershipFactRetriever` working first with its example
`groupOwnerCheck`. Do not write your own retriever until you see a green tick from a
supplied one — otherwise you cannot tell whether a failure is your code or your wiring.

**Checkpoint:** a scorecard renders on `payments-test-repo` with at least one passing check.

### 6b. The Harbor fact retriever

Implement the `FactRetriever` interface: `id`, `version`, `schema`, `entityFilter`,
`handler`. Register it with a cadence of a few minutes so you aren't waiting.

Logic:

1. Filter to entities carrying `harbor.io/project`.
2. Read both annotations off the entity.
3. Call Harbor for the current project config.
4. Emit facts.

### 6c. THE CRUX — read this before writing the check

The json-rules-engine checker compares **a fact against a literal value written in
`app-config.yaml`**:

```yaml
techInsights:
  factChecker:
    checks:
      autoScanCheck:
        type: json-rules-engine
        factIds: [harborConfigFactRetriever]
        rule:
          conditions:
            all:
              - fact: autoScan
                operator: equal
                value: true      # <-- a literal. Not this entity's baseline.
```

That expresses *"auto_scan must be true for everyone"* — a policy check. It does **not**
express *"auto_scan must equal whatever this service had at onboarding"* — a drift check.
Those are different products. Yours is the second one.

**Test whether the literal can be an entity reference.** Spend 30 minutes, no more. If it
can't (expected), apply the workaround:

**Move the comparison into the retriever.** Emit a precomputed boolean plus both operands:

```ts
// facts emitted per entity
{
  autoScanMatchesBaseline: false,   // <- the check tests this
  autoScanObserved: 'false',        // <- for display
  autoScanBaseline: 'true',         // <- for display
  driftedFieldCount: 1,
}
```

The check becomes `autoScanMatchesBaseline equals true`. **This works.** Confirm it works,
because if it does, the M-1 answer on drift is *"yes, achievable"* — and your §14 premise
that Backstage cannot do the observe half is wrong.

Then write down the consequence, which is the actually interesting finding:
**the fact checker is no longer doing the checking.** All drift logic lives in your
TypeScript retriever; the rules engine is a boolean pass-through. You are using Tech
Insights as a scheduler, a fact database and a UI shell — not as a comparison engine.
Ask yourself in the verdict whether that's a good trade or a hollow one.

**Checkpoint:** a check on `payments-test-repo` that passes while Harbor matches the baseline.

---

## 7. Break it and look hard

In the Harbor UI, flip `auto_scan` off. Wait for the next retrieval (or restart the backend).

Now evaluate the output honestly against §8 of your design doc, which specifies:

```
retentionDays     baseline: 90        now: 30
scanOnPush        baseline: true      now: false
```

Questions to answer by looking, not by reasoning:

- **What does the scorecard actually render?** A check name and a red X, most likely. Is the
  check *description* enough to convey what drifted, or do you need the field-level table?
- **Are `autoScanObserved` / `autoScanBaseline` visible anywhere in the UI**, or only in the
  facts API? If only the API, the field-level diff needs a custom frontend plugin — cost that
  at a weekend and note it.
- **Is there any "accept as new baseline" affordance?** There won't be. In this architecture
  it means editing the annotation, which means a PR against `catalog-info.yaml`. Decide
  whether that's better than your §8 button (it's git-versioned, reviewable, attributable —
  arguably better) or worse (slow, requires repo write access, wrong audience).
- **Is drift history visible?** Facts are stored with timestamps and there's an API for facts
  between timestamps. Can you see *when* it drifted? Your design doesn't have this. Note it as
  something Backstage gives you free that you'd have to build.

---

## 8. The two probes your design doc underweights

Budget an hour. No code — this is reading docs and writing conclusions.

### 8a. Where does per-binding operational state live?

Your `binding` table carries `phase`, `message`, `last_sync_at`, `next_sync_at`,
`failure_count`, `version`. Ask:

- A catalog entity is a YAML file in git, refreshed from source. It cannot hold mutable
  runtime state — anything written there gets overwritten on the next refresh. Confirm this.
- Tech Insights facts are append-only timestamped observations. Can they represent a state
  machine with backoff? Where would `failure_count` increment?
- If the answer is "a custom backend plugin with its own database," write down what that
  plugin would contain. If it contains `binding`, `orphaned_resource`, and the poller — you
  have just described your Spring app, in TypeScript, inside someone else's monorepo.

### 8b. What happens on decommission?

- Delete `payments-test-repo` from the catalog. What happens to the Harbor project? (Nothing.)
- Is there any record that it existed? Any enumeration of what was left behind?
- Where would `orphaned_resource` live, given the entity — and its annotations, and its
  baseline — is the thing that just disappeared?

This is the gap with no Backstage mechanism reaching toward it. If step 6 succeeds and step
8 fails, that asymmetry is your differentiation statement, and it's a sharper one than drift.

---

## 9. Verdict template — fill this in before closing the laptop

Copy into `M-1-FINDINGS.md`. Answer in sentences, not adjectives.

```markdown
# M-1 Findings — <date>

## Drift detection on Backstage
- Baseline storage mechanism used:
- Did json-rules-engine support per-entity baselines?  yes / no
- Lines of TypeScript for the working drift path:
- What the scorecard renders on drift:
- Cost of a field-level diff UI (custom frontend plugin? how big?):
- Verdict on drift:  achievable / achievable-but-ugly / not achievable

## Per-binding operational state
- Where phase / failure_count / next_sync_at would live:
- Does that require a custom backend plugin with its own schema?  yes / no
- If yes, what else would end up in that plugin:

## Decommissioning and orphans
- Existing mechanism:  (expected: none)
- What building it on Backstage would require:

## Things Backstage gives free that v0.3 would have to build
- (catalog, ownership, auth, UI shell, TechDocs, fact history, scheduling, ...)

## Things v0.3 needs that Backstage actively resists
-

## DECISION
[ ] Build as Backstage plugins — fork the monorepo, own it forever
[ ] Build standalone Spring app (v0.3 as written)
[ ] Build standalone + ship a thin read-only Backstage frontend plugin
[ ] Not enough signal — what's still unknown:

## One-paragraph justification
```

### How to read your own answers

- **Drift works, and binding state fits somewhere sane** → build on Backstage. Save two years.
- **Drift works, but binding state and orphans need a custom backend plugin with its own
  tables** → most likely outcome. You'd be writing your app inside a TypeScript monorepo you
  didn't choose, for the sake of a catalog and a login page. Build standalone — and the
  write-up of exactly why becomes your README, per §14.
- **Drift doesn't work at all** → surprising. Re-check §6c before believing it.

The third decision option is the one your design doc doesn't list and should:
standalone backend, plus a small read-only Backstage frontend plugin that renders your
data on the entity page. Backstage shops don't have to leave Backstage; everyone else gets
your SPA. That turns the biggest competitor into a distribution channel.

---

## 10. Gotchas

- **API churn is severe.** The new backend system replaced the old, and community plugins
  moved out of `backstage/backstage` into `backstage/community-plugins`. Blog posts older
  than a few months have wrong import paths and wrong registration syntax. Use the workspace
  README in the community-plugins repo as the only source for package names.
- **Don't set up GitHub OAuth.** Guest auth all weekend. Auth is Spring Security's job in the
  real design and isn't under test here.
- **Don't install SonarQube or Dependency-Track.** Harbor alone answers every question above.
  Three tools costs a day and proves nothing new.
- **Don't try to make it pretty.** No custom theming, no polished template. If you catch
  yourself doing UI work, you've drifted from the experiment.
- **Restart the backend after config changes.** Tech Insights schedules are read at startup;
  a stale process will make you debug code that's already correct.
- **Verify the §14 premise while you're here.** Your doc asserts Backstage's scaffolder
  "can already create Sonar, DT and Harbor projects via custom actions." Check whether
  off-the-shelf actions exist or whether that means "you write them." It changes the size
  of the Backstage-plugin option considerably.
