import { describe, expect, test } from 'bun:test';
import { DEFAULT_MEMORY_CONFIG, MemoryGateway } from '../../../src/memory';
import { deriveDecision } from '../../../src/memory/consolidation';
import { _test_exports } from '../../../src/memory/injector';
import { buildRecallPromptBlock } from '../../../src/memory/prompt-block';
import {
	createBundleId,
	validateMemoryRecordRules,
} from '../../../src/memory/schema';
import {
	MEMORY_RECALL_SENTINEL,
	RECALL_BUNDLE_MARKER_RE,
} from '../../../src/memory/sentinel';
import type { MemoryRecord } from '../../../src/memory/types';

const { messagesContainRecall } = _test_exports as {
	messagesContainRecall: (messages: unknown[]) => boolean;
};

function part(text: string): unknown[] {
	return [{ role: 'user', parts: [{ type: 'text', text }] }];
}

describe('sentinel bundle anchoring (#1466 DD-14)', () => {
	test('a real bundle marker is detected', () => {
		const id = createBundleId('query', '2026-08-22T10:11:12.000Z');
		expect(id).toMatch(/^bundle_\d{14}_[0-9a-f]{8}$/);
		expect(messagesContainRecall(part(`Swarm-Recall-Bundle: ${id}`))).toBe(
			true,
		);
	});

	test('injected prompt blocks embed the bundle marker line', () => {
		const id = createBundleId('q', '2026-08-22T10:11:12.000Z');
		const { promptBlock } = buildRecallPromptBlock(
			[],
			1000,
			'2026-08-22T10:11:12.000Z',
			id,
		);
		expect(promptBlock).toContain(`Swarm-Recall-Bundle: ${id}`);
		expect(messagesContainRecall(part(promptBlock))).toBe(true);
	});

	test('the DD-14 forge is closed: bare short-substring text no longer suppresses recall', () => {
		// Pre-#1466 this returned true and silently skipped recall injection.
		expect(
			messagesContainRecall(
				part('We discussed Retrieved Swarm Memory in standup'),
			),
		).toBe(false);
	});

	test('the full sentinel header (legacy format) is still detected', () => {
		expect(
			messagesContainRecall(part(`${MEMORY_RECALL_SENTINEL}\nsome items`)),
		).toBe(true);
	});

	test('random text is not detected', () => {
		expect(messagesContainRecall(part('ordinary memory about the build'))).toBe(
			false,
		);
	});

	test('marker regex pins the exact createBundleId shape', () => {
		expect(RECALL_BUNDLE_MARKER_RE.test('bundle_20260822101112_deadbeef')).toBe(
			true,
		);
		expect(RECALL_BUNDLE_MARKER_RE.test('bundle_2026_deadbeef')).toBe(false);
		expect(RECALL_BUNDLE_MARKER_RE.test('bundle_20260822101112_DEADBEEF')).toBe(
			false,
		);
		expect(
			RECALL_BUNDLE_MARKER_RE.test('bundle_20260822101112_deadbeefx'),
		).toBe(false);
	});
});

describe('bundle_ write-time ban (#1466 DD-14)', () => {
	function durableRecord(text: string): MemoryRecord {
		// createRecord computes consistent id/hash; we then swap the text so
		// the bundle_ ban (checked BEFORE hash validation) is what fires.
		const gateway = new MemoryGateway(
			{ directory: '.' },
			{
				config: {
					...DEFAULT_MEMORY_CONFIG,
					enabled: true,
					provider: 'local-jsonl',
				},
				now: () => new Date('2026-08-22T10:00:00.000Z'),
			},
		);
		const record = gateway.createRecord({
			kind: 'repo_convention',
			text: 'placeholder text',
			source: { type: 'file', filePath: 'README.md' },
		});
		return { ...record, text };
	}

	test('memory text containing a bundle-shaped marker is rejected at the funnel', () => {
		expect(() =>
			validateMemoryRecordRules(
				durableRecord('see bundle_20260822101112_deadbeef for context'),
				{
					rejectDurableSecrets: false,
				},
			),
		).toThrow('recall bundle marker prefix');
	});

	test('memory text containing the bare bundle_ prefix is rejected (issue requirement)', () => {
		expect(() =>
			validateMemoryRecordRules(durableRecord('a bundle_ prefix mention'), {
				rejectDurableSecrets: false,
			}),
		).toThrow('recall bundle marker prefix');
	});

	test('the sentinel header ban still applies', () => {
		expect(() =>
			validateMemoryRecordRules(
				durableRecord(`${MEMORY_RECALL_SENTINEL} injected?`),
				{
					rejectDurableSecrets: false,
				},
			),
		).toThrow('recall sentinel header');
	});

	test('curator decisions skip facts containing bundle_ (lockstep with the write ban)', () => {
		const plan = deriveDecision(
			{
				id: 'f1',
				kind: 'code_pattern',
				text: 'fact mentioning bundle_20260822101112_deadbeef',
				confidence: 0.9,
				source: { type: 'file', filePath: 'a.ts' },
			},
			[],
			{ autoApplyMinConfidence: 0.5, jaccardThreshold: 0.8 },
		);
		expect(plan.type).toBe('skip');
		expect(plan.reason).toContain('bundle marker');
	});
});
