<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="sluice" width="360">
  </picture>
</h1>

A serverless GitHub App (Cloudflare Workers, TypeScript, Hono, Octokit) that keeps a three-repo
chain in sync:

```
 upstream  ──poll (cron)──▶  midstream  ──webhook (push)──▶  downstream
 third-party                 yours                           yours (may be another org)
 app NOT installed           app installed                   app installed
 public, read-only           holds .github/chain.yml
```

**Every change lands through a pull request that you review and merge.** The app never pushes to a
tracked branch: it only ever writes to `chain/*` branches and opens PRs from them.

## Status

All seven planned steps are built. Steps 5–7 await review.

| # | Step | State |
|---|------|-------|
| 1 | Scaffold: Worker, Hono, webhook verification, App JWT + installation tokens | ✅ built |
| 2 | `chain.yml` parsing and validation | ✅ built |
| 3 | Hop sync (cron upstream→midstream, webhook midstream→downstream) | ✅ built, merged |
| 4 | Conflict handling (label / comment / assign) and protected paths | ✅ built, merged |
| 5 | Secret / variable pass-through distribution | ✅ built, **awaiting your review** |
| 6 | Workflow template PRs | ✅ built, **awaiting your review** |
| 7 | Drift reconcile | ✅ built, **awaiting your review** |

Everything below describes what is built; things I could not verify against live GitHub are listed at the end. Sections marked *(planned)* describe design intent only.

---

## 1. Register the GitHub App

You need one app, installed on **midstream** and **downstream** (not upstream).

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**:

| Setting | Value |
|---|---|
| Webhook URL | `https://<your-worker>.<your-subdomain>.workers.dev/webhook` (set after the first deploy; use a placeholder until then) |
| Webhook secret | a random string: `openssl rand -hex 32`. Keep it; it becomes `GITHUB_WEBHOOK_SECRET` |
| **Repository permissions** | Contents: **Read & write** · Workflows: **Read & write** · Pull requests: **Read & write** · Secrets: **Read & write** · Variables: **Read & write** · Metadata: **Read-only** · Issues: **Read & write** *(only for drift reports; see below)* |
| Subscribe to events | **Push**, **Pull request**. (`installation` and `installation_repositories` are delivered to every GitHub App automatically.) |
| Where can this app be installed? | **Any account** if midstream and downstream are in different orgs (see note) |

Under *Display information*, upload [`assets/logo-mark-512.png`](assets/logo-mark-512.png) as the app's logo.
Then **Generate a private key** (downloads a `.pem`) and note the **App ID**.

Install the app on the midstream repo and the downstream repo (each org installs it separately).

> **Why "Workflows":** workflow template PRs (step 6) write under `.github/workflows/`, and GitHub
> refuses that to an app without this permission (sluice says so plainly when it happens). It may also
> be needed for plain sync, because upstream commits can touch `.github/workflows/`; I have not verified
> whether it applies to creating a ref at an existing commit, so grant it (as the brief specifies) and
> drop it only after testing. "Secrets" and "Variables" are used by step 5.
>
> **Issues permission (one addition to the list in the brief).** The drift report (step 7) is a single
> self-updating GitHub issue, and creating an issue needs `Issues: Read & write`; Pull requests: write
> does not cover it. If you would rather not grant it, set `reconcile.report: none` in `chain.yml`: the
> reconcile still runs and its findings are in the run log and `POST /admin/reconcile`, but no issue is
> filed. Without the permission and with `report: issue`, sluice says so in the result and keeps going.
>
> **Public app, private data:** a GitHub App can be installed on other accounts only if it is
> public. Midstream and downstream in different orgs therefore forces the app to be public, which
> means *strangers can install it too*. `ALLOWED_OWNERS` (below) is what keeps them out. If every
> repo lives under one account, keep the app private and still set `ALLOWED_OWNERS`.

## 2. Convert the private key to PKCS#8

