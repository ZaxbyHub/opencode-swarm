/**
 * Versioned PR-review finding synthesis and terminal projection policy.
 *
 * This is the policy boundary between authenticated lane output and the
 * terminal report/handoff projections.  It intentionally has no dependency on
 * the workflow gate so it can be exercised in isolation and reused by every
 * settlement caller.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	appendCoreEventSync,
	coreEventsFilePath,
	readCoreEvents,
} from '../events/core-events.js';
import { validateSwarmPath } from '../hooks/utils.js';
import {
	ensurePrWorkflowSafeParentDirectory,
	writeAtomicJson,
} from './persistence.js';

export const FINDING_POLICY_VERSION = 1 as const;

export type FindingSeverity =
	| 'CRITICAL'
	| 'HIGH'
	| 'MEDIUM'
	| 'LOW'
	| 'INFO'
	| 'NONE';
export type FindingAction =
	| 'route_to_reviewer'
	| 'route_to_critic'
	| 'report'
	| 'suppress_with_reason'
	| 'handoff_to_feedback';
export type FindingStatus =
	| 'UNRESOLVED'
	| 'CONFIRMED'
	| 'DISPROVED'
	| 'NON_ACTIONABLE'
	| 'PRE_EXISTING';
export type ConfidenceLabel = 'LOW' | 'MEDIUM' | 'HIGH';
export type CriticOutcome =
	| 'UPHELD'
	| 'DOWNGRADED'
	| 'DISPROVED'
	| 'NEEDS_MORE_EVIDENCE';

const CONFIDENCE_SCORE: Record<ConfidenceLabel, number> = {
	LOW: 0.35,
	MEDIUM: 0.65,
	HIGH: 0.95,
};
const CONFIDENCE_RANK: Record<ConfidenceLabel, number> = {
	LOW: 0,
	MEDIUM: 1,
	HIGH: 2,
};
const SEVERITY_RANK: Record<FindingSeverity, number> = {
	NONE: 0,
	INFO: 1,
	LOW: 2,
	MEDIUM: 3,
	HIGH: 4,
	CRITICAL: 5,
};

export interface ParsedCandidateConfidence {
	label: ConfidenceLabel;
	score: number;
}

/** Parse the version-1 categorical confidence vocabulary. */
export function parseCandidateConfidence(
	value: unknown,
): ParsedCandidateConfidence {
	if (typeof value !== 'string') {
		throw new Error(
			'Invalid candidate confidence: expected LOW, MEDIUM, or HIGH',
		);
	}
	const normalized = value.trim().toUpperCase();
	if (
		normalized !== 'LOW' &&
		normalized !== 'MEDIUM' &&
		normalized !== 'HIGH'
	) {
		throw new Error(
			`Invalid candidate confidence "${value}": expected LOW, MEDIUM, or HIGH`,
		);
	}
	return { label: normalized, score: CONFIDENCE_SCORE[normalized] };
}

export interface FindingProvenance {
	identity: string;
	lane?: string;
	[key: string]: unknown;
}

export interface FindingLocation {
	file: string;
	line: number;
	lineEnd?: number;
}

export interface FindingCandidateInput {
	finding: string;
	severity: FindingSeverity | string;
	action?: FindingAction | string;
	confidence: ConfidenceLabel | string;
	category: string;
	location: FindingLocation;
	provenance: FindingProvenance | FindingProvenance[];
	status?: FindingStatus | string;
	[key: string]: unknown;
}

export interface SynthesizedFinding {
	id: string;
	finding: string;
	severity: FindingSeverity;
	action: FindingAction;
	confidence: ConfidenceLabel;
	confidenceScore: number;
	agreementCount: number;
	category: string;
	location: FindingLocation;
	provenance: FindingProvenance[];
	status: FindingStatus;
	sourceFindingIds: string[];
}

