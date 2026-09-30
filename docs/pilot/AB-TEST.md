# A/B Test — Create Group: Wizard (4-step) vs 1-Screen

**Why:** Wizard feels warmer; 1-screen is faster. Pilot decides with data, not taste.

## Variants
- **A (wizard, current):** Step 1 name → Step 2 amount chips → Step 3 frequency → Step 4 stepper → Create. Code `AJ-4821` + share sheet.
- **B (1-screen):** All fields on one scroll (name, amount chips, frequency, stepper, payout mode) + single CTA. Same success state.

## Assignment
- Bodija recruits split alternately A/B (odd/even join order), n≥20 attempts per variant.
- Events: `create_started, create_step_{1..4}_done, create_completed, create_abandoned(step)` + `duration_ms`.

## Success metrics (2 weeks)
- Primary: completion rate (completed/started). Wizard wins if ≥10pts higher; 1-screen wins if faster with ≤5pts gap.
- Secondary: median time-to-create (target <60s both), error rate, support asks, Day-7 group activation.
- Guardrail: no variant below 60% completion.

## Decision rule
- Ship winner to all 20 groups; loser kept in git (`d9e3f91` contains wizard; 1-screen to be built if B wins test build).
- If inconclusive (<10pts gap), ship 1-screen (simpler to maintain) with wizard copy tone.

## Runbook
1. PM assigns A/B at onboarding (tracker column).
2. Ops logs completions daily in `docs/pilot/GROUPS.md` tracker.
3. Friday review: compare, decide, document in this file.
