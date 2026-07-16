# POLARIS Running Known Issues — Lane INTEL

This is the living ledger for every issue surfaced while Lane INTEL
works: bugs, plan contradictions, gaps, surprising behavior, anything
you were tempted to call "fine." An issue exists the moment you notice
it — it gets an entry BEFORE it gets a fix. This file is append-only
history; entries change status, they never disappear.

---

## Owner instructions (Tanner) — OWNER-CONFIRMED 2026-07-16

These are my rules. They are not suggestions.

1. **When you surface an issue: STOP.** Immediately stop the affected
   work and document it here first — before you fix it, before you work
   around it, before you build anything on top of it. Then make sure I
   see it.
2. **The HOW is yours. The WHAT is mine.** You have full authority over
   implementation — any code or structure route that reaches the plan's
   end state, no permission needed. You have NO authority over what:
   plan deviations, public types/contracts, behavior changes, changed
   test expectations, acceptance criteria. Those stop and wait for my
   explicit yes.
3. **Never alter the plan without my explicit permission.** Proposed
   changes are written as PROPOSED — PENDING OWNER APPROVAL and stay
   that way until I approve. You never write your own decision in as
   adopted, and you never label your own choices "ruled," "approved,"
   or "cleared." The label for your judgment is: lead decision — pending
   owner.
4. **No deferring real bugs.** If it is not correct now, there is no
   next phase until it is. Filing a known defect as a non-blocking
   follow-up is unacceptable.
5. **Before you deem anything correct or intentional, it goes in this
   document** — so I can see it and attempt solutions myself. Rulings
   never live only in code comments or test pins.
6. **Plan silence can be deliberate.** Absence of something in the plan
   is not automatically a gap for you to fill. Ask. I am the authority
   on gap vs decision.
7. **Never *weaken*, skip, or delete an asserted property to make
   progress.** A failing assertion stands until it is properly fixed or
   I rule on it. A test may change only to assert a *stronger* property
   (finding N3) — strengthening is encouraged, never frozen; only
   weakening is rejectable.
8. **You and the other lead are equals.** You do not direct each other;
   direction comes from me. Disagreements come to me — I am the
   tiebreaker. You do not touch their lane's work.
9. **TOON is untouchable.** Nothing under packages/zenith-toon changes,
   ever, for any reason. If your work changes what flows across that
   seam, the TOON suites get rerun and I hear about it.

---

## Entry format

```
### <LANE>-<n> — <short title>
- Date:
- Status: OPEN | LEAD DECISION — PENDING OWNER | OWNER-APPROVED | FIXED (commit)
- Where: <files/paths>
- What: <the issue, plainly>
- Evidence: <repro, failing test, probe output>
- Options / proposed disposition:
```

---

## Issues

*(none yet)*
