import { addCivilDays, type DateRange } from './dates.js';
import type { Missing } from './errors.js';
import type { HealthApi } from './health.js';
import { readRecoveryDays } from './recovery.js';
import { percentile, present } from './stats.js';
import { readAccountDate } from './today.js';

export type Sex = 'male' | 'female' | 'unspecified';

/** [age, value] points of a population median that falls with age. */
type Curve = ReadonlyArray<readonly [number, number]>;

/**
 * Treadmill VO2 max 50th percentile (ml/kg/min) at decade midpoints 25-75, FRIEND registry:
 * Kaminsky LA, Arena R, Myers J. Reference standards for cardiorespiratory fitness measured with
 * cardiopulmonary exercise testing. Mayo Clin Proc. 2015;90(11):1515-1523.
 * Not yet checked against the paper's table: the 35-65 points may differ from the published medians.
 */
const VO2_MAX_MEDIAN: Record<'male' | 'female', Curve> = {
  male: [[25, 48.0], [35, 44.6], [45, 40.3], [55, 35.0], [65, 29.4], [75, 24.4]],
  female: [[25, 37.6], [35, 34.1], [45, 30.9], [55, 27.1], [65, 22.6], [75, 18.3]],
};

/**
 * Short-term RMSSD (ms) by age, both sexes. Attributed to Shaffer F, Ginsberg JP. An overview of heart rate
 * variability metrics and norms. Front Public Health. 2017;5:258. A review, not a registry: low confidence.
 * Not yet checked against the review.
 */
const RMSSD_MEDIAN: Curve = [[25, 60], [35, 46], [45, 36], [55, 29], [65, 23]];

/** The age where a falling piecewise-linear curve reaches `value`, end slopes extended, clamped to 20-90. */
export function ageAtValue(curve: Curve, value: number): number {
  let i = 0;
  while (i < curve.length - 2 && curve[i + 1]![1] > value) i++;
  const [a0, v0] = curve[i]!;
  const [a1, v1] = curve[i + 1]!;
  return Math.min(90, Math.max(20, a0 + ((value - v0) * (a1 - a0)) / (v1 - v0)));
}

/** The sex's curve; `unspecified` averages the male and female values at each age. */
function vo2Curve(sex: Sex): Curve {
  if (sex !== 'unspecified') return VO2_MAX_MEDIAN[sex];
  return VO2_MAX_MEDIAN.male.map(([age, value], i) => [age, (value + VO2_MAX_MEDIAN.female[i]![1]) / 2] as const);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export type FitnessAgeInput = { start?: string; end?: string; age?: number; birthYear?: number; sex?: Sex };

type Part = {
  key: 'vo2max' | 'hrv';
  inputMedian: number;
  unit: string;
  days: number;
  estimatedDays?: number;
  latestCardioFitnessLevel?: string;
  equivalentAge: number;
  reference: string;
  confidence?: 'low';
  caveat?: string;
};

export type FitnessAgeResult = { window?: DateRange; chronologicalAge?: number; sex: Sex; parts: Part[]; missing: Missing[]; note: string };

/** Equivalent ages for VO2 max and overnight HRV against population medians. Descriptive, not a score. */
export async function readFitnessAge(api: HealthApi, now: Date, input: FitnessAgeInput): Promise<FitnessAgeResult> {
  const sex = input.sex ?? 'unspecified';
  const note = 'Equivalent ages compare you with population medians. Not a medical result.';
  let end = input.end;
  if (!end) {
    const account = await readAccountDate(api, now);
    if (!account.date) return { sex, parts: [], missing: account.missing, note };
    end = account.date;
  }
  const start = input.start ?? addCivilDays(end, -29);
  const recovery = await readRecoveryDays(api, start, end);
  const chronologicalAge = input.age ?? (input.birthYear === undefined ? undefined : Number(end.slice(0, 4)) - input.birthYear);
  if (chronologicalAge !== undefined && chronologicalAge < 0) throw new Error('birthYear is after the end date.');

  const missing: Missing[] = [];
  /** The median when there are at least `min` days; otherwise a missing entry, never a guess. */
  const medianOf = (series: string, values: number[], min: number, unit: string) => {
    if (values.length >= min) return percentile(values, 0.5);
    const failed = values.length === 0 ? recovery.missing.find((entry) => entry.series === series && !entry.date) : undefined;
    missing.push({ series, reason: failed?.reason ?? `${values.length} of ${min} ${unit} with data` });
    return undefined;
  };

  // The API documents vo2Max in [0, 100]; anything else is dropped.
  const vo2Days = recovery.days.filter(({ dailyVo2Max: v }) => typeof v?.vo2Max === 'number' && v.vo2Max >= 0 && v.vo2Max <= 100);
  const vo2 = vo2Days.map((day) => day.dailyVo2Max!.vo2Max as number);
  const hrv = present(recovery.days.map((day) => day.dailyHeartRateVariability?.averageHeartRateVariabilityMilliseconds as number | undefined));
  const vo2Median = medianOf('daily-vo2-max', vo2, 3, 'days');
  const hrvMedian = medianOf('daily-heart-rate-variability', hrv, 7, 'nights');

  const parts: Part[] = [];
  if (vo2Median !== undefined) {
    const latestLevel = [...vo2Days].reverse().find((day) => day.dailyVo2Max!.cardioFitnessLevel)?.dailyVo2Max!.cardioFitnessLevel as string | undefined;
    parts.push({
      key: 'vo2max',
      inputMedian: round1(vo2Median),
      unit: 'ml/kg/min',
      days: vo2.length,
      estimatedDays: vo2Days.filter((day) => day.dailyVo2Max!.estimated === true).length,
      ...(latestLevel ? { latestCardioFitnessLevel: latestLevel } : {}),
      equivalentAge: round1(ageAtValue(vo2Curve(sex), vo2Median)),
      reference: 'FRIEND registry treadmill 50th percentile (Kaminsky 2015)',
    });
  }
  if (hrvMedian !== undefined) {
    parts.push({
      key: 'hrv',
      inputMedian: round1(hrvMedian),
      unit: 'ms RMSSD',
      days: hrv.length,
      equivalentAge: round1(ageAtValue(RMSSD_MEDIAN, hrvMedian)),
      reference: 'Age RMSSD values attributed to the Shaffer & Ginsberg 2017 review; same table for both sexes',
      confidence: 'low',
      caveat:
        'The API documents averageHeartRateVariabilityMilliseconds as an average RMSSD recorded during sleep, not explicitly as whole-night RMSSD; the reference values are short-term resting recordings.',
    });
  }

  return {
    window: { start, end },
    ...(chronologicalAge === undefined ? {} : { chronologicalAge }),
    sex,
    parts,
    missing,
    note,
  };
}