export interface CriticSettlementRecord {
	findingId: string;
	terminal: boolean;
	status: CriticOutcome;
	finalFinding: CriticSettlementInput['finding'];
	handoffFindingIds: string[];
}

export interface FindingSynthesis {
	policyVersion: typeof FINDING_POLICY_VERSION;
	findings: SynthesizedFinding[];
	diagnostics: string[];
	criticSettlements?: CriticSettlementRecord[];
}

// Small, fixed alias set improves paraphrase matching while keeping the
// operation bounded and deterministic.  It is deliberately not an embedding
// or unbounded fuzzy-search subsystem.
const TOKEN_ALIASES: Record<string, string> = {
	authorization: 'auth',
	authorized: 'auth',
	authorise: 'auth',
	authorised: 'auth',
	permissions: 'permission',
	checking: 'check',
	checked: 'check',
	checks: 'check',
	reading: 'read',
	reads: 'read',
	requests: 'request',
	path: 'endpoint',
	skips: 'skip',
	skipped: 'skip',
	skipping: 'skip',
};
const TOKEN_STOPWORDS = new Set([
	'the',
	'and',
	'for',
	'with',
	'from',
	'evidence',
	'critic',
	'reviewer',
	'explorer',
	'rationale',
	'reason',
	'change',
	'probe',
]);

function tokens(value: string): Set<string> {
	return new Set(
		value
			.toLocaleLowerCase('en-US')
			.replace(/[^a-z0-9]+/g, ' ')
			.split(/\s+/)
			.filter((token) => token.length >= 3 && !TOKEN_STOPWORDS.has(token))
			.map((token) => TOKEN_ALIASES[token] ?? token),
	);
}

function semanticSimilarity(left: string, right: string): number {
	const a = tokens(left);
	const b = tokens(right);
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) if (b.has(token)) intersection += 1;
	return intersection / (a.size + b.size - intersection);
}

function normalizedLocation(location: FindingLocation): string {
	const file = location.file
		.replaceAll('\\', '/')
		.trim()
		.toLocaleLowerCase('en-US');
	const line = Number(location.line);
	const lineEnd =
		location.lineEnd === undefined ? line : Number(location.lineEnd);
	return `${file}:${line}-${lineEnd}`;
}

function normalizedCategory(category: string): string {
	return category.trim().toLocaleLowerCase('en-US');
}

function severity(value: unknown): FindingSeverity {
	if (
		value === 'CRITICAL' ||
		value === 'HIGH' ||
		value === 'MEDIUM' ||
		value === 'LOW' ||
		value === 'INFO' ||
		value === 'NONE'
	) {
		return value;
	}
	throw new Error(`Invalid finding severity "${String(value)}"`);
}

function action(value: unknown): FindingAction {
	if (
		value === 'route_to_reviewer' ||
		value === 'route_to_critic' ||
		value === 'report' ||
		value === 'suppress_with_reason' ||
		value === 'handoff_to_feedback'
	) {
		return value;
	}
	return 'report';
}

function status(value: unknown): FindingStatus {
	if (
		value === 'UNRESOLVED' ||
		value === 'CONFIRMED' ||
		value === 'DISPROVED' ||
		value === 'NON_ACTIONABLE' ||
		value === 'PRE_EXISTING'
	) {
		return value;
	}
	return 'UNRESOLVED';
}

const ACTION_RANK: Record<FindingAction, number> = {
	suppress_with_reason: 0,
	report: 1,
	handoff_to_feedback: 2,
	route_to_reviewer: 3,
	route_to_critic: 4,
};

const STATUS_RANK: Record<FindingStatus, number> = {
	DISPROVED: 0,
	PRE_EXISTING: 1,
	NON_ACTIONABLE: 1,
	UNRESOLVED: 2,
	CONFIRMED: 3,
};

function provenanceKey(value: FindingProvenance): string {
	// Identity denotes the independent reviewer/producer.  A retry or a
	// differently labelled lane from the same identity is not independent
	// agreement and must not increase confidence.
	return value.identity.trim();
}

