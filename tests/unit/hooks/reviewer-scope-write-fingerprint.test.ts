import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	captureReviewerScopeFileFingerprint,
	_internals as fingerprintInternals,
} from '../../../src/hooks/reviewer-scope-file-fingerprint';
import {
	getReviewerScopeGenerationForCoderCall,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	swarmState,
} from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	idle_timeout_minutes: 60,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	profiles: undefined,
	block_destructive_commands: true,
};

let directory = '';
let hooks: ReturnType<typeof createGuardrailsHooks>;
const realReadFileSync = fingerprintInternals.readFileSync;

function generation() {
	return getReviewerScopeGenerationForCoderCall({
		parentSessionID: 'parent',
		taskId: '1.1',
		coderCallID: 'coder-call',
	});
}

async function after(
	tool: string,
	callID: string,
	output = 'write completed',
	metadata: unknown = { status: 'completed' },
): Promise<void> {
	await hooks.toolAfter(
		{ tool, sessionID: 'child', callID },
		{ title: '', output, metadata },
	);
}

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'review-write-fingerprint-')),
	);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(path.join(directory, 'src/a.ts'), 'before\n');
	startAgentSession('parent', 'architect', directory);
	startAgentSession('child', 'coder', directory);
	swarmState.activeAgent.set('child', 'coder');
	swarmState.agentSessions.get('child')!.delegationActive = true;
	installActiveScopeBinding({
		directory,
		childSessionId: 'child',
		parentSessionId: 'parent',
		dispatchCallId: 'coder-call',
		taskId: '1.1',
		files: ['src/a.ts'],
	});
	expect(
		startReviewerScopeGeneration({
			parentSessionID: 'parent',
			taskId: '1.1',
			coderCallID: 'coder-call',
			background: true,
			declaredFiles: ['src/a.ts'],
		}),
	).not.toBeNull();
	hooks = createGuardrailsHooks(directory, undefined, config);
});

afterEach(() => {
	fingerprintInternals.readFileSync = realReadFileSync;
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer scope post-write fingerprints', () => {
	test('records a direct child write only after its successful after-hook', async () => {
		await hooks.toolBefore(
			{ tool: 'apply_patch', sessionID: 'child', callID: 'direct-write' },
			{
				args: {
					input:
						'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-before\n+after\n*** End Patch',
				},
			},
		);
		expect(generation()?.modifiedFiles).toEqual(['src/a.ts']);
		expect(generation()?.modifiedFileFingerprints).toEqual([]);
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'after\n');
		await after('apply_patch', 'direct-write');

		expect(generation()?.modifiedFileFingerprints).toEqual([
			captureReviewerScopeFileFingerprint(directory, 'src/a.ts'),
		]);
	});

	test('does not fabricate ownership for a failed child write', async () => {
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'child', callID: 'failed-write' },
			{ args: { filePath: 'src/a.ts', content: 'after\n' } },
		);
		await after('write', 'failed-write', 'error: write failed', {
			status: 'failed',
		});

		expect(generation()?.modifiedFiles).toEqual(['src/a.ts']);
		expect(generation()?.modifiedFileFingerprints).toEqual([]);
	});

	test('a successful no-op fingerprints old bytes and cannot bless a later direct mutation', async () => {
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'child', callID: 'no-op-write' },
			{ args: { filePath: 'src/a.ts', content: 'before\n' } },
		);
		await after('write', 'no-op-write');
		const recorded = generation()?.modifiedFileFingerprints[0];
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'direct mutation\n');

		expect(recorded).toBeDefined();
		expect(recorded).not.toEqual(
			captureReviewerScopeFileFingerprint(directory, 'src/a.ts'),
		);
	});

	test('routes and fingerprints every statically resolved shell target', async () => {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 'child', callID: 'shell-write' },
			{ args: { command: 'echo after > src/a.ts' } },
		);
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'after\n');
		await after('bash', 'shell-write');

		expect(generation()?.modifiedFiles).toEqual(['src/a.ts']);
		expect(generation()?.modifiedFileFingerprints).toEqual([
			captureReviewerScopeFileFingerprint(directory, 'src/a.ts'),
		]);
	});

	test('fails closed for a shell write whose target is dynamic', async () => {
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'child', callID: 'dynamic-shell-write' },
				{ args: { command: 'echo after > $TARGET' } },
			),
		).rejects.toThrow(/dynamic path target|cannot be statically resolved/);
		expect(generation()?.modifiedFiles).toEqual([]);
		expect(generation()?.modifiedFileFingerprints).toEqual([]);
	});

	test('rejects an over-budget target before reading or hashing its bytes', () => {
		fs.writeFileSync(path.join(directory, 'src/a.ts'), 'A'.repeat(32));
		let reads = 0;
		fingerprintInternals.readFileSync = ((...args) => {
			reads += 1;
			return realReadFileSync(...args);
		}) as typeof realReadFileSync;

		expect(
			captureReviewerScopeFileFingerprint(directory, 'src/a.ts', 16),
		).toBeNull();
		expect(reads).toBe(0);
		expect(
			captureReviewerScopeFileFingerprint(directory, 'src/a.ts', 32),
		).not.toBeNull();
		expect(reads).toBe(1);
	});
});
