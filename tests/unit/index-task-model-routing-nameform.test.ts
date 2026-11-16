/**
 * Issue #3331 (trace 3331-underscore-derivation-class, AC1+AC2) — the two
 * boundary sides of the Task model-fallback state machine resolve their agent
 * identity through DIFFERENT name forms: the route stores the STRIPPED role
 * (stripKnownSwarmPrefix at registration) and session.error's routed arm
 * resolves the chain from `route.role`, while the chat boundary resolves the
 * chain from the FULL `String(input.agent)`. When the child's chat.message
 * carries an agent name whose spelling resolves a different primary than the
 * stripped route role (hyphen form `code-coder` vs roster key `coder`), the
 * two normalizeModelChain signatures disagree, `resolveScopedModelSelection`
 * reseeds (generation+1, fallbackIndex 0), and the completed advance is
 * silently discarded. RED at base, GREEN after the fix.
 *
 * Mirrors the integration-harness shape of
 * tests/unit/index-task-model-routing-underscore-agents.test.ts (real plugin
 * boundary via plugin['chat.message'] / plugin.event / plugin['tool.execute.before'],
 * canonicalMkdtemp projects, .opencode/opencode-swarm.json fixtures, state
 * resets in afterEach).
 *
 * Test roles (plan-critic-labeled):
 * - 'nameform-mismatch keeps the advanced fallback' is THE DISCRIMINATING
 *   AC1 net — at base the chat-side chain (primary undefined for `code-coder`)
 *   has a different signature than the advance-side chain (roster `coder` →
 *   prov/primary), so the advance is discarded and output.message.model is
 *   never set. RED at base, GREEN after the fix.
 * - 'nameform discard is never silent' is the AC2 net — the AC is conditional
 *   ("IF an advance is discarded ... THEN emit a diagnostic"), so the
 *   assertion is the exact negation of "silently reverting": EITHER the
 *   advanced fallback was applied at the chat boundary (no revert happened)
 *   OR an observable diagnostic (console line or telemetry record) mentions
 *   the discard/reseed semantics. At base neither holds (probe A verified the
 *   discard is silent), so the assertion fails — RED at base, GREEN after
 *   the fix.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import { _internals as severeInternals } from '../../src/full-auto/severe-result';
import OpenCodeSwarm from '../../src/index';
import { resetTaskModelRoutingStateForTests } from '../../src/models/task-model-routing';
import { resetSwarmState } from '../../src/state';
import {
	addTelemetryListener,
	removeTelemetryListener,
	resetTelemetryForTesting,
	type TelemetryListener,
} from '../../src/telemetry';
import { canonicalMkdtemp, removeTreeWithRetry } from '../helpers/tmpdir';

const PARENT_SESSION = 'parent-session';
const CHILD_SESSION = 'child-session';

/**
 * The roster key for the dispatched agent. The child session later identifies
 * itself with the hyphen spelling `code-coder`, which stripKnownSwarmPrefix
 * resolves to the same canonical role `coder` but which matches NO roster
 * name — exactly the resolution asymmetry #3331 describes (advance side:
 * prov/primary; chat side: undefined primary).
 */
const ROSTER_AGENT = 'coder';
/** The chat-boundary spelling of the same agent (resolves a different primary). */
const CHAT_AGENT_NAMEFORM = 'code-coder';
const PRIMARY_MODEL = 'prov/primary';
const FALLBACK_MODEL = 'prov/fb1';

function makeProject(): string {
	return canonicalMkdtemp('j3331-nameform-routing-');
}

function writeAgentsConfig(
	directory: string,
	agents: PluginConfigAgents,
): void {
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			quiet: true,
			version_check: false,
			hooks: { delegation_gate: false },
			agents,
		}),
	);
}

type PluginConfigAgents = Record<
	string,
	{ model: string; fallback_models: string[] }
>;

function writePlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Issue 3331 nameform fixture',
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
				get: async ({ path }: { path: { id: string } }) => ({
					data: { parentID: undefined },
					error: null,
				}),
			},
		} as never,
		project: {} as never,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as never,
	});
}

async function dispatchAgentTask(
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
				prompt: 'TASK: 1.1\nACCEPTANCE: exercise nameform fallback wiring',
			},
		} as never,
	);
}

async function bindChild(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
	callID: string,
): Promise<void> {
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
}

async function fireRetryable429(
	plugin: Awaited<ReturnType<typeof bootPlugin>>,
): Promise<void> {
	await plugin.event?.({
		event: {
			type: 'session.error',
			properties: {
				sessionID: CHILD_SESSION,
				error: { message: '429 rate_limit_exceeded: too many requests' },
			},
		},
	});
}

/**
 * Diagnostic keywords a discard notice may legitimately use. Deliberately
 * narrow: base emits NO line or telemetry record matching this (the discard
 * is silent — probe A), so a match is a real observable, and the generic
 * DEBUG_SWARM `[DIAG]` lines / telemetry event names in this flow
 * (delegation begin/end, heartbeat) cannot match it.
 */
const DISCARD_DIAGNOSTIC =
	/discard|reseed|reseeding|signature|chain[- ]identity|stale advance|advance.*(dropped|lost|reset)/i;

