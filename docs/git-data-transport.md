# `transport: git-data`: design

**Status: proposal for review (step 1). Nothing here is implemented.** Today `transport: git-data` is
accepted by the schema, warned about, and the hop is skipped (`src/config/parse.ts`, `src/sync/chain.ts`).

## 1. Problem

`transport: fork` works because source and target share a git object network: a branch in the target can
point straight at a source commit, `compare` and the Merges API see the source's ancestry, and GitHub's
three-way merge has a real merge base. Unrelated repos (a repo made from a template, a copy, a mirror
across orgs) share nothing, so a source SHA does not exist in the target and there is no merge base.

Whatever replaces it must keep every property the fork path has: only `chain/*` refs are written, every
change arrives as a PR the owner merges, **conflicts are visible in GitHub's own merge UI** (not decided
silently by us), and a re-run with nothing new makes zero writes.

## 2. The idea: a vendor branch in the target

Keep a bot branch in the **target** repo, `chain/mirror-<hop>`, that holds pristine snapshots of the
source's tracked branch, one commit per sync, each parented on the previous. This is the classic
"vendor branch" workflow. Then run the **existing fork hop engine unchanged**, with the mirror branch's
tip standing in for "the source commit":

```
 source repo (unrelated)                       target repo
 ───────────────────────                       ──────────────────────────────────────────
 S0 ── S1 ── S2   (acme/widget@main)           chain/mirror-upstream:  M0 ── M1 ── M2
        │ copy changed blobs + tree                                     │ (tree(Mn) = tree(Sn) minus protected paths)
        └──────── Git Data API ───────────────▶                        merge (Merges API)
                                               main:  … ── T ─────────────┴──▶ chain/sync-upstream ─▶ PR
```

Why this and not "build the merged tree ourselves": once the mirror shares history with `main`,
GitHub does the content-level merge, shows real conflicts in the PR, offers its conflict editor and
computes `mergeable`. Everything in `hop.ts` (ancestry, merge methods, rejected-PR detection,
protected paths, conflict label/comment/assign, PR refresh) keeps working because, from the engine's
point of view, the target now **is** in the source's network. The new code is (a) building the mirror
and (b) the one-time bootstrap. See §9 for why building the merge client-side was rejected.

## 3. Baseline: what's new, without shared history

Two SHAs are kept apart in `runHop`: **`sourceSha`** (the real upstream commit; used for PR text, the
`sluice:v1` marker, rejected-PR detection) and **`carrierSha`** (an object that exists in the target;
used for `compare`, `createBranch`, the Merges API, protection). For `fork` they are the same value.

The state is read from GitHub, never from D1:

| Mirror branch | `compare(target tip, mirror tip)` | State | What sluice does |
|---|---|---|---|
| absent | – | **new** | create the mirror root, open the **adoption PR** (§3.1) |
| present | no common ancestor | **unadopted** | keep the adoption PR open; no content sync PR yet (the mirror itself may still advance) |
| present | shared history | **steady** | advance mirror if upstream moved, then the normal engine |

**Steady state.** Each run: read the source tip `S`; read the mirror tip's `sluice-source: <sha>`
trailer. If equal, nothing moved and nothing is written (reads only). If not, build the next mirror
commit `Mn+1` (§4) and fast-forward the mirror branch to it, then run the unchanged engine with
`carrierSha = Mn+1`. "Is the target behind?" is ancestry of the mirror tip, exactly as for forks; for
`squash`/`rebase` the existing marker baseline applies (the marker's `source` stays the upstream SHA).
The mirror advances whenever upstream does, **even if the sync PR was rejected**: the mirror records
what upstream is, PRs record what you decided to merge.

**What the PR lists as "commits".** `compare(source repo, lastSyncedSource, S)` runs in the *source*
repo (where those SHAs exist), not the target. Upstream's individual commits are therefore listed but
are **not** in the target's history; the mirror commit is one squashed snapshot (trailers carry the
source SHA; optionally `Co-authored-by` for the listed authors).

