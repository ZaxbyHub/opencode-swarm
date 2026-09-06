/**
 * Frozen per-scenario budget manifest for issue #2507 dispatch protection
 * (tests-side, mirroring the #2473 precedent in
 * dispatch-lanes-launch-budget-manifest.ts).
 *
 * Every row freezes the EFFECTIVE configuration a composed scenario runs
 * under, the single retry owner for each failure channel, and explicit
 * INTEGER bounds — maximum task attempts, maximum admitted host launches,
 * and a wall-clock ceiling — so a scenario can never declare an
 * effectively-unbounded budget. The module self-validates at load time:
 * an invalid row fails every importing test.
 */

export interface DispatchProtectionBudgetRow {
	scenario: string;
	retry_owner: string;
	effective_configuration: Record<string, string | number | boolean>;
	max_attempts: number;
	max_host_launches: number;
	wall_clock_ms: number;
}

export const DISPATCH_PROTECTION_SCENARIO_BUDGETS: readonly DispatchProtectionBudgetRow[] =
	[
		{
			scenario: 'spawn-circuit-threshold-opening',
			retry_owner:
				'dispatch.spawn-circuit (issue #2507) — native-task spawn failures only; policy denials stay with the gate-denial tracker, shell-structural with the non-transient circuit',
			effective_configuration: {
				spawn_failure_threshold: 3,
				half_open_after_ms: 150,
			},
			// Sequence: 3 failing launches + interleaves + 1 denied attempt +
			// half-open probe + recovery dispatch. Counters that include the
			// loop-window interleaves observe 9 attempts / 8 launches;
			// counters that exclude them observe 8/7. The bound covers both
			// accounting shapes while staying far below the 50 ceilings.
			max_attempts: 12,
			max_host_launches: 10,
			wall_clock_ms: 30_000,
		},
		{
			scenario: 'rate-limited-composed-sequence',
			retry_owner:
				'dispatch.token-bucket (issue #2507) — pacing only, never denial; provable-non-acceptance launch retry stays with #2473',
			effective_configuration: {
				rate_per_second: 2,
				burst_capacity: 2,
			},
			max_attempts: 6,
			max_host_launches: 6,
			wall_clock_ms: 20_000,
		},
	] as const;

const REQUIRED_INTEGER_BOUNDS = [
	'max_attempts',
	'max_host_launches',
	'wall_clock_ms',
] as const;
const CEILINGS: Record<(typeof REQUIRED_INTEGER_BOUNDS)[number], number> = {
	max_attempts: 50,
	max_host_launches: 50,
	wall_clock_ms: 300_000,
};

export function validateDispatchProtectionBudgetRow(
	row: DispatchProtectionBudgetRow,
): string[] {
	const problems: string[] = [];
	if (row.scenario.length === 0) problems.push('scenario empty');
	if (typeof row.retry_owner !== 'string' || row.retry_owner.length === 0) {
		problems.push('retry_owner missing');
	}
	if (
		row.effective_configuration === null ||
		typeof row.effective_configuration !== 'object' ||
		Object.keys(row.effective_configuration).length === 0
	) {
		problems.push('effective_configuration missing');
	}
	for (const key of REQUIRED_INTEGER_BOUNDS) {
		const value = row[key];
		if (!Number.isInteger(value)) {
			problems.push(`${key} not an integer (${String(value)})`);
		} else if (value <= 0) {
			problems.push(`${key} not positive (${String(value)})`);
		} else if (value > CEILINGS[key]) {
			problems.push(
				`${key} above sanity ceiling (${String(value)} > ${String(CEILINGS[key])})`,
			);
		}
	}
	if (
		Number.isInteger(row.max_attempts) &&
		Number.isInteger(row.max_host_launches) &&
		row.max_attempts < row.max_host_launches
	) {
		problems.push('max_attempts < max_host_launches');
	}
	return problems;
}

export interface DispatchProtectionObserved {
	attempts: number;
	host_launches: number;
	wall_clock_ms: number;
}

export function assertWithinDispatchProtectionBudget(
	row: DispatchProtectionBudgetRow,
	observed: DispatchProtectionObserved,
): void {
	const problems: string[] = [];
	if (observed.attempts > row.max_attempts) {
		problems.push(
			`attempts ${String(observed.attempts)} exceeded max_attempts ${String(row.max_attempts)}`,
		);
	}
	if (observed.host_launches > row.max_host_launches) {
		problems.push(
			`host_launches ${String(observed.host_launches)} exceeded max_host_launches ${String(row.max_host_launches)}`,
		);
	}
	if (observed.wall_clock_ms > row.wall_clock_ms) {
		problems.push(
			`wall_clock_ms ${String(observed.wall_clock_ms)} exceeded budget ${String(row.wall_clock_ms)}`,
		);
	}
	if (problems.length > 0) {
		throw new Error(
			`dispatch-protection budget exceeded for ${row.scenario}: ${problems.join('; ')}`,
		);
	}
}

// Module-load validation: an invalid row fails every importing test.
for (const row of DISPATCH_PROTECTION_SCENARIO_BUDGETS) {
	const problems = validateDispatchProtectionBudgetRow(row);
	if (problems.length > 0) {
		throw new Error(
			`invalid dispatch-protection budget row ${row.scenario}: ${problems.join('; ')}`,
		);
	}
}