GitHub gives you a PKCS#1 key (`-----BEGIN RSA PRIVATE KEY-----`). WebCrypto, and so Workers, can
only import PKCS#8 (`-----BEGIN PRIVATE KEY-----`).

```bash
node scripts/convert-private-key.mjs ~/Downloads/my-app.2026-10-12.private-key.pem > private-key-pkcs8.pem
# or, with openssl:
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in my-app.pem -out private-key-pkcs8.pem
```

The script passes an already-PKCS#8 key through unchanged. Delete both PEM files once uploaded.
Invoke it with `node` as shown: `npm run … > file` would write npm's own banner into the key file.
The Worker also checks the key on first use and tells you exactly what is wrong if it is PKCS#1.

## 3. Deploy with Wrangler

```bash
npm install                                  # .npmrc sets legacy-peer-deps (npm 10.9 resolver bug with vitest)
npx wrangler login

# D1 (sync log + idempotency bookkeeping only)
npx wrangler d1 create sluice            # copy the printed database_id into wrangler.jsonc
npm run d1:migrate:remote

# Plain vars (wrangler.jsonc):
#   ALLOWED_OWNERS  REQUIRED. Comma-separated logins that may be acted on, e.g. "my-org,my-other-org"
#   CHAIN_REPOS     optional "my-org/widget,..." to skip scanning every repo for a chain.yml
#   LOG_LEVEL       debug | info | warn | error

# Worker secrets (never in wrangler.jsonc)
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < private-key-pkcs8.pem
npx wrangler secret put GITHUB_WEBHOOK_SECRET
openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put ADMIN_TOKEN   # note the token it prints

npx wrangler deploy
```

Put the deployed `…/webhook` URL into the App's **Webhook URL** setting, then verify:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>/admin/whoami
# → { "app": { "id": …, "permissions": {…}, "events": […] }, "installations": [ … ] }
```

`/admin/whoami` makes the Worker sign an app JWT with your converted key and call GitHub, so it
proves the key, App ID and runtime crypto all work. Also use GitHub's *Advanced → Recent
deliveries* page to confirm the webhook returns `202`.

**Plan and CPU.** Secrets are sealed with a **pure-JS** sealed box (tweetnacl + blakejs), not libsodium:
`libsodium-wrappers` cannot run on Workers (it asks for random bytes at import time and instantiates
WASM from bytes at runtime, which Workers refuse with `Wasm code generation disallowed by embedder`;
I confirmed both in real workerd). libsodium stays a **test-only** dependency, used as an independent
oracle. A seal costs about **2 ms** of CPU warm (Node), but the **first seal in a fresh isolate measured
about 7 ms** in local workerd (JIT warm-up), so a submission to two repos can exceed the Workers **Free**
plan's 10 ms CPU limit. Plan on the **$5 Workers plan** if you submit secrets (it has no such limit);
everything else in sluice is I/O-bound and light on CPU. Nothing in `src/` outside `index.ts` and
`store/d1.ts` imports a Workers-only API, so a plain Node server (SQLite `Store`) remains an option.

## 4. `.github/chain.yml`

Lives in the **midstream** repo's default branch; read at runtime through the API, never stored.
See [`examples/chain.yml`](examples/chain.yml) for every key. Minimal form:

```yaml
version: 1
upstream:   { repo: acme-oss/widget }
midstream:  { repo: my-org/widget }
downstream: { repo: my-other-org/widget-deploy }
```

Validation is strict, and errors carry `line:col`:

```
.github/chain.yml: 2 errors
  error  8:19   hops.upstream_to_midstream.merge_method must be "merge", "squash" or "rebase"
  error  12:3   protectd_paths unknown key (did you mean "protected_paths"?)
