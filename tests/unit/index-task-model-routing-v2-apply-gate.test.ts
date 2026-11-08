/**
 * Issue #3331 — v2 apply-target separation + route swarm-id derivation rows
 * (plan v4 Components 3b and 2b; plan-critic rounds 2-3).
 *
 * The session.error advance arm may resolve the chain from a RAW dispatched
 * name (`code-coder`, or a case variant like `Coder`). The v2 model editor is
 * create-or-update keyed by the EXACT registered name (#3022 contract), so:
 * - a hyphen-form raw name that matches no roster key must produce ZERO v2
 *   editor calls (no phantom agent minted), while the v1 advance itself still
 *   lands (the frozen C1 suite covers the v1 surface);
 * - a case-variant raw name (`Coder`, roster key `coder`) must update ONLY the
 *   registered spelling `coder`, never `Coder`.
 *
 * The v2 apply surface is owner-token-keyed and resolves through the
 * MOST-RECENTLY-REGISTERED owner, so this suite registers its own capturing
 * surface and then drives the REAL plugin boundary (Task dispatch -> child
 * bind -> sticky quota session.error), exactly like the sibling #3331 suite.
 *
 * Route-registration rows (Component 2b): the route's swarmID now comes from
 * the shared guarded derivation — malformed doubled-separator names fail
 * closed to the default swarm (undefined), and case-carrying ids keep their
 * raw case.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import {
	clearV2AgentTransformSurface,
	registerV2AgentTransformSurface,
} from '../../src/host/v2/model-apply';
import type { V2AgentEditor, V2PluginContext } from '../../src/host/v2/types';
import OpenCodeSwarm from '../../src/index';
import {
	getPendingTaskModelRouteSnapshot,
	resetTaskModelRoutingStateForTests,
} from '../../src/models/task-model-routing';
import { resetSwarmState } from '../../src/state';
import { resetTelemetryForTesting } from '../../src/telemetry';
import { canonicalMkdtemp, removeTreeWithRetry } from '../helpers/tmpdir';

const PARENT_SESSION = 'parent-session';
const CHILD_SESSION = 'child-session';
const PRIMARY_MODEL = 'prov/primary';
const FALLBACK_MODEL = 'prov/fb1';

interface EditorCall {
	kind: 'update' | 'remove';
	name: string;
	// PRR-003: capture the applied model via the mutate callback so a
	// wrong-model mutant (primary instead of the advanced fallback) FAILS.
	model?: { providerID: string; id: string };
}

function fakeCtx(calls: EditorCall[]): V2PluginContext {
	const editor: V2AgentEditor = {
		update: (
			name: string,
			mutate?: (agent: Record<string, unknown>) => void,
		) => {
			const captured: Record<string, unknown> = {};
			if (mutate) mutate(captured);
			const model = captured.model as
				| { providerID: string; id: string }
				| undefined;
			calls.push({ kind: 'update', name, model });
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

function makeProject(): string {
	return canonicalMkdtemp('j3331-v2-apply-gate-');
}

function writeAgentsConfig(
	directory: string,
	agents: Record<string, { model: string; fallback_models: string[] }>,
	swarms?: Record<
		string,
		{
			name: string;
			agents: Record<string, { model: string; fallback_models: string[] }>;
		}
	>,
): void {
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			quiet: true,
			version_check: false,
			hooks: { delegation_gate: false },
			agents,
			...(swarms ? { swarms } : {}),
		}),
	);
}

function writePlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Issue 3331 v2 apply gate fixture',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: ['src/index.ts'],
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
}

async function bootPlugin(directory: string) {
	return OpenCodeSwarm.server({
		client: {
			session: {
				get: async () => ({ data: { parentID: undefined }, error: null }),
			},
		} as never,
		project: {} as never,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as never,
	} as never);
}

async function dispatchAndAdvance(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
	callID: string,
	subagentType: string,
): Promise<void> {
	await plugin['chat.message']?.(
		{ sessionID: PARENT_SESSION, agent: 'architect' } as never,
		{} as never,
	);
	await plugin['tool.execute.before']?.(
		{ tool: 'Task', sessionID: PARENT_SESSION, callID } as never,
		{
			args: {
				subagent_type: subagentType,
				prompt: 'TASK: 1.1\nACCEPTANCE: exercise the v2 apply gate',
			},
		} as never,
	);
	await plugin.event?.({
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					sessionID: PARENT_SESSION,
					callID,
					type: 'tool',
					tool: 'task',
					state: { metadata: { sessionId: CHILD_SESSION } },
				},
			},
		},
	});
	// Sticky-eligible quota error so the v2 apply path is exercised (#3029
	// F-002: quota exhaustion is a sticky-appropriate class).
	await plugin.event?.({
		event: {
			type: 'session.error',
			properties: {
				sessionID: CHILD_SESSION,
				error: { message: '429 rate_limit_exceeded: quota exhausted' },
			},
		},
	});
}

describe('index task-model routing — v2 apply gate + route swarm-id derivation (#3331)', () => {
	let directory = '';
	let previousXdg: string | undefined;

	beforeEach(() => {
		directory = makeProject();
		previousXdg = process.env.XDG_CONFIG_HOME;
		// Isolate from any user-level opencode config (deep-merge hazard).
		fs.mkdirSync(path.join(directory, 'xdg-home'), { recursive: true });
		process.env.XDG_CONFIG_HOME = path.join(directory, 'xdg-home');
	});

	afterEach(() => {
		if (previousXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdg;
		}
		clearV2AgentTransformSurface();
		resetSwarmState();
		resetTaskModelRoutingStateForTests();
		resetTelemetryForTesting();
		removeTreeWithRetry(directory);
	});

	test('hyphen-form advance mints no phantom v2 agent (skip, zero editor calls)', async () => {
		writeAgentsConfig(directory, {
			coder: { model: PRIMARY_MODEL, fallback_models: [FALLBACK_MODEL] },
		});
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		const calls: EditorCall[] = [];
		registerV2AgentTransformSurface(fakeCtx(calls));
		await dispatchAndAdvance(plugin, 'call-hyphen', 'code-coder');
		// The raw name matches no roster key: the apply is SKIPPED entirely —
		// create-or-update must never see an unregistered spelling.
		expect(calls.filter((call) => call.kind === 'update')).toEqual([]);
		expect(calls.map((call) => call.name)).not.toContain('code-coder');
	});

	test('no-route advance (primary session, no Task dispatch) applies the same gate', async () => {
		writeAgentsConfig(directory, {
			coder: { model: PRIMARY_MODEL, fallback_models: [FALLBACK_MODEL] },
		});
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		const calls: EditorCall[] = [];
		registerV2AgentTransformSurface(fakeCtx(calls));
		// No Task dispatch: the child's identity comes from the chat boundary's
		// recorded agent only (the no-route arm). Hyphen spelling is
		// unregistered -> skip; case variant resolves the roster key 'coder'.
		await plugin['chat.message']?.(
			{ sessionID: CHILD_SESSION, agent: 'code-coder' } as never,
			{} as never,
		);
		await plugin.event?.({
			event: {
				type: 'session.error',
				properties: {
					sessionID: CHILD_SESSION,
					error: { message: '429 rate_limit_exceeded: quota exhausted' },
				},
			},
		});
		expect(calls.filter((call) => call.kind === 'update')).toEqual([]);
		expect(calls.map((call) => call.name)).not.toContain('code-coder');

		calls.length = 0;
		await plugin['chat.message']?.(
			{ sessionID: 'child-session-2', agent: 'Coder' } as never,
			{} as never,
		);
		await plugin.event?.({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'child-session-2',
					error: { message: '429 rate_limit_exceeded: quota exhausted' },
				},
			},
		});
		const updates = calls.filter((call) => call.kind === 'update');
		expect(updates.length).toBe(1);
		expect(updates[0]?.name).toBe('coder');
		expect(calls.map((call) => call.name)).not.toContain('Coder');
	});

	test('case-variant advance updates only the registered spelling', async () => {
		writeAgentsConfig(directory, {
			coder: { model: PRIMARY_MODEL, fallback_models: [FALLBACK_MODEL] },
		});
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		const calls: EditorCall[] = [];
		registerV2AgentTransformSurface(fakeCtx(calls));
		await dispatchAndAdvance(plugin, 'call-case', 'Coder');
		const updates = calls.filter((call) => call.kind === 'update');
		expect(updates.length).toBe(1);
		expect(updates[0]?.name).toBe('coder');
		// PRR-003: the applied model must be the ADVANCED fallback, not the
		// (already-failing) primary — a wrong-model mutant fails here.
		expect(updates[0]?.model).toEqual({ providerID: 'prov', id: 'fb1' });
		expect(calls.map((call) => call.name)).not.toContain('Coder');
	});

	test('case-colliding roster keys refuse the v2 apply (PRR-001 ambiguity skip)', async () => {
		writeAgentsConfig(
			directory,
			{ coder: { model: PRIMARY_MODEL, fallback_models: [FALLBACK_MODEL] } },
			{
				Case: {
					name: 'Case',
					agents: {
						coder: { model: 'case/model', fallback_models: ['case/fb1'] },
					},
				},
				case: {
					name: 'case',
					agents: {
						coder: { model: 'lower/model', fallback_models: ['lower/fb1'] },
					},
				},
			},
		);
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		const calls: EditorCall[] = [];
		registerV2AgentTransformSurface(fakeCtx(calls));
		await dispatchAndAdvance(plugin, 'call-collide', 'CASE_CODER');
		// 'CASE_CODER' exact-matches nothing but case-insensitively matches BOTH
		// 'Case_coder' and 'case_coder' — the ambiguity skip must refuse the
		// sticky write entirely instead of silently writing whichever key
		// hashed first (executed wrong-target probe at review time).
		expect(calls.filter((call) => call.kind === 'update')).toEqual([]);
		expect(calls.map((call) => call.name)).not.toContain('Case_coder');
		expect(calls.map((call) => call.name)).not.toContain('case_coder');
	});

	test('route swarmID uses the guarded derivation (fail-closed + raw case)', async () => {
		writeAgentsConfig(
			directory,
			{ coder: { model: PRIMARY_MODEL, fallback_models: [FALLBACK_MODEL] } },
			{
				Case: {
					name: 'Case',
					agents: {
						coder: { model: 'case/model', fallback_models: ['case/fb1'] },
					},
				},
			},
		);
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		await plugin['chat.message']?.(
			{ sessionID: PARENT_SESSION, agent: 'architect' } as never,
			{} as never,
		);
		for (const [callID, name] of [
			['call-malformed', 'local__coder'],
			['call-multi', 'mega_local_coder'],
			['call-case', 'Case_coder'],
		] as const) {
			await plugin['tool.execute.before']?.(
				{ tool: 'Task', sessionID: PARENT_SESSION, callID } as never,
				{
					args: {
						subagent_type: name,
						prompt: 'TASK: 1.1\nACCEPTANCE: route swarm-id derivation',
					},
				} as never,
			);
		}
		const snapshot = getPendingTaskModelRouteSnapshot();
		const byCall = new Map(snapshot.map((route) => [route.callID, route]));
		// F-08a: the route must EXIST first — asserting a missing field on an
		// absent route would pass vacuously under a route-drop regression.
		expect(byCall.get('call-malformed')).toBeDefined();
		expect(byCall.get('call-multi')).toBeDefined();
		expect(byCall.get('call-case')).toBeDefined();
		// Doubled separator: derived id contains an underscore -> default swarm.
		expect(byCall.get('call-malformed')?.swarmID).toBeUndefined();
		// Multi-token prefix: same fail-closed direction.
		expect(byCall.get('call-multi')?.swarmID).toBeUndefined();
		// Case-carrying id keeps its raw case.
		expect(byCall.get('call-case')?.swarmID).toBe('Case');
		// The RAW dispatched name is preserved for the advance arm.
		expect(byCall.get('call-case')?.agentName).toBe('Case_coder');
	});
});
