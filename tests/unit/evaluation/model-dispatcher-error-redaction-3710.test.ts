import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvaluationRunV1 } from '../../../src/evaluation/contracts.js';
import { computeRunIntegrityHash } from '../../../src/evaluation/hashing.js';
import {
	createEvaluationModelDispatcher,
	_internals as dispatcherInternals,
} from '../../../src/evaluation/model-dispatcher.js';
import { saveEvaluationRun } from '../../../src/evaluation/store.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

/**
 * #3710 final-critic round 1, finding 2 — the evaluation model dispatcher's
 * failed-dispatch error text is persisted by saveEvaluationRun as
 * `failureCode` into `.swarm/evolution/runs/<runId>.json`, so it carries the
 * failure-evidence redaction family. The sanitize sits AFTER the
 * isQuotaError classification read in the dispatcher's catch; no downstream
 * evaluation consumer classifies on this field. Synthetic token only.
 */

const SYNTH_TOKEN = 'sk-SynthEval123456789012345678';
const SYNTH_PLACEHOLDER = '[REDACTED:openai]';

let tmpDir: string;
let origLog: typeof dispatcherInternals.log;

function clientWhosePromptFails(): {
	value: Parameters<typeof createEvaluationModelDispatcher>[0];
} {
	return {
		value: {
			app: {
				agents: async () => ({
					data: [{ name: 'reviewer' }],
				}),
			},
			session: {
				create: async () => ({ data: { id: 'session-eval-3710' } }),
				prompt: async () => {
					throw new Error(`Failed to run: bad key ${SYNTH_TOKEN} rejected`);
				},
				delete: async () => ({}),
			},
		} as unknown as Parameters<typeof createEvaluationModelDispatcher>[0],
	};
}

beforeEach(() => {
	tmpDir = canonicalMkdtemp('eval-dispatch-redact-3710-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origLog = dispatcherInternals.log;
	dispatcherInternals.log = () => {};
});

afterEach(() => {
	dispatcherInternals.log = origLog;
	removeTreeWithRetry(tmpDir);
});

describe('evaluation dispatcher error redaction persists through saveEvaluationRun (#3710)', () => {
	test('a failed dispatch returns a redacted error that persists redacted as failureCode', async () => {
		const fake = clientWhosePromptFails();
		const dispatch = createEvaluationModelDispatcher(fake.value);
		const result = await dispatch({
			sessionDirectory: tmpDir,
			agentName: 'reviewer',
			modelId: 'p/m',
			prompt: 'inspect',
			timeoutMs: 1_000,
		});

		// The dispatch failed (after bounded retries) — fail-closed posture.
		expect(result.status).toBe('error');
		// The returned error text is REDACTED (no token cleartext, family
		// placeholder present).
		expect(result.error?.includes(SYNTH_TOKEN)).toBe(false);
		expect(result.error).toContain(SYNTH_PLACEHOLDER);

		// Persist a run whose single result carries that error as
		// failureCode (the evaluation runner's mapping), read it back from
		// the durable artifact: still redacted.
		const failureCode = (result.error ?? 'unreachable').slice(0, 160);
		const withoutIntegrity = {
			v: 1 as const,
			runId: 'run-redact-3710',
			createdAt: '2026-11-15T00:00:00.000Z',
			status: 'complete' as const,
			baseline: {
				v: 1 as const,
				id: 'baseline',
				kind: 'baseline' as const,
				payloadPath: 'candidates/baseline.md',
				model: 'model-a',
				contentHash: 'a'.repeat(64),
			},
			candidate: {
				v: 1 as const,
				id: 'candidate',
				kind: 'skill' as const,
				payloadPath: 'candidates/candidate.md',
				model: 'model-a',
				contentHash: 'b'.repeat(64),
			},
			taskSet: {
				id: 'validation-v1',
				contentHash: 'c'.repeat(64),
				taskIds: ['task-1'],
			},
			split: 'validation' as const,
			seed: 'seed',
			models: ['model-a'],
			environment: {
				platform: 'test',
				arch: 'test',
				runtime: 'bun-test',
				baseSha: 'd'.repeat(40),
				activeTreeHash: 'e'.repeat(64),
				taskSetHash: 'c'.repeat(64),
			},
			budgets: {
				maxTasks: 1,
				maxRepetitions: 1,
				maxConcurrency: 1,
				maxTaskTimeMs: 1_000,
				maxRetries: 0,
				maxOutputBytes: 1_024,
			},
			results: [
				{
					v: 1 as const,
					taskId: 'task-1',
					category: 'main',
					protected: false,
					repetition: 0,
					candidateId: 'candidate',
					seed: 'seed',
					outcome: 'infrastructure_failure' as const,
					scoreRange: [0, 1],
					cost: { source: 'unavailable' as const },
					durationMs: result.durationMs,
					retries: 0,
					failureCode,
				},
			],
			cost: { source: 'unavailable' as const },
		};
		const run = {
			...withoutIntegrity,
			integrityHash: computeRunIntegrityHash(
				withoutIntegrity as unknown as EvaluationRunV1,
			),
		} as unknown as EvaluationRunV1;
		await saveEvaluationRun(tmpDir, run);

		const persistedPath = path.join(
			tmpDir,
			'.swarm',
			'evolution',
			'runs',
			'run-redact-3710.json',
		);
		expect(fs.existsSync(persistedPath)).toBe(true);
		const persisted = fs.readFileSync(persistedPath, 'utf-8');
		expect(persisted.includes(SYNTH_TOKEN)).toBe(false);
		expect(persisted).toContain(SYNTH_PLACEHOLDER);
	}, 30_000);
});
