/**
 * r17 audit (P1): a corrupt context map must never be overwritten by the
 * NORMAL child completion update path.
 *
 * `updateContextMapAfterAgent` (and its locked wrapper) still does
 * `loadContextMap(directory) ?? createEmptyContextMap()`. `loadContextMap`
 * returns `null` BOTH for a missing file AND for an existing-but-corrupt one,
 * so a child completion on a corrupt map manufactures a fresh, nearly-empty
 * map and — via `saveContextMap` — REPLACES the damaged file, destroying the
 * operator's recovery path (decisions, task history, file summaries).
 *
 * The r16 repairs already guard `promoteContextMapTaskRelease` and
 * `reconcileContextMapTaskReleases` via the discriminated read
 * (`readContextMapState`); this suite closes the remaining hole: the normal
 * per-child update. Expected semantics after the repair:
 *
 * - corrupt map  → original bytes preserved byte-for-byte, condition logged,
 *                  no silent rebuild, no fake task history, never acked as a
 *                  persisted write (the observer's read-back verifier keeps
 *                  reporting retryable until the map is repaired);
 * - missing map  → rebuilt per the existing product contract;
 * - valid map    → extended normally (task summary + decisions).
 *
 * Integration-style (real filesystem, no _internals swaps) mirroring
 * corrupt-map-preservation.test.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
	loadContextMap,
	readContextMapState,
} from '../../../src/context-map/persistence';
import {
	updateContextMapAfterAgent,
	updateContextMapAfterAgentLocked,
	type PostAgentUpdateParams,
} from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '2.1';

/** Unique, deliberately corrupt bytes — recoverable payload must survive. */
const CORRUPT_BYTES =
	'{"schema_version": 1, "decisions": [{"id": "A1", "decision": "r17-recovery-marker", "rationale": "must survive a child completion", "timestamp": "2026-11-21T00:00:00.000Z", "task_id": "1.1"}], "files": {}, "task_history": {"1.1": {"final_status": "pending"'; // truncated JSON

function contextMapPath(directory: string): string {
	return join(directory, '.swarm', 'context-map.json');
}

function sha256(bytes: Buffer): string {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

function childParams(directory: string): PostAgentUpdateParams {
	return {
		task_id: TASK_ID,
		agent_role: 'coder',
		files_touched: [],
		implementation_summary: 'child finished its work',
		task_goal: 'do the work',
		final_status: 'in_progress',
		decisions: [{ decision: 'r17-child-decision', rationale: 'fresh' }],
		directory,
	};
}

function seedCorruptMap(directory: string): { bytes: Buffer; hash: string } {
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(contextMapPath(directory), CORRUPT_BYTES, 'utf-8');
	const bytes = fs.readFileSync(contextMapPath(directory));
	return { bytes, hash: sha256(bytes) };
}

function seedValidMap(directory: string): void {
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		contextMapPath(directory),
		JSON.stringify(
			{
				schema_version: 1,
				generated_at: '2026-11-20T00:00:00.000Z',
				repo_fingerprint: '',
				files: {},
				task_history: {
					'1.1': {
						task_id: '1.1',
						goal: 'prior task',
						files_touched: [],
						implementation_summary: 'prior',
						final_status: 'approved',
					},
				},
				decisions: [
					{
						id: 'A1',
						decision: 'prior-decision',
						rationale: 'keep me',
						timestamp: '2026-11-20T00:00:00.000Z',
						task_id: '1.1',
					},
				],
			},
			null,
			2,
		),
		'utf-8',
	);
}

describe('context-map — corrupt map preservation on the normal child update path (r17 P1)', () => {
	let directory: string;
	let cleanup: () => void;
	let warnSpy: ReturnType<typeof spyOn>;
	let originalDebug: string | undefined;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('ctxmap-child-corrupt-'));
		originalDebug = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (originalDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = originalDebug;
		}
		resetSwarmState();
		closeAllProjectDbs();
		cleanup();
	});

	test('Test A: updateContextMapAfterAgent preserves a corrupt map byte-for-byte', () => {
		const { bytes, hash } = seedCorruptMap(directory);
		expect(readContextMapState(directory).kind).toBe('unreadable');

		updateContextMapAfterAgent(childParams(directory));

		// Original bytes survive — no silent rebuild, no fake task history.
		const after = fs.readFileSync(contextMapPath(directory));
		expect(sha256(after)).toBe(hash);
		expect(after.equals(bytes)).toBe(true);
		expect(loadContextMap(directory)).toBeNull();

		// The condition is diagnosable (logged).
		const warned = warnSpy.mock.calls
			.map((call) => String(call[0]))
			.some((text) => text.includes('corrupt or unreadable'));
		expect(warned).toBe(true);
	});

	test('Test B: updateContextMapAfterAgentLocked preserves a corrupt map byte-for-byte', async () => {
		const { bytes, hash } = seedCorruptMap(directory);

		await expect(
			updateContextMapAfterAgentLocked(childParams(directory)),
		).resolves.toBeDefined();

		const after = fs.readFileSync(contextMapPath(directory));
		expect(sha256(after)).toBe(hash);
		expect(after.equals(bytes)).toBe(true);
		expect(loadContextMap(directory)).toBeNull();
	});

	test('Test C: a genuinely missing map is still rebuilt per the product contract', () => {
		fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
		fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
		expect(readContextMapState(directory).kind).toBe('missing');

		updateContextMapAfterAgent(childParams(directory));

		const map = loadContextMap(directory);
		expect(map).not.toBeNull();
		// The child result is recorded (non-final pending — a child completion
		// is not a task release).
		expect(map?.task_history[TASK_ID]?.final_status).toBe('pending');
		expect(
			map?.decisions.some(
				(entry) => entry.decision === 'r17-child-decision',
			),
		).toBe(true);
	});

	test('Test D: a valid existing map is still extended normally', () => {
		seedValidMap(directory);

		updateContextMapAfterAgent(childParams(directory));

		const map = loadContextMap(directory);
		expect(map).not.toBeNull();
		// Prior data preserved...
		expect(map?.task_history['1.1']?.final_status).toBe('approved');
		expect(
			map?.decisions.some((entry) => entry.decision === 'prior-decision'),
		).toBe(true);
		// ...and the new child result appended.
		expect(map?.task_history[TASK_ID]?.final_status).toBe('pending');
		expect(
			map?.decisions.some(
				(entry) => entry.decision === 'r17-child-decision',
			),
		).toBe(true);
	});

	test('Test E: repeated child completions never overwrite a corrupt map', () => {
		const { hash } = seedCorruptMap(directory);

		for (let i = 0; i < 3; i++) {
			updateContextMapAfterAgent(childParams(directory));
			expect(sha256(fs.readFileSync(contextMapPath(directory)))).toBe(hash);
		}

		expect(loadContextMap(directory)).toBeNull();
	});
});
