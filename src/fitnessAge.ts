import { addCivilDays, type DateRange } from './dates.js';
import type { Missing } from './errors.js';
import type { HealthApi } from './health.js';
import { readRecoveryDays } from './recovery.js';
import { percentile } from './stats.js';
import { readAccountDate } from './today.js';

export type Sex = 'male' | 'female' | 'unspecified';

/** [age, value] points of a population median that falls with age. */
type Curve = ReadonlyArray<readonly [number, number]>;

/**
 * Treadmill VO2 max 50th percentile (ml/kg/min) per age decade, placed at the decade midpoints 25-75, FRIEND registry:
 * Kaminsky LA, Arena R, Myers J. Reference standards for cardiorespiratory fitness measured with
 * cardiopulmonary exercise testing. Mayo Clin Proc. 2015;90(11):1515-1523, Table 3 (PMC4919021).
 */
const VO2_MAX_MEDIAN: Record<'male' | 'female', Curve> = {
  male: [[25, 48.0], [35, 42.4], [45, 37.8], [55, 32.6], [65, 28.2], [75, 24.4]],
  female: [[25, 37.6], [35, 30.2], [45, 26.7], [55, 23.4], [65, 20.0], [75, 18.3]],
};

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

const MIN_VO2_DAYS = 3;

export type FitnessAgeInput = { start?: string; end?: string; age?: number; birthYear?: number; sex?: Sex };

type Part = {
  key: 'vo2max';
  inputMedian: number;
  unit: string;
  days: number;
  estimatedDays: number;
  latestCardioFitnessLevel?: string;
  equivalentAge: number;
  reference: string;
};

export type FitnessAgeResult = { window?: DateRange; chronologicalAge?: number; sex: Sex; parts: Part[]; missing: Missing[]; note: string };

/** The age whose population median VO2 max matches yours. Descriptive, not a score. */
export async function readFitnessAge(api: HealthApi, now: Date, input: FitnessAgeInput): Promise<FitnessAgeResult> {
  const sex = input.sex ?? 'unspecified';
  const note = 'The equivalent age compares you with population medians. Not a medical result.';
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

  // The API documents vo2Max in [0, 100]; anything else is dropped.
  const vo2Days = recovery.days.filter(({ dailyVo2Max: v }) => typeof v?.vo2Max === 'number' && v.vo2Max >= 0 && v.vo2Max <= 100);
  const vo2 = vo2Days.map((day) => day.dailyVo2Max!.vo2Max as number);
  const missing: Missing[] = [];
  const parts: Part[] = [];
  if (vo2.length < MIN_VO2_DAYS) {
    // Too few days is a missing entry, never a guess. A failed read (such as a 403) keeps its own reason.
    const failed = vo2.length === 0 ? recovery.missing.find((entry) => entry.series === 'daily-vo2-max' && !entry.date) : undefined;
    missing.push({ series: 'daily-vo2-max', reason: failed?.reason ?? `${vo2.length} of ${MIN_VO2_DAYS} days with data` });
  } else {
    const vo2Median = percentile(vo2, 0.5);
    const latestLevel = [...vo2Days].reverse().find((day) => day.dailyVo2Max!.cardioFitnessLevel)?.dailyVo2Max!.cardioFitnessLevel as string | undefined;
    parts.push({
      key: 'vo2max',
      inputMedian: round1(vo2Median),
      unit: 'ml/kg/min',
      days: vo2.length,
      estimatedDays: vo2Days.filter((day) => day.dailyVo2Max!.estimated === true).length,
      ...(latestLevel ? { latestCardioFitnessLevel: latestLevel } : {}),
      equivalentAge: round1(ageAtValue(vo2Curve(sex), vo2Median)),
      reference: 'FRIEND registry treadmill 50th percentile (Kaminsky 2015, Table 3)',
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
