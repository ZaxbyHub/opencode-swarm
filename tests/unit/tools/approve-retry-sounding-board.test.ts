import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	approve_retry_sounding_board,
	executeApproveRetrySoundingBoard,
} from '../../../src/tools/approve-retry-sounding-board';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as PluginConfig;

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

interface ToolResult {
	success?: boolean;
	message?: string;
	task_id?: string;
	generation?: number;
	retry_epoch?: number;
	method?: string;
	user_confirmed?: boolean;
	audit_event_recorded?: boolean;
}

describe('approve_retry_sounding_board tool (issue #2703)', () => {
	let directory = '';
	let cleanup = (): void => {};

	async function dispatchCoder(
		hook: ReturnType<typeof createDelegationGateHook>,
		callID: string,
	): Promise<void> {
		const args = {
			subagent_type: 'coder',
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: feature is implemented and verified',
		};
		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent-1', callID },
			{ args },
		);
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'parent-1', callID, args },
			{ state: 'completed', output: 'no changes required' },
		);
	}

	async function wedgeTask1_1(): Promise<void> {
		const session = ensureAgentSession('parent-1', 'architect', directory);
		session.currentTaskId = '1.1';
		const hook = createDelegationGateHook(config, directory);
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await dispatchCoder(hook, `no-op-${attempt}`);
		}
		await expect(dispatchCoder(hook, 'threshold-probe')).rejects.toThrow(
			'Dispatch critic_sounding_board',
		);
	}

	beforeEach(async () => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('tool-retry-sb-'));
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		git(directory, ['add', 'src/feature.ts']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/feature.ts'] },
		]);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('rejects invalid args (missing fields, over-length reason)', async () => {
		const missingTask = JSON.parse(
			await executeApproveRetrySoundingBoard({ reason: 'x' }, directory, {
				sessionID: 's',
			}),
		) as ToolResult;
		expect(missingTask.success).toBe(false);
		expect(missingTask.message).toContain('task_id');

		const missingReason = JSON.parse(
			await executeApproveRetrySoundingBoard({ task_id: '1.1' }, directory, {
				sessionID: 's',
			}),
		) as ToolResult;
		expect(missingReason.success).toBe(false);
		expect(missingReason.message).toContain('reason');

		const overLength = JSON.parse(
			await executeApproveRetrySoundingBoard(
				{ task_id: '1.1', reason: 'r'.repeat(501) },
				directory,
				{ sessionID: 's' },
			),
		) as ToolResult;
		expect(overLength.success).toBe(false);
		expect(overLength.message).toContain('reason');
	});

	test('rejects an unknown extra arg (strict schema)', async () => {
		const result = JSON.parse(
			await executeApproveRetrySoundingBoard(
				{ task_id: '1.1', reason: 'x', extra: true },
				directory,
				{ sessionID: 's' },
			),
		) as ToolResult;
		expect(result.success).toBe(false);
	});

	test('requires an active sessionID', async () => {
		const result = JSON.parse(
			await executeApproveRetrySoundingBoard(
				{ task_id: '1.1', reason: 'x' },
				directory,
				{},
			),
		) as ToolResult;
		expect(result.success).toBe(false);
		expect(result.message).toContain('sessionID');
	});

	test('records a manual approval from an architect session with audit markers', async () => {
		await wedgeTask1_1();
		ensureAgentSession('arch-tool', 'architect', directory);
		const result = JSON.parse(
			await executeApproveRetrySoundingBoard(
				{
					task_id: '1.1',
					reason:
						'sounding board returned APPROVED but the recorder missed the verdict format',
				},
				directory,
				{ sessionID: 'arch-tool' },
			),
		) as ToolResult;
		expect(result.success).toBe(true);
		expect(result.task_id).toBe('1.1');
		expect(result.method).toBe('manual_override');
		expect(result.user_confirmed).toBe(false);
		expect(result.audit_event_recorded).toBe(true);
		expect(typeof result.generation).toBe('number');
		expect(typeof result.retry_epoch).toBe('number');
	});

	test('surfaces typed helper failures as success:false JSON, not throws', async () => {
		await wedgeTask1_1();
		ensureAgentSession('coder-session', 'coder', directory);
		const result = JSON.parse(
			await executeApproveRetrySoundingBoard(
				{ task_id: '1.1', reason: 'self-unblock attempt' },
				directory,
				{ sessionID: 'coder-session' },
			),
		) as ToolResult;
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'APPROVE_RETRY_SOUNDING_BOARD_ARCHITECT_REQUIRED',
		);
	});

	test('is exported through the tool barrel surface with a createSwarmTool shape', () => {
		expect(typeof approve_retry_sounding_board.execute).toBe('function');
		expect(approve_retry_sounding_board.args).toBeDefined();
	});
});
