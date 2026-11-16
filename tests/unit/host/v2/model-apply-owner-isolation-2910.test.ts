/**
 * #2910 W5 / #3352 implementation-phase control: the REAL apply/dispose
 * isolation across two setup instances, beyond frozen C27's boolean
 * hasV2AgentTransformSurface assertions.
 *
 * Two public openCodeSwarmV2Setup runs (fast fake ctxs whose agent transforms
 * record editor.update calls and registration disposals). A model override
 * applied while instance A is the most-recently-registered owner routes
 * through A's surface; A's cleanup clears ONLY A's surface + held
 * registrations — B's override STILL applies through B's surface afterwards
 * (and vice versa); after both cleanups no surface remains and the apply is
 * a no-op.
 *
 * Fakes only (no mock.module); public setup/cleanup + apply surfaces only.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	applyV2AgentModelOverride,
	clearV2AgentTransformSurface,
	hasV2AgentTransformSurface,
} from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { clearDeferredWarnings } from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

interface EditorUpdate {
	name: string;
	model?: { providerID: string; id: string };
}

interface InstanceRecording {
	updates: EditorUpdate[];
	disposals: number[];
}

/** Fast fake v2 Context whose agent transform records update calls + disposals. */
function makeInstanceCtx(
	directory: string,
	recording: InstanceRecording,
): Record<string, unknown> {
	let counter = 0;
	const nextRegistration = () => {
		counter += 1;
		const id = counter;
		return {
			dispose: async () => {
				recording.disposals.push(id);
			},
		};
	};
	const agentEditor = {
		update: (name: string, mutate: (agent: EditorUpdate) => void) => {
			const record: EditorUpdate = { name };
			mutate(record);
			recording.updates.push(record);
		},
		remove: () => {},
		list: () => [],
	};
	const makeTransform = () => async (fn: (editor: unknown) => void) => {
		fn(agentEditor);
		return nextRegistration();
	};
	return {
		location: { directory },
		agent: { transform: makeTransform(), reload: async () => {} },
		command: {
			transform: async (fn: (e: { add: () => void }) => void) => {
				fn({ add: () => {} });
				return nextRegistration();
			},
			reload: async () => {},
		},
		tool: {
			transform: (fn: (e: { add: () => void }) => void) => {
				fn({ add: () => {} });
				return Promise.resolve(nextRegistration());
			},
			hook: async () => nextRegistration(),
		},
		session: { hook: async () => nextRegistration() },
		event: {},
	};
}

const makeHooks = (): V1HooksSubset =>
	({
		config: (c: Record<string, unknown>) => {
			c.agent = {};
			c.command = {};
		},
		dispose: async () => {},
	}) as unknown as V1HooksSubset;

const tempDirs: string[] = [];

async function runSetup(
	suffix: string,
	recording: InstanceRecording,
): Promise<() => Promise<void>> {
	const dir = canonicalMkdtemp(`v2-mapply-iso-${suffix}-`);
	tempDirs.push(dir);
	return openCodeSwarmV2Setup(makeInstanceCtx(dir, recording) as never, {
		runInit: async () => makeHooks(),
	});
}

afterEach(async () => {
	// Administrative clear-all (legacy form) so a failed assertion cannot
	// leak an owner surface into sibling files.
	clearV2AgentTransformSurface();
	resetSwarmState();
	clearDeferredWarnings();
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('#2910 W5 model-apply apply/dispose isolation across setup instances', () => {
	test("A's cleanup never removes B's live surface: applies route through the live owner afterwards", async () => {
		const a: InstanceRecording = { updates: [], disposals: [] };
		const b: InstanceRecording = { updates: [], disposals: [] };
		// B registers FIRST, then A — A is the most-recently-registered owner,
		// so the first apply routes through A's surface.
		const cleanupB = await runSetup('b', b);
		const cleanupA = await runSetup('a', a);
		expect(hasV2AgentTransformSurface()).toBe(true);

		// Apply through A (the current owner): A's editor sees it, B's does not.
		expect(
			await applyV2AgentModelOverride('local_coder', 'opencode/big-pickle'),
		).toBe(true);
		expect(a.updates.filter((u) => u.name === 'local_coder')).toHaveLength(1);
		expect(b.updates).toHaveLength(0);

		// A's cleanup clears ONLY A's surface + held registrations. B is still
		// live — its surface now owns the apply.
		await cleanupA();
		expect(hasV2AgentTransformSurface()).toBe(true);
		expect(
			await applyV2AgentModelOverride('local_engineer', 'opencode/big-pickle'),
		).toBe(true);
		expect(b.updates.filter((u) => u.name === 'local_engineer')).toHaveLength(
			1,
		);
		// A's editor was never touched again.
		expect(a.updates.filter((u) => u.name === 'local_engineer')).toHaveLength(
			0,
		);

		// Vice versa: B's cleanup removes the last surface — no leak, no-op apply.
		await cleanupB();
		expect(hasV2AgentTransformSurface()).toBe(false);
		expect(
			await applyV2AgentModelOverride('coder', 'opencode/big-pickle'),
		).toBe(false);
		expect(b.updates.filter((u) => u.name === 'coder')).toHaveLength(0);
	}, 30_000);

	test("A's cleanup disposes only A's held apply registration; B's held registrations stay live", async () => {
		const a: InstanceRecording = { updates: [], disposals: [] };
		const b: InstanceRecording = { updates: [], disposals: [] };
		const cleanupB = await runSetup('b2', b);
		const cleanupA = await runSetup('a2', a);

		// Hold one apply registration on EACH owner (A is current).
		expect(
			await applyV2AgentModelOverride('local_coder', 'opencode/big-pickle'),
		).toBe(true);
		await cleanupA();
		// Flip ownership to B by... B is now the only live owner.
		expect(hasV2AgentTransformSurface()).toBe(true);
		expect(
			await applyV2AgentModelOverride('local_qa', 'opencode/big-pickle'),
		).toBe(true);
		const bDisposalsBefore = b.disposals.length;

		// A's cleanup already ran; it disposed A's held registration — and
		// NONE of B's (host dispose is the undo path for a transform's
		// rewrites; disposing B's would revert B's sticky model rewrite, the
		// #3022 regression class).
		await cleanupB();
		expect(b.disposals.length).toBeGreaterThan(bDisposalsBefore);
		expect(hasV2AgentTransformSurface()).toBe(false);
	}, 30_000);
});
