/**
 * #3351 (PR #3327 follow-up) — the v2 permission bridge must route asks
 * through the documented assert API and fail closed on reply-only hosts.
 *
 * DEFECT (base 8e5cfd387, src/host/v2/tools.ts): `buildPermissionBridge`
 * awaits `permission.reply?.(input)` and DISCARDS the resolved value, so any
 * resolved reply — including a host denial like `{ allow: false }` — is treated
 * as a grant (fail-open on denial). The documented `assert` API is never
 * consulted, and the bridge is not even built for an assert-only host.
 *
 * FIX CONTRACT this file pins on the implementer:
 *
 * 1. ASSERT ROUTING (2.0.29 documented API; absent in the 2.0.26 vendored pin,
 *    so feature-detect with `typeof permission.assert === 'function'`): when
 *    assert is a function, ask() routes through it with EXACTLY
 *
 *      { sessionID, agent, action, resources }
 *
 *    - sessionID/agent come from the v2 ToolContext the tool execute received
 *      (agent as a name — the fake context supplies a bare string);
 *    - action is normalized with the HOST's own v1→v2 action mapping
 *      (sst/opencode v2.0.29 packages/core/src/v1/config/migrate.ts
 *      normalizeAction, captured verbatim at
 *      .agents/issue-traces/2910-v2-dual-host-plugin-port/probe-v2sdk/
 *      migrate-v2.0.29.ts):
 *
 *        write | patch -> edit
 *        task          -> subagent
 *        bash          -> shell
 *        anything else -> VERBATIM (edit stays edit; apply_patch stays
 *          apply_patch; a plugin tool name stays itself — there is NO
 *          'tool' catch-all)
 *
 *    - resources is the ask payload's patterns array (default []);
 *    - assert resolving => ask resolves; assert rejecting => ask rejects;
 *    - when assert is present, reply must NOT be consulted.
 *
 * 2. REPLY-ONLY HOSTS (no assert; the 2.0.26 shape): ANY resolved reply value
 *    => ask REJECTS (fail-closed — NO grant interpretation at all). reply is
 *    the host's answer-side RPC { requestID, reply, message }, not an ask
 *    surface; grant shapes are NOT interpreted pending a live-host observation
 *    recorded on issue #3351. A rejecting reply still rejects (unchanged arm).
 *
 * 3. NO permission domain at all: keep the existing fail-closed throw
 *    containing "denying by default" (regression floor, green both ends).
 *
 * HARNESS: the bridge is built inside `registerV2Tools` (not exposed via
 * _internals at base), so each test drives the real path — register one fake
 * v1 tool whose execute calls the synthesized `ctx.ask(...)` for every payload,
 * then invoke the registered v2 tool execute with a v2 ToolContext. No
 * mock.module; plain object fakes only.
 *
 * BASE EXPECTATIONS: the assert-consulted deny arm (reply NOT called) and the
 * reply-only any-resolution-deny arm are RED at base (base resolves ask after
 * reply resolves); the assert-input normalization arm is RED at base (base
 * builds no bridge for an assert-only host, so ask throws "denying by
 * default"); the assert-resolve grant, rejecting-reply and no-permission arms
 * stay green at base.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { registerV2Tools } from '../../../../src/host/v2/tools';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { clearDeferredWarnings } from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

/** The v1 ask() payload shape the bridge receives (permission name + patterns). */
interface AskPayload {
	permission: string;
	patterns?: string[];
	always?: string[];
	metadata?: Record<string, unknown>;
}

const BASH_ASK: AskPayload = {
	permission: 'bash',
	patterns: ['echo probe'],
	always: [],
	metadata: {},
};

/** v2 ToolContext the host would hand a tool execute (subset the adapter reads). */
function makeV2ToolContext(): Record<string, unknown> {
	return {
		sessionID: 'sess-3351',
		agent: 'architect',
		messageID: 'msg-3351',
		id: 'call-3351',
		signal: new AbortController().signal,
		progress: async () => {},
	};
}

interface RegisteredTool {
	name: string;
	execute: (
		input: unknown,
		context: unknown,
	) => Promise<{ content: unknown; metadata?: unknown }>;
}

