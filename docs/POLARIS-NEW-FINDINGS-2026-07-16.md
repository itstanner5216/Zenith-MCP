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