```

- Unknown keys are errors, so a typo cannot silently disable something.
- `secrets:` takes **names only**; there is no key that can hold a value.
- Sync branches must start with `chain/` and can never equal a tracked branch.
- A PR that touches `chain.yml` gets one comment with any errors (updated in place; ✅ when fixed).
  Invalid configs are also written to the run log, and the chain is skipped until fixed.
- Cross-field checks (duplicate repos, branch clashes…) are reported once the field-level errors
  are fixed, because the schema library only runs them on otherwise-valid input.

## 5. How hop sync works

**Upstream → midstream** runs on the Cron Trigger (hourly; `poll_interval_minutes` can only slow a
chain down). **Midstream → downstream** runs when a push lands on midstream's tracked branch (a
merged PR *is* a push, so one trigger covers both). The same code runs for both, plus
`POST /admin/sync`.

For a hop, in the **target** repo:

1. Read the source tip. For upstream that is a public repo read with **midstream's** installation
   token (5,000 req/h instead of 60/h anonymous).
2. `compare` target vs source tip. Nothing ahead → up to date; close a now-pointless sync PR.
3. Make the bot branch `chain/sync-*` carry the source:
   - target has no commits of its own → the branch **is** the source commit (fast-forward);
   - otherwise start from the target tip and let GitHub merge the source in (Merges API, server
     side); on conflict, point the branch at the source tip so the PR exists and shows the conflict.
4. Open **one** PR (or refresh the existing one) from that branch into the tracked branch, with
   labels/assignees/reviewers from `pull_requests:`.

**Idempotency is structural, not bookkeeping.** Re-running does nothing because each step is a read
or a write whose "already done" answer GitHub reports and we accept: branch exists, branch already
contains the source (`aheadBy == 0`), PR already open, Merges API `204 Nothing to merge`. D1 holds
logs only; deleting it loses nothing. Overlapping runs (cron + webhook) converge on one branch and
one PR. A Durable Object per chain would add serialization, but races are handled without one, so
it is deliberately not included.

**Merge methods.** `merge_method` is how *you* will merge that hop's PRs.
- `merge`: "is the target behind?" is plain ancestry. **Use a merge commit.**
- `squash` / `rebase`: the source commit never becomes an ancestor, so each sync PR carries a
  hidden marker (`<!-- sluice:v1 hop=… source=<sha> -->`) and the last *merged* sync PR is the
  baseline. Don't delete that comment. Squash-merging also loses merge history, so later upstream
  edits to a file you already squashed can conflict.

**Safety behaviours**
- A PR closed unmerged is not re-opened for the same upstream commit; it re-opens when upstream moves.
- A leftover branch is reset only when that cannot lose work (it is exactly what was merged, or adds
  nothing over the target). Human commits on a sync branch are never discarded and never force-pushed over.
- Writes are hard-limited to `chain/*` by a guard around the GitHub port, independent of config validation.
- Downstream may be in another org: it uses *its own* installation, and its owner must be in `ALLOWED_OWNERS`.

**Fork requirement.** `transport: fork` (the only one implemented) needs midstream to be a GitHub
fork in upstream's network and downstream a fork in midstream's, so a branch in the target can
point straight at a source commit. If it is not, the hop fails with an error that says so.
`transport: git-data` (copy objects through the Git Data API for unrelated repos) is accepted by
the schema but **not implemented**; hops report that clearly instead of attempting it. A design
proposal for it, awaiting review, is in [`docs/git-data-transport.md`](docs/git-data-transport.md).

### Conflicts

After opening or refreshing a sync PR, sluice asks GitHub whether it can be merged. GitHub computes
that lazily (the first answer is often "not yet"), so it polls up to 5 times with growing waits
(1.5 s, 3 s, 4.5 s, 6 s). GitHub's answer is authoritative; a refused merge only counts as evidence
if GitHub never answers, and an unanswered poll never *clears* an existing flag.

On the **transition** into a conflict, once:

1. add the conflict label (`conflicts.label`, default `sluice/conflict`);
2. post **one** comment, marked so it is edited in place and never duplicated (`conflicts.comment`);
3. assign (and, with `conflicts.request_review`, request review from) `conflicts.assignees`, else
   `pull_requests.reviewers`, else `pull_requests.assignees`.

When the conflict goes away the label comes off and the comment is edited to say so. The label *is*
the "already flagged" state, so a steady state (still conflicting, or still clean) performs **zero
writes**. Consequences worth knowing:

- if you remove the label by hand while the conflict persists, the next run flags it again (without a
  second comment);
- you resolve a conflict by pushing to the `chain/sync-*` branch; sluice never force-pushes over it;
- a failure to comment, assign or request review is logged and does not fail the sync; the label is
  applied first for that reason.

### Protected paths

`hops.<hop>.protected_paths` (globs, `dot: true`, so `config/**` covers `config/.env`) are files whose
content in the **target** must survive the sync: midstream-only patches on the upstream hop,
downstream-only deployment config on the downstream hop.

The reason to protect a path is that *both sides* edited it, which is exactly when GitHub refuses to
merge. So sluice does not "merge, then fix up". It builds a **restore commit** instead: the source
tree with every protected path reset to the target's content (removed if the target has no such
file), parented on the source tip. That commit is what gets merged, so:

- protected paths cannot conflict, and upstream edits to them are discarded;
- everything else in the PR is the normal sync;
- the source tip is still an ancestor, so "up to date" detection converges once the PR lands.

The commit is deterministic (fixed identity `sluice <sluice@users.noreply.github.com>` and the
source commit's date), so re-runs and overlapping runs produce the same object. A run that changes
nothing creates **no** objects. The PR body lists the protected paths that were kept. `dry_run`
reports them as `plan.protectedPaths`.

Limits, stated plainly:

- **Config changes apply on the next upstream commit.** Adding a path to `protected_paths` does not
  rewrite an already-open sync PR whose source has not moved; close it, or wait for upstream to move.
- Detection reads both full file trees (recursive listing): about 4 extra API reads per hop run.
  GitHub truncates listings beyond ~100k entries; sluice then **refuses** to sync rather than guess.
- Restore commits are created through the API with that fixed identity and are **not signed**. If you
  require signed commits on `chain/*` branches, this will not pass; the merge commit you create when
  landing the PR is yours and signed as usual.
- Protection is path-level: it discards upstream's version of the *whole file*, not individual hunks.

### Operating it

All `/admin/*` routes need `Authorization: Bearer $ADMIN_TOKEN`.

```bash
# Dry run: what would happen? (writes nothing, not logged)
curl -s -X POST https://<worker>/admin/sync -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"chain":"my-org/widget","hop":"upstream_to_midstream","dry_run":true}'

# Do it now (same code path as cron)
curl -s -X POST … -d '{"chain":"my-org/widget","hop":"midstream_to_downstream"}'

# Recent runs from D1
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "https://<worker>/admin/runs?chain=my-org/widget&limit=20"

npx wrangler tail          # structured JSON logs
```

Outcomes: `up_to_date`, `pr_opened`, `pr_updated`, `pr_unchanged`, `stale_pr_closed`,
`skipped_rejected`, `conflict`, `rate_limited`, `error`, `dry_run`.

## 6. Secrets and variables

### Declare them in `chain.yml`

```yaml
variables:                # non-sensitive; values live in the file
  - name: DEPLOY_REGION
    value: eu-west-1
    targets: [downstream]

secrets:                  # NAMES ONLY; there is no key that can hold a value
  - name: NPM_TOKEN
    targets: [midstream, downstream]
```

### Submit a secret (once)

```bash
# jq builds the JSON, so quotes, backslashes and newlines in the value are escaped correctly.
jq -n --arg value "$(pbpaste)" '{chain: "my-org/widget", name: "NPM_TOKEN", value: $value}' \
  | curl -s -X POST https://<worker>/admin/secrets \
      -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d @-
```

(Taking the value from the clipboard or a file, as above, keeps it out of your shell history.)
The response lists each target as `created`, `updated`, `error` or `skipped`, and **never** echoes the
value. `207` means some targets failed (re-submit to finish), `502` means none were written.

What happens, in this request only: the Worker fetches each target repo's Actions **public key**, seals
the value to it (libsodium-compatible sealed box), `PUT`s the ciphertext, and drops the value. Only
names declared under `secrets:` can be submitted, only to the targets declared for them. Downstream
may be in another org: it needs its own installation, and its owner must be on `ALLOWED_OWNERS`.

**Rotation is re-submission.** Secrets are write-only on GitHub: you can set one but never read it back.
So sluice can never verify a value, only that a name exists and when it was last updated; drift checks
(step 7) can compare names and `updated_at`, nothing else. To rotate, submit the new value again.

### Variables

Variables are applied **directly** (no PR): `chain.yml` on midstream's default branch is the thing you
reviewed and merged. They are applied when a push to the default branch changes `chain.yml`, and on
demand:

```bash
curl -s -X POST https://<worker>/admin/variables -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"chain":"my-org/widget","dry_run":true}'     # shows create / update / unchanged per repo
```

Only declared names are touched, a variable that already matches costs no writes, and values are
not written to the run log (names and actions only).

### Protecting the endpoint

The bearer token (≥ 24 chars, constant-time compare) is the application-level check. Also put
**Cloudflare Access** in front of the route so unauthenticated traffic never reaches the Worker, and
**disable the `*.workers.dev` route** (or protect it too): an Access policy on a custom domain does not
cover the workers.dev hostname. Add a WAF rate-limit rule on `/admin/*`.

## 7. Workflow templates

Keep one workflow template in midstream and have sluice render it into each repo that should have it.

```yaml
workflows:
  templates_path: templates          # in the midstream repo
  branch: chain/workflows            # bot branch in each target; PRs open from it
  values: { node_version: "22" }
  files:
    - template: ci.yml               # templates/ci.yml
      destination: .github/workflows/ci.yml
      targets: [midstream, downstream]
```

See [`examples/templates/ci.yml`](examples/templates/ci.yml). **Syntax:** `{{ name }}` is replaced.
GitHub's own `${{ secrets.X }}` is **never** touched (a `{{ … }}` preceded by `$` is left alone), and
`\{{ name }}` writes a literal placeholder. Placeholders in comments are replaced too. An undefined name
is an error that lists every missing one. **Built-ins** (do not redefine them; the schema rejects it):
`repo`, `owner`, `name`, `branch`, `role` (`midstream`|`downstream`), `upstream_repo`, `midstream_repo`,
`downstream_repo`. The rendered file must be valid YAML or nothing is pushed.

For each target repo, sluice compares the rendered files with what is on its tracked branch and, if
they differ, commits the new content to `chain/workflows` and opens (or refreshes) **one PR**. Each
file starts with a "managed by sluice" header naming its template. The commit carries no author, so
GitHub attributes it to the app and signs it ("Verified").

- **Idempotent.** Matching files mean no PR and no writes; an existing PR is refreshed in place. The PR
  body carries a SHA-256 digest of the content, so a PR you **close unmerged** is not reopened until the
  templates or values change. A PR you *merge* and someone later hand-edits away is reopened, since the
  content drifted.
- **Triggered** by a push to midstream's default branch that changes `chain.yml` or anything under the
  templates path (that push is your merge), and on demand:
  `POST /admin/workflows {"chain":"my-org/widget","dry_run":true}` previews the drift and writes nothing.
  The daily reconcile (step 7) also checks it.
- **No fights with hop sync.** Managed destinations are added to each hop's protected paths
  automatically, so upstream's (or midstream's) copy of `.github/workflows/ci.yml` cannot be merged over
  the one sluice renders, and midstream's rendered copy does not flow downstream over downstream's own.
- **Conflicts** (someone edited the managed file on the target branch) get the same label, comment and
  assignee treatment as sync PRs.
- Needs the app's **Workflows: Read & write** permission. Without it GitHub refuses the write and the
  run log says exactly that.

## 8. Drift detection

A reconcile re-checks everything sluice is responsible for. It rides the hourly cron tick (no second
schedule) and runs per chain at most every `reconcile.interval_hours` (default 24); trigger it any time
with `POST /admin/reconcile {"chain":"my-org/widget","dry_run":true}`, where `dry_run` reports drift and
changes **nothing** (no fixes, no PRs, no issue).

| What it checks | When it drifts | What sluice does |
|---|---|---|
| **Workflow files** vs templates | a managed file differs from its rendered template | opens / refreshes a **PR** (step 6) |
| **Variables** vs `chain.yml` | a declared variable is missing or has another value | **fixes it directly** |
| **Secrets** vs `chain.yml` | missing; older than the secret's `max_age_days`; targets written > 15 min apart (a half-finished rotation) | **reports it, never fixes it** |
| **Hop state** | downstream is behind with no sync PR (a missed webhook) | opens the sync PR (re-runs the hop) |
|  | a sync PR is conflicted, errored, or open longer than `stale_pr_days` (14) | reports it |

Only things **a person must look at** are findings; what sluice fixed, or opened a PR for, is not.

**Secrets can only be compared by name and timestamp.** GitHub never reveals a secret, so sluice cannot
tell whether a value is *right*, only that a name exists and when it was last written. It also cannot
fix one: it does not have the value (by design, it never stores one). The fix is always you submitting
it again. Add a rotation policy per secret if you want staleness reported:

```yaml
secrets:
  - name: NPM_TOKEN
    max_age_days: 90

reconcile:            # all optional; these are the defaults
  enabled: true
  interval_hours: 24
  report: issue       # or "none": run log only, no issue
  issue_label: sluice/drift
  stale_pr_days: 14
```

### The report

With `report: issue`, findings are kept in **one issue** in the midstream repo, found by the
`sluice/drift` label plus a hidden marker (so an unrelated issue carrying the label is never touched):

- it is **created** when something needs attention, **edited in place** when the findings change, and
  **closed with a comment** when everything is in order; a later problem opens a new one;
- an unchanged report costs zero writes, and the body is deterministic (no timestamps), so it never
  churns;
- if a rate limit cuts the reconcile short, the report is left alone rather than rewritten from half the
  evidence.

Needs the Issues permission (see registration). Each reconcile is also recorded in the run log
(`outcome`: `reconcile_clean`, `reconcile_findings` or `reconcile_partial`, with counts per kind).

## 9. Threat model

| Threat | Mitigation |
|---|---|
| Forged webhooks | `X-Hub-Signature-256` verified over the raw bytes with WebCrypto (constant-time) *before* anything parses the body. 401 otherwise. |
| Replays / redeliveries | De-duplicated by `X-GitHub-Delivery`; a *failed* delivery can be redelivered to retry. All handlers are idempotent regardless. |
| A stranger installs your public app | `ALLOWED_OWNERS` is checked on every webhook, every cron scan, every admin call, and for the downstream owner. Empty list = refuse everything. Installations outside it are logged as warnings. |
| A midstream owner points `downstream:` at someone else's repo | Downstream owner must be allowlisted (also for secrets and variables). |
| Bug or config writes to a real branch | Sync/workflow branches must be `chain/*` (schema) and the port guard rejects any ref write elsewhere (code). Nothing merges PRs. |
| Admin endpoint guessing | Bearer token compared in constant time; put Cloudflare Access / a WAF rate-limit rule in front. |
| **A secret value reaching a log** | Request bodies are never logged. The value is never in a URL or header (the route is POST-only and a value in a query string is ignored). Every error from sealing or from GitHub is logged as name/message/status only, **and** the logger for that request additionally strips the *exact value* from anything it prints, so even a library that quotes its input cannot leak it. |
| **A secret value reaching storage** | There is no code path that writes it: not D1 (the run log records names, repos and outcomes), not KV (unused), not a Worker secret. |
| **A secret value reaching GitHub in the clear** | Only the sealed-box ciphertext is sent; the plaintext is never in a request. |
| A secret value in a response | Responses carry per-target results only; validation errors name fields, never values; `Cache-Control: no-store`. |

Each of the last four rows is a test, not a promise: `test/secrets.test.ts` captures every log line,
every D1-bound row, every argument of every call made to GitHub and every response, and searches them
for the value in raw, base64 and hex form, including when dependencies deliberately **echo the value
in their error messages**. I also checked it against five deliberate leaks (an unscrubbed logger, an
unscrubbed response, a debug line, the value in the run log, plaintext sent instead of ciphertext);
each makes a test fail. Finally, the real Worker in workerd was sent a secret and its log, D1 and
response searched: zero occurrences.

**What this does *not* protect against.** The plaintext is in the Worker's memory for the duration of
one request, and Cloudflare terminates TLS, so Cloudflare can in principle see it. JavaScript strings
cannot be wiped, so the value lingers until garbage collection (the byte copies and the ephemeral key
are zeroed). Anyone who can deploy code to the Worker, or read its secrets, can change it to capture
values, and can act as the app on every installed repo, so protect your Cloudflare account and
GitHub App credentials. Anyone with the admin token can submit secrets for declared names. A value
sealed to a repo's key is readable by every workflow in that repo, as with any Actions secret.

Credentials the Worker itself must hold (unavoidable): `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`, `ADMIN_TOKEN`, as Worker secrets. Installation tokens are minted per use,
cached in isolate memory only, and live ~1 hour.

## 10. Development

```bash
npm test               # vitest: ~410 tests, no network, no Cloudflare account
npm run typecheck
npx wrangler dev       # local workerd; put dev secrets in .dev.vars (git-ignored)
```

`test/helpers/fake-github.ts` is an in-memory GitHub (shared commit graph per fork network,
server-side three-way merges with conflicts, PRs landing by merge/squash/rebase). Engine tests run
against it; `test/octokit-port.test.ts` pins the real adapter's request shapes and GitHub's
error responses with a mocked HTTP layer.

### Not verified against live GitHub

These behaviours are asserted from GitHub's documentation and experience but have **not** been
exercised against the real API from this repo; confirm them with `POST /admin/sync` + `dry_run`
and one real sync on a throwaway chain before relying on them:

- creating a ref in a fork that points at a commit that only exists in the parent repo;
- `compare` and the Merges API accepting such a SHA;
- cross-org forks sharing objects as assumed;
- *(step 4)* the Merges API accepting the **unreferenced restore commit** as `head` (it is created
  through the Git Data API and only becomes reachable once merged into the sync branch), and the Git
  Data endpoints (`git/commits`, `git/trees`) resolving a parent-repo SHA through the fork;
- *(step 7)* `GET /repos/{o}/{r}/actions/secrets` returning `updated_at` as assumed (documented, but not
  exercised live), and the Issues permission behaving as described when absent;
- *(step 6)* GitHub accepting a Git Data API commit that adds or changes `.github/workflows/*.yml` (and
  what it says without the Workflows permission), and signing a commit that sets no author;
- *(step 5)* GitHub accepting the sealed-box ciphertext for `PUT .../actions/secrets/{name}`. It is
  checked against libsodium (GitHub's reference) in tests, and the 32-byte Curve25519 key format is
  GitHub's documented one, but no secret was sent to the real API;
- *(step 4)* `mergeable` becoming non-null within the polling budget (if not, the next run asks again).
