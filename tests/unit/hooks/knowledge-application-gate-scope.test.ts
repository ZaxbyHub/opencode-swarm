import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_KNOWLEDGE_APPLICATION_CONFIG } from '../../../src/hooks/knowledge-application.js';
import {
	_internals,
	knowledgeApplicationGateBefore,
} from '../../../src/hooks/knowledge-application-gate.js';
import {
	commitApplicationMarkerBatch,
	commitDisplayedMembership,
	commitPhaseClosed,
	type ReceiptExposureKind,
	type ReceiptMembership,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { swarmState } from '../../../src/state.js';

const SESSION = 'scope-session';
const ENTRY = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa';
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(path.join(tmpdir(), 'application-gate-scope-'));
	writeFileSync(path.join(directory, '.git'), 'gitdir: fixture');
	swarmState.knowledgeAckDedup.clear();
	swarmState.gateDenialCounts.clear();
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

async function display(input: {
	trace: string;
	phase: string;
	task: string;
	kind: ReceiptExposureKind;
	critical?: boolean;
}): Promise<void> {
	const result = await commitDisplayedMembership(directory, {
		trace_id: input.trace,
		session_id: SESSION,
		phase: input.phase,
		task_id: input.task,
		exposure_kind: input.kind,
		entries: [{ entry_id: ENTRY, critical: input.critical ?? true }],
	});
	if (!result.ok) throw new Error(result.detail);
}

const enforce = {
	...DEFAULT_KNOWLEDGE_APPLICATION_CONFIG,
	mode: 'enforce' as const,
};

describe('knowledge application gate scope', () => {
	it('excludes delegate, manual, and phase-closed architect exposures', async () => {
		await display({
			trace: 'delegate-trace',
			phase: 'Delegate phase',
			task: 'delegate-task',
			kind: 'delegate_directive',
		});
		await display({
			trace: 'manual-trace',
			phase: 'Manual phase',
			task: 'manual-task',
			kind: 'manual_recall',
		});
		await display({
			trace: 'closed-architect-trace',
			phase: 'Closed phase',
			task: 'closed-task',
			kind: 'architect_directive',
		});
		const closed = await commitPhaseClosed(directory, 'Closed phase');
		expect(closed.ok).toBe(true);

		await knowledgeApplicationGateBefore(
			directory,
			{ tool: 'save_plan', agent: 'architect', sessionID: SESSION },
			enforce,
		);
	});

	it('gates only the latest active architect phase/task scope', async () => {
		await display({
			trace: 'old-task-trace',
			phase: 'Phase 1',
			task: 'old-task',
			kind: 'architect_directive',
		});
		await display({
			trace: 'current-task-trace',
			phase: 'Phase 2',
			task: 'current-task',
			kind: 'architect_directive',
		});
		const marked = await commitApplicationMarkerBatch(directory, {
			trace_id: 'current-task-trace',
			session_id: SESSION,
			items: [{ entry_id: ENTRY, outcome: 'applied', source: 'test' }],
		});
		expect(marked.ok && marked.rejected.length === 0).toBe(true);

		await knowledgeApplicationGateBefore(
			directory,
			{ tool: 'phase_complete', agent: 'architect', sessionID: SESSION },
			enforce,
		);
	});

	it('computes staleness from each current unmarked exact pair', () => {
		const base: ReceiptMembership = {
			trace_id: 'old-marked-trace',
			entry_id: ENTRY,
			session_id: SESSION,
			phase: 'Phase 1',
			task_id: 'task-a',
			critical: true,
			committed_at: '1970-01-01T00:00:00.000Z',
			membership_event_id: 'old-event',
			grace_days: 7,
			exposure_kind: 'architect_directive',
			origin: 'v2',
			application_marker: {
				outcome: 'applied',
				source: 'test',
				event_id: 'marker-event',
				committed_at: '1970-01-01T00:00:00.100Z',
			},
		};
		const fresh: ReceiptMembership = {
			...base,
			trace_id: 'fresh-unmarked-trace',
			committed_at: '1970-01-01T00:00:00.950Z',
			membership_event_id: 'fresh-event',
			application_marker: undefined,
		};
		const staleUnmarked: ReceiptMembership = {
			...fresh,
			trace_id: 'stale-unmarked-trace',
			committed_at: '1970-01-01T00:00:00.000Z',
		};

		expect(
			_internals
				.selectStaleUnmarkedMemberships([base, fresh], 1_000, 100)
				.map((membership) => membership.trace_id),
		).toEqual([]);
		expect(
			_internals
				.selectStaleUnmarkedMemberships(
					[base, fresh, staleUnmarked],
					1_000,
					100,
				)
				.map((membership) => membership.trace_id),
		).toEqual(['stale-unmarked-trace']);
	});
});
