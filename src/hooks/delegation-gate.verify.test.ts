/**
 * Focused verification for exact task-id resolution used by delegation
 * evidence. Evidence writes themselves are covered by lifecycle tests; this
 * suite proves attribution without bypassing the Stage A/generation guards.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureAgentSession, resetSwarmState } from '../state';
import { _internals } from './delegation-gate';

let tmpDir: string;

beforeEach(() => {
	resetSwarmState();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-resolve-test-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('delegation evidence task-id resolution', () => {
	it('uses a valid explicit task_id before session fallback', async () => {
		const session = ensureAgentSession('explicit', 'architect', tmpDir);
		session.currentTaskId = '1.1';

		await expect(
			_internals.resolveEvidenceTaskId({ task_id: '2.5' }, session, tmpDir),
		).resolves.toBe('2.5');
	});

	it('falls back to currentTaskId for an invalid explicit task_id', async () => {
		const session = ensureAgentSession('invalid', 'architect', tmpDir);
		session.currentTaskId = '8.8';

		await expect(
			_internals.resolveEvidenceTaskId(
				{ task_id: 'not-valid' },
				session,
				tmpDir,
			),
		).resolves.toBe('8.8');
	});

	it('falls back when task_id exceeds the bounded field length', async () => {
		const session = ensureAgentSession('long', 'architect', tmpDir);
		session.currentTaskId = '9.9';

		await expect(
			_internals.resolveEvidenceTaskId(
				{ task_id: '123456789012345678901' },
				session,
				tmpDir,
			),
		).resolves.toBe('9.9');
	});

	it('uses the durable in-progress task when session attribution is empty', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({
				phases: [
					{
						tasks: [
							{ id: '1.1', status: 'pending' },
							{ id: '1.2', status: 'in_progress' },
						],
					},
				],
			}),
		);
		const session = ensureAgentSession('durable', 'architect', tmpDir);

		await expect(
			_internals.resolveEvidenceTaskId(undefined, session, tmpDir),
		).resolves.toBe('1.2');
	});

	it('keeps concurrent explicit resolutions independent', async () => {
		const session = ensureAgentSession('parallel', 'architect', tmpDir);
		session.currentTaskId = '1.1';

		const results = await Promise.all(
			['12.12', '13.13', '14.14'].map((taskId) =>
				_internals.resolveEvidenceTaskId({ task_id: taskId }, session, tmpDir),
			),
		);

		expect(results).toEqual(['12.12', '13.13', '14.14']);
	});
});
