/**
 * PR 3922 (SolCritic adjudication): the per-directory native-async registry is
 * GONE. One immutable dialect is resolved per v2 plugin setup from the host
 * version and bound at the boundaries (tool-hook adapters, delegation gate), so:
 *   (a) arbitrarily many overlapping distinct v2 setups register successfully —
 *       the former 1024-project fail-closed capacity path no longer exists —
 *       and cleanup still works;
 *   (b) overlapping legacy and 2.3 setups on the SAME directory each keep their
 *       own dialect (per-setup binding, not per-directory state);
 *   (c) one setup's cleanup does not disturb another live setup's dialect;
 *   (d) a delegation gate constructed with dialect 'native-2.3' captures a
 *       DIFFERENT mode than the default legacy call (omission = legacy, so a
 *       hard-coded or dropped binding cannot silently pass).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	createDelegationGateHook,
	SWARM_BACKGROUND_TASK_BLOCKED_MESSAGE,
} from '../../../../src/hooks/delegation-gate';
import { resolveV2SubagentDialect } from '../../../../src/host/v2/native-async-mode';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset, V2InitInput } from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

/** Overlap count for the distinct-directory proof (contract: 60+ overlapping
 * setups suffice to prove no bound; the old registry threw past 1024). */
const OVERLAPPING_SETUPS = 64;

/** The v1 args the native (2.3) before-adapter hands the chain: background
 * injected, the child sessionID preserved as a resume token. */
const NATIVE_V1_ARGS = {
	subagent_type: 'coder',
	sessionID: 'ses_child_binding',
	prompt: 'go',
	background: true,
};

/** The v1 args the legacy before-adapter hands the chain: foreground (no
 * background), the v2 sessionID mapped to the v1 task_id. */
const LEGACY_V1_ARGS = {
	subagent_type: 'coder',
	task_id: 'ses_child_binding',
	prompt: 'go',
};

interface SetupHandle {
	cleanup: () => Promise<void>;
	hookCalls: Array<{ name: string; cb: (event: unknown) => unknown }>;
	inputs: V2InitInput[];
	/** v1 `output.args` snapshots recorded by this setup's before-chain. */
	recorded: Array<Record<string, unknown>>;
}

function makeHooksWithBeforeCapture(
	recorded: Array<Record<string, unknown>>,
): V1HooksSubset {
	return {
		tool: {},
		agent: {},
		config: async () => {},
		event: async () => {},
		dispose: async () => {},
		'tool.execute.before': async (
			_input: unknown,
			output: { args: unknown },
		) => {
			recorded.push({ ...(output.args as Record<string, unknown>) });
		},
	} as V1HooksSubset;
}

async function startSetup(
	version: string,
	directory: string,
): Promise<SetupHandle> {
	const hookCalls: Array<{ name: string; cb: (event: unknown) => unknown }> =
		[];
	const inputs: V2InitInput[] = [];
	const recorded: Array<Record<string, unknown>> = [];
	const ctx = {
		app: { name: 'opencode', version, channel: 'test' },
		location: {
			directory,
			workspaceID: 'w',
			project: { id: 'p', directory, canonical: directory },
		},
		options: {},
		tool: {
			transform: async () => ({ dispose: async () => {} }),
			reload: async () => {},
			list: async () => [],
			hook: async (name: string, cb: (event: unknown) => unknown) => {
				hookCalls.push({ name, cb });
				return { dispose: async () => {} };
			},
		},
		agent: {
			transform: async () => ({ dispose: async () => {} }),
			reload: async () => {},
		},
		command: {
			transform: async () => ({ dispose: async () => {} }),
			reload: async () => {},
		},
		session: { hook: async () => ({ dispose: async () => {} }) },
		event: {
			subscribe: () => (async function* () {})(),
		},
		permission: {},
	} as never;
	const deps = {
		runInit: async (input: V2InitInput) => {
			inputs.push(input);
			return makeHooksWithBeforeCapture(recorded);
		},
	};
	const cleanup = await openCodeSwarmV2Setup(ctx, deps as never);
	return { cleanup, hookCalls, inputs, recorded };
}

/** Drives a setup's registered execute.before adapter with a native v2
 * `subagent` event and returns the args its v1 before-chain received. */
async function driveBeforeAdapter(
	handle: SetupHandle,
	callID: string,
): Promise<Record<string, unknown>> {
	const before = handle.hookCalls.find((c) => c.name === 'execute.before');
	expect(before).toBeDefined();
	const snapshotCount = handle.recorded.length;
	await before?.cb({
		tool: 'subagent',
		sessionID: `ses_parent_${callID}`,
		agent: 'architect',
		messageID: 'msg_binding',
		id: callID,
		input: { agent: 'coder', sessionID: 'ses_child_binding', prompt: 'go' },
	});
	expect(handle.recorded.length).toBe(snapshotCount + 1);
	return handle.recorded[handle.recorded.length - 1];
}

