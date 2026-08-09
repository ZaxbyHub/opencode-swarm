import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
	_internals,
	councilRoundStatePaths,
	runCouncilAttempt,
} from '../../../src/council/council-round-state.js';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const scope = { kind: 'task' as const, taskId: '1.1' };
const originalInternals = { ..._internals };

beforeEach(() => Object.assign(_internals, originalInternals));
afterEach(() => Object.assign(_internals, originalInternals));

function validRecord() {
	const attemptId = randomUUID();
	return {
		version: 1,
		event: 'finalized',
		attemptId,
		timestamp: '2026-08-09T00:00:00.000Z',
		scope: {
			kind: 'task',
			scopeHash: createHash('sha256').update(scope.taskId).digest('hex'),
		},
		authoritativeRound: 1,
		digest: 'a'.repeat(64),
		disposition: 'evaluated_concerns',
		verdictCount: 3,
		members: ['critic', 'reviewer', 'sme'],
		transition: 'advance',
		gateEffect: 'blocked',
		verdict: 'CONCERNS',
		quorumSize: 3,
		nextState: {
			version: 1,
			currentRound: 2,
			status: 'open',
			maxRoundsExhausted: false,
			lastAttemptId: attemptId,
			lastDigest: 'a'.repeat(64),
		},
	};
}

function receivedFor(record: ReturnType<typeof validRecord>) {
	return {
		...record,
		event: 'received',
		disposition: 'received',
		transition: undefined,
		gateEffect: undefined,
		verdict: undefined,
		quorumSize: undefined,
		nextState: undefined,
	};
}

