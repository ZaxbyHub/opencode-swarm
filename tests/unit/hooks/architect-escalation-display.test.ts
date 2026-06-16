/**
 * Tests for the architect escalation briefing (Change 3 / Task 3.3).
 *
 * buildEscalationBriefing renders a deterministic "Recently Escalated"
 * subsection; readRecentEscalations windows escalation events to the last N days.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildEscalationBriefing,
	type RecentEscalation,
	readRecentEscalations,
} from '../../../src/hooks/knowledge-escalator.js';
import { appendKnowledgeEvent } from '../../../src/hooks/knowledge-events.js';

const DAY = 24 * 60 * 60 * 1000;

describe('buildEscalationBriefing', () => {
	it('renders the Recently Escalated subsection for two escalations', () => {
		const escalations: RecentEscalation[] = [
			{
				entry_id: 'k-001',
				from: 'medium',
				to: 'critical',
				reason: 'repeat_violation',
				at: '2026-03-01T00:00:00.000Z',
			},
			{
				entry_id: 'k-002',
				from: 'high',
				to: 'critical',
				reason: 'repeat_violation',
				at: '2026-02-28T00:00:00.000Z',
			},
		];
		const block = buildEscalationBriefing(escalations);
		expect(block).toBe(
			[
				'### Recently Escalated (last 7 days)',
				'- k-001 (medium→critical) reason=repeat_violation',
				'- k-002 (high→critical) reason=repeat_violation',
			].join('\n'),
		);
	});

	it('returns null when there are no escalations', () => {
		expect(buildEscalationBriefing([])).toBeNull();
	});
});

describe('readRecentEscalations', () => {
	let dir: string;
	const now = new Date('2026-03-10T00:00:00.000Z');

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-display-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('returns escalations within the window, newest first, excluding old ones', async () => {
		await appendKnowledgeEvent(dir, {
			type: 'escalation',
			entry_id: 'recent-1',
			from: 'medium',
			to: 'critical',
			reason: 'repeat_violation',
			timestamp: new Date(now.getTime() - 1 * DAY).toISOString(),
		});
		await appendKnowledgeEvent(dir, {
			type: 'escalation',
			entry_id: 'recent-2',
			from: 'high',
			to: 'critical',
			reason: 'repeat_violation',
			timestamp: new Date(now.getTime() - 3 * DAY).toISOString(),
		});
		await appendKnowledgeEvent(dir, {
			type: 'escalation',
			entry_id: 'old-1',
			from: 'low',
			to: 'critical',
			reason: 'repeat_violation',
			timestamp: new Date(now.getTime() - 30 * DAY).toISOString(),
		});

		const recent = await readRecentEscalations(dir, 7, now);
		expect(recent.map((e) => e.entry_id)).toEqual(['recent-1', 'recent-2']);
	});
});