describe('v2 native-async dialect binding (PR 3922 closeout)', () => {
	afterEach(() => {
		resetSwarmState();
	});

	test('(a) 64 overlapping distinct v2 setups on distinct directories register successfully and clean up', async () => {
		const handles: SetupHandle[] = [];
		const directories: string[] = [];
		try {
			for (let i = 0; i < OVERLAPPING_SETUPS; i++) {
				const directory = canonicalMkdtemp('swarm-v2-dialect-a-');
				directories.push(directory);
				// All setups stay LIVE simultaneously — under the old registry the
				// 1025th distinct directory threw a capacity error; here there is
				// no registry and no bound, so every setup resolves.
				handles.push(await startSetup('2.3.1', directory));
			}
			expect(handles.length).toBe(OVERLAPPING_SETUPS);
			for (const handle of handles) {
				expect(handle.inputs).toHaveLength(1);
				expect(handle.inputs[0].subagentDialect).toBe('native-2.3');
			}
			// Cleanup still works for every live setup.
			for (const handle of handles) {
				await handle.cleanup();
			}
		} finally {
			for (const directory of directories) removeTreeWithRetry(directory);
		}
	});

	test('(a2) resolveV2SubagentDialect has no capacity path (1,025 consecutive resolutions)', () => {
		for (let i = 0; i < 1025; i++) {
			expect(resolveV2SubagentDialect('2.3.1')).toBe('native-2.3');
			expect(resolveV2SubagentDialect('1.0.0')).toBe('legacy');
		}
	});

	test('(b) overlapping legacy and 2.3 setups on the SAME directory each keep their own dialect', async () => {
		const directory = canonicalMkdtemp('swarm-v2-dialect-b-');
		try {
			const legacySetup = await startSetup('1.0.0', directory);
			const nativeSetup = await startSetup('2.3.1', directory);
			// Same directory, two live setups, two different dialects — the
			// per-directory registry could only ever hold one shared answer.
			expect(legacySetup.inputs[0].directory).toBe(directory);
			expect(nativeSetup.inputs[0].directory).toBe(directory);
			expect(legacySetup.inputs[0].subagentDialect).toBe('legacy');
			expect(nativeSetup.inputs[0].subagentDialect).toBe('native-2.3');
			// Behavioral: each setup's before-adapter translates per ITS OWN
			// dialect — background:true + preserved resume sessionID for the 2.3
			// setup; foreground task_id mapping for the legacy setup.
			expect(await driveBeforeAdapter(nativeSetup, 'call-native')).toEqual(
				NATIVE_V1_ARGS,
			);
			expect(await driveBeforeAdapter(legacySetup, 'call-legacy')).toEqual(
				LEGACY_V1_ARGS,
			);
			await legacySetup.cleanup();
			await nativeSetup.cleanup();
		} finally {
			removeTreeWithRetry(directory);
		}
	});

	test('(c) one setup cleanup does not disturb a peer setup dialect on the same directory', async () => {
		const directory = canonicalMkdtemp('swarm-v2-dialect-c-');
		try {
			const first = await startSetup('2.3.1', directory);
			const second = await startSetup('2.3.1', directory);
			expect(second.inputs[0].subagentDialect).toBe('native-2.3');
			// The first setup's cleanup must not flip or unset the second's
			// dialect: the binding is a closed-over immutable value, not registry
			// state. Drive the SECOND setup's adapter after the FIRST cleanup.
			await first.cleanup();
			expect(await driveBeforeAdapter(second, 'call-peer')).toEqual(
				NATIVE_V1_ARGS,
			);
			await second.cleanup();
		} finally {
			removeTreeWithRetry(directory);
		}
	});

	test('(d) createDelegationGateHook with dialect native-2.3 captures a different mode than the default legacy call', async () => {
		const makeConfig = () =>
			({
				max_iterations: 5,
				qa_retry_limit: 3,
				inject_phase_reminders: true,
				hooks: {
					delegation_gate: true,
					delegation_max_chars: 4000,
				},
			}) as never;
		const callToolBefore = async (
			hook: ReturnType<typeof createDelegationGateHook>,
		): Promise<string | null> => {
			try {
				await hook.toolBefore(
					{
						tool: 'Task',
						sessionID: 'dialect-falsifier',
						callID: 'call-dialect',
					},
					{ args: { subagent_type: 'reviewer', background: true } },
				);
				return null;
			} catch (err) {
				return err instanceof Error ? err.message : String(err);
			}
		};
		const dirNative = canonicalMkdtemp('swarm-dialect-native-');
		const dirLegacy = canonicalMkdtemp('swarm-dialect-legacy-');
		try {
			// Native-2.3 dialect: background swarm dispatch names the native
			// tracking contract (captured mode = native async).
			const nativeHook = createDelegationGateHook(
				makeConfig(),
				dirNative,
				undefined,
				{ subagentDialect: 'native-2.3' },
			);
			const nativeMessage = await callToolBefore(nativeHook);
			expect(nativeMessage).toContain(
				'SWARM_V2_NATIVE_ASYNC_REQUIRES_TRACKING',
			);
			// Default (omitted) dialect: the legacy fail-closed block (captured
			// mode = legacy foreground). Omission must NOT inherit the native
			// mode — a hard-coded or dropped binding fails this test.
			const legacyHook = createDelegationGateHook(makeConfig(), dirLegacy);
			const legacyMessage = await callToolBefore(legacyHook);
			expect(legacyMessage).toBe(SWARM_BACKGROUND_TASK_BLOCKED_MESSAGE);
			expect(nativeMessage).not.toBe(legacyMessage);
		} finally {
			removeTreeWithRetry(dirNative);
			removeTreeWithRetry(dirLegacy);
		}
	});
});
