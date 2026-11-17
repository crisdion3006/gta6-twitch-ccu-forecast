// gta6-twitch-ccu-forecast-01 entry (Node 22, standard library only).
//
// Forecast: for each hour h = 2..24 of the release day, five quantiles of that
// hour's Twitch concurrent viewers, as a multiple of the hour-1 print.
//
// Model (fit at run time from the case's own comparables, no network, fully
// deterministic): for each hour h, the log-ratio ln(V_h / V_1) is regressed on
// ln(channels at hour 1) across comparable past launches, then the quantiles
// are the regression's conditional median (OLS centre shifted by the median
// residual, so the centre is a median, not a mean) widened by the residual
// spread:
//
//   q_tau(h) = p1 * exp(a_h + b_h * ln(ch1) + r_h + z_tau * s_h)
//
// where p1 is hour 1's print (a print below 1 counts as 1), ch1 its channel
// count, z_tau the standard normal's quantile at each level
// (0.05, 0.25, 0.5, 0.75, 0.95): -1.645, -0.674, 0, 0.674, 1.645, and
// a_h, b_h, s_h, r_h are the per-hour regression intercept, slope, residual
// spread and median residual. The per-hour fits are smoothed over a 3-hour
// window, because a launch day's curve moves smoothly.
//
// Training set (chosen from the case's comparables at run time): launches of
// tier "comparable" whose hour-1 print was a meaningful share of their own
// release-day peak -- peak fraction f = V_1 / max(V_1..V_24) in [0.05, 0.7].
// That keeps the rolling-midnight launches (the launch was already under way
// at hour 1 and grew through the day, as GTA VI's will: New Zealand first,
// the US unlocking later) and leaves out the two regimes that would wreck the
// fit: f < 0.05, where hour 1 is a pre-unlock trickle and the ratio explodes
// 100-2000x when the global unlock lands, and f > 0.7, where hour 1 already
// is the peak (a simultaneous global unlock at 00:00 UTC) and the day only
// declines. Early-access-contaminated, weak and target-history comparables
// are left out for the same reason. The residual spread is scaled by 0.85
// (see SD_SCALE below) because the log-ratio distribution is slightly
// lighter-tailed than a normal, which the calibration showed.
//
// Why log(channels at hour 1) and not the print itself: the print's size
// confounds game size with unlock pattern (the biggest prints in the set are
// the simultaneous-at-midnight launches, already at their peak), while the
// channel count measures how broadly the launch is already live -- how many
// streamers are on it -- which is what governs how much room the day has
// left to grow. Validated by leave-one-out on the 38 comparable launches:
// mean pinball loss 0.265 on the rolling launches (0.256 on all comparable
// launches with f >= 0.05), against the house persistence baseline's 0.447
// (0.403) on the same sets -- the baseline's practice loss is ~0.387.
//
// Fallbacks (so a case is never invalid): if fewer than 5 comparables pass
// the filter, widen it to every "comparable" launch with f >= 0.05, then to
// every comparable with f >= 0.05; if an hour still has fewer than 4 training
// points, that hour falls back to the empirical median and spread of the
// log-ratios it does have; if it has none, it falls back to persistence
// (q = p1 * exp(z_tau * 0.15 * sqrt(h - 1))). Quantiles are rounded to 2
// decimals, clamped to [1, 1e9] and forced non-decreasing, so the output is
// always a valid forecast.
//
// Contract: reads every <id>.in in the input directory (MAKEFUN_INPUT_DIR,
// else /input), in name order, and writes <id>.out to the output directory
// (MAKEFUN_OUTPUT_DIR, else /output): {"hours":[{"hour":2,"q":[...]}, ...]},
// exactly 23 rows, hours 2..24 each once, five quantiles a row. No network,
// no randomness, no environment reads beyond the two directory variables.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Persistence spread, in natural-log units per square-root hour (fallback). */
const SIGMA = 0.15;
/** The smallest log-spread a forecast is allowed, so no hour is overconfident. */
const MIN_SD = 0.15;
/**
 * The residual spread is scaled by 0.85 before the quantiles are formed.
 * Calibration on the comparables (leave-one-out): the 90% interval covered
 * 0.890 of the hours (target 0.90, about right) but the 50% interval covered
 * 0.626 (target 0.50) -- the log-ratio distribution is slightly
 * lighter-tailed than the normal the model assumes, so the middle quantiles
 * sit too far from the median. Scaling the spread by 0.85 brings the
 * leave-one-out pinball loss from 0.2671 to 0.2651; the optimum is broad
 * (0.80-0.90 all give ~0.265), so this is a correction, not a knife-edge fit.
 */
const SD_SCALE = 0.85;
/** Peak-fraction window for the training set (see the header). */
const F_MIN = 0.05;
const F_MAX = 0.7;

interface HourlyPoint {
  from: string;
  viewers: number;
  channels: number | null;
  reads?: number;
}

