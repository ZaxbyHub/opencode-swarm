import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
	type PR_REVIEW_CRITIC_STATUSES,
	PrReviewCriticVerdictFieldsSchema,
} from '../../../src/background/pr-review-contract.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts,
	completePrWorkflow,
	_test_exports as gateInternals,
	recordPrFeedbackPushAttemptResult,
	reserveActivePrReviewReentryAuthorization,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_REVIEW_EVENT_AUTHORITY_REGISTRY,
	type PR_REVIEW_WIRED_EVENT_TYPES,
} from '../../../src/pr-review/authority.js';
import {
	_internals as authorizationInternals,
	issuePrReviewReentryAuthorization,
} from '../../../src/pr-review/authorization.js';
import type {
	PrReviewPhaseComposition,
	PrReviewTranscriptGateHelpers,
	PrReviewTranscriptState,
} from '../../../src/pr-review/legacy-transcript-adapter.js';
import {
	bindPrReviewTranscriptAdapterHelpers,
	composePrReviewPhaseVerdicts,
	reviewerVerdictRowDigest,
} from '../../../src/pr-review/legacy-transcript-adapter.js';
import {
	readPrWorkflowGateStateFromDisk,
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import type { PrReviewEvent } from '../../../src/pr-review/types.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type AcceptanceEventUnionIsExact = AssertTrue<
	Equal<PrReviewEvent['type'], (typeof PR_REVIEW_WIRED_EVENT_TYPES)[number]>
>;
const HISTORICAL_EVENT_TYPES = [
	'base_admission_requested',
	'base_admission_rolled_back',
	'collection_observed',
	'lane_structured_result_submitted',
	'transcript_evidence_presented',
	'provider_terminal_observed',
	'lane_cancelled',
	'circuit_advance_requested',
	'circuit_probe_settled',
	'resilience_config_changed',
	'coverage_finalization_requested',
	'critic_result_recorded',
	'publication_armed',
	'publication_published',
	'armed_recovery_requested',
	'reviewer_authorization_consumed',
] as const;
const RETIRED_EVENT_TYPES = new Set([
	'base_admission_requested',
	'transcript_evidence_presented',
	'provider_terminal_observed',
	'lane_cancelled',
	'coverage_finalization_requested',
	'critic_result_recorded',
	'publication_armed',
	'publication_published',
	'armed_recovery_requested',
	'reviewer_authorization_consumed',
]);
type AuthorityEntry = {
	status: 'wired' | 'retired';
	lifecycle: string;
	authority?: unknown;
	authoritySymbol?: string;
	productionCreator?: string;
	replacement?: string;
	replacementAuthority?: unknown;
};
const REVIEWER_FIELDS = [
	'[REVIEWED]',
	'finding-1',
	'CONFIRMED',
	'STRUCTURALLY_PROVEN',
	'HIGH',
	'YES',
	'file.ts:1',
	'canonical rationale',
	'probe-1',
	'reviewer',
	'ORDINARY',
	'',
] as const;
const REVIEWER_ROW_DIGEST = reviewerVerdictRowDigest(REVIEWER_FIELDS);
let directory = '';
const originalHeadAsync = gateInternals.resolveCurrentGitHeadAsync;
const originalWorkingTreeClean = gateInternals.resolveIsWorkingTreeCleanAsync;
const originalRevisionDigest = gateInternals.resolvePrWorkflowRevisionDigest;
beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-authority-2512-');
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => 'revision-2512';
});
afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHeadAsync = originalHeadAsync;
	gateInternals.resolveIsWorkingTreeCleanAsync = originalWorkingTreeClean;
	gateInternals.resolvePrWorkflowRevisionDigest = originalRevisionDigest;
	closeAllProjectDbs();
	await rm(directory, { recursive: true, force: true });
});
function criticRow(
	status: (typeof PR_REVIEW_CRITIC_STATUSES)[number],
	severity: string,
): string {
	return `[CRITIC] | finding-1 | ${status} | ${severity} | valid reason | required change`;
}
function reviewerRow(classification: string, severity: string): string {
	return `[REVIEWED] | finding-1 | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | canonical rationale | probe-1 | reviewer`;
}
function errorFrom(promise: Promise<unknown>): Promise<Error | null> {
	return promise.then(
		() => null,
		(reason: unknown) => reason as Error,
	);
}
function assertWiredEntry(entry: AuthorityEntry, eventType: string): void {
	if (entry.status !== 'wired') return;
	if (typeof entry.authority !== 'function')
		throw new Error(`${eventType} wired authority is not importable`);
	if (!entry.authoritySymbol || !entry.authoritySymbol.includes('#'))
		throw new Error(`${eventType} wired entry has no authority symbol`);
	if (!entry.productionCreator || !entry.productionCreator.includes('#'))
		throw new Error(`${eventType} wired entry has no production creator`);
}
function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
type S = string;
type N = number;
function matching(s: S, i: N, o: S, c: S): N | null {
	let depth = 0;
	for (let index = i; index < s.length; index += 1) {
		const character = s[index];
		if (character === "'" || character === '"' || character === '`') {
			for (index += 1; index < s.length; index += 1) {
				if (s[index] === '\\') index += 1;
				else if (s[index] === character) break;
			}
			continue;
		}
		if (character === '/' && s[index + 1] === '/') {
			index = s.indexOf('\n', index + 2);
			if (index < 0) return null;
		} else if (character === '/' && s[index + 1] === '*') {
			index = s.indexOf('*/', index + 2) + 1;
			if (index === 0) return null;
		}
		if (character === o) depth += 1;
		if (character === c && --depth === 0) return index;
	}
	return null;
}
async function functionBodyForLocator(locator: string): Promise<string | null> {
	const [relativeSource, symbol] = locator.split(' (')[0]!.split('#');
	if (!relativeSource || !symbol) return null;
	const source = await readFile(
		path.resolve(import.meta.dir, '../../..', relativeSource),
		'utf8',
	);
	const declaration = new RegExp(
		`(?:^|[\\r\\n])\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegex(symbol)}\\s*\\(`,
		'm',
	).exec(source);
	if (!declaration) return null;
	const parameterEnd = matching(
		source,
		source.indexOf('(', declaration.index),
		'(',
		')',
	);
	if (parameterEnd === null) return null;
	const bodyStart = source.indexOf('{', parameterEnd + 1);
	if (bodyStart === -1) return null;
	const bodyEnd = matching(source, bodyStart, '{', '}');
	return bodyEnd === null ? null : source.slice(bodyStart, bodyEnd + 1);
}
async function assertProductionCreator(
	entry: AuthorityEntry,
	eventType: string,
): Promise<void> {
	if (entry.status !== 'wired' || !entry.productionCreator) return;
	const body = await functionBodyForLocator(entry.productionCreator);
	expect(body, `${eventType} creator body`).not.toBeNull();
	if (body === null) return;
	expect(body).toMatch(
		new RegExp(`type\\s*:\\s*['"]${escapeRegex(eventType)}['"]`),
	);
}
describe('issue #2512 — critic status and report projection', () => {
	test('terminal critic rows use the production report projection', async () => {
		await activatePrWorkflow(
			directory,
			'session-2512-projection',
			'PR_REVIEW',
			{
				prHeadSha: 'abc123',
			},
		);
		for (const [status, severity, expected] of [
			['UPHELD', 'HIGH', { status: 'CONFIRMED', next_action: 'report' }],
			['DOWNGRADED', 'LOW', { status: 'CONFIRMED', next_action: 'report' }],
			[
				'DISPROVED',
				'NONE',
				{ status: 'DISPROVED', next_action: 'suppress_with_reason' },
			],
		] as const) {
			expect(
				PrReviewCriticVerdictFieldsSchema.safeParse(
					criticRow(status, severity).split(' | '),
				).success,
				status,
			).toBe(true);
			installCompositionHelpers(
				criticRow(status, severity),
				reviewerRow('CONFIRMED', 'HIGH'),
			);
			const projectionError = await errorFrom(
				assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
					directory,
					'session-2512-projection',
					'post_critic',
					[
						{
							finding_id: 'finding-1',
							...expected,
							severity,
						},
					],
				),
			);
			if (projectionError) console.log(projectionError.message);
			expect(projectionError).toBeNull();
		}
	});
});
function installCompositionHelpers(
	criticText: string,
	reviewerText = reviewerRow('CONFIRMED', 'HIGH'),
): void {
	const helpers: PrReviewTranscriptGateHelpers = {
		derivePrReviewCandidateInventory: () => ['finding-1'],
		derivePrReviewCriticInventory: () => ['finding-1'],
		authoritativeReviewerClaims: () =>
			new Map([
				[
					'finding-1',
					{
						batchId: 'review-batch',
						laneId: 'review-lane',
						workflowLane: 'reviewer',
						classification: 'CONFIRMED',
						severity: 'HIGH',
						rowDigest: REVIEWER_ROW_DIGEST,
					},
				],
			]),
		reviewerSubagentSessionIds: () => new Set(),
		prReviewPhaseWindow: (_state, phase) => [
			{
				batchId: `${phase}-batch`,
				validatedAt: 'now',
				lanes: [
					{
						laneId: `${phase}-lane`,
						workflowLane: phase,
						reviewItemIds: ['finding-1'],
					},
				],
			},
		],
		batchMayContributeClaims: () => true,
		recordsPassingBatchIntegrity: (
			_directory,
			_state,
			_batchId,
			expectedLanes,
			expectedMode,
		) => [
			{
				record: {} as never,
				expectedLane: expectedLanes[0]!,
				expectedWorkflowLane: expectedMode.endsWith(':critic')
					? 'critic'
					: 'reviewer',
			},
		],
		loadArtifactPassingLaneIntegrity: (
			_directory,
			_state,
			_record,
			expectedMode,
		) =>
			({
				text: expectedMode.endsWith(':critic') ? criticText : reviewerText,
			}) as never,
	};
	bindPrReviewTranscriptAdapterHelpers(helpers);
}
function composedCritic(binding: string): PrReviewPhaseComposition {
	const state: PrReviewTranscriptState = {
		sessionID: 'session-2512',
		prReviewBatchCoherence: {
			'critic-batch': {
				validatedInventory: ['finding-1'],
				reviewerItemBindings: { 'finding-1': binding },
			},
		},
	};
	return composePrReviewPhaseVerdicts('injected-directory', state, 'critic', {
		revisionDigest: 'revision-2512',
	});
}
describe('issue #2512 — current reviewer-row digest authority', () => {
	test('critic settlement requires the current authoritative reviewer-row digest', () => {
		installCompositionHelpers(criticRow('UPHELD', 'HIGH'));
		const settled = composedCritic(REVIEWER_ROW_DIGEST);
		expect(settled.unclaimed).toEqual([]);
		expect(settled.claims.get('finding-1')).toMatchObject({
			classification: 'UPHELD',
			severity: 'HIGH',
		});
		for (const stale of ['stale-reviewer-row-digest', '']) {
			const result = composedCritic(stale);
			expect(result.claims.has('finding-1')).toBe(false);
			expect(result.unclaimed).toEqual(['finding-1']);
		}
	});
});
describe('issue #2512 — durable authorization identity', () => {
	test('authorization uses the exact tuple and permits only exact-call replay', async () => {
		const sessionID = 'session-2512-auth';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW', {
			prHeadSha: 'abc123',
		});
		const issued = await issuePrReviewReentryAuthorization(
			directory,
			sessionID,
			{ prHeadSha: 'abc123', role: 'reviewer' },
		);
		const request = { role: 'reviewer' as const, callID: 'call-2512' };
		const consumed = await reserveActivePrReviewReentryAuthorization(
			directory,
			sessionID,
			request,
		);
		const replay = await reserveActivePrReviewReentryAuthorization(
			directory,
			sessionID,
			request,
		);
		expect(consumed?.authorizationId).toBe(issued.authorizationId);
		expect(replay?.authorizationId).toBe(issued.authorizationId);
		await withSessionStateMutation(directory, sessionID, async () => {
			const state = await readPrWorkflowGateStateFromDisk(directory, sessionID);
			if (!state) throw new Error('expected active authorization state');
			await writeStateWhileLocked(directory, {
				...state,
				updatedAt: '2026-09-07T00:00:00.000Z',
			});
		});
		await expect(
			reserveActivePrReviewReentryAuthorization(directory, sessionID, {
				...request,
				callID: 'different-call-after-revision',
			}),
		).resolves.toBeNull();
		const fullRecord = {
			...issued,
			workflowInstanceId: 'workflow-2512',
			runId: 'run-2512',
		};
		const fullBinding = {
			workflowInstanceId: 'workflow-2512',
			runId: 'run-2512',
			prHeadSha: fullRecord.prHeadSha,
			revisionDigest: fullRecord.revisionDigest,
			generation: fullRecord.generation,
		};
		expect(
			authorizationInternals.authorizationMatchesBinding(
				fullRecord,
				fullBinding,
			),
		).toBe(true);
		for (const field of [
			'workflowInstanceId',
			'runId',
			'prHeadSha',
			'revisionDigest',
			'generation',
		] as const) {
			expect(
				authorizationInternals.authorizationMatchesBinding(fullRecord, {
					...fullBinding,
					[field]: `${String(fullBinding[field])}-stale`,
				}),
			).toBe(false);
		}
		expect(
			authorizationInternals.authorizationMatchesBinding(fullRecord, {
				...fullBinding,
				workflowInstanceId: undefined,
			}),
		).toBe(false);
	});
});
describe('issue #2512 — exhaustive authority registry', () => {
	test('registry covers all sixteen historical events and names ten replacements', async () => {
		const registry = PR_REVIEW_EVENT_AUTHORITY_REGISTRY as Record<
			string,
			AuthorityEntry
		>;
		expect(Object.keys(registry).sort()).toEqual(
			[...HISTORICAL_EVENT_TYPES].sort(),
		);
		for (const eventType of HISTORICAL_EVENT_TYPES) {
			const entry = registry[eventType];
			expect(entry, `${eventType} authority metadata`).toBeDefined();
			expect(['wired', 'retired']).toContain(entry.status);
			expect(entry.lifecycle.trim().length).toBeGreaterThan(0);
			assertWiredEntry(entry, eventType);
			await assertProductionCreator(entry, eventType);
			if (RETIRED_EVENT_TYPES.has(eventType)) {
				expect(entry.status, `${eventType} must be retired`).toBe('retired');
				expect(entry.replacement, `${eventType} replacement`).toMatch(/\S/);
				expect(typeof entry.replacementAuthority).toBe('function');
			} else {
				expect(entry.status, `${eventType} must be wired`).toBe('wired');
				expect(entry.authoritySymbol).toContain('#');
			}
		}
	});
	test('completion and publication replacement authorities remain mode-distinct', () => {
		const completion =
			PR_REVIEW_EVENT_AUTHORITY_REGISTRY.coverage_finalization_requested;
		const publication =
			PR_REVIEW_EVENT_AUTHORITY_REGISTRY.publication_published;
		expect(completion.domain).toBe('completion');
		expect(completion.replacement).toBe(
			'src/hooks/pr-workflow-gate.ts#completePrWorkflow',
		);
		expect(completion.replacementAuthority).toBe(completePrWorkflow);
		expect(publication.domain).toBe('publication');
		expect(publication.replacement).toBe(
			'src/hooks/pr-workflow-gate.ts#recordPrFeedbackPushAttemptResult',
		);
		expect(publication.replacementAuthority).toBe(
			recordPrFeedbackPushAttemptResult,
		);
		expect(completion.replacement).not.toBe(publication.replacement);
	});
	test('a wired row without a production creator is rejected by the census guard', async () => {
		const wired =
			PR_REVIEW_EVENT_AUTHORITY_REGISTRY.base_admission_rolled_back as AuthorityEntry;
		expect(() =>
			assertWiredEntry(
				{ ...wired, productionCreator: '' },
				'synthetic-wired-row',
			),
		).toThrow(/production creator/);
		expect(() =>
			assertWiredEntry(
				{ ...wired, authority: undefined },
				'synthetic-wired-row',
			),
		).toThrow(/importable/);
		await expect(
			assertProductionCreator(
				{
					...wired,
					productionCreator:
						'src/hooks/pr-workflow-gate.ts#submitPrReviewResult',
				},
				'base_admission_rolled_back',
			),
		).rejects.toThrow(/base_admission_rolled_back/);
	});
});
