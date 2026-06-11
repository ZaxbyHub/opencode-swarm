/**
 * Tests that /swarm status surfaces recently-escalated directives
 * (Change 3 / Task 3.3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendKnowledgeEvent } from '../../../src/hooks/knowledge-events.js';
import {
	formatStatusMarkdown,
	getStatusData,
	type StatusData,
} from '../../../src/services/status-service.js';

function baseStatus(overrides: Partial<StatusData> = {}): StatusData {
	return {
		hasPlan: true,
		currentPhase: 'Phase 2',
		completedTasks: 1,
		totalTasks: 3,
		agentCount: 5,
		isLegacy: false,
		turboMode: false,
		contextBudgetPct: null,
		compactionCount: 0,
		lastSnapshotAt: null,
		...overrides,
	};
}

describe('formatStatusMarkdown — escalations', () => {
	it('renders a Recently Escalated section when escalations are present', () => {
		const md = formatStatusMarkdown(
			baseStatus({
				recentEscalations: [
					{
						entry_id: 'k-9',
						from: 'medium',
						to: 'critical',
						reason: 'repeat_violation',
						at: '2026-03-01T00:00:00.000Z',
					},
				],
			}),
		);
		expect(md).toContain('**Recently Escalated (last 7 days)**:');
		expect(md).toContain('k-9 (medium→critical) reason=repeat_violation');
	});

	it('omits the section when there are no escalations', () => {
		const md = formatStatusMarkdown(baseStatus({ recentEscalations: [] }));
		expect(md).not.toContain('Recently Escalated');
	});
});

describe('getStatusData — escalations', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-esc-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('populates recentEscalations from the event log', async () => {
		await appendKnowledgeEvent(dir, {
			type: 'escalation',
			entry_id: 'k-1',
			from: 'medium',
			to: 'critical',
			reason: 'repeat_violation',
			timestamp: new Date().toISOString(),
		});
		const status = await getStatusData(dir, {});
		expect(status.recentEscalations?.map((e) => e.entry_id)).toContain('k-1');
	});
});
