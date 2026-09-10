import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
	_resetMaintenanceCounters,
	appendCoreEventSync,
	CORE_EVENT_LIMITS,
	_internals as coreEventInternals,
	readCoreEvents,
} from '../../../src/events/core-events.js';
import {
	persistReviewOutcome,
	readReviewOutcome,
} from '../../../src/pr-review/finding-policy.js';
import { canonicalMkdtemp, canonicalTmpDir } from '../../helpers/tmpdir.js';

const createdDirs: string[] = [];
const originalLimits = coreEventInternals.limits;

beforeEach(() => {
	coreEventInternals.limits = {
		...CORE_EVENT_LIMITS,
		readMaxBytes: 256,
		activeMaxBytes: Number.MAX_SAFE_INTEGER,
		activeMaxEntries: Number.MAX_SAFE_INTEGER,
		ageMaxMs: Number.MAX_SAFE_INTEGER,
		checkInterval: Number.MAX_SAFE_INTEGER,
	};
	_resetMaintenanceCounters();
});

afterEach(() => {
	coreEventInternals.limits = originalLimits;
	_resetMaintenanceCounters();
	const root = fs.realpathSync(canonicalTmpDir());
	for (const directory of createdDirs.splice(0)) {
		const resolved = fs.realpathSync(directory);
		if (resolved === root || !resolved.startsWith(root + fs.sep)) continue;
		fs.rmSync(resolved, { recursive: true, force: true });
	}
});

function countEventType(raw: string, type: string): number {
	return raw.split('\n').filter((line) => {
		if (line.trim() === '') return false;
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			return event.type === type;
		} catch {
			return false;
		}
	}).length;
}

describe('readReviewOutcome — regression: bounded audit truncation does not block or duplicate events (NF-4)', () => {
	test('discloses incomplete audit coverage and leaves uncertain history untouched', async () => {
		const projectRoot = canonicalMkdtemp('finding-policy-audit-truncation-');
		createdDirs.push(projectRoot);
		mkdirSync(join(projectRoot, '.opencode'), { recursive: true });
		const input = {
			projectRoot,
			routeReceipt: {
				kind: 'pr_review_finding_policy',
				version: 1,
				sessionId: 'nf4-session',
				taskId: 'nf4-run',
			},
			synthesis: { findings: [] },
		};

		await persistReviewOutcome(input);
		for (let index = 0; index < 8; index += 1) {
			appendCoreEventSync(projectRoot, {
				type: 'nf4-noise',
				index,
				pad: 'x'.repeat(120),
			});
		}
		const eventsPath = join(projectRoot, '.swarm', 'events.jsonl');
		const beforeRetry = fs.readFileSync(eventsPath, 'utf8');
		const coverage = readCoreEvents(projectRoot);
		expect(coverage.coverage).toBe('truncated');
		expect(coverage.text).not.toContain('review.route.receipt');
		expect(coverage.text).not.toContain('review.finding.synthesis');

		// Before NF-4, this bounded read treated the missing tail entries as
		// proof that persistence failed and permanently blocked the outcome.
		const readBack = await readReviewOutcome({
			projectRoot,
			sessionId: input.routeReceipt.sessionId,
			taskId: input.routeReceipt.taskId,
		});
		expect(readBack.auditCoverage).toBe('truncated');
		expect(readBack.evidence.synthesis).toEqual({ findings: [] });

		// Before NF-4, retrying persistence saw only the tail and appended both
		// identity-only events again, even though they may still exist outside
		// the bounded window.
		await persistReviewOutcome(input);
		const afterRetry = fs.readFileSync(eventsPath, 'utf8');
		expect(countEventType(afterRetry, 'review.route.receipt')).toBe(
			countEventType(beforeRetry, 'review.route.receipt'),
		);
		expect(countEventType(afterRetry, 'review.finding.synthesis')).toBe(
			countEventType(beforeRetry, 'review.finding.synthesis'),
		);
	});

	test('writes audit companions on first persistence over a truncated history', async () => {
		const projectRoot = canonicalMkdtemp('finding-policy-audit-truncation-');
		createdDirs.push(projectRoot);
		mkdirSync(join(projectRoot, '.opencode'), { recursive: true });
		const input = {
			projectRoot,
			routeReceipt: {
				kind: 'pr_review_finding_policy',
				version: 1,
				sessionId: 'nf4-first-write-session',
				taskId: 'nf4-first-write-run',
			},
			synthesis: { findings: [] },
		};

		// Simulate a pre-existing legacy log whose bounded tail cannot prove
		// whether these review events are already present.
		for (let index = 0; index < 8; index += 1) {
			appendCoreEventSync(projectRoot, {
				type: 'nf4-preexisting-noise',
				index,
				pad: 'x'.repeat(120),
			});
		}
		expect(readCoreEvents(projectRoot).coverage).toBe('truncated');

		await persistReviewOutcome(input);
		const eventsPath = join(projectRoot, '.swarm', 'events.jsonl');
		const afterFirstWrite = fs.readFileSync(eventsPath, 'utf8');
		expect(countEventType(afterFirstWrite, 'review.route.receipt')).toBe(1);
		expect(countEventType(afterFirstWrite, 'review.finding.synthesis')).toBe(1);

		// Evict the newly appended events from the bounded tail before retrying.
		for (let index = 0; index < 8; index += 1) {
			appendCoreEventSync(projectRoot, {
				type: 'nf4-retry-noise',
				index,
				pad: 'x'.repeat(120),
			});
		}
		expect(readCoreEvents(projectRoot).coverage).toBe('truncated');

		await persistReviewOutcome(input);
		const afterRetry = fs.readFileSync(eventsPath, 'utf8');
		expect(countEventType(afterRetry, 'review.route.receipt')).toBe(1);
		expect(countEventType(afterRetry, 'review.finding.synthesis')).toBe(1);
	});
});
