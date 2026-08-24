import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	_internals,
	type CouncilAttemptEvaluation,
	councilRoundStatePaths,
	runCouncilAttempt,
} from '../../../src/council/council-round-state.js';

const originals = { ..._internals };
let directory: string;

function parsed(result: string): Record<string, unknown> {
	return JSON.parse(result) as Record<string, unknown>;
}

function scopeHash(taskId = '1.1'): string {
	return createHash('sha256').update(taskId).digest('hex');
}

const IDENTITY = 'c'.repeat(64); // 64-hex fixture identity (v2 scopes)
function auditScopeFixture() {
	return {
		kind: 'task' as const,
		scopeHash: scopeHash(),
		identityDigest: IDENTITY,
	};
}
const MISMATCHED_SCOPE_FIXTURE = {
	kind: 'task' as const,
	scopeHash: 'b'.repeat(64),
	identityDigest: 'd'.repeat(64),
};

const TASK_SCOPE = {
	kind: 'task' as const,
	taskId: '1.1',
	identityDigest: IDENTITY,
};

function evaluation(
	transition: 'stay' | 'advance' | 'close',
	extra: Partial<CouncilAttemptEvaluation> = {},
): CouncilAttemptEvaluation {
	return {
		disposition: `test_${transition}`,
		response: { success: true },
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
		scope: TASK_SCOPE,
		maxRounds: 3,
		request: { taskId: '1.1', verdicts: [{ member: 'critic' }] },
		verdictCount: 1,
		members: ['critic'],
		evaluate,
		...overrides,
	});
}

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), 'council-round-state-')));
	Object.assign(_internals, originals);
});

afterEach(() => {
	Object.assign(_internals, originals);
	rmSync(directory, { recursive: true, force: true });
});

