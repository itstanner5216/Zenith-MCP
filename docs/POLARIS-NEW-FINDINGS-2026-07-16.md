# POLARIS — New Findings Ledger (from 2026-07-16, five-lane repair program)

**Owner: Tanner. Nothing here is accepted/cleared without his explicit ruling.**
This is the designated document (per owner directive 2026-07-16) for anything
NEW discovered during the audit-repair program — regressions, deviations, or
issues not already in `POLARIS-KNOWN-ISSUES-2026-07-15.md` or the A1–A21 audit
set. Every entry: notify Tanner at discovery, status "lead-documented —
pending owner", never reworded toward settled.

Comparison protocol in force: lead fixes for audit findings are developed on
`lead/*` branches in the integration tree (never in lane worktrees) and are
compared head-to-head against lane fixes at the gate; best option wins on
evidence. Gate = `.polaris-gate/verify-lane.mjs` against the pinned
`46b341f` failure baseline (17 failing / 65 passing audit signatures +
1,689-test base).

---

N1. **[operational, notify] pnpm purge hazard through symlinked node_modules
    in worktrees (2026-07-16).** Discovered by the gate harness's own smoke
    test: running `pnpm run rebuild` (or any pnpm command that triggers a
    deps-status check) inside a worktree whose `node_modules` is a SYMLINK
    into the main tree makes pnpm attempt a modules-directory purge — through
    the symlink, i.e. against the shared real install used by every tree.
    Non-interactive runs abort on no-TTY (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`),
    which is the only thing that prevented damage here. Interactive runs
    prompt y/N. Relevance: the five lane worktrees follow the same symlink
    pattern. Gate harness now never invokes pnpm in scratch trees (executes
    the package's own rebuild script via symlinked .bin directly); lane
    agents' briefs may deserve the same warning — owner's call.

N2. **[gate accommodation, FYI] audit failure signatures can embed
    run-variant data.** The A5 test's assertion message contains
    `g/<sha256(mkdtemp root)>`, different every run. The gate normalizes
    hex runs ≥16, /tmp paths, and ISO timestamps in signatures before
    set-algebra so "mutated failure" means the failure MODE changed, not
    that a temp path rolled. Recorded so nobody mistakes normalization for
    signature laundering; raw signatures remain pinned in
    `.polaris-gate/audit-baseline-46b341f.json`.

N3. **[OWNER RULING, 2026-07-16] Tests are judged by property strength, not
    stasis.** Tanner: tests can and should be updated to reflect the better
    implementation when one is available; verdicts are about what is most
    correct for the codebase, never about whether a test file changed. Gate
    consequence: a vanished baseline key is an adjudication pointer (find
    the successor test in the diff; judge stronger/weaker), not a failure.
    Only WEAKENING an asserted property is rejectable. The lead's earlier
    "freeze audit test titles" recommendation is retracted. First
    application: resolution-1's renamed occurrences-differential test
    asserts a strictly stronger property (concat == one-shot over the
    six-field tuple) and passes — adjudicated clean.

N4. **[process event, owner-acknowledged 2026-07-16] A foreign lane agent is
    writing into the integration worktree.** Discovered as an unattributed
    uncommitted A19-shaped edit to `questions/file.ts` (parseJsonStringArray
    rejecting non-string JSON list members as STORE_CORRUPT, mtime 07:55).
    Tanner identified it as a lane agent confused about worktree paths and
    chose to let it finish. Containment: the lead's own edits are committed
    so the uncommitted delta is attributable to the agent alone; a
    change-triggered snapshot monitor records every state it passes through
    (for review or full revert); nothing of the agent's is committed; gate
    runs are immune (scratch trees build from committed refs, never this
    working tree). Its finished work will be adjudicated like any lane
    delivery — on correctness, per N3.

N5. **[lead process error, self-reported 2026-07-16] A10 proof suite leaked
    onto integration HEAD.** During the res1 A10 cross-check, cleanup ran
    with repo-root pathspecs from `packages/` — `git rm --cached` and the
    file delete both failed silently (`2>/dev/null`), a `head -3` truncated
    the status output that would have shown it, and the still-staged test
    rode into commits 97bf921/3affe01. Detected by the resolution-5 gate
    run (4 "new failures" = the leaked suite pinning A10-fixed behavior on
    a HEAD with no A10 fix merged). Remedy: removed at HEAD; the suite
    returns with whichever A10 candidate merges (already committed on
    `lead/a10-epoch`, proven 8/8 against resolution-1's implementation
    too). Res1's gate numbers predate the leak and stand. Lesson encoded:
    candidate assembly and cross-checks now happen only in scratch
    worktrees, never in the shared tree.

N6. **[cross-lane seam, lead-documented 2026-07-16] A5 × A15 intersect on
    frontier candidate paths.** res-2's A5 fix (facade decodes store keys to
    scope-relative paths per plan 789) covers the pinned surface
    (fileModel/locationAt path). But res-5's A15 `locateTarget` mints
    candidate `LocatedSymbol.path` from raw DB `filePath` — which in global
    mode is a `g/<hash>/...` store key: the same A5 leak in the frontier
    arm, outside A5's pinned surface. res-2 attempted a candidate decode,
    hit 2 unexplained test regressions (likely more bug-pins of the same
    leak shape), reverted it, and disclosed the residual — correct
    discipline. Resolution belongs to the merge sequence: when res-2 and
    res-5 both land, candidate paths need ONE consistent treatment
    (recommend: decode via codec, fail loud on non-decoding domain-member
    keys rather than falling back to the raw key; cross-scope candidates
    need an owner ruling — serve decoded-foreign, typed-unavailable, or
    omit-with-issue). Also noted for review: res-2's `publicPathOf` helper
    ends in `?? storeKey` — a silent re-leak on any non-decoding key; the
    primary path should hard-fail instead. Two stale bug-pinning
    assertions in polaris-questions-file.test.js (the lead's own tests,
    asserting `startsWith('g/')` and reusing model.path as a DB key) are
    authorized for correction under N3 + plan 789.

---

## N7 — AMENDMENT (A8/A14 coverage honesty) — OWNER-APPROVED 2026-07-16: OPTION A

Escalated by the resolution-2 agent; lead concurs with its Option A and
records the recommendation here for owner ruling. Lead notes this finding
class indicts the lead's own two-state coverageBuilder design.

**Problem.** FactCoverage is strictly `complete | unavailable(reason)` and
coverageBuilder throws otherwise. No UnavailabilityReason value honestly
describes "member present but bytes unreadable" or "member persisted as
too-large sentinel," so single-file assemblies are forced to claim
`complete` for domains whose facts are knowingly absent (A8), and the same
boundary blocks A14's coverage half.

**Option A (lead recommendation).** Add two UnavailabilityReason members:
- `source_unreadable` — domain member present but bytes unreadable at
  assembly time.
- `source_file_too_large` — member persisted under the too-large sentinel;
  facts intentionally absent.

Scope discipline (binding if approved):
- Constructible ONLY from member status (unreadable / too-large sentinel),
  never as a general escape hatch.
- Single-member assemblies (fileModel, locationAt) mark affected domains
  `unavailable(reason)`. Multi-member aggregates (scopeModel) keep
  `complete` + per-path CoverageIssue flags — this amendment does NOT
  authorize whole-domain unavailability when one member of many is bad.
- Status derivation unchanged (710 rule): unavailable domains already
  imply `partial`.
- A14 rider: its coverage half uses these members; its claim-stripping
  half (no complete qualified-name/owner chains from truncated parent
  walks) is pure code, proceeding now, no approval needed.

**Option B (rejected by lead, preserved for owner).** Third FactCoverage
state `incomplete`: conceptually purer for "facts partially present" but
changes the coverage model consumed by every composer, coverageBuilder,
and all status-derivation pins under the owner-ratified 710 rule —
strictly larger blast radius for equal honesty at the surface that
matters.

**Blast radius of A.** types.ts enum +2; coverageBuilder accepts the new
reasons (mechanical); composers construct them; compile fallout limited to
exhaustive switches on UnavailabilityReason (res-2 to enumerate by grep
pre-merge); existing pins asserting complete-for-unreadable flip as
expected-value changes, itemized at the merge gate. No collision with
res-5's pending type amendments (disjoint types).

---

## N8 — Cross-lane seam A9×A11: content-key ordering (FIXED AT MERGE GATE)

resolution-3 forked before resolution-1's A9 fix existed; its A11 content
phase added `contentKeys.sort` under JS relational (UTF-16) order while
merged A9 makes canonical order UTF-8 bytes — the digest sort three lines
below orders the SAME keys differently. Composed, processing order and
digest order disagreed for non-ASCII store keys. Same species as N6:
two independently-correct lanes composing into an inconsistency.

Lead fix at the merge gate (integration-next): the sort switched to
Buffer.compare UTF-8, with a discriminating pin appended to
polaris-independent-content-receipts.test.js (BMP U+FF61 vs astral
U+10000 keys, trigger on the byte-canonically-last file; proven RED under
the JS sort by compiled-dist mutation, GREEN restored). Both lanes' own
tests were blind to it (ASCII fixtures only). Lead decision — pending
owner; disclosed here per the audit-repair ledger protocol.

---

## N9 — Owner approval batch (2026-07-16, verbatim scope)

The owner approved, in one batch: res-5's five amendments (A2, A21, A6,
A7, A15 — public-type changes now adopted), N7 Option A (two
UnavailabilityReason members, scope discipline binding), the Decision-26
collation amendment (UTF-8 byte order — written into the plan), and the
three outstanding ratifications (Task 1.1 persist.ts allowlist, Task 1.2
typed-edge-anchor expected-value correction, P2-4b pre-clamp junk-root
fix in boundaries.ts). res-3's report-waiver question was mooted by its
delivered FIX-REPORT. Recorded by the lead as the durable receipt.

---

## N10 — Owner design principle: the surface filters, it never hedges (REVISED per owner, 2026-07-16)

Owner-stated: grades, proofs, coverage receipts, and epochs are internal.
Context is not free; the consuming model receives whatever crosses the
tool boundary as fact. Below-threshold material is not shown at all,
though it still feeds internal machinery (ranking, compression,
advisories, other tools). This raises the stakes: miscalibration
surfaces as confident fact or silence, never as a visible hedge. The
plan's existing structure is the complete answer to this — unforgeable
proof types at the resolved boundary (A2), grade/basis conservation on
all internal flows, and coverage proofs separating absent-with-proof
from unsearched.

Owner clarifications superseding the first version of this entry:

1. Optional mechanisms giving the model access to internal grading are
   planned eventually. "Never sees" describes the default surface, not a
   permanent wall.
2. The lead's proposed corollary — surface thresholds as named rules
   with dedicated regression pins — is REJECTED as unnecessary. Its
   absence from the plan is deliberate, not an oversight: following the
   plan as structured, without unnecessary deviation, produces the
   reliable end result directly; building the extra mechanism does not
   strengthen the implementation. Recorded so the idea is not
   reintroduced later as a presumed gap.

---

## N11 — Residual: candidate-site qualifiedName cannot claim-strip (PENDING OWNER)

Discovered at the res-2 stitch: A14's claim-strip (qualifiedName null when
the parent walk truncated) is implemented for declaration facts per the
approved amendment, but locateTarget's heuristic candidates carry a
NON-NULLABLE qualifiedName in the frozen candidate type, so a truncated
walk still joins a dotted name there (truncation IS detectable —
parentInternalId is in the ancestry row). The lead attempted the same
approved mechanism at this site; tsc correctly rejected it as a new
public type change, and it was reverted rather than adopted unilaterally.
Fix if owner wants it: one-field amendment (candidate qualifiedName:
string | null), then the identical mechanism applies. Mitigation today:
candidates are explicitly heuristic_name basis (never proof-bearing), and
the code site carries an N11 comment.

## Program close (2026-07-16)

All 21 audit findings fixed and merged. Final board on integration-next:
1817 passed / 0 failed / 2 skipped. Train: res-1 (A3/A4/A9/A10/A18) →
res-4 (A13/A20) → res-3 (A1/A11/A12/A16/A17, +N8 seam fix) → res-5
(A2/A6/A7/A15/A21, owner-approved amendments) → res-2 (A19/A5/A8/A14,
N7 Option A, N6 seam closed at stitch). Every merge shrank the failure
set by exactly its predicted signatures; zero mutations; zero new
failures anywhere in the train.

---

## N12 — Lead process error: tracked node_modules SYMLINKS (FIXED)

The lead's `git add -A` bookkeeping commits (from 28e3a77 onward) swept
the three node_modules symlinks into the tree: `.gitignore`'s
`node_modules/` (trailing slash) matches directories only, and a SYMLINK
named node_modules is not a directory for gitignore purposes. Every
worktree created from those commits materialized dangling symlinks into
the (deleted) import-extension tree and failed pnpm install with ENOTDIR.
Fix: symlinks git rm --cached'd, `.gitignore` pattern corrected to
`node_modules` (matches dirs, files, and symlinks), lane branches
recreated from the fixed commit. History still carries the 68-byte blobs;
HEAD does not. Self-reported, N5's sibling: the cost of `git add -A` as a
bookkeeping habit is now two ledger entries, so the habit ends — targeted
adds only.