describe('council audit recovery validation', () => {
	for (const [name, mutate] of [
		[
			'invalid digest',
			(record: ReturnType<typeof validRecord>) => {
				record.digest = 'not-a-digest';
			},
		],
		[
			'impossible round jump',
			(record: ReturnType<typeof validRecord>) => {
				record.nextState.currentRound = 10;
			},
		],
	] as const) {
		test(`fails closed on ${name}`, async () => {
			const directory = mkdtempSync(
				join(canonicalTmpDir(), 'council-audit-invalid-'),
			);
			try {
				const paths = councilRoundStatePaths(directory, scope);
				mkdirSync(dirname(paths.audit), { recursive: true });
				const record = validRecord();
				mutate(record);
				writeFileSync(paths.audit, `${JSON.stringify(record)}\n`, 'utf8');
				const result = JSON.parse(
					await runCouncilAttempt({
						directory,
						scope,
						maxRounds: 3,
						request: {},
						verdictCount: 0,
						members: [],
						evaluate: async () => ({
							disposition: 'evaluated_approve',
							response: { success: true },
							transition: 'close',
							gateEffect: 'allowed',
						}),
					}),
				);
				expect(result.reason).toBe('council_round_state_uncertain');
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	test('recovers a closed scope from a duplicate record after snapshot loss', async () => {
		const directory = mkdtempSync(
			join(canonicalTmpDir(), 'council-closed-recovery-'),
		);
		const input = {
			directory,
			scope,
			maxRounds: 3,
			request: { verdict: 'APPROVE' },
			verdictCount: 0,
			members: [],
			evaluate: async () => ({
				disposition: 'evaluated_approve',
				response: { success: true },
				transition: 'close' as const,
				gateEffect: 'allowed' as const,
			}),
		};
		try {
			await runCouncilAttempt(input);
			await runCouncilAttempt(input);
			rmSync(councilRoundStatePaths(directory, scope).state);
			const recovered = JSON.parse(await runCouncilAttempt(input));
			expect(recovered.reason).toBe('duplicate_submission');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('fails closed when individually valid records regress round history', async () => {
		const directory = mkdtempSync(
			join(canonicalTmpDir(), 'council-history-regress-'),
		);
		try {
			const paths = councilRoundStatePaths(directory, scope);
			mkdirSync(dirname(paths.audit), { recursive: true });
			const advance = validRecord();
			const regress = validRecord();
			regress.transition = 'close';
			regress.disposition = 'evaluated_approve';
			regress.gateEffect = 'allowed';
			regress.verdict = 'APPROVE';
			regress.nextState.currentRound = 1;
			regress.nextState.status = 'closed';
			writeFileSync(
				paths.audit,
				`${[receivedFor(advance), advance, receivedFor(regress), regress]
					.map((record) => JSON.stringify(record))
					.join('\n')}\n`,
				'utf8',
			);
			const result = JSON.parse(
				await runCouncilAttempt({
					directory,
					scope,
					maxRounds: 3,
					request: {},
					verdictCount: 0,
					members: [],
					evaluate: async () => ({
						disposition: 'evaluated_approve',
						response: { success: true },
						transition: 'close',
						gateEffect: 'allowed',
					}),
				}),
			);
			expect(result.reason).toBe('council_round_state_uncertain');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('rejects an open-to-closed stay transition in an untruncated audit', async () => {
		const directory = mkdtempSync(
			join(canonicalTmpDir(), 'council-history-status-'),
		);
		try {
			const paths = councilRoundStatePaths(directory, scope);
			mkdirSync(dirname(paths.audit), { recursive: true });
			const invalidStay = validRecord();
			invalidStay.transition = 'stay';
			invalidStay.disposition = 'council_round_mismatch';
			invalidStay.gateEffect = 'none';
			invalidStay.verdict = undefined as never;
			invalidStay.quorumSize = undefined as never;
			invalidStay.nextState.currentRound = 1;
			invalidStay.nextState.status = 'closed';
			writeFileSync(
				paths.audit,
				`${JSON.stringify(receivedFor(invalidStay))}\n${JSON.stringify(invalidStay)}\n`,
				'utf8',
			);
			const result = JSON.parse(
				await runCouncilAttempt({
					directory,
					scope,
					maxRounds: 3,
					request: {},
					verdictCount: 0,
					members: [],
					evaluate: async () => ({
						disposition: 'evaluated_approve',
						response: { success: true },
						transition: 'close',
						gateEffect: 'allowed',
					}),
				}),
			);
			expect(result.reason).toBe('council_round_state_uncertain');
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('uses the latest valid transition from a truncated audit tail', async () => {
		const directory = mkdtempSync(
			join(canonicalTmpDir(), 'council-tail-recovery-'),
		);
		try {
			const paths = councilRoundStatePaths(directory, scope);
			mkdirSync(dirname(paths.audit), { recursive: true });
			const history = Array.from({ length: 500 }, () => {
				const stay = validRecord();
				stay.transition = 'stay';
				stay.disposition = 'insufficient_quorum';
				stay.gateEffect = 'none';
				stay.verdict = undefined as never;
				stay.quorumSize = undefined as never;
				stay.nextState.currentRound = 1;
				return [receivedFor(stay), stay];
			}).flat();
			const advance = validRecord();
			writeFileSync(
				paths.audit,
				`${history
					.map((record) => JSON.stringify(record))
					.join(
						'\n',
					)}\n${JSON.stringify(receivedFor(advance))}\n${JSON.stringify(advance)}\n`,
				'utf8',
			);
			const recovered = JSON.parse(
				await runCouncilAttempt({
					directory,
					scope,
					maxRounds: 3,
					request: { verdict: 'APPROVE' },
					verdictCount: 0,
					members: [],
					evaluate: async () => ({
						disposition: 'evaluated_approve',
						response: { success: true },
						transition: 'close',
						gateEffect: 'allowed',
					}),
				}),
			);
			expect(recovered.success).toBe(true);
			expect(recovered.authoritativeRound).toBe(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('pairs received audit when pending-state persistence fails', async () => {
		const directory = mkdtempSync(
			join(canonicalTmpDir(), 'council-pending-write-'),
		);
		const paths = councilRoundStatePaths(directory, scope);
		let writes = 0;
		_internals.atomicWrite = async (path, content) => {
			writes++;
			if (writes === 2) throw new Error('pending state denied');
			await originalInternals.atomicWrite(path, content);
		};
		const input = {
			directory,
			scope,
			maxRounds: 3,
			request: { verdict: 'APPROVE' },
			verdictCount: 0,
			members: [],
			evaluate: async () => ({
				disposition: 'evaluated_approve',
				response: { success: true },
				transition: 'close' as const,
				gateEffect: 'allowed' as const,
			}),
		};
		try {
			expect(JSON.parse(await runCouncilAttempt(input)).reason).toBe(
				'council_round_state_persistence_failed',
			);
			_internals.atomicWrite = originalInternals.atomicWrite;
			expect(JSON.parse(await runCouncilAttempt(input)).success).toBe(true);
			const records = readFileSync(paths.audit, 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line) as { event: string });
			expect(
				records.filter((record) => record.event === 'received'),
			).toHaveLength(2);
			expect(
				records.filter((record) => record.event === 'finalized'),
			).toHaveLength(2);
			rmSync(paths.state);
			expect(JSON.parse(await runCouncilAttempt(input)).reason).toBe(
				'duplicate_submission',
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('rejects terminal audit that contradicts persisted pending intent', async () => {
		const directory = mkdtempSync(
			join(canonicalTmpDir(), 'council-pending-forged-'),
		);
		const paths = councilRoundStatePaths(directory, scope);
		_internals.appendAudit = (path, record) => {
			if (record.event === 'finalized') throw new Error('final audit denied');
			originalInternals.appendAudit(path, record);
		};
		try {
			expect(
				JSON.parse(
					await runCouncilAttempt({
						directory,
						scope,
						maxRounds: 3,
						request: { verdict: 'CONCERNS' },
						verdictCount: 0,
						members: [],
						evaluate: async () => ({
							disposition: 'evaluated_concerns',
							response: { success: true },
							transition: 'advance',
							gateEffect: 'blocked',
						}),
					}),
				).reason,
			).toBe('council_round_state_persistence_failed');
			_internals.appendAudit = originalInternals.appendAudit;
			const received = JSON.parse(
				readFileSync(paths.audit, 'utf8').trim(),
			) as Parameters<typeof _internals.appendAudit>[1];
			_internals.appendAudit(paths.audit, {
				...received,
				event: 'finalized',
				disposition: 'evaluated_approve',
				transition: 'close',
				gateEffect: 'allowed',
				nextState: {
					version: 1,
					currentRound: 1,
					status: 'closed',
					maxRoundsExhausted: false,
					lastAttemptId: received.attemptId,
					lastDigest: received.digest,
				},
			});
			let evaluated = false;
			const result = JSON.parse(
				await runCouncilAttempt({
					directory,
					scope,
					maxRounds: 3,
					request: { verdict: 'APPROVE' },
					verdictCount: 0,
					members: [],
					evaluate: async () => {
						evaluated = true;
						return {
							disposition: 'evaluated_approve',
							response: { success: true },
							transition: 'close',
							gateEffect: 'allowed',
						};
					},
				}),
			);
			expect(result.reason).toBe('council_round_state_uncertain');
			expect(evaluated).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
