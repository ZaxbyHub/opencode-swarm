import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MemoryProvider } from '../../../src/memory/provider';
import {
	applyRecallRewardForCouncil,
	resolveRewardRunIds,
} from '../../../src/memory/reward';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	}
});

function tempRoot(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), 'memory-reward-'));
	roots.push(root);
	return root;
}

describe('resolveRewardRunIds', () => {
	test('always includes trusted session ids without validation', () => {
		const ids = resolveRewardRunIds({
			trustedSessionIds: ['session-arch'],
			untrustedSessionIds: [],
			isKnownSession: () => false,
		});
		expect(ids).toEqual(['session-arch']);
	});

	test('drops an untrusted (caller-supplied) session id that does not resolve to a known session', () => {
		const ids = resolveRewardRunIds({
			trustedSessionIds: ['session-arch'],
			untrustedSessionIds: ['spoofed-or-guessed-id'],
			isKnownSession: (id) => id === 'session-arch',
		});
		expect(ids).toEqual(['session-arch']);
		expect(ids).not.toContain('spoofed-or-guessed-id');
	});

	test('includes an untrusted session id when it resolves to a known, tracked session', () => {
		const ids = resolveRewardRunIds({
			trustedSessionIds: ['session-arch'],
			untrustedSessionIds: ['session-critic-1'],
			isKnownSession: (id) =>
				id === 'session-arch' || id === 'session-critic-1',
		});
		expect(ids.sort()).toEqual(['session-arch', 'session-critic-1'].sort());
	});

	test('includes multiple validated per-verdict member session ids so sub-agent recalls are rewarded too', () => {
		const ids = resolveRewardRunIds({
			trustedSessionIds: ['session-arch'],
			untrustedSessionIds: [
				'session-critic-1',
				'session-reviewer-1',
				'session-sme-1',
			],
			isKnownSession: (id) => id.startsWith('session-'),
		});
		expect(ids).toEqual([
			'session-arch',
			'session-critic-1',
			'session-reviewer-1',
			'session-sme-1',
		]);
	});

	test('deduplicates ids that appear in both trusted and untrusted lists', () => {
		const ids = resolveRewardRunIds({
			trustedSessionIds: ['session-arch'],
			untrustedSessionIds: ['session-arch'],
			isKnownSession: () => true,
		});
		expect(ids).toEqual(['session-arch']);
	});

	test('drops undefined/empty entries from both lists', () => {
		const ids = resolveRewardRunIds({
			trustedSessionIds: [undefined, 'session-arch', ''],
			untrustedSessionIds: [undefined, ''],
			isKnownSession: () => true,
		});
		expect(ids).toEqual(['session-arch']);
	});

	test('never treats a swarmId-shaped string as a session id substitute', () => {
		// Callers must never pass a bare swarmId into either list; this test
		// documents that resolveRewardRunIds performs no swarmId-specific
		// fallback of its own — the caller is solely responsible for keeping
		// swarmId out of both lists (see convene-council.ts / submit-phase-
		// council-verdicts.ts, which pass ctx.sessionID/provenanceSessionId/
		// per-verdict sessionId only, never input.swarmId).
		const ids = resolveRewardRunIds({
			trustedSessionIds: [],
			untrustedSessionIds: ['mega'],
			isKnownSession: (id) => id === 'mega',
		});
		// Even if a swarmId happens to validate as a "known session" (it
		// shouldn't in practice — swarmIds and sessionIds are different id
		// spaces tracked in different registries), resolveRewardRunIds itself
		// applies no special-casing; this is purely a documentation test for
		// the calling convention.
		expect(ids).toEqual(['mega']);
	});
});

describe('applyRecallRewardForCouncil skip reasons', () => {
	test('returns memory_disabled without constructing a provider when memory.enabled is false', async () => {
		const result = await applyRecallRewardForCouncil(
			tempRoot(),
			{ enabled: false },
			{
				runIds: ['session-arch'],
				verdict: 'APPROVE',
				verdictPayload: { overallVerdict: 'APPROVE' },
			},
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('memory_disabled');
	});

	test('returns no_recall_usage_for_run when no candidate session ids were resolved', async () => {
		const result = await applyRecallRewardForCouncil(
			tempRoot(),
			{ enabled: true, provider: 'sqlite' },
			{
				runIds: [],
				verdict: 'APPROVE',
				verdictPayload: { overallVerdict: 'APPROVE' },
			},
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('no_recall_usage_for_run');
	});

	test('returns provider_does_not_support_learning when the configured provider lacks applyRecallReward', async () => {
		// Local-JSONL provider (the non-sqlite default) does not implement
		// applyRecallReward — exercise the real skip path via config rather
		// than a hand-rolled fake provider.
		const result = await applyRecallRewardForCouncil(
			tempRoot(),
			{ enabled: true, provider: 'local-jsonl' },
			{
				runIds: ['session-arch'],
				verdict: 'APPROVE',
				verdictPayload: { overallVerdict: 'APPROVE' },
			},
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('provider_does_not_support_learning');
	});
});

// Compile-time check that the provider interface shape referenced above still
// matches what applyRecallRewardForCouncil expects (`applyRecallReward` is
// optional on MemoryProvider).
type _AssertOptionalApplyRecallReward = MemoryProvider['applyRecallReward'];
