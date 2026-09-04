/**
 * Issue #2104 — opt-in background-work status section.
 *
 * Pins: absent by default (no config, no output delta), present only when
 * backgroundSubagents is enabled, counts + reservation lease states +
 * maintenance lines render, and corrupt stores surface typed uncertainty
 * instead of partially-trusted counts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_CODER_RESERVATIONS_FILE,
	BACKGROUND_DELEGATIONS_FILE,
	type BackgroundTerminalResult,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	recordPendingDelegation,
	reserveBackgroundCoderSlot,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	type BackgroundWorkStatus,
	formatStatusMarkdown,
	getStatusData,
	handleStatusCommand,
	type StatusData,
} from '../../../src/services/status-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-status-bg-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function baseStatus(over: Partial<StatusData> = {}): StatusData {
	return {
		hasPlan: true,
		currentPhase: 'Phase 1',
		completedTasks: 0,
		totalTasks: 2,
		agentCount: 4,
		isLegacy: false,
		turboMode: false,
		contextBudgetPct: null,
		contextBudgetTokens: null,
		compactionCount: 0,
		lastSnapshotAt: null,
		...over,
	};
}

function rejectedTerminal(correlationId: string): BackgroundTerminalResult {
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId,
			jobId: null,
			status: 'rejected',
			resultDigest: `${correlationId}:rejected`,
		}),
		status: 'rejected',
		recordedAt: 100,
		result: {
			chars: 8,
			truncated: false,
			digest: `${correlationId}:rejected`,
			error: 'rejected',
		},
	};
}

describe('status background-work section (issue #2104)', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempProject();
	});

	afterEach(() => {
		closeAllProjectDbs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('adds no section and no backgroundWork data when the feature is disabled', async () => {
		const status = await getStatusData(dir, {});
		expect(status.backgroundWork).toBeUndefined();
		const markdown = formatStatusMarkdown(status);
		expect(markdown).not.toContain('Background Work');
	});

	it('collects counts, reservation lease state, and maintenance when enabled', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			maxConcurrent: 4,
		});
		expect(claim.ok).toBe(true);
		await recordPendingDelegation(dir, {
			correlationId: 'ses_a',
			jobId: null,
			subagentSessionId: 'ses_a',
			parentSessionId: 'parent_1',
			callID: 'call_1',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			coderReservationId: claim.ok
				? claim.reservation.reservationId
				: undefined,
		});

		const status = await getStatusData(dir, {}, undefined, {
			backgroundSubagents: true,
		});
		const work = status.backgroundWork as BackgroundWorkStatus;
		expect(work.source).toBe('validated-recovery');
		expect(work.counts.pending).toBe(1);
		expect(work.reservations).toHaveLength(1);
		expect(work.reservations[0]?.leaseState).toBe('active');
		expect(work.reservations[0]?.generation).toBe(1);
		expect(work.maintenance).not.toBeNull();

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('**Background Work** (opt-in):');
		expect(markdown).toContain('1 pending');
		expect(markdown).toContain('Reservations (1 active):');
		expect(markdown).toContain('lease active until');
		expect(markdown).toContain('Source: validated recovery');
		expect(markdown).toContain('Maintenance:');
	});

	it('renders rejected background delegations in counts and markdown', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'ses_rejected',
			jobId: null,
			subagentSessionId: 'ses_rejected',
			parentSessionId: 'parent_1',
			callID: 'call_rejected',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		await claimTerminalResult(
			dir,
			'ses_rejected',
			rejectedTerminal('ses_rejected'),
		);

		const status = await getStatusData(dir, {}, undefined, {
			backgroundSubagents: true,
		});
		const work = status.backgroundWork as BackgroundWorkStatus;
		expect(work.source).toBe('validated-recovery');
		expect(work.counts.rejected).toBe(1);

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('1 rejected');
	});

	it('renders typed uncertainty and no counts when the ledger is corrupt', async () => {
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			'not-json\n',
		);

		const status = await getStatusData(dir, {}, undefined, {
			backgroundSubagents: true,
		});
		const work = status.backgroundWork as BackgroundWorkStatus;
		expect(work.source).toBe('uncertain');
		expect(work.uncertainty).toBeDefined();

		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('State uncertain');
		expect(markdown).not.toContain('pending, ');
	});

	it('renders typed uncertainty when the reservation store is corrupt', async () => {
		fs.writeFileSync(
			path.join(dir, '.swarm', BACKGROUND_CODER_RESERVATIONS_FILE),
			'{broken',
		);

		const status = await getStatusData(dir, {}, undefined, {
			backgroundSubagents: true,
		});
		const work = status.backgroundWork as BackgroundWorkStatus;
		expect(work.source).toBe('uncertain');
		expect(work.uncertainty).toContain('reservation store');
	});

	it('shows the section in the no-plan branch when enabled', async () => {
		const claim = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent_1',
			planTaskId: '1.1',
			callID: 'call_1',
			maxConcurrent: 4,
		});
		expect(claim.ok).toBe(true);

		const output = await handleStatusCommand(dir, {}, undefined, {
			backgroundSubagents: true,
		});
		expect(output).toContain('No active swarm plan found.');
		expect(output).toContain('**Background Work** (opt-in):');
		expect(output).toContain('Reservations (1 active):');
	});

	it('keeps the no-plan branch byte-identical when disabled', async () => {
		const output = await handleStatusCommand(dir, {});
		expect(output).toBe('No active swarm plan found.');
	});
});
