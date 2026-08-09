import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	_internals,
	type CouncilAttemptEvaluation,
	councilRoundStatePaths,
	recordUnscopedCouncilAttempt,
	runCouncilAttempt,
} from '../../../src/council/council-round-state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalInternals = { ..._internals };
let directory: string;

function parsed(result: string): Record<string, unknown> {
	return JSON.parse(result) as Record<string, unknown>;
}

function evaluation(
	transition: 'stay' | 'advance' | 'close',
	extra: Partial<CouncilAttemptEvaluation> = {},
): CouncilAttemptEvaluation {
	return {
		disposition: `test_${transition}`,
		response: { success: transition === 'close' },
		transition,
		gateEffect: transition === 'close' ? 'allowed' : 'none',
		...extra,
	};
}

function attempt(
	evaluate: (round: number) => Promise<CouncilAttemptEvaluation>,
	overrides: Partial<Parameters<typeof runCouncilAttempt>[0]> = {},
): Promise<string> {
	return runCouncilAttempt({
		directory,
		scope: { kind: 'task', taskId: '1.1' },
		maxRounds: 3,
		request: { taskId: '1.1', verdicts: [{ member: 'critic' }] },
		verdictCount: 1,
		members: ['critic'],
		evaluate,
		...overrides,
	});
}

function auditRecords(): Array<Record<string, unknown>> {
	const path = councilRoundStatePaths(directory, {
		kind: 'task',
		taskId: '1.1',
	}).audit;
	return readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
	directory = canonicalMkdtemp('council-round-feedback-');
	Object.assign(_internals, originalInternals);
});

afterEach(() => {
	Object.assign(_internals, originalInternals);
	rmSync(directory, { recursive: true, force: true });
});