interface ProbeHarness {
	/** Fake plugin Context whose tool.transform collects the registered tools. */
	ctx: Record<string, unknown>;
	/** The tools the transform registered. */
	tools: RegisteredTool[];
	/** v1 tool body completions — non-empty means ask() RESOLVED (the defect). */
	completions: string[];
}

const harnessDirs: string[] = [];

function makeHarness(
	permission: Record<string, unknown> | undefined,
	payloads: AskPayload[] = [BASH_ASK],
): Promise<ProbeHarness> {
	const tools: RegisteredTool[] = [];
	const completions: string[] = [];
	const hooks = {
		tool: {
			probe_tool: {
				description: 'calls ctx.ask through the synthesized v1 context',
				execute: async (
					_input: unknown,
					v1ctx: { ask: (input: unknown) => Promise<void> },
				) => {
					// The denial decision lives entirely in ask(): a deny must
					// reject HERE, so the tool body never completes.
					for (const payload of payloads) {
						await v1ctx.ask(payload);
					}
					completions.push('probe-ok');
					return 'probe-ok';
				},
			},
		},
	} as unknown as V1HooksSubset;
	const ctx: Record<string, unknown> = {
		tool: {
			transform: (
				fn: (editor: { add: (info: RegisteredTool) => void }) => void,
			) => {
				fn({
					add: (info) => {
						tools.push(info);
					},
				});
				return Promise.resolve({ dispose: async () => {} });
			},
		},
	};
	if (permission !== undefined) ctx.permission = permission;
	const registrations: Array<{ dispose: () => Promise<void> }> = [];
	const root = canonicalMkdtemp('v2-perm-bridge-3351-');
	harnessDirs.push(root);
	return registerV2Tools(ctx as never, hooks, root, registrations).then(() => ({
		ctx,
		tools,
		completions,
	}));
}

async function registeredTool(h: ProbeHarness): Promise<RegisteredTool> {
	const tool = h.tools.find((t) => t.name === 'probe_tool');
	if (tool === undefined) throw new Error('probe_tool was not registered');
	return tool;
}

afterEach(async () => {
	resetSwarmState();
	clearDeferredWarnings();
	for (const d of harnessDirs.splice(0)) {
		await removeTreeWithRetry(d);
	}
});