**Upstream force-push.** The mirror is built from trees, not from upstream ancestry, so a rewritten
upstream just produces the next snapshot. The commit list degrades to "upstream history was rewritten;
showing a tree comparison" when the old SHA is gone.

### 3.1 Bootstrap: the adoption PR

A target created independently has no history in common with any mirror, so the first merge needs a
link. sluice creates it as its **own reviewed PR**, separate from the first content sync:

1. Pick the baseline `B`: `hops.<hop>.baseline` (a 40-hex upstream SHA the target currently
   corresponds to) if set, else the **current source tip** (proposal; see §10).
2. Create the mirror root `M_B` (tree of `B`, no parent) and branch `chain/mirror-<hop>` at it.
3. Create the adoption commit `A` = parents `[target tip, M_B]`, **tree = the target's own tree**
   (an "ours" merge), on `chain/sync-<hop>`, and open a PR titled *"Adopt acme/widget@abc1234 as the
   sync baseline"*. It changes **no files**; it only records that `M_B` is already accounted for.
4. After it merges (with a **merge commit**), the mirror is in the target's history and the state is
   *steady*. If upstream has moved past `B` (typically so when `baseline` was supplied), the next run opens
   the first real sync PR with ordinary, visible conflicts.

Why two PRs: a conflict can only be *shown* by a PR whose head shares history with its base. Before
adoption, `M_S` and `main` are unrelated, so a combined "adopt + sync" branch would have to hide a
conflict inside a commit sluice authored. Keeping adoption content-neutral keeps "nothing is applied
without your merge" literally true.

Failure mode: if the adoption PR is **squashed or rebased**, the link is dropped. The next run sees
*unadopted* with a *merged* adoption PR and stops with an error that says so and how to redo it
(delete `chain/mirror-<hop>`; sluice re-adopts; merge with a merge commit).

## 4. Copying content

Changed paths are found by a **differential walk**, not by listing both full trees: compare the mirror
tip's tree with the source tip's tree one directory at a time, descend only where tree SHAs differ. Cost
is proportional to changed directories and has no whole-repo 100,000-entry ceiling (the recursive
listing's limit per GitHub's docs, which `TreeTooLargeError` guards today; one directory is still
limited). Entries compare on `(mode, sha)`, so a
mode-only change is a change. Blob SHAs are content-addressed and equal across repos, so an unchanged
blob is never transferred; tree SHAs are expected to match too but correctness never depends on it.

| Case | Handling |
|---|---|
| **Text file** (valid UTF-8, ≤ 1 MiB) | read from source, pass as inline `content` in `createTree`: no separate blob POST |
| **Binary file** (≤ 5 MiB proposed) | `GET blob` (raw media type), `POST blob` (base64), reference by SHA |
| **Over the size cap** | the hop **refuses**, naming the paths. Never silently skipped. Add the path to `protected_paths` to exclude it (below) |
| **Executable bit** (`100755`) | carried in the tree entry's `mode`; mode-only changes are diffed and applied |
| **Symlink** (`120000`) | blob content is the link target; copied verbatim with its mode |
| **Submodule** (`160000`, type `commit`) | gitlink copied as-is (the commit need not exist in the target); `.gitmodules` copied verbatim and **not rewritten** |
| **Git LFS** | pointer files copy fine but the LFS objects do not exist in an unrelated repo. If `.gitattributes` has `filter=lfs` for a changed path the PR says so; the hop does not pretend it worked |
| **Odd paths** | entries with `.git` components, `..`, absolute paths, or non-UTF-8 names are rejected before any request (defence in depth; untrusted upstream feeds `createTree`) |
| **Deletions** | `sha: null` in `createTree`, applied over the mirror tip as `base_tree` |

Many changes are split across several `createTree` calls (each result is the next `base_tree`) and the
mirror ref is moved **last**, so an interrupted run leaves only unreferenced objects; the next run
recomputes the same deterministic result (fixed identity, source committer date, `sluice-source:`
trailer, as with restore commits).