describe('council round review feedback', () => {
	test('PRR-001: evaluation exceptions finalize a durable state-neutral attempt', async () => {
		const result = parsed(
			await attempt(async () => {
				throw new Error('evaluation exploded');
			}),
		);

		expect(result).toMatchObject({
			success: false,
			reason: 'council_evaluation_failed',
			message: 'evaluation exploded',
			authoritativeRound: 1,
			nextRound: 1,
			maxRoundsExhausted: false,
		});
		const finalized = auditRecords().find(
			(record) => record.event === 'finalized',
		);
		expect(finalized).toMatchObject({
			disposition: 'council_evaluation_failed',
			transition: 'stay',
			gateEffect: 'none',
			nextState: { currentRound: 1, status: 'open' },
		});
	});

	test('PRR-002: a probe-negative pending attempt is recovered as an orphan', async () => {
		let evidenceCommits = 0;
		const failed = parsed(
			await attempt(async () =>
				evaluation('close', {
					evidence: {
						reference: '.swarm/evidence/1.1.json',
						commit: async () => {
							evidenceCommits++;
							throw new Error('evidence write interrupted');
						},
					},
				}),
			),
		);
		expect(failed.reason).toBe('council_round_state_persistence_failed');

		let retryEvaluations = 0;
		const recovered = parsed(
			await attempt(
				async () => {
					retryEvaluations++;
					return evaluation('close');
				},
				{ probePendingEvidence: async () => false },
			),
		);

		expect(recovered.success).toBe(true);
		expect(evidenceCommits).toBe(1);
		expect(retryEvaluations).toBe(1);
		expect(
			auditRecords().some(
				(record) =>
					record.event === 'recovered' &&
					record.disposition === 'orphan_recovered' &&
					record.transition === 'stay' &&
					record.gateEffect === 'none',
			),
		).toBe(true);
	});

	test('PRR-003: unscoped attempts keep stable privacy-safe fingerprints', async () => {
		const issues = [{ path: ['verdicts', 0, 'member'], code: 'invalid_type' }];
		expect(
			await recordUnscopedCouncilAttempt(
				directory,
				'task',
				'invalid_arguments',
				{
					taskId: 'private-task-a',
					roundNumber: 'one',
					verdicts: [{ detail: 'TOP_SECRET_A' }],
				},
				issues,
				'private-session-a',
			),
		).toBeNull();
		expect(
			await recordUnscopedCouncilAttempt(
				directory,
				'task',
				'invalid_working_directory',
				{
					taskId: 'private-task-b',
					roundNumber: 'two',
					verdicts: [{ detail: 'TOP_SECRET_B' }],
				},
				issues,
				'private-session-b',
			),
		).toBeNull();

		const raw = readFileSync(
			join(directory, '.swarm', 'council', 'attempts', 'unscoped.jsonl'),
			'utf8',
		);
		const records = raw
			.trim()
			.split('\n')
			.map(
				(line) =>
					JSON.parse(line) as {
						disposition: string;
						fingerprint: string;
						sessionHash: string;
					},
			);
		expect(records.map((record) => record.disposition)).toEqual([
			'invalid_arguments',
			'invalid_working_directory',
		]);
		expect(records[0]?.fingerprint).toBe(records[1]?.fingerprint);
		expect(records[0]?.sessionHash).not.toBe(records[1]?.sessionHash);
		expect(raw).not.toContain('private-task');
		expect(raw).not.toContain('private-session');
		expect(raw).not.toContain('TOP_SECRET');
	});

	test('PRR-004: valid JSON with an invalid state shape fails closed distinctly', async () => {
		const paths = councilRoundStatePaths(directory, {
			kind: 'task',
			taskId: '1.1',
		});
		mkdirSync(dirname(paths.state), { recursive: true });
		writeFileSync(paths.state, JSON.stringify({ version: 1 }), 'utf8');
		let evaluated = false;

		const result = parsed(
			await attempt(async () => {
				evaluated = true;
				return evaluation('close');
			}),
		);

		expect(result).toMatchObject({
			success: false,
			reason: 'council_round_state_uncertain',
			message: 'council round state is invalid',
		});
		expect(evaluated).toBe(false);
	});

	test('PRR-005: valid JSON with an invalid audit shape fails closed', async () => {
		const paths = councilRoundStatePaths(directory, {
			kind: 'task',
			taskId: '1.1',
		});
		mkdirSync(dirname(paths.audit), { recursive: true });
		writeFileSync(
			paths.audit,
			`${JSON.stringify({ schemaVersion: 1 })}\n`,
			'utf8',
		);
		let evaluated = false;

		const result = parsed(
			await attempt(async () => {
				evaluated = true;
				return evaluation('close');
			}),
		);

		expect(result).toMatchObject({
			success: false,
			reason: 'council_round_state_uncertain',
			message: 'council attempt audit is corrupt',
		});
		expect(evaluated).toBe(false);
	});

	test('PRR-006: identical open-round requests may re-evaluate after gate state changes', async () => {
		let evaluations = 0;
		const first = parsed(
			await attempt(async () => {
				evaluations++;
				return evaluation('stay', {
					response: { success: false, reason: 'gate_not_ready' },
				});
			}),
		);
		const second = parsed(
			await attempt(async () => {
				evaluations++;
				return evaluation('close');
			}),
		);

		expect(first).toMatchObject({
			success: false,
			reason: 'gate_not_ready',
			authoritativeRound: 1,
			nextRound: 1,
		});
		expect(second).toMatchObject({
			success: true,
			authoritativeRound: 1,
			nextRound: 1,
		});
		expect(evaluations).toBe(2);
		expect(
			auditRecords()
				.filter((record) => record.event === 'finalized')
				.map((record) => record.disposition),
		).toEqual(['test_stay', 'test_close']);
	});

	test('PRR-007: metadata-only round failures cannot impersonate a REJECT verdict', async () => {
		let evaluated = false;
		const result = parsed(
			await attempt(
				async () => {
					evaluated = true;
					return evaluation('close');
				},
				{ clientRound: 2 },
			),
		);

		expect(result).toMatchObject({
			success: false,
			reason: 'council_round_mismatch',
			authoritativeRound: 1,
			submittedRound: 2,
		});
		expect(result).not.toHaveProperty('overallVerdict');
		expect(result).not.toHaveProperty('maxRoundsExhausted');
		expect(evaluated).toBe(false);
	});
});