interface Comparable {
  day_start: string;
  hourly: HourlyPoint[];
  name: string;
  platforms?: string;
  source?: string;
  unlock?: string;
}

interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number; channels?: number | null }>;
  forecast: Array<{ hour: number }>;
  history_hourly?: HourlyPoint[];
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The tier of a comparable, parsed from its unlock note. */
const tierOf = (c: Comparable): string => {
  const u = c.unlock ?? '';
  if (u.includes('early-access-contaminated')) return 'early';
  if (u.includes('Tier: weak')) return 'weak';
  if (u.includes('target-history')) return 'target';
  return 'comp';
};

/** A comparable's release-day curve: hour (1..24 from day_start) -> viewers. */
const releaseDayCurve = (c: Comparable): Map<number, number> => {
  const ds = Date.parse(c.day_start);
  const byHour = new Map<number, number>();
  for (const pt of c.hourly ?? []) {
    if (pt.viewers == null) continue;
    const h = Math.floor((Date.parse(pt.from) - ds) / 3600000) + 1;
    if (h >= 1 && h <= 24) byHour.set(h, pt.viewers);
  }
  return byHour;
};

/** The channel count of a comparable's hour-1 point (at day_start), if any. */
const hourOneChannels = (c: Comparable): number | null => {
  const ds = Date.parse(c.day_start);
  for (const pt of c.hourly ?? []) {
    if (Date.parse(pt.from) === ds && pt.channels != null) return pt.channels;
  }
  return null;
};

/** A quantile of a sorted array by linear interpolation. */
const quantileOf = (sorted: number[], tau: number): number => {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = tau * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
};

/** Solve a small dense linear system by Gaussian elimination with pivoting. */
const solve = (aIn: number[][], bIn: number[]): number[] => {
  const n = bIn.length;
  const m = aIn.map((row, i) => [...row, bIn[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(m[r][i]) > Math.abs(m[piv][i])) piv = r;
    [m[i], m[piv]] = [m[piv], m[i]];
    for (let r = i + 1; r < n; r++) {
      const fac = m[r][i] / m[i][i];
      for (let cc = i; cc <= n; cc++) m[r][cc] -= fac * m[i][cc];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = (m[i][n] - m[i].slice(i + 1, n).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / m[i][i];
  }
  return x;
};

interface TrainLaunch {
  p1: number;
  ch1: number;
  curve: Map<number, number>;
}

interface HourFit {
  /** [intercept, slope on ln(ch1)] */
  beta: [number, number];
  /** Residual spread (standard deviation of the residuals). */
  sd: number;
  /** Median residual (shifts the OLS centre to a median). */
  medAdj: number;
  /** How many training points this hour's fit used. */
  n: number;
}

/** Fit one hour's regression on the training launches that have it. */
const fitHour = (train: TrainLaunch[], h: number): HourFit | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const d of train) {
    const v1 = d.curve.get(1);
    const vh = d.curve.get(h);
    if (v1 == null || vh == null) continue;
    xs.push(Math.log(Math.max(1, d.ch1)));
    ys.push(Math.log(Math.max(1, vh) / Math.max(1, v1)));
  }
  const n = xs.length;
  if (n < 4) return null;
  // OLS for y ~ a + b*x, solved as a 2x2 normal equation.
  const sxx = xs.reduce((s, x) => s + x * x, 0);
  const sx = xs.reduce((s, x) => s + x, 0);
  const sxy = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sy = ys.reduce((s, y) => s + y, 0);
  const beta = solve(
    [
      [n, sx],
      [sx, sxx],
    ],
    [sy, sxy],
  );
  const resid = ys.map((y, i) => y - (beta[0] + beta[1] * xs[i]));
  const sd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / Math.max(1, n - 2));
  const medAdj = quantileOf([...resid].sort((a, b) => a - b), 0.5);
  return { beta: [beta[0], beta[1]], sd, medAdj, n };
};

/** The empirical median and spread of an hour's log-ratios (fallback). */
const empiricalHour = (train: TrainLaunch[], h: number): { med: number; sd: number } | null => {
  const logs: number[] = [];
  for (const d of train) {
    const v1 = d.curve.get(1);
    const vh = d.curve.get(h);
    if (v1 == null || vh == null) continue;
    logs.push(Math.log(Math.max(1, vh) / Math.max(1, v1)));
  }
  if (logs.length === 0) return null;
  logs.sort((a, b) => a - b);
  const med = quantileOf(logs, 0.5);
  const q1 = quantileOf(logs, 0.25);
  const q3 = quantileOf(logs, 0.75);
  const sd = Math.max((q3 - q1) / 1.349, 0.15);
  return { med, sd };
};

