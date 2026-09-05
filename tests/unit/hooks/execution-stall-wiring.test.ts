/**
 * Wiring proof for the two #2063 containment levers (B4 + B5).
 *
 * The behavioural contracts are pinned in `execution-stall-{episode,ladder,
 * progress}.test.ts` and `internals-guard.test.ts` against the modules
 * directly. This file exists for a different reason: the repository treats a
 * module that is exported but not reachable from the running hook chain as
 * UNWIRED CODE, which is a blocker rather than a polish item. Everything here
 * therefore goes through `createGuardrailsHooks(...)` — the same factory
 * `src/index.ts` builds its `tool.execute.before` / `.after` handlers from — so
 * a future refactor that drops either call site fails this file.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	type GuardrailsConfig,
	GuardrailsConfigSchema,
	resolveGuardrailsConfig,
} from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { isExecutionEpisodeArmed } from '../../../src/hooks/guardrails/execution-episode';
import {
	_internals as stallInternals,
	_test_exports as stallTestExports,
} from '../../../src/hooks/guardrails/execution-stall';
import {
	_internals as guardInternals,
	SWARM_INTERNALS_DENIAL_MESSAGE,
} from '../../../src/hooks/guardrails/internals-guard';
import { resetSwarmState, swarmState } from '../../../src/state';

const WARN_CALLS = 4;
const STOP_CALLS = 6;

const config: GuardrailsConfig = GuardrailsConfigSchema.parse({
	enabled: true,
	execution_stall_warn_calls: WARN_CALLS,
	execution_stall_stop_calls: STOP_CALLS,
	execution_stall_episode_minutes: 30,
	shell_audit_log: false,
});

let root: string;
let workspace: string;
let installRoot: string;
let hooks: ReturnType<typeof createGuardrailsHooks>;

const realNow = stallInternals.now;
const realCapture = stallInternals.captureWorkspaceSnapshotAsync;
const realChanged = stallInternals.changedFilesSinceSnapshotAsync;
const realModuleUrl = guardInternals.moduleUrl;

let clock = 1_700_000_000_000;

beforeEach(() => {
	resetSwarmState();
	stallTestExports.reset();
	clock = 1_700_000_000_000;
	stallInternals.now = () => clock;
	stallInternals.captureWorkspaceSnapshotAsync = mock(
		() => ({ gitHead: 'H0', changedFiles: [] }) as never,
	) as never;
	stallInternals.changedFilesSinceSnapshotAsync = mock(async () => []) as never;

	root = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-wiring-'));
	workspace = path.join(root, 'user-project');
	installRoot = path.join(workspace, 'node_modules', 'opencode-swarm');
	fs.mkdirSync(path.join(installRoot, 'dist'), { recursive: true });
	fs.writeFileSync(
		path.join(installRoot, 'package.json'),
		JSON.stringify({ name: 'opencode-swarm' }),
	);
	fs.writeFileSync(path.join(installRoot, 'dist', 'index.js'), '// bundle');
	fs.writeFileSync(
		path.join(workspace, 'package.json'),
		JSON.stringify({ name: 'my-app' }),
	);
	guardInternals.moduleUrl = () =>
		pathToFileURL(path.join(installRoot, 'dist', 'index.js')).href;
	guardInternals.resetCaches();

	hooks = createGuardrailsHooks(workspace, config);
	swarmState.activeAgent.set('arch', 'architect');
});

afterEach(() => {
	stallInternals.now = realNow;
	stallInternals.captureWorkspaceSnapshotAsync = realCapture;
	stallInternals.changedFilesSinceSnapshotAsync = realChanged;
	guardInternals.moduleUrl = realModuleUrl;
	guardInternals.resetCaches();
	stallTestExports.reset();
	resetSwarmState();
	const resolved = path.resolve(root);
	if (resolved.startsWith(path.resolve(os.tmpdir())) && resolved.length > 8) {
		fs.rmSync(resolved, { recursive: true, force: true });
	}
});

async function before(
	tool: string,
	args: unknown,
	callID: string,
): Promise<void> {
	clock += 1_000;
	await hooks.toolBefore({ tool, sessionID: 'arch', callID }, { args } as {
		args: unknown;
	});
}

async function after(
	tool: string,
	callID: string,
	output: unknown,
	args?: Record<string, unknown>,
): Promise<void> {
	await hooks.toolAfter(
		{ tool, sessionID: 'arch', callID, args } as never,
		output as never,
	);
}

describe('#2063 B5 — wired into the guardrails hook chain', () => {
	test('toolBefore arms the episode on a mutating-role Task dispatch', async () => {
		await before('Task', { subagent_type: 'coder', prompt: 'p' }, 'c-1');
		expect(isExecutionEpisodeArmed('arch')).toBe(true);
		expect(stallTestExports.peekState('arch')?.armed).toBe(true);
	});

	test('toolBefore denies a read once the hard rung is reached', async () => {
		// The arming dispatch is itself call #1, and the counter is incremented
		// BEFORE the denial is evaluated within the same toolBefore — so the call
		// that takes the counter to STOP_CALLS is the one that gets denied.
		await before('Task', { subagent_type: 'coder', prompt: 'p' }, 'c-1');
		for (let i = 0; i < STOP_CALLS - 2; i++) {
			await before(
				'read',
				{ filePath: path.join(workspace, `f${i}.ts`) },
				`r${i}`,
			);
		}
		expect(stallTestExports.peekState('arch')?.nonProgressCalls).toBe(
			STOP_CALLS - 1,
		);
		await expect(
			before('read', { filePath: path.join(workspace, 'boom.ts') }, 'r-deny'),
		).rejects.toThrow(/^EXECUTION_STALL:/);
	});

	test('toolBefore does NOT deny Task or update_task_status at the hard rung', async () => {
		await before('Task', { subagent_type: 'coder', prompt: 'p' }, 'c-1');
		for (let i = 0; i < STOP_CALLS + 2; i++) {
			await before(
				'read',
				{ filePath: path.join(workspace, `f${i}.ts`) },
				`r${i}`,
			).catch((err) => {
				if (!/^EXECUTION_STALL:/.test((err as Error).message)) throw err;
			});
		}
		await expect(
			before(
				'update_task_status',
				{ task_id: '1.1', status: 'blocked' },
				'u-1',
			),
		).resolves.toBeUndefined();
		await expect(
			before('Task', { subagent_type: 'coder', prompt: 'different' }, 'c-2'),
		).resolves.toBeUndefined();
	});

	test('toolAfter records a coder completion as progress and clears the rung', async () => {
		await before('Task', { subagent_type: 'coder', prompt: 'p' }, 'c-1');
		for (let i = 0; i < STOP_CALLS; i++) {
			await before(
				'read',
				{ filePath: path.join(workspace, `f${i}.ts`) },
				`r${i}`,
			).catch((err) => {
				if (!/^EXECUTION_STALL:/.test((err as Error).message)) throw err;
			});
		}
		await after('Task', 'c-1', {
			title: 'Task',
			output: 'done',
			metadata: {},
		});
		expect(stallTestExports.peekState('arch')?.nonProgressCalls).toBe(0);
		await expect(
			before('read', { filePath: path.join(workspace, 'ok.ts') }, 'r-ok'),
		).resolves.toBeUndefined();
	});

	test('toolAfter arms the episode on update_task_status(in_progress)', async () => {
		await after(
			'update_task_status',
			'u-1',
			{
				title: 'update_task_status',
				output: JSON.stringify({ success: true, new_status: 'in_progress' }),
				metadata: {},
			},
			{ task_id: '1.1', status: 'in_progress' },
		);
		expect(isExecutionEpisodeArmed('arch')).toBe(true);
	});

	test('the advisory rung reaches the session advisory queue', async () => {
		await before('Task', { subagent_type: 'coder', prompt: 'p' }, 'c-1');
		for (let i = 0; i < WARN_CALLS; i++) {
			await before(
				'read',
				{ filePath: path.join(workspace, `f${i}.ts`) },
				`r${i}`,
			);
		}
		const queued =
			swarmState.agentSessions.get('arch')?.pendingAdvisoryMessages ?? [];
		expect(queued.some((m) => m.startsWith('EXECUTION STALL:'))).toBe(true);
	});
});

describe('#2063 B5 — the config-surface assumption the call sites rely on', () => {
	test('GuardrailsProfileSchema cannot express the stall knobs — so reading top-level cfg is correct', () => {
		// Cross-entry invariant (writing-tests § "Cross-Entry Invariants").
		//
		// `tool-before.ts` and `index.ts` read the TOP-LEVEL `cfg` for the four
		// containment knobs instead of routing through `resolveGuardrailsConfig`.
		// That is only safe because `GuardrailsProfileSchema` is a CLOSED seven-key
		// budget subset and Zod strips unknown keys, so a per-agent override of
		// `enabled` or any `execution_stall_*` key is dropped at PARSE time and can
		// never reach the resolver.
		//
		// If someone later adds those keys to the profile schema, this test fails
		// and points at the two call sites that must start resolving per agent —
		// otherwise the config surface would silently lie.
		const parsed = GuardrailsConfigSchema.parse({
			enabled: true,
			execution_stall_warn_calls: 99,
			execution_stall_stop_calls: 99,
			execution_stall_episode_minutes: 99,
			profiles: {
				architect: {
					enabled: false,
					execution_stall_warn_calls: 2,
					execution_stall_stop_calls: 3,
					execution_stall_episode_minutes: 4,
					max_tool_calls: 7,
				},
			},
		});
		// Only the budget key survived the profile schema.
		expect(parsed.profiles?.architect).toEqual({ max_tool_calls: 7 });

		const resolved = resolveGuardrailsConfig(parsed, 'architect');
		expect(resolved.max_tool_calls).toBe(7);
		expect(resolved.enabled).toBe(parsed.enabled);
		expect(resolved.execution_stall_warn_calls).toBe(
			parsed.execution_stall_warn_calls,
		);
		expect(resolved.execution_stall_stop_calls).toBe(
			parsed.execution_stall_stop_calls,
		);
		expect(resolved.execution_stall_episode_minutes).toBe(
			parsed.execution_stall_episode_minutes,
		);
	});
});

describe('#2063 B4 — wired into the guardrails hook chain', () => {
	test('toolBefore denies a read of the installed package', async () => {
		await expect(
			before(
				'read',
				{ filePath: path.join(installRoot, 'dist', 'index.js') },
				'i-1',
			),
		).rejects.toThrow(SWARM_INTERNALS_DENIAL_MESSAGE);
	});

	test('toolBefore allows a read of the user workspace', async () => {
		fs.writeFileSync(path.join(workspace, 'app.ts'), 'x');
		await expect(
			before('read', { filePath: path.join(workspace, 'app.ts') }, 'i-2'),
		).resolves.toBeUndefined();
	});
});
