# chain-sync

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

This repo is being built in reviewable steps.

| # | Step | State |
|---|------|-------|
| 1 | Scaffold: Worker, Hono, webhook verification, App JWT + installation tokens | ✅ built |
| 2 | `chain.yml` parsing and validation | ✅ built |
| 3 | Hop sync (cron upstream→midstream, webhook midstream→downstream) | ✅ built, **awaiting your review** |
| 4 | Conflict handling (label / comment / assign) and protected paths | ⏳ not built |
| 5 | Secret / variable pass-through distribution | ⏳ not built |
| 6 | Workflow template PRs | ⏳ not built |
| 7 | Drift reconcile | ⏳ not built |

Everything below is accurate for steps 1–3. Sections marked *(planned)* describe design intent only.

---

## 1. Register the GitHub App

You need one app, installed on **midstream** and **downstream** (not upstream).

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**:

| Setting | Value |
|---|---|
| Webhook URL | `https://<your-worker>.<your-subdomain>.workers.dev/webhook` (set after the first deploy; use a placeholder until then) |
| Webhook secret | a random string: `openssl rand -hex 32`. Keep it; it becomes `GITHUB_WEBHOOK_SECRET` |
| **Repository permissions** | Contents: **Read & write** · Workflows: **Read & write** · Pull requests: **Read & write** · Secrets: **Read & write** · Variables: **Read & write** · Metadata: **Read-only** |
| Subscribe to events | **Push**, **Pull request**. (`installation` and `installation_repositories` are delivered to every GitHub App automatically.) |
| Where can this app be installed? | **Any account** if midstream and downstream are in different orgs (see note) |

Then **Generate a private key** (downloads a `.pem`) and note the **App ID**.

Install the app on the midstream repo and the downstream repo (each org installs it separately).

> **Why "Workflows" even for plain sync:** upstream commits may touch `.github/workflows/`, and GitHub
> rejects pushes from an app that create or modify workflow files without this permission. I have
> not verified whether it also applies to creating a ref at an existing commit, so grant it (as the
> brief specifies) and drop it only after testing. "Secrets" and "Variables" are only used from
> step 5 on; you may leave them off until then.
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
npx wrangler d1 create chain-sync            # copy the printed database_id into wrangler.jsonc
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

**Plan:** this needs no WASM, so the **Workers Free plan** is expected to suffice for steps 1–3
(JWT signing is WebCrypto, not libsodium). The libsodium sealed box arrives in step 5; if its WASM
start-up exceeds the free CPU limit, the plan is the $5 Workers plan or a pure-JS sealed box
behind the same interface. Nothing in `src/` outside `index.ts` and `store/d1.ts` imports a
Workers-only API, so a plain Node server (SQLite `Store`) remains an option.

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
  hidden marker (`<!-- chain-sync:v1 hop=… source=<sha> -->`) and the last *merged* sync PR is the
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
the schema but **not implemented**; hops report that clearly instead of attempting it.

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

## 6. Submitting a secret *(planned: step 5)*

Not built yet. Design for review:

1. `POST` a value once to an authenticated endpoint (Cloudflare Access in front, plus the bearer token).
2. For each target repo listed in `chain.yml`, fetch its Actions public key, seal the value into a
   libsodium sealed box, `PUT` it, and drop the value. No D1, no KV, no logs, no Worker secret.
3. The request body is never logged; the value never appears in a URL (Workers Logs record URLs).
4. Secrets are write-only on GitHub, so drift checks (step 7) can only compare names and
   `updated_at`, never values. **Rotation means re-submitting the value.**

## 7. Threat model

What exists today (steps 1–3):

| Threat | Mitigation |
|---|---|
| Forged webhooks | `X-Hub-Signature-256` verified over the raw bytes with WebCrypto (constant-time) *before* anything parses the body. 401 otherwise. |
| Replays / redeliveries | De-duplicated by `X-GitHub-Delivery`; a *failed* delivery can be redelivered to retry. All handlers are idempotent regardless. |
| A stranger installs your public app | `ALLOWED_OWNERS` is checked on every webhook, every cron scan, every admin call, and for the downstream owner. Empty list = refuse everything. Installations outside it are logged as warnings. |
| A midstream owner points `downstream:` at someone else's repo | Downstream owner must be allowlisted. |
| Bug or config writes to a real branch | Sync/workflow branches must be `chain/*` (schema) and the port guard rejects any ref write elsewhere (code). Nothing merges PRs. |
| Secrets in logs | Logger redacts by key name and by token-shaped value (GitHub tokens, JWTs, PEM keys, `Bearer …`, signatures); request bodies are never logged; errors are logged as name/message/status only. |
| Admin endpoint guessing | Bearer token compared in constant time; put Cloudflare Access / a WAF rate-limit rule in front. |

Credentials the Worker itself must hold (unavoidable): `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`, `ADMIN_TOKEN`, as Worker secrets. Installation tokens are minted per use,
cached in isolate memory only, and live ~1 hour. Anyone who can read the Worker's secrets (or
deploy code to it) can act as the app on every installed repo, so protect your Cloudflare account.

*(planned, step 5)* The secret pass-through additionally exposes the plaintext value to the Worker
process for the duration of one request, and to Cloudflare as the TLS terminator. It is not
persisted by this code, but it is not protected from a compromised Worker deployment either.

## 8. Development

```bash
npm test               # vitest: ~190 tests, no network, no Cloudflare account
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
- cross-org forks sharing objects as assumed.
