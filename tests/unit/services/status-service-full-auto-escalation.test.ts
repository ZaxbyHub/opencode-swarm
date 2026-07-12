/**
 * Issue #1781 E2 — `/swarm status` surfaces full-auto oversight-escalation
 * detail (reason, interaction/deadlock counts, phase) when Full-Auto is active.
 *
 * Coverage:
 *  - formatStatusMarkdown renders the escalation line when fullAutoActive +
 *    fullAutoEscalation are set (turbo ON case).
 *  - formatStatusMarkdown renders the escalation line even when turboStrategy
 *    is 'off' (the B2 regression — previously the whole block was hidden
 *    inside the turbo branch).
 *  - formatStatusMarkdown renders `**Full-Auto**: active` without an
 *    escalation line when active but no escalation has occurred.
 *  - formatStatusMarkdown does NOT render the full-auto block when inactive,
 *    even if escalation data is present (gated).
 *  - getStatusData end-to-end: with the _internals seam overriding the active
 *    session + the durable state reader, fullAutoEscalation is populated from
 *    lastEscalation and survives a formatStatusMarkdown pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as statusInternals,
	formatStatusMarkdown,
	getStatusData,
	type StatusData,
} from '../../../src/services/status-service';
import type { FullAutoRunState } from '../../../src/full-auto/state';

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

describe('formatStatusMarkdown — full-auto escalation block', () => {
	it('renders escalation line when fullAutoActive + fullAutoEscalation (turbo ON)', () => {
		const md = formatStatusMarkdown(
			baseStatus({
				turboStrategy: 'lean',
				fullAutoActive: true,
				fullAutoEscalation: {
					reason: 'deadlock',
					interactionCount: 5,
					deadlockCount: 3,
					phase: 2,
				},
			}),
		);
		expect(md).toContain('**Full-Auto**: active');
		expect(md).toContain(
			'Escalation: deadlock (interactions=5, deadlocks=3 | Phase 2)',
		);
	});

	it('renders escalation line when turboStrategy is off (B2 regression guard)', () => {
		// Pre-E2: the full-auto block was nested inside `turboStrategy !== 'off'`,
		// so it was invisible when full-auto ran without turbo. The hoist renders
		// it independently.
		const md = formatStatusMarkdown(
			baseStatus({
				turboStrategy: 'off',
				fullAutoActive: true,
				fullAutoEscalation: {
					reason: 'interaction_limit',
					interactionCount: 12,
					deadlockCount: 0,
				},
			}),
		);
		expect(md).toContain('**Full-Auto**: active');
		expect(md).toContain('Escalation: interaction_limit (interactions=12');
	});

	it('renders **Full-Auto**: active without an escalation line when no escalation', () => {
		const md = formatStatusMarkdown(
			baseStatus({
				fullAutoActive: true,
			}),
		);
		expect(md).toContain('**Full-Auto**: active');
		expect(md).not.toContain('Escalation:');
	});

	it('does NOT render the full-auto block when fullAutoActive is false/undefined', () => {
		const mdInactive = formatStatusMarkdown(
			baseStatus({
				fullAutoActive: false,
				fullAutoEscalation: {
					reason: 'deadlock',
					interactionCount: 1,
					deadlockCount: 1,
				},
			}),
		);
		expect(mdInactive).not.toContain('**Full-Auto**: active');
		expect(mdInactive).not.toContain('Escalation:');

		const mdUndefined = formatStatusMarkdown(baseStatus({}));
		expect(mdUndefined).not.toContain('Full-Auto');
	});

	it('renders escalation without phase when phase is undefined', () => {
		const md = formatStatusMarkdown(
			baseStatus({
				fullAutoActive: true,
				fullAutoEscalation: {
					reason: 'ESCALATE_TO_HUMAN',
					interactionCount: 2,
					deadlockCount: 1,
				},
			}),
		);
		// The escalation line ends after deadlocks (no `| Phase N` suffix).
		expect(md).toContain(
			'Escalation: ESCALATE_TO_HUMAN (interactions=2, deadlocks=1)',
		);
		const escalationLine = md
			.split('\n')
			.find((l) => l.includes('Escalation:'));
		expect(escalationLine).toBeDefined();
		expect(escalationLine).not.toInclude('| Phase');
	});
});

describe('getStatusData — full-auto escalation end-to-end (DI seam)', () => {
	let dir: string;
	const sessionID = 'test-session-1781';
	let origHasActiveFullAuto: typeof statusInternals.hasActiveFullAuto;
	let origGetActiveFullAutoSessionID: typeof statusInternals.getActiveFullAutoSessionID;
	let origLoadFullAutoRunState: typeof statusInternals.loadFullAutoRunState;

	/**
	 * Build a minimal valid FullAutoRunState with optional lastEscalation.
	 */
	function buildRunState(
		lastEscalation?: FullAutoRunState['lastEscalation'],
	): FullAutoRunState {
		return {
			status: 'running',
			sessionID,
			mode: 'supervised',
			startedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			denialCounters: { consecutive: 0, total: 0 },
			denialHistory: [],
			counters: {
				architectTurns: 0,
				toolCalls: 0,
				coderDelegations: 0,
				reviewerRejections: 0,
				testFailures: 0,
				oversightChecks: 0,
				consecutiveNoProgressTurns: 0,
				consecutiveOversightFailures: 0,
			},
			lastEscalation,
		} as FullAutoRunState;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-fa-esc-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		origHasActiveFullAuto = statusInternals.hasActiveFullAuto;
		origGetActiveFullAutoSessionID = statusInternals.getActiveFullAutoSessionID;
		origLoadFullAutoRunState = statusInternals.loadFullAutoRunState;
		// Make this session appear active for the duration of each test.
		statusInternals.hasActiveFullAuto = () => true;
		statusInternals.getActiveFullAutoSessionID = () => sessionID;
	});

	afterEach(() => {
		statusInternals.hasActiveFullAuto = origHasActiveFullAuto;
		statusInternals.getActiveFullAutoSessionID = origGetActiveFullAutoSessionID;
		statusInternals.loadFullAutoRunState = origLoadFullAutoRunState;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('populates fullAutoEscalation from lastEscalation and renders end-to-end', async () => {
		const escalationPayload = {
			reason: 'deadlock',
			interactionCount: 7,
			deadlockCount: 4,
			phase: 3,
			escalatedAt: new Date().toISOString(),
		};
		statusInternals.loadFullAutoRunState = () =>
			buildRunState(escalationPayload);

		const status = await getStatusData(dir, {});
		expect(status.fullAutoActive).toBe(true);
		expect(status.fullAutoEscalation).toEqual({
			reason: 'deadlock',
			interactionCount: 7,
			deadlockCount: 4,
			phase: 3,
		});

		// End-to-end render (N4 fixture acceptance test): the escalation detail
		// survives the formatStatusMarkdown pass and appears in the markdown.
		const md = formatStatusMarkdown(status);
		expect(md).toContain('**Full-Auto**: active');
		expect(md).toContain('interactions=7, deadlocks=4 | Phase 3');
	});

	it('sets fullAutoActive true but leaves fullAutoEscalation undefined when no escalation', async () => {
		statusInternals.loadFullAutoRunState = () => buildRunState(undefined);

		const status = await getStatusData(dir, {});
		expect(status.fullAutoActive).toBe(true);
		expect(status.fullAutoEscalation).toBeUndefined();
	});

	it('leaves fullAutoEscalation undefined when loadFullAutoRunState returns undefined (no durable state)', async () => {
		statusInternals.loadFullAutoRunState = () => undefined;

		const status = await getStatusData(dir, {});
		expect(status.fullAutoActive).toBe(true);
		expect(status.fullAutoEscalation).toBeUndefined();
	});

	it('leaves fullAutoEscalation undefined when getActiveFullAutoSessionID returns undefined', async () => {
		// Even if durable state has an escalation, if no active sessionID
		// resolves, nothing is surfaced (avoids stale cross-session reads).
		statusInternals.getActiveFullAutoSessionID = () => undefined;
		statusInternals.loadFullAutoRunState = () =>
			buildRunState({
				reason: 'deadlock',
				interactionCount: 99,
				deadlockCount: 99,
				escalatedAt: '2020-01-01T00:00:00.000Z',
			});

		const status = await getStatusData(dir, {});
		expect(status.fullAutoActive).toBe(true);
		expect(status.fullAutoEscalation).toBeUndefined();
	});
});
