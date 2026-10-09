import { afterEach, describe, expect, test } from 'bun:test';
import {
	applyV2AgentModelOverride,
	clearV2AgentTransformSurface,
	hasV2AgentTransformSurface,
	registerV2AgentTransformSurface,
} from '../../../src/host/v2/model-apply';
import type {
	V2AgentEditor,
	V2PluginContext,
} from '../../../src/host/v2/types';

/**
 * Issue #3151 (8.x port of the 7.x #3022 AC3 suite) — v2 runtime agent-model
 * application.
 *
 * The apply re-invokes the stored `ctx.agent.transform` entry and keys
 * `editor.update` on the EXACT REGISTERED agent name. `update()` is
 * create-or-update: a bare prefix-stripped role on a multi-swarm config would
 * mint a phantom agent — the multi-swarm test below pins the contract
 * (AGENTS.md invariant 11).
 */

interface EditorCall {
	kind: 'update' | 'remove';
	name: string;
	mutate?: (agent: Record<string, unknown>) => void;
}

function fakeCtx(calls: EditorCall[]): V2PluginContext {
	const editor: V2AgentEditor = {
		update: (
			name: string,
			mutate: (agent: Record<string, unknown>) => void,
		) => {
			calls.push({ kind: 'update', name, mutate });
		},
		remove: (name: string) => {
			calls.push({ kind: 'remove', name });
		},
	} as unknown as V2AgentEditor;
	return {
		agent: {
			transform: async (fn: (editor: V2AgentEditor) => void) => {
				fn(editor);
				return { dispose: async () => {} };
			},
		},
	} as unknown as V2PluginContext;
}

afterEach(() => {
	clearV2AgentTransformSurface();
});

describe('#3151 v2 agent model apply', () => {
	test('apply rewrites the model on the exact registered agent name', async () => {
		const calls: EditorCall[] = [];
		registerV2AgentTransformSurface(fakeCtx(calls));
		expect(hasV2AgentTransformSurface()).toBe(true);

		const applied = await applyV2AgentModelOverride(
			'local_coder',
			'opencode/big-pickle',
		);
		expect(applied).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.kind).toBe('update');
		// Multi-swarm prefixed registration key passed through verbatim (never
		// the bare role — update() is create-or-update).
		expect(calls[0]?.name).toBe('local_coder');
		const agent: Record<string, unknown> = {};
		calls[0]?.mutate?.(agent);
		expect(agent.model).toEqual({ providerID: 'opencode', id: 'big-pickle' });
	});

	test('multi-swarm: apply for local_coder updates local_coder and creates nothing', async () => {
		const calls: EditorCall[] = [];
		registerV2AgentTransformSurface(fakeCtx(calls));
		await applyV2AgentModelOverride(
			'local_coder',
			'opencode/mimo-v2.6-flash-free',
		);
		expect(calls.map((c) => c.name)).toEqual(['local_coder']);
		expect(calls.some((c) => c.name === 'coder')).toBe(false);
	});

	test('no registered surface (v1 host) is a non-throwing no-op', async () => {
		expect(hasV2AgentTransformSurface()).toBe(false);
		const applied = await applyV2AgentModelOverride(
			'coder',
			'opencode/big-pickle',
		);
		expect(applied).toBe(false);
	});

	test('malformed model strings are rejected without touching the editor', async () => {
		const calls: EditorCall[] = [];
		registerV2AgentTransformSurface(fakeCtx(calls));
		expect(await applyV2AgentModelOverride('coder', 'no-slash')).toBe(false);
		expect(await applyV2AgentModelOverride('coder', '/leading')).toBe(false);
		expect(await applyV2AgentModelOverride('coder', 'trailing/')).toBe(false);
		expect(await applyV2AgentModelOverride('', 'opencode/big-pickle')).toBe(
			false,
		);
		expect(calls).toHaveLength(0);
	});

	test('clearV2AgentTransformSurface disables the apply', async () => {
		const calls: EditorCall[] = [];
		registerV2AgentTransformSurface(fakeCtx(calls));
		clearV2AgentTransformSurface();
		expect(
			await applyV2AgentModelOverride('coder', 'opencode/big-pickle'),
		).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test('a ctx without the agent domain registers no surface', () => {
		registerV2AgentTransformSurface({} as V2PluginContext);
		expect(hasV2AgentTransformSurface()).toBe(false);
	});
});