describe('authoritative council round state', () => {
	test('starts at one, advances server-side, and rejects stale caller expectations', async () => {
		const first = parsed(
			await attempt(async () => evaluation('advance'), { clientRound: 1 }),
		);
		expect(first.authoritativeRound).toBe(1);
		expect(first.nextRound).toBe(2);

		let staleEvaluated = false;
		const stale = parsed(
			await attempt(
				async () => {
					staleEvaluated = true;
					return evaluation('close');
				},
				{ clientRound: 1 },
			),
		);
		expect(stale.reason).toBe('council_round_mismatch');
		expect(stale.authoritativeRound).toBe(2);
		expect(staleEvaluated).toBe(false);

		const second = parsed(await attempt(async () => evaluation('close')));
		expect(second.authoritativeRound).toBe(2);
		expect(second.nextRound).toBe(2);

		const audit = readFileSync(
			councilRoundStatePaths(directory, TASK_SCOPE).audit,
			'utf8',
		)
			.trim()
			.split('\n')
			.map(
				(line) => JSON.parse(line) as { event: string; disposition: string },
			);
		expect(audit.filter((record) => record.event === 'received')).toHaveLength(
			3,
		);
		expect(
			audit.some((record) => record.disposition === 'council_round_mismatch'),
		).toBe(true);
	});

	test('clamps at max round without regressing after a config reduction', async () => {
		await attempt(async () => evaluation('advance'), { maxRounds: 2 });
		const exhausted = parsed(
			await attempt(async () => evaluation('advance'), { maxRounds: 2 }),
		);
		expect(exhausted.authoritativeRound).toBe(2);
		expect(exhausted.nextRound).toBe(2);
		expect(exhausted.maxRoundsExhausted).toBe(true);

		const stayed = parsed(
			await attempt(async () => evaluation('stay'), { maxRounds: 1 }),
		);
		expect(stayed.authoritativeRound).toBe(2);
		expect(stayed.nextRound).toBe(2);
		expect(stayed.maxRoundsExhausted).toBe(true);
	});

	test('orders received audit, pending state, evidence, final audit, and final state', async () => {
		const order: string[] = [];
		_internals.appendAudit = (path, record) => {
			order.push(`audit:${record.event}`);
			originals.appendAudit(path, record);
		};
		_internals.atomicWrite = async (path, content) => {
			const state = JSON.parse(content) as { pending?: unknown };
			order.push(state.pending ? 'state:pending' : 'state:final');
			await originals.atomicWrite(path, content);
		};

		await attempt(async () =>
			evaluation('close', {
				evidence: {
					reference: '.swarm/evidence/1.1.json',
					commit: async () => {
						order.push('evidence');
					},
				},
			}),
		);

		expect(order).toEqual([
			'state:final',
			'audit:received',
			'state:pending',
			'evidence',
			'audit:finalized',
			'state:final',
		]);
	});

	test('fails before evaluation when the received audit cannot be persisted', async () => {
		let evaluated = false;
		_internals.appendAudit = () => {
			throw new Error('audit denied');
		};
		const result = parsed(
			await attempt(async () => {
				evaluated = true;
				return evaluation('close');
			}),
		);
		expect(result.reason).toBe('council_round_state_persistence_failed');
		expect(evaluated).toBe(false);
		expect(
			readFileSync(
				join(directory, '.swarm', 'council', 'attempts', 'unscoped.jsonl'),
				'utf8',
			),
		).toContain('council_round_state_persistence_failed');
	});

	test('recovers a finalized transition after the final state write fails', async () => {
		let writes = 0;
		let evidenceCommits = 0;
		_internals.atomicWrite = async (path, content) => {
			writes++;
			if (writes === 3) throw new Error('final state denied');
			await originals.atomicWrite(path, content);
		};
		const failed = parsed(
			await attempt(async () =>
				evaluation('close', {
					evidence: {
						reference: '.swarm/evidence/1.1.json',
						commit: async () => {
							evidenceCommits++;
						},
					},
				}),
			),
		);
		expect(failed.reason).toBe('council_round_state_persistence_failed');
		Object.assign(_internals, originals);

		let reevaluated = false;
		const retry = parsed(
			await attempt(async () => {
				reevaluated = true;
				return evaluation('close');
			}),
		);
		expect(retry.reason).toBe('duplicate_submission');
		expect(reevaluated).toBe(false);
		expect(evidenceCommits).toBe(1);
	});

	test('uses an evidence marker to recover a commit whose final audit failed', async () => {
		let evidenceCommits = 0;
		_internals.appendAudit = (path, record) => {
			if (record.event === 'finalized') throw new Error('final audit denied');
			originals.appendAudit(path, record);
		};
		const failed = parsed(
			await attempt(async () =>
				evaluation('close', {
					evidence: {
						reference: '.swarm/evidence/1.1.json',
						commit: async () => {
							evidenceCommits++;
						},
					},
				}),
			),
		);
		expect(failed.reason).toBe('council_round_state_persistence_failed');
		Object.assign(_internals, originals);

		let reevaluated = false;
		const retry = parsed(
			await attempt(
				async () => {
					reevaluated = true;
					return evaluation('close');
				},
				{ probePendingEvidence: async () => true },
			),
		);
		expect(retry.reason).toBe('duplicate_submission');
		expect(reevaluated).toBe(false);
		expect(evidenceCommits).toBe(1);

		const audit = readFileSync(
			councilRoundStatePaths(directory, TASK_SCOPE).audit,
			'utf8',
		);
		expect(audit).toContain('pending_evidence_recovered');
	});

	test('fails closed on corrupt state instead of guessing a round', async () => {
		const paths = councilRoundStatePaths(directory, TASK_SCOPE);
		mkdirSync(dirname(paths.state), { recursive: true });
		writeFileSync(paths.state, '{broken', 'utf8');
		let evaluated = false;
		const result = parsed(
			await attempt(async () => {
				evaluated = true;
				return evaluation('close');
			}),
		);
		expect(result.reason).toBe('council_round_state_uncertain');
		expect(evaluated).toBe(false);
		expect(
			readFileSync(
				join(directory, '.swarm', 'council', 'attempts', 'unscoped.jsonl'),
				'utf8',
			),
		).toContain('council_round_state_uncertain');
	});

	test('fails closed on syntactically valid but inconsistent pending state', async () => {
		const paths = councilRoundStatePaths(directory, TASK_SCOPE);
		mkdirSync(dirname(paths.state), { recursive: true });
		writeFileSync(
			paths.state,
			JSON.stringify({
				version: 2,
				currentRound: 1,
				status: 'open',
				maxRoundsExhausted: false,
				pending: {
					attemptId: '11111111-1111-4111-8111-111111111111',
					digest: 'a'.repeat(64),
					round: 1,
					transition: 'advance',
					disposition: 'evaluated_concerns',
					gateEffect: 'blocked',
					evidenceExpected: false,
					nextState: {
						version: 2,
						currentRound: 1,
						status: 'closed',
						maxRoundsExhausted: false,
						lastAttemptId: '11111111-1111-4111-8111-111111111111',
						lastDigest: 'a'.repeat(64),
					},
				},
			}),
			'utf8',
		);
		expect(parsed(await attempt(async () => evaluation('close'))).reason).toBe(
			'council_round_state_uncertain',
		);
	});

	test('fails closed when a missing snapshot cannot be reconstructed from audit', async () => {
		const paths = councilRoundStatePaths(directory, TASK_SCOPE);
		mkdirSync(dirname(paths.audit), { recursive: true });
		writeFileSync(
			paths.audit,
			`${JSON.stringify({
				version: 2,
				event: 'received',
				attemptId: '11111111-1111-4111-8111-111111111111',
				timestamp: '2026-08-09T00:00:00.000Z',
				scope: auditScopeFixture(),
				authoritativeRound: 2,
				digest: 'a'.repeat(64),
				disposition: 'received',
				verdictCount: 1,
				members: ['critic'],
			})}\n`,
			'utf8',
		);
		let evaluated = false;
		const result = parsed(
			await attempt(async () => {
				evaluated = true;
				return evaluation('close');
			}),
		);
		expect(result.reason).toBe('council_round_state_uncertain');
		expect(evaluated).toBe(false);
	});

	test('rejects scope-mismatched audit records during snapshot recovery', async () => {
		const paths = councilRoundStatePaths(directory, TASK_SCOPE);
		mkdirSync(dirname(paths.audit), { recursive: true });
		writeFileSync(
			paths.audit,
			`${JSON.stringify({
				version: 2,
				event: 'received',
				attemptId: randomUUID(),
				timestamp: '2026-08-09T00:00:00.000Z',
				scope: MISMATCHED_SCOPE_FIXTURE,
				authoritativeRound: 1,
				digest: 'a'.repeat(64),
				disposition: 'received',
				verdictCount: 1,
				members: ['critic'],
			})}\n`,
			'utf8',
		);
		expect(parsed(await attempt(async () => evaluation('close'))).reason).toBe(
			'council_round_state_uncertain',
		);
	});

	test('does not reconstruct missing state from a truncated audit window', async () => {
		const paths = councilRoundStatePaths(directory, TASK_SCOPE);
		mkdirSync(dirname(paths.audit), { recursive: true });
		const records = Array.from({ length: 900 }, () =>
			JSON.stringify({
				version: 2,
				event: 'received',
				attemptId: randomUUID(),
				timestamp: '2026-08-09T00:00:00.000Z',
				scope: auditScopeFixture(),
				authoritativeRound: 1,
				digest: 'a'.repeat(64),
				disposition: 'received',
				verdictCount: 1,
				members: ['critic'],
			}),
		);
		writeFileSync(paths.audit, `${records.join('\n')}\n`, 'utf8');
		expect(statSync(paths.audit).size).toBeGreaterThan(256 * 1024);
		expect(parsed(await attempt(async () => evaluation('close'))).reason).toBe(
			'council_round_state_uncertain',
		);
	});

	test('runs best-effort post-commit effects at most once for an accepted attempt', async () => {
		let effects = 0;
		const first = parsed(
			await attempt(async () =>
				evaluation('close', {
					afterCommit: () => {
						effects++;
						throw new Error('non-critical effect failed');
					},
				}),
			),
		);
		expect(first.success).toBe(true);
		expect(parsed(await attempt(async () => evaluation('close'))).reason).toBe(
			'duplicate_submission',
		);
		expect(effects).toBe(1);
	});

	test('serializes concurrent submissions so only one can close the scope', async () => {
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let evaluations = 0;
		let evidenceCommits = 0;
		const first = attempt(async () => {
			evaluations++;
			firstStarted();
			await release;
			return evaluation('close', {
				evidence: {
					reference: '.swarm/evidence/1.1.json',
					commit: async () => {
						evidenceCommits++;
					},
				},
			});
		});
		await started;
		const second = attempt(async () => {
			evaluations++;
			return evaluation('close');
		});
		releaseFirst();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(parsed(firstResult).success).toBe(true);
		expect(parsed(secondResult).reason).toBe('duplicate_submission');
		expect(evaluations).toBe(1);
		expect(evidenceCommits).toBe(1);
	});

	test('audit records hash private request and session content', async () => {
		await attempt(async () => evaluation('stay'), {
			sessionID: 'raw-session-secret',
			request: {
				working_directory: directory,
				provenanceAgentName: 'private-agent',
				verdicts: [{ member: 'critic', detail: 'TOP_SECRET_FINDING' }],
			},
		});
		const audit = readFileSync(
			councilRoundStatePaths(directory, TASK_SCOPE).audit,
			'utf8',
		);
		expect(audit).not.toContain(directory);
		expect(audit).not.toContain('raw-session-secret');
		expect(audit).not.toContain('private-agent');
		expect(audit).not.toContain('TOP_SECRET_FINDING');
		expect(audit).toMatch(/"sessionHash":"[a-f0-9]{64}"/);
	});
});