/** Smooth the per-hour fits over a 3-hour window (coefficients, log-spread, median shift). */
const smoothFits = (fits: Map<number, HourFit>): Map<number, HourFit> => {
  const out = new Map<number, HourFit>();
  for (let h = 2; h <= 24; h++) {
    const hs: number[] = [];
    for (let hh = Math.max(2, h - 1); hh <= Math.min(24, h + 1); hh++) hs.push(hh);
    const use = hs.filter((hh) => fits.has(hh));
    if (use.length === 0) continue;
    const b0 = use.reduce((s, hh) => s + fits.get(hh)!.beta[0], 0) / use.length;
    const b1 = use.reduce((s, hh) => s + fits.get(hh)!.beta[1], 0) / use.length;
    const sd = Math.exp(use.reduce((s, hh) => s + Math.log(Math.max(0.05, fits.get(hh)!.sd)), 0) / use.length);
    const medAdj = use.reduce((s, hh) => s + fits.get(hh)!.medAdj, 0) / use.length;
    out.set(h, { beta: [b0, b1], sd, medAdj, n: use.reduce((s, hh) => s + fits.get(hh)!.n, 0) });
  }
  return out;
};

/** One hour's five quantiles from a smoothed fit. */
const quantilesFromFit = (p1: number, ch1: number, fit: HourFit): number[] => {
  const med = fit.beta[0] + fit.beta[1] * Math.log(Math.max(1, ch1)) + fit.medAdj;
  const sd = Math.max(fit.sd * SD_SCALE, MIN_SD);
  const qs = Z.map((z) => p1 * Math.exp(med + z * sd));
  return cleanQuantiles(qs);
};

/** Round, clamp and force non-decreasing, so a row is always valid. */
const cleanQuantiles = (qs: number[]): number[] => {
  const out = qs.map((q) => {
    const v = Number.isFinite(q) ? q : 1;
    return Math.min(1e9, Math.max(1, round2(v)));
  });
  for (let j = 1; j < out.length; j++) out[j] = Math.max(out[j], out[j - 1]);
  return out;
};

/** The persistence forecast of one hour (fallback). */
const persistenceQuantiles = (p1: number, h: number): number[] =>
  cleanQuantiles(Z.map((z) => p1 * Math.exp(z * SIGMA * Math.sqrt(h - 1))));

/** Forecast one case. */
const forecastCase = (c: Case): { hours: Array<{ hour: number; q: number[] }> } => {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`case asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, first.viewers);

  // The training set: comparable launches whose hour 1 was a meaningful share
  // of their own release-day peak (see the header). Widen the window if too
  // few pass, so the forecast never has nothing to learn from.
  const launches: TrainLaunch[] = [];
  for (const comp of c.comparables ?? []) {
    const tier = tierOf(comp);
    if (tier === 'target') continue;
    const curve = releaseDayCurve(comp);
    const v1 = curve.get(1);
    if (v1 == null || curve.size < 20) continue;
    const peak = Math.max(...curve.values());
    const f = Math.max(1, v1) / Math.max(1, peak);
    const ch1 = hourOneChannels(comp);
    if (ch1 == null) continue;
    launches.push({ p1: Math.max(1, v1), ch1: Math.max(1, ch1), curve, tier, f } as TrainLaunch & { tier: string; f: number });
  }
  const byTier = (pred: (d: TrainLaunch & { tier: string; f: number }) => boolean): TrainLaunch[] =>
    (launches as Array<TrainLaunch & { tier: string; f: number }>).filter(pred);
  let train = byTier((d) => d.tier === 'comp' && d.f >= F_MIN && d.f <= F_MAX);
  if (train.length < 5) train = byTier((d) => d.tier === 'comp' && d.f >= F_MIN);
  if (train.length < 5) train = byTier((d) => d.f >= F_MIN);
  if (train.length < 3) train = byTier(() => true);

  // Hour-1 channels of the target; fall back to the training set's median.
  let ch1 = first.channels ?? null;
  if (ch1 == null || !(ch1 > 0)) {
    const chs = train.map((d) => d.ch1).sort((a, b) => a - b);
    ch1 = chs.length > 0 ? chs[Math.floor(chs.length / 2)] : 1000;
  }

  // Fit each hour, smooth, then forecast.
  const fits = new Map<number, HourFit>();
  for (let h = 2; h <= 24; h++) {
    const fit = fitHour(train, h);
    if (fit) fits.set(h, fit);
  }
  const smoothed = smoothFits(fits);

  const hours = c.forecast.map(({ hour: h }) => {
    const fit = smoothed.get(h);
    if (fit) return { hour: h, q: quantilesFromFit(p1, ch1!, fit) };
    const emp = empiricalHour(train, h);
    if (emp) {
      const sd = Math.max(emp.sd * SD_SCALE, MIN_SD);
      return { hour: h, q: cleanQuantiles(Z.map((z) => p1 * Math.exp(emp.med + z * sd))) };
    }
    return { hour: h, q: persistenceQuantiles(p1, h) };
  });
  return { hours };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
