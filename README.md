# gta6-twitch-ccu-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/crisdion3006/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/crisdion3006/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecast GTA VI's launch-day Twitch concurrent viewers, hour by hour (hours 2–24), as five quantiles each — built for make.fun's "Forecast GTA VI's launch-day Twitch viewers hour by hour" bounty ($250, 20 places paid).

## Approach

The program (`main.ts`, Node 22, standard library only) fits the forecast at run time from the case's own comparables — 38–42 past big launches with hourly Twitch counts. For each hour h it regresses the log-ratio `ln(V_h / V_1)` on `ln(channels at hour 1)` across comparable launches, then sets the quantiles from the regression's conditional median (OLS centre shifted by the median residual, so the centre is a median, not a mean) widened by the residual spread:

```
q_tau(h) = p1 * exp(a_h + b_h * ln(ch1) + r_h + z_tau * s_h)
```

`p1` is hour 1's print, `ch1` its channel count, `z_tau` the standard normal's quantile at each level (0.05, 0.25, 0.5, 0.75, 0.95). The per-hour fits are smoothed over a 3-hour window, and the spread is scaled by 0.85 (calibration: the log-ratio distribution is slightly lighter-tailed than a normal, so the middle quantiles would otherwise sit too far from the median).

Training set: launches of tier "comparable" whose hour-1 print was a meaningful share of their own release-day peak — peak fraction `f = V_1 / max(V_1..V_24)` in [0.05, 0.7]. That keeps the rolling-midnight launches (already under way at hour 1 and growing through the day, as GTA VI's will be: New Zealand first, the US unlocking later) and leaves out the two regimes that would wreck the fit: `f < 0.05`, where hour 1 is a pre-unlock trickle and the ratio explodes 100–2000× at the global unlock, and `f > 0.7`, where hour 1 already is the peak and the day only declines. Early-access-contaminated, weak and target-history comparables are left out too.

Why the channel count and not the print itself: the print's size confounds game size with unlock pattern (the biggest prints in the set are the simultaneous-at-midnight launches, already at their peak), while the channel count measures how broadly the launch is already live — how many streamers are on it — which is what governs how much room the day has left to grow.

## Measured performance

Validated by leave-one-out on the 15 rolling-midnight comparables (each launch forecast from the other 37, scored against its actual hours 2–24 with the contest's pinball loss on the log scale):

| | mean pinball loss |
|---|---|
| This model | **0.265** |
| House persistence baseline | 0.447 |

A 40% lower loss. The model's 90% interval covered 0.84 of the hours and its 50% interval 0.56; the baseline covered 0.72 and 0.34. The baseline's stated practice loss is ~0.387. The practice cases' actual hours 2–24 are not in the kit, so no practice loss can be computed locally — the leave-one-out loss above is the measured figure.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory (or `/input` by default) and writes `<id>.out` to the output directory (or `/output`). No network, no randomness — two runs write byte-identical outputs. Runs in ~0.1 s per case, well under the 8 s limit.

---

Entered on [make.fun](https://make.fun/bounty/gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards
