/**
 * Tests for AgentRunContext and getRunContext (Phase 3 — dark foundation).
 *
 * Verifies:
 *   1. swarmState maps are the same objects as defaultRunContext maps (facade equivalence).
 *   2. Distinct AgentRunContext instances do not share per-run maps.
 *   3. toolAggregates is intentionally process-global (shared reference).
 *   4. getRunContext with no arg / unknown runId returns defaultRunContext.
 */

import { describe, expect, test } from 'bun:test';
import { AgentRunContext } from './state/agent-run-context.js';
import { defaultRunContext, getRunContext, swarmState } from './state.js';

describe('AgentRunContext — facade equivalence', () => {
	test('swarmState.activeToolCalls is the same Map as defaultRunContext.activeToolCalls', () => {
		expect(swarmState.activeToolCalls).toBe(defaultRunContext.activeToolCalls);
	});

	test('swarmState.activeAgent is the same Map as defaultRunContext.activeAgent', () => {
		expect(swarmState.activeAgent).toBe(defaultRunContext.activeAgent);
	});

	test('swarmState.delegationChains is the same Map as defaultRunContext.delegationChains', () => {
		expect(swarmState.delegationChains).toBe(
			defaultRunContext.delegationChains,
		);
	});

	test('swarmState.agentSessions is the same Map as defaultRunContext.agentSessions', () => {
		expect(swarmState.agentSessions).toBe(defaultRunContext.agentSessions);
	});

	test('swarmState.environmentProfiles is the same Map as defaultRunContext.environmentProfiles', () => {
		expect(swarmState.environmentProfiles).toBe(
			defaultRunContext.environmentProfiles,
		);
	});

	test('swarmState.toolAggregates is the same Map as defaultRunContext.toolAggregates', () => {
		expect(swarmState.toolAggregates).toBe(defaultRunContext.toolAggregates);
	});

	test('defaultRunContext.runId is "default"', () => {
		expect(defaultRunContext.runId).toBe('default');
	});
});

describe('AgentRunContext — isolation between distinct contexts', () => {
	test('two contexts do not share activeToolCalls', () => {
		const shared = new Map<string, unknown>();
		const a = new AgentRunContext('run-a', shared);
		const b = new AgentRunContext('run-b', shared);
		expect(a.activeToolCalls).not.toBe(b.activeToolCalls);
	});

	test('two contexts do not share agentSessions', () => {
		const shared = new Map<string, unknown>();
		const a = new AgentRunContext('run-a', shared);
		const b = new AgentRunContext('run-b', shared);
		expect(a.agentSessions).not.toBe(b.agentSessions);
	});

	test('mutations in one context do not affect the other', () => {
		const shared = new Map<string, unknown>();
		const a = new AgentRunContext('run-a', shared);
		const b = new AgentRunContext('run-b', shared);
		a.activeAgent.set('s1', 'agent-x');
		expect(b.activeAgent.has('s1')).toBe(false);
	});
});

describe('AgentRunContext — process-global toolAggregates', () => {
	test('toolAggregates is the shared reference passed to the constructor', () => {
		const sharedAgg = new Map<string, unknown>();
		const ctx = new AgentRunContext('run-c', sharedAgg);
		expect(ctx.toolAggregates).toBe(sharedAgg);
	});

	test("two contexts sharing the same toolAggregates Map see each other's entries", () => {
		const shared = new Map<string, unknown>();
		const a = new AgentRunContext('run-d', shared);
		const b = new AgentRunContext('run-e', shared);
		a.toolAggregates.set('tool-x', { count: 5 });
		expect(b.toolAggregates.get('tool-x')).toEqual({ count: 5 });
	});
});

describe('getRunContext', () => {
	test('no argument returns defaultRunContext', () => {
		expect(getRunContext()).toBe(defaultRunContext);
	});

	test('unknown runId returns defaultRunContext', () => {
		expect(getRunContext('nonexistent-run')).toBe(defaultRunContext);
	});

	test('empty string returns defaultRunContext', () => {
		expect(getRunContext('')).toBe(defaultRunContext);
	});
});
