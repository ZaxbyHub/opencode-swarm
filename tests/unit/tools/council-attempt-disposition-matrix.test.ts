import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	councilRoundStatePaths,
	runCouncilAttempt,
} from '../../../src/council/council-round-state.js';
import {
	addTelemetryListener,
	initTelemetry,
	removeTelemetryListener,
	resetTelemetryForTesting,
	type TelemetryListener,
} from '../../../src/telemetry.js';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const TOOL_DISPOSITIONS = [
	'blocking_concerns_unresolved',
	'cherry_pick_detected',
	'council_disabled',
	'evaluated_approve',
	'evaluated_concerns',
	'evaluated_reject',
	'insufficient_quorum',
	'invalid_evidence_path',
	'plan_not_found',
] as const;

const TOOL_FILES = [
	'convene-council.ts',
	'submit-phase-council-verdicts.ts',
	'write-final-council-evidence.ts',
] as const;

function declaredToolDispositions(): string[] {
	const toolsDir = resolve(
		dirname(fileURLToPath(import.meta.url)),
		'../../../src/tools',
	);
	const dispositions = new Set<string>();
	for (const file of TOOL_FILES) {
		const source = readFileSync(join(toolsDir, file), 'utf8');
		const executeStart = source.indexOf(
			'const parsed = ArgsSchema.safeParse(args);',
		);
		const wrapperIndex = source.indexOf('return runCouncilAttempt({');
		if (executeStart < 0 || wrapperIndex < executeStart) {
			throw new Error(`${file} bypasses runCouncilAttempt`);
		}
		const preWrapper = source.slice(executeStart, wrapperIndex);
		const earlyReturns = [...preWrapper.matchAll(/\breturn\b/g)].map(
			(match) => match.index ?? -1,
		);
		const unscopedAudits = [
			...preWrapper.matchAll(/recordUnscopedCouncilAttempt\s*\(/g),
		].map((match) => match.index ?? -1);
		if (
			earlyReturns.length !== unscopedAudits.length ||
			earlyReturns.some(
				(position, index) => (unscopedAudits[index] ?? position + 1) > position,
			)
		) {
			throw new Error(
				`${file} has a pre-wrapper return without an unscoped audit`,
			);
		}
		for (const match of source.matchAll(/disposition:\s*'([^']+)'/g)) {
			if ((match.index ?? -1) < wrapperIndex) {
				throw new Error(
					`${file} returns a disposition before runCouncilAttempt`,
				);
			}
			if (match[1]) dispositions.add(match[1]);
		}
		if (source.includes('disposition: `evaluated_${')) {
			if (source.indexOf('disposition: `evaluated_${') < wrapperIndex) {
				throw new Error(
					`${file} evaluates a disposition outside runCouncilAttempt`,
				);
			}
			for (const verdict of ['approve', 'concerns', 'reject']) {
				dispositions.add(`evaluated_${verdict}`);
			}
		}
	}
	return [...dispositions].sort();
}

function finalizedDispositions(
	directory: string,
	phaseNumber: number,
): string[] {
	const audit = councilRoundStatePaths(directory, {
		kind: 'phase',
		phaseNumber,
		identityDigest: IDENTITY,
	}).audit;
	return readFileSync(audit, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { event: string; disposition: string })
		.filter((record) => record.event === 'finalized')
		.map((record) => record.disposition);
}

const IDENTITY = 'c'.repeat(64);

describe('council attempt disposition finalization matrix', () => {
	test('durably finalizes every task, phase, and final tool disposition', async () => {
		expect(declaredToolDispositions()).toEqual([...TOOL_DISPOSITIONS].sort());
		const directory = realpathSync(
			mkdtempSync(join(canonicalTmpDir(), 'council-dispositions-')),
		);
		// Observability-layer capture (PR #2466 review follow-up): every
		// disposition must also emit a finalized `council_attempt`, proving the
		// every-append-emits contract across the full tool disposition set —
		// not only the durable audit side.
		const captured: Array<{ event: string; data: Record<string, unknown> }> =
			[];
		const listener: TelemetryListener = (event, data) => {
			captured.push({ event, data: data as Record<string, unknown> });
		};
		resetTelemetryForTesting();
		initTelemetry(directory);
		addTelemetryListener(listener);
		try {
			for (const [index, disposition] of TOOL_DISPOSITIONS.entries()) {
				const phaseNumber = index + 1;
				await runCouncilAttempt({
					directory,
					scope: { kind: 'phase', phaseNumber, identityDigest: IDENTITY },
					maxRounds: 3,
					request: { disposition },
					verdictCount: 0,
					members: [],
					evaluate: async () => ({
						disposition,
						response: { success: disposition === 'evaluated_approve' },
						transition: 'stay',
						gateEffect: 'none',
					}),
				});
				expect(finalizedDispositions(directory, phaseNumber)).toContain(
					disposition,
				);
			}

			// Each attempt emits exactly received + finalized (all dispositions
			// here are 'stay', so no transition events may appear). Other
			// catalogued kinds (e.g. evidence_lock_acquired from the evidence
			// lock itself) may share the capture — count council events only.
			const councilAttemptEvents = captured.filter(
				(entry) => entry.event === 'council_attempt',
			);
			expect(councilAttemptEvents.length).toBe(TOOL_DISPOSITIONS.length * 2);
			expect(
				captured.some((entry) => entry.event === 'council_round_transition'),
			).toBe(false);
			for (const disposition of TOOL_DISPOSITIONS) {
				expect(
					councilAttemptEvents.some(
						(entry) =>
							entry.data.stage === 'finalized' &&
							entry.data.disposition === disposition,
					),
				).toBe(true);
			}
		} finally {
			removeTelemetryListener(listener);
			resetTelemetryForTesting();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