**Hard caps** (config, proposed defaults): `max_files: 500` changed paths and `max_bytes: 50 MiB` per
sync. Beyond them the hop refuses with a finding and tells the owner to seed the baseline by hand
(`git push` the large import once; sluice handles increments after). A first import of a large repo
is deliberately not something an hourly Worker should attempt.

## 5. API budget and rate limits

Per-run cost, with `d` changed directories and `f` changed files (text, no binaries):

| Phase | Calls |
|---|---|
| Nothing new | ~5 reads (source tip, target tip, mirror tip, open PR, closed PRs), **0 writes** |
| Differential walk | `2 × (d + 1)` tree reads |
| Content | `f` blob reads; `⌈f / 500⌉` `createTree`; 1 `createCommit`; 1 ref move |
| Existing engine | merge 1, PR create 1, labels/assignees/reviewers ~3, mergeability polls ≤ 5, source `compare` 1 |

So roughly **`2d + f + 25` requests**; a 100-file change across 10 directories is ~150. Each binary
adds one POST. Against the limits (GitHub's REST rate-limit docs, Cloudflare's Workers limits docs):

- **Primary:** 5,000 requests/hour per installation (rising to 12,500 with repo/user count). A 500-file
  sync is ~10% of one hour's budget.
- **Secondary:** 900 points/minute (GET 1, write 5) and **80 content-generating requests/minute, 500/hour**.
  The docs do not say which endpoints count as content-generating. If blob/tree/commit POSTs do, binaries
  are the exposure; text files avoid per-file POSTs by going inline. The resilience plugin already
  waits out short `retry-after`s and raises `RateLimitExceededError` for long ones; a rate-limited run
  stops and the next tick redoes the same (idempotent) work.
- **Workers:** 10,000 subrequests per invocation on **Paid** (50 on Free, so this transport requires
  Paid), 6 simultaneous connections (blob reads run at concurrency ≤ 4), 128 MB per isolate (the
  per-file and total byte caps are sized for it: concurrency 4 × ≤ 5 MiB × base64/decoded copies).
  Cron CPU limits are far above what an I/O-bound run uses.
- **Reads of a public upstream** use midstream's installation token (as fork does), so 5,000/h, not 60/h.

## 6. Protected paths and conflicts

**Protected paths are excluded from the mirror instead of being restored over it.** A path matching
`protected_paths` (including the auto-added managed workflow destinations) is simply not copied into
the mirror, not in the base snapshot and not in later ones. Merging the mirror therefore cannot touch
it, upstream edits and deletions to it are never applied, and its blob is never even downloaded
(which is also how an over-cap file is fenced off). The end state is identical to the restore-commit
path (`src/sync/protect.ts`) with fewer API calls and no second commit. The PR's "Protected paths" list
is the set of excluded paths that changed upstream. Removing a path from `protected_paths` makes it
appear in the mirror's next snapshot, so a differing target copy surfaces as an ordinary add/add
conflict, visible in the PR.

**Conflicts are unchanged**: GitHub computes `mergeable` on the PR; `awaitMergeable` polls it;
`reconcileConflict` labels, comments once and assigns on the transition. Resolution is pushing to
`chain/sync-<hop>` (sluice never force-pushes over it). Because the mirror has real shared history,
GitHub's conflict editor works.

Merge methods: `merge` gives exact ancestry. `squash`/`rebase` work as they do for forks (the marker
baseline), with the same documented cost: squashing loses the merge base, so later upstream edits to a
file you patched can re-conflict. The **adoption PR must be a merge commit** (§3.1).

## 7. What the reviewer sees

*Adoption PR* (once): "Adopt `acme/widget@abc1234` as the sync baseline". No files changed. States
what it does, that it must be merged with a **merge commit**, and how many tracked paths currently
differ from that upstream snapshot (informational, capped list).

