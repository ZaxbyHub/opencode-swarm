import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	_internals,
	type PreCheckBatchInput,
	type PreCheckBatchResult,
	pre_check_batch,
} from '../../../src/tools/pre-check-batch';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originals = {
	resolveGatePreamble: _internals.resolveGatePreamble,
	runPreCheckBatch: _internals.runPreCheckBatch,
};

let directory = '';
let capturedInput: PreCheckBatchInput | undefined;
let capturedSessionID: string | undefined;

function completedResult(): PreCheckBatchResult {
	const skipped = { ran: false, duration_ms: 0 };
	return {
		batch_status: 'completed',
		gates_passed: true,
		lint: skipped,
		secretscan: skipped,
		sast_scan: skipped,
		quality_budget: skipped,
		total_duration_ms: 0,
	};
}

function context(): ToolContext {
	return {
		sessionID: 'issue-2254-session',
		messageID: 'message',
		agent: 'architect',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => undefined,
		ask: async () => undefined,
	} as unknown as ToolContext;
}

beforeEach(() => {
	directory = canonicalMkdtemp('pre-check-sast-profile-');
	fs.mkdirSync(path.join(directory, '.git'));
	fs.writeFileSync(
		path.join(directory, 'safe.ts'),
		'export const safe = true;\n',
	);
	capturedInput = undefined;
	capturedSessionID = undefined;
	_internals.runPreCheckBatch = async (input) => {
		capturedInput = input;
		return completedResult();
	};
});

afterEach(() => {
	_internals.resolveGatePreamble = originals.resolveGatePreamble;
	_internals.runPreCheckBatch = originals.runPreCheckBatch;
	fs.rmSync(directory, { recursive: true, force: true });
});

async function execute() {
	const raw = await pre_check_batch.execute(
		{ files: ['safe.ts'], directory },
		context() as never,
	);
	return JSON.parse(raw);
}

describe('pre_check_batch QA-profile SAST wiring — issue #2254', () => {
	test('effective sast_enabled false is derived internally and receives session identity', async () => {
		_internals.resolveGatePreamble = async (_dir, sessionID) => {
			capturedSessionID = sessionID;
			return {
				resolved: true,
				effectiveGates: { sast_enabled: false },
			} as never;
		};

		await execute();

		expect(capturedSessionID).toBe('issue-2254-session');
		expect(capturedInput?.sast_enabled).toBe(false);
	});

	test('effective sast_enabled true schedules the gate', async () => {
		_internals.resolveGatePreamble = async () =>
			({
				resolved: true,
				effectiveGates: { sast_enabled: true },
			}) as never;

		await execute();

		expect(capturedInput?.sast_enabled).toBe(true);
	});

	test('missing plan or profile defaults SAST to enabled', async () => {
		_internals.resolveGatePreamble = async () => ({ resolved: false });

		await execute();

		expect(capturedInput?.sast_enabled).toBe(true);
	});

	test('profile resolution exceptions fail safe by keeping SAST enabled', async () => {
		_internals.resolveGatePreamble = async () => {
			throw new Error('profile database unavailable');
		};

		const result = await execute();

		expect(result.gates_passed).toBe(true);
		expect(capturedInput?.sast_enabled).toBe(true);
	});
});
