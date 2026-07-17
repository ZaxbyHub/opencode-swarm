import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import {
	type GuardrailsConfig,
	GuardrailsConfigSchema,
} from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

function makeInput(tool: string, callID: string) {
	return { tool, sessionID: 'test-session', callID };
}

function makeOutput(args: unknown) {
	return { args };
}

describe('guardrails resolved write targets (#1875)', () => {
	beforeEach(() => resetSwarmState());

	it('fails closed when a delegated apply_patch payload has no target', async () => {
		const tempDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'write-target-resolution-')),
		);
		const originalCwd = process.cwd();
		process.chdir(tempDir);
		try {
			const sessionId = 'patch-f4-delegated';
			ensureAgentSession(sessionId, 'coder');
			swarmState.activeAgent.set(sessionId, 'coder');
			getAgentSession(sessionId)!.delegationActive = true;
			beginInvocation(sessionId, 'coder');
			const hooks = createGuardrailsHooks(
				tempDir,
				GuardrailsConfigSchema.parse({ enabled: true }),
			);

			await expect(
				hooks.toolBefore(
					{ tool: 'apply_patch', sessionID: sessionId, callID: 'call-f4' },
					{ args: { input: '' } },
				),
			).rejects.toThrow('WRITE TARGET UNVERIFIABLE');
		} finally {
			process.chdir(originalCwd);
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it('fails closed for architect when universal guards cannot resolve a target', async () => {
		const sessionId = 'architect-unverifiable';
		startAgentSession(sessionId, ORCHESTRATOR_NAME);
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		const hooks = createGuardrailsHooks(process.cwd(), defaultConfig());

		await expect(
			hooks.toolBefore(
				{ tool: 'apply_patch', sessionID: sessionId, callID: 'architect-call' },
				{ args: { input: '' } },
			),
		).rejects.toThrow('WRITE TARGET UNVERIFIABLE');
	});

	describe('modified-file tracking uses patch payload targets', () => {
		beforeEach(() => {
			startAgentSession('test-session', ORCHESTRATOR_NAME);
			getAgentSession('test-session')!.delegationActive = true;
		});

		it('tracks write, edit, and patch targets together', async () => {
			const hooks = createGuardrailsHooks(defaultConfig());
			const session = getAgentSession('test-session');

			await hooks.toolBefore(
				makeInput('write', 'call-1'),
				makeOutput({ filePath: 'src/foo.ts' }),
			);
			await hooks.toolBefore(
				makeInput('edit', 'call-2'),
				makeOutput({ filePath: 'src/bar.ts' }),
			);
			await hooks.toolBefore(
				makeInput('patch', 'call-3'),
				makeOutput({
					input: '*** Begin Patch\n*** Update File: src/baz.ts\n*** End Patch',
				}),
			);

			expect(session?.modifiedFilesThisCoderTask).toEqual([
				'src/foo.ts',
				'src/bar.ts',
				'src/baz.ts',
			]);
		});

		it('tracks create_file, insert, and apply_patch targets together', async () => {
			const hooks = createGuardrailsHooks(defaultConfig());
			const session = getAgentSession('test-session');

			await hooks.toolBefore(
				makeInput('create_file', 'call-1'),
				makeOutput({ filePath: 'src/new-file.ts' }),
			);
			await hooks.toolBefore(
				makeInput('insert', 'call-2'),
				makeOutput({ path: 'src/insert-into.ts' }),
			);
			await hooks.toolBefore(
				makeInput('apply_patch', 'call-3'),
				makeOutput({
					input:
						'*** Begin Patch\n*** Update File: src/patch.ts\n*** End Patch',
				}),
			);

			expect(session?.modifiedFilesThisCoderTask).toEqual([
				'src/new-file.ts',
				'src/insert-into.ts',
				'src/patch.ts',
			]);
		});
	});
});