function uniqueProvenance(values: FindingProvenance[]): FindingProvenance[] {
	const unique = new Map<string, FindingProvenance>();
	for (const value of values) {
		if (typeof value.identity !== 'string' || !value.identity.trim()) {
			throw new Error('Finding provenance identity must be non-empty');
		}
		const key = provenanceKey(value);
		if (!unique.has(key)) unique.set(key, { ...value });
	}
	return [...unique.values()].sort((a, b) =>
		provenanceKey(a).localeCompare(provenanceKey(b)),
	);
}

function sameFinding(
	left: FindingCandidateInput,
	right: FindingCandidateInput,
): boolean {
	if (
		normalizedCategory(left.category) !== normalizedCategory(right.category)
	) {
		return false;
	}
	if (
		normalizedLocation(left.location) !== normalizedLocation(right.location)
	) {
		return false;
	}
	if (left.finding.trim() === right.finding.trim()) return true;
	return semanticSimilarity(left.finding, right.finding) >= 0.2;
}

function findingId(value: FindingCandidateInput): string {
	const material = `${normalizedLocation(value.location)}|${normalizedCategory(value.category)}|${[...tokens(value.finding)].sort().join(',')}`;
	// FNV-1a is sufficient for a bounded ledger-local projection.  This ID is
	// not used as a cryptographic authority; source provenance remains attached.
	let hash = 2166136261;
	for (const char of material) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return `finding-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function lowestConfidence(values: ConfidenceLabel[]): ConfidenceLabel {
	return values.reduce((lowest, value) =>
		CONFIDENCE_RANK[value] < CONFIDENCE_RANK[lowest] ? value : lowest,
	);
}

/** Synthesize semantically equivalent findings and independent agreement. */
export function synthesizePrReviewFindings(input: {
	candidates: FindingCandidateInput[];
}): FindingSynthesis {
	const groups: FindingCandidateInput[][] = [];
	const diagnostics: string[] = [];
	for (const raw of input.candidates) {
		if (!raw || typeof raw !== 'object') {
			throw new Error('Finding candidate must be an object');
		}
		const candidate: FindingCandidateInput = {
			...raw,
			finding: typeof raw.finding === 'string' ? raw.finding.trim() : '',
			severity: severity(raw.severity),
			confidence: parseCandidateConfidence(raw.confidence).label,
			category: typeof raw.category === 'string' ? raw.category.trim() : '',
		};
		if (
			!candidate.finding ||
			!candidate.category ||
			!candidate.location?.file
		) {
			throw new Error(
				'Finding candidate requires non-empty finding, category, and location',
			);
		}
		const existing = groups.find((group) => sameFinding(group[0]!, candidate));
		if (existing) existing.push(candidate);
		else groups.push([candidate]);
	}

	const findings = groups.map((group) => {
		const first = group[0]!;
		const provenance = uniqueProvenance(
			group.flatMap((candidate) =>
				Array.isArray(candidate.provenance)
					? candidate.provenance
					: [candidate.provenance],
			),
		);
		const severities = group.map((candidate) => severity(candidate.severity));
		const confidenceValues = group.map(
			(candidate) => parseCandidateConfidence(candidate.confidence).label,
		);
		const finalSeverity = severities.reduce((highest, value) =>
			SEVERITY_RANK[value] > SEVERITY_RANK[highest] ? value : highest,
		);
		const confidence =
			provenance.length >= 2 ? 'HIGH' : lowestConfidence(confidenceValues);
		if (new Set(severities).size > 1 || new Set(confidenceValues).size > 1) {
			diagnostics.push(
				`conservative disagreement at ${normalizedLocation(first.location)}`,
			);
		}
		const finalAction = group
			.map((candidate) => action(candidate.action))
			.reduce((mostRestrictive, value) =>
				ACTION_RANK[value] > ACTION_RANK[mostRestrictive]
					? value
					: mostRestrictive,
			);
		const finalStatus = group
			.map((candidate) => status(candidate.status))
			.reduce((mostConservative, value) =>
				STATUS_RANK[value] > STATUS_RANK[mostConservative]
					? value
					: mostConservative,
			);
		const sourceFindingIds = [
			...new Set(
				group.flatMap((candidate) =>
					typeof candidate.sourceFindingId === 'string'
						? [candidate.sourceFindingId]
						: [],
				),
			),
		].sort();
		return {
			id: findingId(first),
			finding: first.finding,
			severity: finalSeverity,
			action: finalAction,
			confidence,
			confidenceScore: CONFIDENCE_SCORE[confidence],
			agreementCount: provenance.length,
			category: first.category,
			location: { ...first.location },
			provenance,
			status: finalStatus,
			sourceFindingIds,
		};
	});
	return { policyVersion: FINDING_POLICY_VERSION, findings, diagnostics };
}

export interface FinalPolicyFinding {
	id?: string;
	severity: FindingSeverity | string;
	action: FindingAction | string;
	status: FindingStatus | string;
	[key: string]: unknown;
}

export interface FinalPolicyCoverage {
	kind: 'base' | 'micro';
	quality: 'complete' | 'degraded' | 'partial' | 'none' | string;
	provenance?: 'valid' | 'invalid' | string;
	disclosed?: boolean;
}

export interface FinalFindingPolicyInput {
	policyVersion: number;
	finalStatus: 'COMPLETE' | 'INCOMPLETE' | string;
	coverage: FinalPolicyCoverage;
	findings: FinalPolicyFinding[];
}

export interface FinalFindingPolicyProjection {
	policyVersion: typeof FINDING_POLICY_VERSION;
	/** The registered terminal report vocabulary; no internal-only verdicts. */
	permittedVerdicts: Array<'APPROVE' | 'REQUEST_CHANGES' | 'INCOMPLETE'>;
	coverageDisposition:
		| 'COMPLETE'
		| 'PARTIAL'
		| 'DEGRADED_DISCLOSED'
		| 'INVALID_PROVENANCE'
		| 'NO_COVERAGE';
	blockingFindingIds: string[];
}

/** Project final finding status/action and coverage through policy v1. */
export function evaluateFinalFindingPolicy(
	input: FinalFindingPolicyInput,
): FinalFindingPolicyProjection {
	if (input.policyVersion !== FINDING_POLICY_VERSION) {
		throw new Error(
			`Unsupported finding policy version ${input.policyVersion}`,
		);
	}
	const invalidProvenance = input.coverage.provenance === 'invalid';
	const noCoverage =
		input.coverage.quality === 'none' ||
		(input.coverage.kind === 'base' &&
			input.coverage.quality === 'partial' &&
			input.findings.length === 0);
	const coverageDisposition: FinalFindingPolicyProjection['coverageDisposition'] =
		invalidProvenance
			? 'INVALID_PROVENANCE'
			: noCoverage
				? 'NO_COVERAGE'
				: input.coverage.quality === 'degraded' && input.coverage.disclosed
					? 'DEGRADED_DISCLOSED'
					: input.coverage.quality === 'complete'
						? 'COMPLETE'
						: 'PARTIAL';

	if (input.finalStatus !== 'COMPLETE' || invalidProvenance || noCoverage) {
		return {
			policyVersion: FINDING_POLICY_VERSION,
			permittedVerdicts: ['INCOMPLETE'],
			coverageDisposition,
			blockingFindingIds: [],
		};
	}

	const blockingFindingIds: string[] = [];
	for (const [index, value] of input.findings.entries()) {
		const currentSeverity = severity(value.severity);
		const currentStatus = String(value.status).toUpperCase();
		const currentAction = action(value.action);
		const active =
			currentStatus === 'UNRESOLVED' ||
			currentStatus === 'UNVERIFIED' ||
			currentStatus === 'CONFIRMED';
		if (!active || currentSeverity === 'NONE') {
			continue;
		}
		if (
			currentSeverity === 'CRITICAL' ||
			currentSeverity === 'HIGH' ||
			(currentSeverity === 'MEDIUM' && currentAction !== 'report')
		) {
			blockingFindingIds.push(String(value.id ?? index));
		}
	}
	if (blockingFindingIds.length > 0) {
		return {
			policyVersion: FINDING_POLICY_VERSION,
			permittedVerdicts: ['REQUEST_CHANGES', 'INCOMPLETE'],
			coverageDisposition,
			blockingFindingIds,
		};
	}
	if (
		coverageDisposition === 'DEGRADED_DISCLOSED' ||
		coverageDisposition === 'PARTIAL'
	) {
		return {
			policyVersion: FINDING_POLICY_VERSION,
			permittedVerdicts: ['REQUEST_CHANGES', 'INCOMPLETE'],
			coverageDisposition,
			blockingFindingIds,
		};
	}
	return {
		policyVersion: FINDING_POLICY_VERSION,
		permittedVerdicts: ['APPROVE', 'REQUEST_CHANGES', 'INCOMPLETE'],
		coverageDisposition,
		blockingFindingIds,
	};
}

export interface CriticSettlementInput {
	finding: {
		id: string;
		severity: FindingSeverity | string;
		action: FindingAction | string;
		status: FindingStatus | string;
	};
	outcome: CriticOutcome;
	finalSeverity?: FindingSeverity | string;
	finalAction?: FindingAction | string;
}

export interface CriticSettlement {
	terminal: boolean;
	status: CriticOutcome;
	finalFinding: CriticSettlementInput['finding'];
	handoffFindingIds: string[];
}

/** Apply critic settlement; NEEDS_MORE_EVIDENCE remains explicitly open. */
export function settleCriticFinding(
	input: CriticSettlementInput,
): CriticSettlement {
	if (input.outcome === 'NEEDS_MORE_EVIDENCE') {
		return {
			terminal: false,
			status: input.outcome,
			finalFinding: { ...input.finding },
			handoffFindingIds: [],
		};
	}
	if (input.outcome === 'DISPROVED') {
		return {
			terminal: true,
			status: input.outcome,
			finalFinding: {
				...input.finding,
				status: 'DISPROVED',
				severity: 'NONE',
				action: 'suppress_with_reason',
			},
			handoffFindingIds: [],
		};
	}
	const finalSeverity = severity(input.finalSeverity ?? input.finding.severity);
	if (input.outcome === 'UPHELD' && finalSeverity === 'NONE') {
		throw new Error('UPHELD critic finding cannot have NONE severity');
	}
	if (input.outcome === 'DOWNGRADED' && finalSeverity === 'CRITICAL') {
		throw new Error('DOWNGRADED critic finding cannot remain CRITICAL');
	}
	const finalAction = action(input.finalAction ?? input.finding.action);
	return {
		terminal: true,
		status: input.outcome,
		finalFinding: {
			...input.finding,
			severity: finalSeverity,
			action: finalAction,
		},
		handoffFindingIds:
			finalAction === 'handoff_to_feedback' &&
			input.finding.status !== 'DISPROVED'
				? [input.finding.id]
				: [],
	};
}

/**
 * Derive the feedback handoff set from the final ledger projection only.
 * Earlier reviewer/candidate records and caller-supplied IDs are deliberately
 * ignored; this keeps handoff membership tied to terminal CONFIRMED records.
 */
export function deriveFeedbackHandoffFindingIds(
	records: ReadonlyArray<{
		finding_id: string;
		status: string;
		next_action: string;
	}>,
): string[] {
	return [
		...new Set(
			records
				.filter(
					(record) =>
						record.status === 'CONFIRMED' &&
						record.next_action === 'handoff_to_feedback',
				)
				.map((record) => record.finding_id),
		),
	].sort();
}

export interface TerminalReceipt {
	id: string;
	valid: boolean;
}

export interface TerminalReadinessInput {
	baseReceipt: TerminalReceipt | null;
	reviewerReceipts: TerminalReceipt[];
	criticReceipt: TerminalReceipt | null;
	coverage: FinalPolicyCoverage;
	council: { enabled: boolean; receipt?: TerminalReceipt | null };
	criticSettlements?: Array<{ terminal: boolean; status?: CriticOutcome }>;
}

export interface TerminalReadiness {
	ready: boolean;
	blockers: string[];
	degradedCoverageDisclosed: boolean;
}

export function assessTerminalReadiness(
	input: TerminalReadinessInput,
): TerminalReadiness {
	const blockers: string[] = [];
	if (!input.baseReceipt?.valid) blockers.push('BASE_RECEIPT_MISSING');
	if (
		input.reviewerReceipts.length === 0 ||
		input.reviewerReceipts.some((receipt) => !receipt.valid)
	) {
		blockers.push('REVIEWER_RECEIPT_MISSING');
	}
	if (!input.criticReceipt?.valid) blockers.push('CRITIC_RECEIPT_MISSING');
	if (
		input.criticReceipt?.valid &&
		input.criticSettlements &&
		input.criticSettlements.length === 0
	) {
		blockers.push('CRITIC_SETTLEMENT_MISSING');
	}
	if (input.council.enabled && !input.council.receipt?.valid) {
		blockers.push('COUNCIL_RECEIPT_MISSING');
	}
	if (
		input.coverage.kind === 'micro' &&
		input.coverage.provenance === 'invalid'
	) {
		blockers.push('MICRO_PROVENANCE_INVALID');
	}
	if (input.coverage.quality === 'degraded' && !input.coverage.disclosed) {
		blockers.push('MICRO_DEGRADATION_UNDISCLOSED');
	}
	if (input.criticSettlements?.some((settlement) => !settlement.terminal)) {
		blockers.push('CRITIC_SETTLEMENT_INCOMPLETE');
	}
	return {
		ready: blockers.length === 0,
		blockers,
		degradedCoverageDisclosed:
			input.coverage.quality === 'degraded' &&
			input.coverage.provenance === 'valid' &&
			input.coverage.disclosed === true,
	};
}

export interface ReviewOutcomeRouteReceipt {
	kind: string;
	version: number;
	sessionId: string;
	taskId: string;
	[key: string]: unknown;
}

export interface PersistReviewOutcomeInput {
	projectRoot: string;
	routeReceipt: ReviewOutcomeRouteReceipt;
	synthesis: Record<string, unknown>;
}

export interface PersistReviewOutcomeResult {
	persisted: true;
	evidencePath: string;
	eventsPath: string;
}

/** Digest the exact JSON projection carried by finding-policy evidence. */
export function reviewOutcomeSynthesisDigest(synthesis: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(synthesis), 'utf8')
		.digest('hex');
}

function safeTaskId(taskId: string): string {
	const value = taskId.trim();
	if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value)) {
		throw new Error(
			'Review outcome taskId must be a bounded path-safe identifier',
		);
	}
	return value;
}

/** Persist policy evidence plus canonical, identity-only audit events. */
export async function persistReviewOutcome(
	input: PersistReviewOutcomeInput,
): Promise<PersistReviewOutcomeResult> {
	const sessionId = input.routeReceipt.sessionId.trim();
	const taskId = safeTaskId(input.routeReceipt.taskId);
	if (!sessionId) throw new Error('Review outcome sessionId must be non-empty');
	const relativeEvidence = path.join(
		'pr-review',
		taskId,
		'finding-policy.json',
	);
	const evidencePath = validateSwarmPath(input.projectRoot, relativeEvidence);
	const eventsPath = coreEventsFilePath(input.projectRoot);
	const evidence = {
		schemaVersion: FINDING_POLICY_VERSION,
		sessionId,
		taskId,
		routeReceipt: input.routeReceipt,
		synthesis: input.synthesis,
		synthesisDigest: reviewOutcomeSynthesisDigest(input.synthesis),
		persistedAt: new Date().toISOString(),
	};
	await ensurePrWorkflowSafeParentDirectory(input.projectRoot, evidencePath);
	let alreadyPersisted = false;
	try {
		const existing = JSON.parse(
			await fs.readFile(evidencePath, 'utf8'),
		) as Record<string, unknown>;
		const sameIdentity =
			existing.schemaVersion === FINDING_POLICY_VERSION &&
			existing.sessionId === sessionId &&
			existing.taskId === taskId &&
			JSON.stringify(existing.routeReceipt) ===
				JSON.stringify(input.routeReceipt) &&
			JSON.stringify(existing.synthesis) === JSON.stringify(input.synthesis) &&
			existing.synthesisDigest ===
				reviewOutcomeSynthesisDigest(input.synthesis);
		if (!sameIdentity) {
			throw new Error(
				'Review outcome already exists with conflicting route or synthesis data',
			);
		}
		alreadyPersisted = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	if (!alreadyPersisted) {
		await writeAtomicJson(input.projectRoot, evidencePath, evidence);
	}
	const events = readReviewEvents(input.projectRoot, sessionId, taskId);
	if (!events.some((event) => event.type === 'review.route.receipt')) {
		appendCoreEventSync(input.projectRoot, {
			type: 'review.route.receipt',
			sessionId,
			taskId,
			receiptVersion: input.routeReceipt.version,
		});
	}
	if (!events.some((event) => event.type === 'review.finding.synthesis')) {
		appendCoreEventSync(input.projectRoot, {
			type: 'review.finding.synthesis',
			sessionId,
			taskId,
			policyVersion: FINDING_POLICY_VERSION,
			findingCount: Array.isArray(input.synthesis.findings)
				? input.synthesis.findings.length
				: 0,
		});
	}
	return { persisted: true, evidencePath, eventsPath };
}

export interface ReadReviewOutcomeInput {
	projectRoot: string;
	sessionId: string;
	taskId: string;
}

export async function readReviewOutcome(
	input: ReadReviewOutcomeInput,
): Promise<{
	evidence: Record<string, unknown>;
	events: Array<Record<string, unknown>>;
}> {
	const taskId = safeTaskId(input.taskId);
	const evidencePath = validateSwarmPath(
		input.projectRoot,
		path.join('pr-review', taskId, 'finding-policy.json'),
	);
	const evidence = JSON.parse(
		await fs.readFile(evidencePath, 'utf8'),
	) as Record<string, unknown>;
	if (
		evidence.sessionId !== input.sessionId ||
		evidence.taskId !== taskId ||
		evidence.schemaVersion !== FINDING_POLICY_VERSION
	) {
		throw new Error('Review outcome evidence identity or schema mismatch');
	}
	if (
		!evidence.synthesis ||
		evidence.synthesisDigest !==
			reviewOutcomeSynthesisDigest(evidence.synthesis)
	) {
		throw new Error('Review outcome evidence synthesis integrity mismatch');
	}
	const events = readReviewEvents(input.projectRoot, input.sessionId, taskId);
	if (
		!events.some((event) => event.type === 'review.route.receipt') ||
		!events.some((event) => event.type === 'review.finding.synthesis')
	) {
		throw new Error('Review outcome evidence audit events are incomplete');
	}
	return { evidence, events };
}

function readReviewEvents(
	projectRoot: string,
	sessionId: string,
	taskId: string,
): Array<Record<string, unknown>> {
	const text = readCoreEvents(projectRoot).text;
	return text.split('\n').flatMap((line) => {
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			return event.sessionId === sessionId && event.taskId === taskId
				? [event]
				: [];
		} catch {
			return [];
		}
	});
}
