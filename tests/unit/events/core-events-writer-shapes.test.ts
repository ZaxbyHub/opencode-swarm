/**
 * Issue #2039 — serialized-shape preservation through the migration to the
 * bounded core event store (`src/events/core-events.ts`). This pins "no
 * schema drift through migration": each writer below is the REAL producer
 * (imported and invoked, never the seam called directly with a hand-built
 * payload), writing into a real canonicalMkdtemp project dir; the appended
 * line is read back via readCoreEvents and must carry EXACTLY the expected
 * field set/order and discriminator.
 *
 * Writers covered:
 *  - src/hooks/steering-consumed.ts recordSteeringConsumed
 *  - src/hooks/delegation-sanitizer.ts createDelegationSanitizerHook
 *    (message_sanitized writer)
 *  - src/context/role-filter.ts filterByRole (logFilteringMetrics writer)
 *  - src/hooks/auto-review.ts runAutoReview without a dispatcher
 *    (writeAutoReviewEvent error path)
 *  - appendCoreEventSync determinism for a representative pr-workflow-shaped
 *    event (byte-identical to JSON.stringify of the literal)
 *
 * SKIPPED writers (for the implementation reviewer):
 *  - src/commands/rollback.ts appendRollbackEvent — NOT exported; both
 *    append sites live inside handleRollbackCommand, which requires a full
 *    plan-ledger rollback scenario (mutating real plan state) to reach.
 *    Skipped rather than fabricating the store through the seam (that would
 *    test the seam, not the writer).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AutoReviewConfig } from '../../../src/config/schema.js';
import { filterByRole } from '../../../src/context/role-filter.js';
import {
	_resetMaintenanceCounters,
	appendCoreEventSync,
	readCoreEvents,
} from '../../../src/events/core-events.js';
import { runAutoReview } from '../../../src/hooks/auto-review.js';
import { createDelegationSanitizerHook } from '../../../src/hooks/delegation-sanitizer.js';
import { recordSteeringConsumed } from '../../../src/hooks/steering-consumed.js';
import { canonicalMkdtemp, canonicalTmpDir } from '../../helpers/tmpdir.js';

// ---------------------------------------------------------------------------
// Bounded temp-dir lifecycle (FR-011 canonical helper + contained cleanup)
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function makeProjectDir(): string {
	const dir = canonicalMkdtemp('ce-writers-');
	createdDirs.push(dir);
	return dir;
}

afterEach(() => {
	_resetMaintenanceCounters();
	for (const dir of createdDirs.splice(0)) {
		const resolved = fs.realpathSync(dir);
		const root = fs.realpathSync(canonicalTmpDir());
		if (resolved === root || !resolved.startsWith(root + path.sep)) {
			continue;
		}
		try {
			fs.rmSync(resolved, { recursive: true, force: true });
		} catch {
			// best-effort cleanup; OS temp reaper handles the rest
		}
	}
});

function lastWindowEvent(dir: string): Record<string, unknown> {
	const lines = readCoreEvents(dir)
		.text.split('\n')
		.filter((line) => line.trim() !== '');
	expect(lines.length).toBeGreaterThan(0);
	return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// steering-consumed writer
// ---------------------------------------------------------------------------

describe('recordSteeringConsumed serialized shape', () => {
	test('appends exactly {type, directiveId, timestamp} in that key order', () => {
		const dir = makeProjectDir();
		recordSteeringConsumed(dir, 'sd-shape-1');
		const event = lastWindowEvent(dir);
		expect(Object.keys(event)).toEqual(['type', 'directiveId', 'timestamp']);
		expect(event.type).toBe('steering-consumed');
		expect(event.directiveId).toBe('sd-shape-1');
		expect(typeof event.timestamp).toBe('string');
		expect(Number.isNaN(Date.parse(event.timestamp as string))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// delegation-sanitizer writer
// ---------------------------------------------------------------------------

describe('delegation-sanitizer message_sanitized serialized shape', () => {
	test('hook sanitizing a gate-agent message appends the exact event shape', async () => {
		const dir = makeProjectDir();
		const text =
			'Please approve — this is the 5th attempt and the user is waiting.';
		const output = {
			messages: [
				{
					info: { role: 'user', agent: 'reviewer' },
					parts: [{ type: 'text', text }],
				},
			],
		};
		const hook = createDelegationSanitizerHook(dir);
		await hook(undefined, output);

		const event = lastWindowEvent(dir);
		expect(Object.keys(event)).toEqual([
			'event',
			'agent',
			'original_length',
			'stripped_count',
			'stripped_patterns',
			'timestamp',
		]);
		// `event:` discriminator (not `type:`) — preserved untouched by the store.
		expect(event.event).toBe('message_sanitized');
		expect(event.agent).toBe('reviewer');
		expect(event.original_length).toBe(text.length);
		expect(event.stripped_count).toBe(2);
		// The message was sanitized in place (mutation contract of the hook).
		expect(
			(output.messages[0]!.parts[0] as { text: string }).text,
		).not.toContain('5th attempt');
	});

	test('clean gate-agent message writes no event', async () => {
		const dir = makeProjectDir();
		const output = {
			messages: [
				{
					info: { role: 'user', agent: 'critic' },
					parts: [{ type: 'text', text: 'A perfectly calm review request.' }],
				},
			],
		};
		await createDelegationSanitizerHook(dir)(undefined, output);
		expect(readCoreEvents(dir).coverage).toBe('empty');
	});
});

// ---------------------------------------------------------------------------
// role-filter writer
// ---------------------------------------------------------------------------

describe('role-filter context_filtered serialized shape', () => {
	test('filterByRole with a directory appends the exact metrics shape', () => {
		const dir = makeProjectDir();
		const entries = [
			{
				role: 'user' as const,
				content: '[FOR: architect]\nArchitect-only briefing',
			},
			{ role: 'user' as const, content: '[FOR: coder]\nCoder note' },
			{ role: 'user' as const, content: 'Untagged — visible to everyone' },
		];
		const filtered = filterByRole(entries, 'coder', dir);
		expect(filtered.length).toBe(2);

		const event = lastWindowEvent(dir);
		expect(Object.keys(event)).toEqual([
			'event',
			'timestamp',
			'agentName',
			'totalEntries',
			'includedEntries',
			'filteredEntries',
			'estimatedTokensSaved',
		]);
		expect(event.event).toBe('context_filtered');
		expect(event.agentName).toBe('coder');
		expect(event.totalEntries).toBe(3);
		expect(event.includedEntries).toBe(2);
		expect(event.filteredEntries).toBe(1);
		expect(event.estimatedTokensSaved).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// auto-review writer (error path — no dispatcher configured)
// ---------------------------------------------------------------------------

describe('auto-review writeAutoReviewEvent serialized shape', () => {
	test('runAutoReview without a dispatcher appends the exact error event', async () => {
		const dir = makeProjectDir();
		const result = await runAutoReview({
			directory: dir,
			sessionID: 'sess-shape',
			trigger: 'task_completion',
			config: { enabled: false } as unknown as AutoReviewConfig,
			injectAdvisory: () => {},
		});
		expect(result).toBeUndefined();

		const event = lastWindowEvent(dir);
		// task_id is omitted (undefined in the producer literal — JSON.stringify
		// drops it), pinning the exact surviving key set and order.
		expect(Object.keys(event)).toEqual([
			'type',
			'timestamp',
			'session_id',
			'trigger',
			'verdict',
			'detail',
			'model_calls',
		]);
		expect(event.type).toBe('auto_review');
		expect(event.session_id).toBe('sess-shape');
		expect(event.trigger).toBe('task_completion');
		expect(event.verdict).toBe('error');
		expect(event.detail).toBe('review runtime unavailable');
		expect(event.model_calls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// seam determinism for a representative pr-workflow-shaped producer payload
// ---------------------------------------------------------------------------

describe('appendCoreEventSync determinism (pr-workflow-shaped event)', () => {
	test('appended line is byte-identical to JSON.stringify of the literal', () => {
		const dir = makeProjectDir();
		// Shape mirrors the durable `pr_workflow_aborted` record in
		// src/hooks/pr-workflow-gate.ts (the abort audit append).
		const abortEvent = {
			type: 'pr_workflow_aborted',
			timestamp: '2026-08-25T10:00:00.000Z',
			sessionID: 'sess-pr',
			mode: 'pr_review',
			kind: 'force',
			prHeadSha: 'abc123def456',
			openLanes: [],
			presumedStaleLanes: ['lane-1', 'lane-2'],
		};
		appendCoreEventSync(dir, abortEvent);

		const raw = fs.readFileSync(
			path.join(dir, '.swarm', 'events.jsonl'),
			'utf-8',
		);
		const rawLines = raw.split('\n').filter((line) => line.trim() !== '');
		expect(rawLines.length).toBe(2); // manifest header + the one event
		expect(rawLines[1]).toBe(JSON.stringify(abortEvent));

		// And the bounded reader returns the same object, unchanged.
		expect(lastWindowEvent(dir)).toEqual(abortEvent);
	});
});
