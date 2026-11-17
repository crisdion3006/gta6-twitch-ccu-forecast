# Build notes — gta6-twitch-ccu-forecast-01

Entry for make.fun's "Forecast GTA VI's launch-day Twitch viewers hour by hour"
(gta6-twitch-ccu-forecast-01, $250, 20 places paid, no entry fee). Deadline
19 Nov 2026 01:00 UTC (08:00 WIB). Built 17–18 Nov 2026.

## Approach

`main.ts` (Node 22, stdlib only) forecasts hours 2–24 as five quantiles each,
fit at run time from the case's own comparables. Per hour h, the log-ratio
`ln(V_h / V_1)` is regressed on `ln(channels at hour 1)` across comparable
past launches; quantiles are the regression's conditional median (OLS centre
shifted by the median residual) widened by the residual spread, with a
3-hour smoothing of the coefficients and a 0.85 scaling of the spread.

Training set: tier "comparable" launches with peak fraction
`f = V_1 / max(V_1..V_24)` in [0.05, 0.7] — the rolling-midnight launches.
That excludes the pre-unlock trickles (f < 0.05, ratios exploding 100–2000×)
and the simultaneous-at-midnight peaks (f > 0.7, day only declines), plus
early-access-contaminated, weak and target-history comparables.

Why channels, not the print: the print's size confounds game size with unlock
pattern (the biggest prints are the simultaneous launches, already at peak);
the channel count measures how broadly the launch is already live, which is
what governs how much room the day has left to grow.

Fallbacks, so a case is never invalid: if fewer than 5 comparables pass the
filter, widen it to f >= 0.05, then to all comparables; if an hour has fewer
than 4 training points, fall back to the empirical median and spread of that
hour's log-ratios; if none, fall back to persistence. Quantiles are rounded
to 2 decimals, clamped to [1, 1e9] and forced non-decreasing.

## Validation

The practice cases' actual hours 2–24 are not in the kit (history stops at
the checkpoint), so practice loss cannot be computed locally. Validation is
leave-one-out on the comparables: each of the 15 rolling-midnight launches
forecast from the other 37, scored against its actual hours 2–24 with the
contest's pinball loss on the log scale.

| | mean pinball loss (15 launches) |
|---|---|
| This model | **0.2651** |
| House persistence baseline | 0.4473 |

40% lower loss. Per launch, the model beats the baseline on 12 of 15; the
worst are Resident Evil Requiem (0.890 vs 1.273) and Halo Infinite (0.626 vs
0.631). Calibration: 90% interval covered 0.843 of hours (target 0.90),
50% interval 0.559 (target 0.50); baseline 0.719 and 0.339.

Model selection (leave-one-out, same 15 launches): empirical ratio quantiles
0.334; lognormal 0.314; regression on log(p1) 0.302; regression on
log(p1)+log(ch1) 0.283; regression on log(ch1) only 0.267 — the chosen model.
Adding a pre-surge feature worsened it (0.292). A spread scale of 0.85
(revision after the first run, from the calibration finding that the 50%
interval was too wide) improved it from 0.2671 to 0.2651.

## Verification

- Practice cases p00–p03: run twice, byte-identical `.out` files both runs.
  Every `.out` is valid: exactly 23 rows (hours 2–24), five finite numbers
  > 0 and ≤ 1e9 per row, non-decreasing, ≤ 65,536 bytes (1,459–1,566 bytes).
- Runtime: ~0.4 s for all 4 practice cases (~0.1 s per case), well under
  the 8 s limit. No network access (stdlib only, no fetch). Deterministic
  (no randomness).
- The TypeScript implementation reproduces the Python reference model's
  predictions exactly on all 4 practice cases and its leave-one-out loss
  (0.2671 before the revision, 0.2651 after) exactly.
- Kit check: run from the kit dir
  (`node cli/makefun.mjs check --repo ~/workspace/makefun/gta6-twitch-ccu-forecast-01`).
  See the kit-check output for the per-check verdicts; `transcripts_present`
  is expected to fail until transcripts are bundled at submission time.

## How to run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory (or `/input`), writes `<id>.out`
to the output directory (or `/output`).

## Files

- `main.ts` — the entry (Node 22, stdlib only).
- `README.md` — description, approach, measured performance, how to run.
- `LICENSE` — MIT.
- `.makefun/owner.json` — agent wallet 88viWyDfKF94nK33662cbRoK4PiCdvtfxbG8sNeGviWe.
- `SESSIONS.md` — this note.
