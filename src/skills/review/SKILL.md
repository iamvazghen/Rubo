---
name: periodic-review
description: The recurring investment review — grade the whole universe, rank the best picks, report what moved since last time, and flag holdings whose case has decayed. Triggers when the user asks for "best picks", "what should I buy", "run the review", "monthly review", "quarterly review", "annual review", "what changed", or when a scheduled cron job fires the review.
---

# Periodic Review Skill

The recurring half of the job. Where `grade-investment` answers "what about this
one", this answers "what is worth owning right now, and what changed".

## Workflow Checklist

```
Review Progress:
- [ ] Step 1: Run the report
- [ ] Step 2: Lead with the changes, not the levels
- [ ] Step 3: Investigate the top of the list
- [ ] Step 4: Review the holdings
- [ ] Step 5: Deliver
```

## Step 1: Run the report

`investment_report` with the horizon the user asked for (`long` if unstated).
It grades every name in the universe, appends each grade to the ledger, diffs
against the previous run, and reviews current holdings. A 50-name universe takes
a few minutes; it runs four at a time to stay inside provider rate limits.

## Step 2: Lead with the changes, not the levels

A ranked list that looks the same every month is noise. The report gives you
`risers` and `fallers` against the previous run — **that is the news**. The top
ten is context.

On the first ever run there is no previous entry and every delta is `new`. Say
that plainly; do not present first-run levels as if something had moved.

## Step 3: Investigate the top of the list

For the top three, and for anything that moved more than 10 points, find out WHY
before reporting it. Check `get_company_news` and the factor breakdown from
`grade_ticker`. A score that jumped because a single quarter's margin spiked is a
different story from one that rose on a three-year trend.

## Step 4: Review the holdings

The report grades what the user actually owns and flags names that dropped 10+
points or fell below 50. These are the ones to lead the holdings section with —
the existing `trade-review` skill only looks at trades already closed, which is
too late to act on.

Flagging is not a sell instruction. Give the reason and let the user decide.

## Step 5: Deliver

```
Investment review — [date] — [horizon]

What moved
- [TICKER] [+/-N] to [score] — [why, in one clause]

Top picks
1. [TICKER] [score] — [the one factor that carries it]
2. ...

Your holdings
- [TICKER] [score] ([delta]) — [flag if any]

[Anything that could not be graded, and why.]
```

Keep it short. The full markdown report is written to `<rubo>/reports/` and
the user can read the detail there.

## Scheduling it

The review runs on whatever cadence the user wants, via the `cron` tool. Use the
session's own timezone.

- **Monthly** — `{ kind: 'cron', expr: '0 8 1 * *' }` — 08:00 on the 1st.
- **Quarterly** — `{ kind: 'cron', expr: '0 8 1 1,4,7,10 *' }` — 08:00 on the 1st
  of January, April, July, October.
- **Annual** — `{ kind: 'cron', expr: '0 8 2 1 *' }` — 08:00 on 2 January.

Set the job payload message to the review request itself, for example
"Run the long-horizon investment review and report what changed", with
`fulfillment: 'keep'`. Results are delivered on the channel the session came in
on.

Short-horizon reviews are worth running monthly; long-horizon reviews quarterly
or annually, because a 20-year thesis does not change in four weeks and a monthly
long-horizon report mostly teaches the user to ignore it.

## Rules

- The universe is fixed on purpose, so month-to-month comparisons are
  like-for-like. Read it with `score_history` action `universe`, change it with
  `set_universe`. Do not silently grade a different list.
- Never present a grade you did not get from the tools.
- Once there are several months of ledger history, `score_history` action
  `calibration` shows whether the high grades actually outperformed. Report it
  honestly, including when it says the scoring is not working.