*Sync PR* (each time): same title and `sluice:v1` marker as today. The "Files changed" tab is the real
diff against the target. The body adds a short "How this was built" note (the repos are unrelated, so
changed files were copied into `chain/mirror-upstream`; upstream commits are listed but not present in
this repo's history) and a changed-files summary (added / modified / deleted / binary, bytes), plus the
usual commit list, protected paths, merge advice and conflict banner. Nothing else about the PR differs.

## 8. Surface area

- **Config:** `transport` becomes overridable **per hop** (`hops.<hop>.transport`, top-level stays the
  default): a chain can have a forked midstream and a template-made downstream. New under a git-data hop:
  `mirror_branch` (default `chain/mirror-upstream` / `chain/mirror-midstream`, must be `chain/*`,
  distinct from the other bot branches), `baseline`, `max_files`, `max_bytes`. Unknown-key strictness
  and the `chain/` rules are unchanged; `git-data` stops producing the "not implemented" warning.
- **`GitHubPort`:** `getBlob`, `createBlob`, non-recursive `getTreeEntries`, `createTree` with an
  optional base (the mirror root has none), `CommitInfo.message`, and a distinct
  `NoCommonAncestorError` (today a 404 from `compare` is indistinguishable from "commit not visible").
- **`hop.ts`:** the `sourceSha`/`carrierSha` split and a `materialize` step before the ancestry check;
  `described` compares in the source repo. Everything after is unchanged.
- **Guard:** the mirror ref moves only through `createBranch`/`setBranchSha`, already limited to
  `chain/*`. Blob/tree/commit creation moves no ref. No new unguarded ref write.
- **`FakeGitHub`:** per-network object visibility for blobs and trees (so a bug that references a
  source blob in the target fails as it would on GitHub); file entries with mode, symlink, submodule
  and binary content; non-recursive listing; "no common ancestor" for unrelated commits.

## 9. Alternatives rejected

- **Client-side three-way merge, single-parent commit, no mirror.** Needs a diff3 implementation (or
  file-level "ours wins"), and a both-edited file would be resolved by sluice rather than shown as a
  conflict, i.e. upstream changes silently dropped inside a PR people merge on trust. Conflict markers
  written into files would pass CI. It also cannot use `mergeable`, the conflict editor, or the
  existing conflict machinery.
- **Git smart-HTTP (fetch from source, push a packfile).** Would preserve upstream's real history, but
  needs a pack encoder/decoder in a Worker and a credential that can push; much larger and riskier.
- **GitHub's fork-sync / import APIs.** Fork-only or deprecated; not applicable to unrelated repos.
- **One mirror commit per upstream commit.** Preserves granularity but multiplies calls by the commit
  count and the upstream history still lands in the target only as copies. One snapshot per sync keeps
  the budget bounded.

## 10. Decisions needed before implementation

1. **Per-hop `transport`** (recommended) vs keeping one chain-wide value.
2. **Bootstrap default** when `baseline` is unset: adopt the current source tip and say how many paths
   differ (recommended), or refuse until a `baseline` is given.
3. **Caps:** are `max_files: 500` / `max_bytes: 50 MiB`, 5 MiB per blob and "refuse, never skip" right?
4. **Attribution:** one sluice identity plus `Co-authored-by` for upstream authors, or no trailers (an
   upstream contributor's email would then appear in a downstream repo's history).
5. **Exclude-from-mirror** for protected paths (recommended) vs reusing the restore-commit path.

## 11. New assumptions that need a live check

To be added to the README's "Not verified against live GitHub" list when this is built:

- `compare` of two unrelated commits answers 404 with a "no common ancestor" message that can be told
  apart from a missing commit.
- A PR whose head adds commits but **no file changes** (the adoption PR) can be opened and merged with a
  merge commit.
- The Merges API accepts a mirror commit created through the Git Data API in the target, including one
  whose root has no parent.
- `createTree` accepts modes `100755`, `120000` and `160000` (type `commit`) for a gitlink whose commit
  is not in the repo, and `sha: null` deletions against a base tree.
- Whether blob/tree/commit POSTs count against the content-generating secondary limit.
- Raw blob download (`application/vnd.github.raw+json`) through Octokit on Workers returns bytes intact.
- Legacy tree modes (e.g. `100664`) are not normalised in a way that changes tree SHAs (only an
  optimisation depends on this, not correctness).
