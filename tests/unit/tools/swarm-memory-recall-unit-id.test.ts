import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgentSessionState } from '../../../src/state';
import {
	_internals,
	swarm_memory_recall,
} from '../../../src/tools/swarm-memory-recall';

// ---------------------------------------------------------------------------
// B.1 resolver-seam coverage for swarm_memory_recall.
//
// The join-key CONTRACT (column/filter/round-trip) is proven in
// tests/unit/memory/. This file pins the RESOLVER that feeds unitId onto the
// gateway context in the manual tool — the seam a `?? sessionID` regression
// would slip through. It asserts, via the _internals DI seam (no mock.module,
// isolation-safe), the exact context handed to createMemoryGateway:
//   - a session that owns a currentTaskId → unitId == that task id
//   - unitId is NOT the sessionID (guards the "never default to sessionID" rule)
//   - currentTaskId === null → unitId undefined (null→undefined normalization)
//   - no session state at all → unitId undefined
//   - runId is unchanged (== sessionID) in every case (additive, not replacing)
// ---------------------------------------------------------------------------

type CapturedContext = {
	directory: string;
	sessionID?: string;
	agentRole?: string;
	agentId?: string;
	runId?: string;
	unitId?: string;
};

const originalLoadConfig = _internals.loadPluginConfigWithMeta;
const originalCreateGateway = _internals.createMemoryGateway;
const originalGetAgentSession = _internals.getAgentSession;

let captured: CapturedContext | null;

function fakeGateway() {
	return {
		recall: async () => ({
			id: 'bundle-test',
			query: 'q',
			generatedAt: '2026-01-01T00:00:00.000Z',
			items: [],
			tokenEstimate: 0,
			promptBlock: '',
		}),
		dispose: async () => {},
	} as unknown as ReturnType<typeof originalCreateGateway>;
}

/** Minimal session stub carrying only the field the resolver reads. */
function sessionWith(currentTaskId: string | null): AgentSessionState {
	return { currentTaskId } as unknown as AgentSessionState;
}

beforeEach(() => {
	captured = null;
	// Memory enabled so the tool proceeds to the resolver + gateway.
	_internals.loadPluginConfigWithMeta = (() => ({
		config: { memory: { enabled: true } },
	})) as unknown as typeof originalLoadConfig;
	_internals.createMemoryGateway = ((context: CapturedContext) => {
		captured = context;
		return fakeGateway();
	}) as unknown as typeof originalCreateGateway;
});

afterEach(() => {
	_internals.loadPluginConfigWithMeta = originalLoadConfig;
	_internals.createMemoryGateway = originalCreateGateway;
	_internals.getAgentSession = originalGetAgentSession;
});

async function runTool(sessionID: string | undefined): Promise<void> {
	// createSwarmTool wraps execute as (args, ctx); directory falls back from ctx.
	await (
		swarm_memory_recall as unknown as {
			execute: (
				args: { query: string },
				ctx: { sessionID?: string; directory: string; agent?: string },
			) => Promise<unknown>;
		}
	).execute(
		{ query: 'how do we run tests' },
		{ sessionID, directory: '/tmp/proj', agent: 'coder' },
	);
}

describe('swarm_memory_recall — unitId resolver seam (B.1)', () => {
	test('resolves unitId from the session-owned currentTaskId (and it is not the sessionID)', async () => {
		_internals.getAgentSession = ((id: string) =>
			id === 'sess-A'
				? sessionWith('2.3')
				: undefined) as unknown as typeof originalGetAgentSession;

		await runTool('sess-A');

		expect(captured).not.toBeNull();
		expect(captured?.unitId).toBe('2.3');
		// Regression guard: a `?? sessionID` default would surface 'sess-A' here.
		expect(captured?.unitId).not.toBe('sess-A');
		// Additive: runId still mirrors the session id, unchanged.
		expect(captured?.runId).toBe('sess-A');
	});

	test('currentTaskId === null normalizes to undefined (NULL persists, not "null")', async () => {
		_internals.getAgentSession = (() =>
			sessionWith(null)) as unknown as typeof originalGetAgentSession;

		await runTool('sess-B');

		expect(captured?.unitId).toBeUndefined();
		expect(captured?.runId).toBe('sess-B');
	});

	test('no session state → unitId undefined (never falls back to sessionID)', async () => {
		_internals.getAgentSession = (() =>
			undefined) as unknown as typeof originalGetAgentSession;

		await runTool('sess-C');

		expect(captured?.unitId).toBeUndefined();
		expect(captured?.unitId).not.toBe('sess-C');
		expect(captured?.runId).toBe('sess-C');
	});
});
