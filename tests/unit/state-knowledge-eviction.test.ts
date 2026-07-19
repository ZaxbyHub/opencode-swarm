/**
 * AGENTS.md invariant #8: module-level global state must have an explicit
 * eviction strategy. The v2 knowledge state (currentCriticalShownIds Map,
 * knowledgeAckDedup Set, and gateDenialCounts Map) is unbounded by default;
 * setCriticalShownIds, addKnowledgeAckDedup, and incrementGateDenialCount
 * wrap insertion with FIFO caps.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	addKnowledgeAckDedup,
	buildGateDenialDirectiveKey,
	clearCriticalShownIds,
	clearGateDenialCount,
	incrementGateDenialCount,
	MAX_TRACKED_CRITICAL_SHOWN,
	MAX_TRACKED_GATE_DENIALS,
	MAX_TRACKED_KNOWLEDGE_ACKS,
	resetSwarmState,
	setCriticalShownIds,
	swarmState,
} from '../../src/state';

beforeEach(() => {
	resetSwarmState();
});
afterEach(() => {
	resetSwarmState();
});

describe('setCriticalShownIds — FIFO cap', () => {
	it('caps the map at MAX_TRACKED_CRITICAL_SHOWN entries', () => {
		// Insert MAX + 5 distinct sessions
		const total = MAX_TRACKED_CRITICAL_SHOWN + 5;
		for (let i = 0; i < total; i++) {
			setCriticalShownIds(`session-${i}`, {
				ids: [`id-${i}`],
				generatedAt: i,
			});
		}
		expect(swarmState.currentCriticalShownIds.size).toBe(
			MAX_TRACKED_CRITICAL_SHOWN,
		);
		// Oldest 5 evicted
		expect(swarmState.currentCriticalShownIds.has('session-0')).toBe(false);
		expect(swarmState.currentCriticalShownIds.has('session-4')).toBe(false);
		expect(swarmState.currentCriticalShownIds.has('session-5')).toBe(true);
		expect(swarmState.currentCriticalShownIds.has(`session-${total - 1}`)).toBe(
			true,
		);
	});

	it('refresh on existing key keeps cap and re-inserts as newest', () => {
		// Fill to MAX
		for (let i = 0; i < MAX_TRACKED_CRITICAL_SHOWN; i++) {
			setCriticalShownIds(`s-${i}`, { ids: [`id-${i}`], generatedAt: i });
		}
		expect(swarmState.currentCriticalShownIds.size).toBe(
			MAX_TRACKED_CRITICAL_SHOWN,
		);
		// Refresh oldest — does not push size over the cap, and oldest remains tracked
		setCriticalShownIds('s-0', { ids: ['id-refreshed'], generatedAt: 9999 });
		expect(swarmState.currentCriticalShownIds.size).toBe(
			MAX_TRACKED_CRITICAL_SHOWN,
		);
		expect(swarmState.currentCriticalShownIds.get('s-0')?.ids).toEqual([
			'id-refreshed',
		]);
		// Now the new oldest is s-1; one more insertion evicts it (not s-0)
		setCriticalShownIds('s-new', { ids: ['x'], generatedAt: 10000 });
		expect(swarmState.currentCriticalShownIds.has('s-1')).toBe(false);
		expect(swarmState.currentCriticalShownIds.has('s-0')).toBe(true);
	});
});

describe('clearCriticalShownIds', () => {
	it('removes an entry and reports the prior presence', () => {
		setCriticalShownIds('s-x', { ids: ['1'], generatedAt: 1 });
		expect(clearCriticalShownIds('s-x')).toBe(true);
		expect(swarmState.currentCriticalShownIds.has('s-x')).toBe(false);
		expect(clearCriticalShownIds('s-x')).toBe(false);
	});

	it('does not break the cap when interleaved with set+clear', () => {
		// Fill to MAX
		for (let i = 0; i < MAX_TRACKED_CRITICAL_SHOWN; i++) {
			setCriticalShownIds(`s-${i}`, { ids: [`id-${i}`], generatedAt: i });
		}
		// Clear half via the helper
		for (let i = 0; i < 100; i++) clearCriticalShownIds(`s-${i}`);
		expect(swarmState.currentCriticalShownIds.size).toBe(
			MAX_TRACKED_CRITICAL_SHOWN - 100,
		);
		// Re-fill — we should never exceed the cap
		for (let i = 0; i < 200; i++) {
			setCriticalShownIds(`new-${i}`, { ids: [`id-${i}`], generatedAt: i });
		}
		expect(swarmState.currentCriticalShownIds.size).toBeLessThanOrEqual(
			MAX_TRACKED_CRITICAL_SHOWN,
		);
	});
});

describe('addKnowledgeAckDedup — FIFO cap', () => {
	it('caps the set at MAX_TRACKED_KNOWLEDGE_ACKS entries', () => {
		const total = MAX_TRACKED_KNOWLEDGE_ACKS + 10;
		for (let i = 0; i < total; i++) {
			addKnowledgeAckDedup(`ack-${i}`);
		}
		expect(swarmState.knowledgeAckDedup.size).toBe(MAX_TRACKED_KNOWLEDGE_ACKS);
		// Oldest 10 evicted
		expect(swarmState.knowledgeAckDedup.has('ack-0')).toBe(false);
		expect(swarmState.knowledgeAckDedup.has('ack-9')).toBe(false);
		expect(swarmState.knowledgeAckDedup.has('ack-10')).toBe(true);
		expect(swarmState.knowledgeAckDedup.has(`ack-${total - 1}`)).toBe(true);
	});

	it('duplicate ack keys are no-ops (preserves dedup semantics)', () => {
		addKnowledgeAckDedup('ack-x');
		addKnowledgeAckDedup('ack-x');
		addKnowledgeAckDedup('ack-x');
		expect(swarmState.knowledgeAckDedup.size).toBe(1);
	});
});

describe('incrementGateDenialCount/clearGateDenialCount — FIFO cap', () => {
	const key = buildGateDenialDirectiveKey(['dir-a']);

	it('caps the map at MAX_TRACKED_GATE_DENIALS entries', () => {
		const total = MAX_TRACKED_GATE_DENIALS + 5;
		for (let i = 0; i < total; i++) {
			incrementGateDenialCount(`session-${i}`, key);
		}
		expect(swarmState.gateDenialCounts.size).toBe(MAX_TRACKED_GATE_DENIALS);
		// Oldest 5 evicted
		expect(swarmState.gateDenialCounts.has('session-0')).toBe(false);
		expect(swarmState.gateDenialCounts.has('session-4')).toBe(false);
		expect(swarmState.gateDenialCounts.has('session-5')).toBe(true);
		expect(swarmState.gateDenialCounts.has(`session-${total - 1}`)).toBe(true);
	});

	it('refresh on existing key keeps cap and re-inserts as newest', () => {
		for (let i = 0; i < MAX_TRACKED_GATE_DENIALS; i++) {
			incrementGateDenialCount(`g-${i}`, key);
		}
		expect(swarmState.gateDenialCounts.size).toBe(MAX_TRACKED_GATE_DENIALS);
		// Refresh oldest — does not push size over the cap, and oldest remains tracked
		incrementGateDenialCount('g-0', key);
		expect(swarmState.gateDenialCounts.size).toBe(MAX_TRACKED_GATE_DENIALS);
		expect(swarmState.gateDenialCounts.get('g-0')?.count).toBe(2);
		// Now the new oldest is g-1; one more insertion evicts it (not g-0)
		incrementGateDenialCount('g-new', key);
		expect(swarmState.gateDenialCounts.has('g-1')).toBe(false);
		expect(swarmState.gateDenialCounts.has('g-0')).toBe(true);
	});

	it('a mismatched directiveKey restarts the count at 1 instead of accumulating', () => {
		incrementGateDenialCount('s1', key);
		incrementGateDenialCount('s1', key);
		expect(incrementGateDenialCount('s1', key)).toBe(3);

		const otherKey = buildGateDenialDirectiveKey(['dir-b']);
		expect(incrementGateDenialCount('s1', otherKey)).toBe(1);
	});

	it('clearGateDenialCount removes an entry', () => {
		incrementGateDenialCount('s-clear', key);
		expect(swarmState.gateDenialCounts.has('s-clear')).toBe(true);
		clearGateDenialCount('s-clear');
		expect(swarmState.gateDenialCounts.has('s-clear')).toBe(false);
	});

	it('does not break the cap when interleaved with increment+clear', () => {
		for (let i = 0; i < MAX_TRACKED_GATE_DENIALS; i++) {
			incrementGateDenialCount(`d-${i}`, key);
		}
		for (let i = 0; i < 100; i++) clearGateDenialCount(`d-${i}`);
		expect(swarmState.gateDenialCounts.size).toBe(
			MAX_TRACKED_GATE_DENIALS - 100,
		);
		for (let i = 0; i < 200; i++) {
			incrementGateDenialCount(`d-new-${i}`, key);
		}
		expect(swarmState.gateDenialCounts.size).toBeLessThanOrEqual(
			MAX_TRACKED_GATE_DENIALS,
		);
	});

	it('resetSwarmState clears the gate denial counter map', () => {
		incrementGateDenialCount('s-reset', key);
		expect(swarmState.gateDenialCounts.size).toBeGreaterThan(0);
		resetSwarmState();
		expect(swarmState.gateDenialCounts.size).toBe(0);
	});
});

describe('buildGateDenialDirectiveKey', () => {
	it('is order-independent (same id set, different order, same key)', () => {
		expect(buildGateDenialDirectiveKey(['b', 'a'])).toBe(
			buildGateDenialDirectiveKey(['a', 'b']),
		);
	});

	it('distinguishes different id sets', () => {
		expect(buildGateDenialDirectiveKey(['a'])).not.toBe(
			buildGateDenialDirectiveKey(['b']),
		);
	});
});