describe('index task-model routing — chat/advance nameform asymmetry (issue #3331)', () => {
	let directory = '';
	let configDirectory = '';
	let previousXdgConfigHome: string | undefined;
	let previousDebugSwarm: string | undefined;
	let previousOpendebugSwarm: string | undefined;
	let consoleErrorSpy: ReturnType<typeof spyOn>;
	let consoleWarnSpy: ReturnType<typeof spyOn>;
	let consoleLogSpy: ReturnType<typeof spyOn>;
	let telemetryRecords: string[];
	let telemetryListener: TelemetryListener;

	beforeEach(() => {
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
		previousDebugSwarm = process.env.DEBUG_SWARM;
		previousOpendebugSwarm = process.env.OPENCODE_SWARM_DEBUG;
		// Pin BOTH debug gates so a debug-gated diagnostic (console-direct or
		// the src/utils/logger logger, whose log/warn are OPENCODE_SWARM_DEBUG
		// gated and error/criticalWarn unconditional) is observable.
		process.env.DEBUG_SWARM = '1';
		process.env.OPENCODE_SWARM_DEBUG = '1';
		configDirectory = makeProject();
		process.env.XDG_CONFIG_HOME = configDirectory;
		resetSwarmState();
		resetTaskModelRoutingStateForTests();
		directory = makeProject();
		telemetryRecords = [];
		telemetryListener = (event, data) => {
			telemetryRecords.push(`${event} ${JSON.stringify(data)}`);
		};
		addTelemetryListener(telemetryListener);
		consoleErrorSpy = spyOn(console, 'error');
		consoleWarnSpy = spyOn(console, 'warn');
		consoleLogSpy = spyOn(console, 'log');
	});

	afterEach(() => {
		if (previousXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		}
		if (previousDebugSwarm === undefined) {
			delete process.env.DEBUG_SWARM;
		} else {
			process.env.DEBUG_SWARM = previousDebugSwarm;
		}
		if (previousOpendebugSwarm === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = previousOpendebugSwarm;
		}
		removeTelemetryListener(telemetryListener);
		consoleErrorSpy.mockRestore();
		consoleWarnSpy.mockRestore();
		consoleLogSpy.mockRestore();
		resetSwarmState();
		resetTaskModelRoutingStateForTests();
		resetTelemetryForTesting();
		severeInternals.pendingCorrelations.clear();
		severeInternals.evidenceEvents.clear();
		severeInternals.childBindings.clear();
		// FB-008 (mirrored from the sibling suite): removeTreeWithRetry is not
		// exception-safe by design — one throw skips the second cleanup and
		// surfaces visibly rather than leaking silently.
		removeTreeWithRetry(directory);
		removeTreeWithRetry(configDirectory);
	});

	test('advance survives when the chat-boundary name form resolves a different primary (AC1)', async () => {
		writeAgentsConfig(directory, {
			[ROSTER_AGENT]: {
				model: PRIMARY_MODEL,
				fallback_models: [FALLBACK_MODEL],
			},
		});
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		await dispatchAgentTask(plugin, 'call-nameform', CHAT_AGENT_NAMEFORM);
		await bindChild(plugin, 'call-nameform');
		// The routed arm resolves the chain from the stripped route role
		// (`coder` — a roster match) because the child session has no recorded
		// identity yet, so this retryable failure must be ACCEPTED and land on
		// the first fallback.
		await fireRetryable429(plugin);

		// At base the chat boundary re-resolves the chain from the FULL name
		// `code-coder` (primary undefined — no roster match), the signatures
		// disagree, the scoped selection reseeds at fallbackIndex 0, and the
		// model override below is never applied. The rewrite is the
		// non-exhausted proof, exactly as in the sibling suite: an override
		// resolution is the only status that rewrites output.message.model.
		const output = {
			message: {} as { model?: { providerID: string; modelID: string } },
		};
		await plugin['chat.message']?.(
			{ sessionID: CHILD_SESSION, agent: CHAT_AGENT_NAMEFORM } as never,
			output as never,
		);
		expect(output.message.model).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
	});

	test('a nameform discard is never silent (AC2)', async () => {
		writeAgentsConfig(directory, {
			[ROSTER_AGENT]: {
				model: PRIMARY_MODEL,
				fallback_models: [FALLBACK_MODEL],
			},
		});
		writePlan(directory);
		const plugin = await bootPlugin(directory);
		await dispatchAgentTask(plugin, 'call-silent', CHAT_AGENT_NAMEFORM);
		await bindChild(plugin, 'call-silent');
		telemetryRecords.length = 0;
		consoleErrorSpy.mockClear();
		consoleWarnSpy.mockClear();
		consoleLogSpy.mockClear();
		await fireRetryable429(plugin);

		const output = {
			message: {} as { model?: { providerID: string; modelID: string } },
		};
		await plugin['chat.message']?.(
			{ sessionID: CHILD_SESSION, agent: CHAT_AGENT_NAMEFORM } as never,
			output as never,
		);

		// Arm 1 — the advance was preserved (no revert happened): the chat
		// boundary applied the advanced fallback model.
		const applied =
			output.message.model?.providerID === 'prov' &&
			output.message.model?.modelID === 'fb1';
		// Arm 2 — a discard happened but was OBSERVED: some console line
		// (console-direct or the logger, both debug-pinned above) or telemetry
		// record mentions the discard/reseed semantics.
		const consoleText = [
			...consoleErrorSpy.mock.calls,
			...consoleWarnSpy.mock.calls,
			...consoleLogSpy.mock.calls,
		]
			.map((call) => call.map((part) => String(part)).join(' '))
			.join('\n');
		const diagnosticSeen =
			DISCARD_DIAGNOSTIC.test(consoleText) ||
			DISCARD_DIAGNOSTIC.test(telemetryRecords.join('\n'));

		// The AC's exact negation: the system may not SILENTLY revert to the
		// primary. At base the advance is discarded with no diagnostic
		// (probe A: "after-chat fallbackIndex=0 ... no diagnostic"), so both
		// arms are false and this fails. RED at base, GREEN after the fix.
		expect(applied || diagnosticSeen).toBe(true);
	});
});