describe('#3351 v2 permission bridge fail-closed', () => {
	test('DISCRIMINATOR: assert-capable host denying via assert — ask rejects, assert consulted exactly once with the exact input, reply NOT called (base resolves via reply -> red)', async () => {
		const assertInputs: unknown[] = [];
		const replyInputs: unknown[] = [];
		const h = await makeHarness({
			// reply resolving a DENIAL value must be irrelevant: with assert
			// present the bridge must not consult reply at all.
			reply: async (input: unknown) => {
				replyInputs.push(input);
				return { allow: false };
			},
			assert: async (input: unknown) => {
				assertInputs.push(input);
				throw new Error('permission denied by host (deny rule)');
			},
		});
		const tool = await registeredTool(h);

		await expect(tool.execute({}, makeV2ToolContext())).rejects.toThrow(
			/deny|denied|permission/i,
		);
		// The tool body must NOT have proceeded past a denied ask.
		expect(h.completions).toEqual([]);
		// CONTRACT: assert (the only in-SDK ask signal — resolve on allow,
		// reject on deny) must be consulted exactly once when present; it is
		// absent in the 2.0.26 pin, hence feature-detected.
		expect(assertInputs).toHaveLength(1);
		// THE discriminating assertion at base: the base bridge never calls
		// assert and consults the answer-side reply RPC instead.
		expect(replyInputs).toHaveLength(0);
		// EXACT assert input (deep-equal — no extra or missing fields).
		expect(assertInputs[0]).toEqual({
			sessionID: 'sess-3351',
			agent: 'architect',
			// host normalizeAction: bash -> shell
			action: 'shell',
			resources: ['echo probe'],
		});
	});

	test('assert input normalization: host-exact action mapping and default resources (assert-only host; base builds no bridge -> red)', async () => {
		const assertInputs: unknown[] = [];
		const h = await makeHarness(
			{
				// assert-only host (no reply): assert alone must bridge the ask.
				assert: async (input: unknown) => {
					assertInputs.push(input);
				},
			},
			[
				{ permission: 'write', patterns: ['src/a.ts', 'src/b.ts'] },
				{ permission: 'patch', patterns: ['src/patch.diff'] },
				{ permission: 'task', patterns: ['implementer'] },
				// apply_patch is NOT in the host table — it stays VERBATIM
				// (only write|patch map to edit).
				{ permission: 'apply_patch', patterns: ['src/c.ts'] },
				// Unknown/plugin-tool names pass through verbatim; a missing
				// patterns array defaults resources to [].
				{ permission: 'deploy_prod' },
			],
		);
		const tool = await registeredTool(h);

		const result = await tool.execute({}, makeV2ToolContext());
		expect(result.content).toBe('probe-ok');
		expect(h.completions).toEqual(['probe-ok']);
		expect(assertInputs).toEqual([
			{
				sessionID: 'sess-3351',
				agent: 'architect',
				action: 'edit',
				resources: ['src/a.ts', 'src/b.ts'],
			},
			{
				sessionID: 'sess-3351',
				agent: 'architect',
				action: 'edit',
				resources: ['src/patch.diff'],
			},
			{
				sessionID: 'sess-3351',
				agent: 'architect',
				action: 'subagent',
				resources: ['implementer'],
			},
			{
				sessionID: 'sess-3351',
				agent: 'architect',
				action: 'apply_patch',
				resources: ['src/c.ts'],
			},
			{
				sessionID: 'sess-3351',
				agent: 'architect',
				action: 'deploy_prod',
				resources: [],
			},
		]);
	});

	test('assert resolving grants: ask resolves and the tool completes (green both ends)', async () => {
		// Assert-capable host whose assert RESOLves (allow); reply also present
		// and resolving, so the base bridge (reply passthrough) and the fixed
		// bridge (assert routing) both grant — deliberately NO call-count
		// assertions here; the deny arm above is the discriminating red arm.
		const h = await makeHarness({
			reply: async () => ({ allow: true }),
			assert: async () => {},
		});
		const tool = await registeredTool(h);

		const result = await tool.execute({}, makeV2ToolContext());
		expect(result.content).toBe('probe-ok');
		expect(h.completions).toEqual(['probe-ok']);
	});

	test('reply-only host: ANY resolved reply value denies — grant shapes are not interpreted (base resolves -> red)', async () => {
		// reply is the host's ANSWER-side RPC { requestID, reply, message },
		// not an ask surface; grant shapes are NOT interpreted pending a
		// live-host observation recorded on issue #3351. Even a value that
		// looks like an explicit grant must deny — the bridge may not resolve
		// ask() off a reply resolution at all.
		const h = await makeHarness({
			reply: async () => ({ allow: true }),
		});
		const tool = await registeredTool(h);

		await expect(tool.execute({}, makeV2ToolContext())).rejects.toThrow();
		expect(h.completions).toEqual([]);
	});

	test('reply-only host: a rejecting reply still denies (green both ends)', async () => {
		// A host that refuses the bridged payload shape must surface as an
		// ask() rejection — denial, never a silent grant.
		const h = await makeHarness({
			reply: async () => {
				throw new Error('reply rejected the payload shape');
			},
		});
		const tool = await registeredTool(h);

		await expect(tool.execute({}, makeV2ToolContext())).rejects.toThrow();
		expect(h.completions).toEqual([]);
	});

	test('no permission surface on the host fails closed with the denial message (green both ends)', async () => {
		// No permission domain at all: buildPermissionBridge returns undefined
		// and ask() throws the fail-closed denial (already correct at base —
		// #3351 out-of-scope path, pinned as a regression floor).
		const h = await makeHarness(undefined);
		const tool = await registeredTool(h);

		await expect(tool.execute({}, makeV2ToolContext())).rejects.toThrow(
			/denying by default/,
		);
		expect(h.completions).toEqual([]);
	});
});
