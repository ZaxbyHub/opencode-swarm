import { createHash, randomUUID } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { withEvidenceLock } from '../evidence/lock.js';
import { atomicWriteFile } from '../evidence/task-file.js';
import { isIdentityDigest } from './council-review-identity.js';

const VERSION = 2 as const;
const MAX_ROUND = 10;
const MAX_AUDIT_TAIL = 256 * 1024;
const STATE_AGENT = 'council-round-state';
const EXHAUSTION_EVENT_RELATIVE_PATH =
	'council/events/max-rounds-exhaustion.jsonl';

/**
 * Council round scope, keyed by the canonical council review identity
 * (issue #2102 contract B). `identityDigest` binds every round to the exact
 * review-relevant plan content and council policy it was convened under:
 * a status-only progress change keeps the identity (and therefore the
 * accepted round), while any review-relevant plan or policy change opens a
 * fresh authoritative generation under a new token. Legacy v1 files (whose
 * tokens predate identity binding) are never read — they remain on disk,
 * auditable, and are never rewritten as if they carried identity proof.
 */
export type CouncilRoundScope =
	| { kind: 'task'; taskId: string; identityDigest: string }
	| { kind: 'phase'; phaseNumber: number; identityDigest: string }
	| { kind: 'final'; identityDigest: string };
export type CouncilRoundTransition = 'stay' | 'advance' | 'close';

type AuditScope =
	| { kind: 'task'; scopeHash: string; identityDigest: string }
	| { kind: 'phase'; phaseNumber: number; identityDigest: string }
	| { kind: 'final'; scopeHash: string; identityDigest: string };

interface StateSnapshot {
	version: 2;
	identityDigest: string;
	currentRound: number;
	status: 'open' | 'closed';
	maxRoundsExhausted: boolean;
	lastAttemptId?: string;
	lastDigest?: string;
}

interface PendingAttempt {
	attemptId: string;
	digest: string;
	round: number;
	transition: CouncilRoundTransition;
	nextState: StateSnapshot;
	disposition: string;
	gateEffect: 'none' | 'blocked' | 'allowed';
	evidenceExpected: boolean;
	evidenceRef?: string;
	verdict?: 'APPROVE' | 'CONCERNS' | 'REJECT';
	quorumSize?: number;
}

interface CouncilRoundState extends StateSnapshot {
	pending?: PendingAttempt;
}

interface AttemptRecord {
	version: 2;
	event: 'received' | 'finalized' | 'recovered';
	attemptId: string;
	timestamp: string;
	scope: AuditScope;
	clientRound?: number;
	authoritativeRound: number;
	digest: string;
	sessionHash?: string;
	disposition: string;
	verdictCount: number;
	members: string[];
	transition?: CouncilRoundTransition;
	gateEffect?: 'none' | 'blocked' | 'allowed';
	verdict?: 'APPROVE' | 'CONCERNS' | 'REJECT';
	quorumSize?: number;
	evidenceRef?: string;
	nextState?: StateSnapshot;
}

export interface CouncilAttemptEvaluation {
	disposition: string;
	response: Record<string, unknown>;
	transition: CouncilRoundTransition;
	gateEffect: 'none' | 'blocked' | 'allowed';
	verdict?: 'APPROVE' | 'CONCERNS' | 'REJECT';
	quorumSize?: number;
	evidence?: {
		reference: string;
		commit: (attemptId: string) => Promise<void>;
	};
	/**
	 * Non-critical notification/reward work. It runs best-effort and at most once
	 * after the verdict, audit, and state commit; failures never change the verdict.
	 */
	afterCommit?: () => void | Promise<void>;
}

export interface CouncilAttemptInput {
	directory: string;
	scope: CouncilRoundScope;
	clientRound?: number;
	maxRounds: number;
	sessionID?: string;
	request: unknown;
	verdictCount: number;
	members: string[];
	/**
	 * True when the user explicitly configured `council.escalateOnMaxRounds`.
	 * Only this boolean reaches the durable max-rounds exhaustion event —
	 * the configured handler/webhook string itself is never persisted or
	 * logged (URL/query redaction, issue #2102 contract F). No outbound
	 * execution ever happens.
	 */
	escalationConfigured?: boolean;
	probePendingEvidence?: (
		attemptId: string,
		round: number,
		evidenceRef?: string,
	) => Promise<boolean>;
	evaluate: (authoritativeRound: number) => Promise<CouncilAttemptEvaluation>;
}

export class CouncilRoundStateUncertainError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CouncilRoundStateUncertainError';
	}
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function isRound(value: unknown): value is number {
	return (
		Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_ROUND
	);
}

function isDisposition(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 80;
}

function isEvidenceRef(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 240 &&
		value.startsWith('.swarm/') &&
		!value.includes('..')
	);
}

function scopeToken(scope: CouncilRoundScope): string {
	if (scope.kind === 'task') {
		if (!/^\d+\.\d+(\.\d+)*$/.test(scope.taskId)) {
			throw new Error('invalid task council scope');
		}
		if (!isIdentityDigest(scope.identityDigest)) {
			throw new Error('invalid task council scope identity');
		}
		return `task-${sha256(
			JSON.stringify({
				k: 'task',
				taskId: scope.taskId,
				id: scope.identityDigest,
			}),
		)}`;
	}
	if (scope.kind === 'phase') {
		if (
			!Number.isInteger(scope.phaseNumber) ||
			scope.phaseNumber < 1 ||
			scope.phaseNumber > 1000
		) {
			throw new Error('invalid phase council scope');
		}
		if (!isIdentityDigest(scope.identityDigest)) {
			throw new Error('invalid phase council scope identity');
		}
		return `phase-${sha256(
			JSON.stringify({
				k: 'phase',
				phaseNumber: scope.phaseNumber,
				id: scope.identityDigest,
			}),
		)}`;
	}
	if (!isIdentityDigest(scope.identityDigest)) {
		throw new Error('invalid final council scope identity');
	}
	return `final-${sha256(JSON.stringify({ k: 'final', id: scope.identityDigest }))}`;
}

function auditScope(scope: CouncilRoundScope): AuditScope {
	// Validate before deriving the bounded representation.
	scopeToken(scope);
	if (scope.kind === 'task') {
		return {
			kind: 'task',
			scopeHash: sha256(scope.taskId),
			identityDigest: scope.identityDigest,
		};
	}
	if (scope.kind === 'phase') {
		return {
			kind: 'phase',
			phaseNumber: scope.phaseNumber,
			identityDigest: scope.identityDigest,
		};
	}
	return {
		kind: 'final',
		scopeHash: sha256(scope.identityDigest),
		identityDigest: scope.identityDigest,
	};
}

function sameAuditScope(left: AuditScope, right: AuditScope): boolean {
	if (left.kind !== right.kind) return false;
	if (left.identityDigest !== right.identityDigest) return false;
	if (left.kind === 'phase' && right.kind === 'phase') {
		return left.phaseNumber === right.phaseNumber;
	}
	if (left.kind !== 'phase' && right.kind !== 'phase') {
		return left.scopeHash === right.scopeHash;
	}
	return false;
}

export function councilRoundStatePaths(
	directory: string,
	scope: CouncilRoundScope,
): { state: string; audit: string; lock: string } {
	const token = scopeToken(scope);
	return {
		state: join(directory, '.swarm', 'council', 'round-state', `${token}.json`),
		audit: join(directory, '.swarm', 'council', 'attempts', `${token}.jsonl`),
		lock: join('council', 'round-state', `${token}.json`),
	};
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			if (
				key === 'working_directory' ||
				key === 'roundNumber' ||
				key === 'provenanceAgentName' ||
				key === 'provenanceSessionId'
			) {
				continue;
			}
			result[key] = canonicalize((value as Record<string, unknown>)[key]);
		}
		return result;
	}
	return value;
}

export function councilRequestDigest(request: unknown, round: number): string {
	return sha256(JSON.stringify({ round, request: canonicalize(request) }));
}

function isSnapshot(value: unknown): value is StateSnapshot {
	if (!value || typeof value !== 'object') return false;
	const state = value as Partial<StateSnapshot>;
	return (
		state.version === VERSION &&
		isIdentityDigest(state.identityDigest) &&
		isRound(state.currentRound) &&
		(state.status === 'open' || state.status === 'closed') &&
		typeof state.maxRoundsExhausted === 'boolean' &&
		(state.lastAttemptId === undefined || isUuid(state.lastAttemptId)) &&
		(state.lastDigest === undefined || isDigest(state.lastDigest)) &&
		(state.lastAttemptId === undefined) === (state.lastDigest === undefined)
	);
}

function isTransition(value: unknown): value is CouncilRoundTransition {
	return value === 'stay' || value === 'advance' || value === 'close';
}

function isGateEffect(value: unknown): value is 'none' | 'blocked' | 'allowed' {
	return value === 'none' || value === 'blocked' || value === 'allowed';
}

function isVerdict(value: unknown): value is 'APPROVE' | 'CONCERNS' | 'REJECT' {
	return value === 'APPROVE' || value === 'CONCERNS' || value === 'REJECT';
}

function auditTransitionIsConsistent(record: AttemptRecord): boolean {
	if (!record.nextState || !record.transition) return false;
	if (record.transition === 'close') {
		return (
			record.nextState.status === 'closed' &&
			record.nextState.currentRound === record.authoritativeRound
		);
	}
	if (record.transition === 'stay') {
		if (
			record.nextState.status === 'closed' &&
			![
				'duplicate_submission',
				'council_round_closed',
				'council_round_mismatch',
			].includes(record.disposition)
		) {
			return false;
		}
		return (
			(record.nextState.status === 'open' ||
				record.nextState.status === 'closed') &&
			record.nextState.currentRound === record.authoritativeRound
		);
	}
	return (
		record.nextState.status === 'open' &&
		((record.nextState.currentRound === record.authoritativeRound + 1 &&
			record.nextState.maxRoundsExhausted === false) ||
			(record.nextState.currentRound === record.authoritativeRound &&
				record.nextState.maxRoundsExhausted === true))
	);
}

function recoverAuditHistory(
	tail: AuditTail,
	identityDigest: string,
): StateSnapshot | undefined {
	let current: StateSnapshot | undefined = tail.truncated
		? undefined
		: initialState(identityDigest);
	let awaiting: AttemptRecord | undefined;
	let sawTransition = false;
	for (const record of tail.records) {
		if (record.event === 'received') {
			if (awaiting) {
				throw new CouncilRoundStateUncertainError(
					'council audit contains overlapping attempts',
				);
			}
			if (
				(current && record.authoritativeRound !== current.currentRound) ||
				(!current && !tail.truncated && record.authoritativeRound !== 1)
			) {
				throw new CouncilRoundStateUncertainError(
					'council audit round history is not monotonic',
				);
			}
			awaiting = record;
			continue;
		}

		if (!record.nextState || !record.transition) {
			throw new CouncilRoundStateUncertainError(
				'council audit transition is incomplete',
			);
		}
		if (awaiting) {
			if (
				awaiting.attemptId !== record.attemptId ||
				awaiting.digest !== record.digest ||
				awaiting.authoritativeRound !== record.authoritativeRound
			) {
				throw new CouncilRoundStateUncertainError(
					'council audit attempt pairing is inconsistent',
				);
			}
			awaiting = undefined;
		} else if (!tail.truncated || sawTransition) {
			throw new CouncilRoundStateUncertainError(
				'council audit transition has no matching received record',
			);
		}

		if (current) {
			if (record.authoritativeRound !== current.currentRound) {
				throw new CouncilRoundStateUncertainError(
					'council audit transition regresses the authoritative round',
				);
			}
			if (
				record.transition === 'stay' &&
				record.nextState.status !== current.status
			) {
				throw new CouncilRoundStateUncertainError(
					'council audit stay transition changes scope status',
				);
			}
			if (
				(record.transition === 'stay' || record.transition === 'close') &&
				record.nextState.maxRoundsExhausted !== current.maxRoundsExhausted
			) {
				throw new CouncilRoundStateUncertainError(
					'council audit changes exhaustion without advancing',
				);
			}
			if (
				current.status === 'closed' &&
				(record.transition !== 'stay' || record.nextState.status !== 'closed')
			) {
				throw new CouncilRoundStateUncertainError(
					'council audit reopens a closed scope',
				);
			}
		}
		current = record.nextState;
		sawTransition = true;
	}
	if (awaiting) {
		throw new CouncilRoundStateUncertainError(
			'council audit ends with an unresolved received attempt',
		);
	}
	return current;
}

function pendingMatchesParent(
	state: CouncilRoundState,
	pending: PendingAttempt,
): boolean {
	if (state.status !== 'open' || pending.round !== state.currentRound)
		return false;
	if (
		pending.nextState.lastAttemptId !== pending.attemptId ||
		pending.nextState.lastDigest !== pending.digest
	) {
		return false;
	}
	if (pending.transition === 'stay') {
		return (
			pending.nextState.status === 'open' &&
			pending.nextState.currentRound === state.currentRound &&
			pending.nextState.maxRoundsExhausted === state.maxRoundsExhausted
		);
	}
	if (pending.transition === 'close') {
		return (
			pending.nextState.status === 'closed' &&
			pending.nextState.currentRound === state.currentRound &&
			pending.nextState.maxRoundsExhausted === state.maxRoundsExhausted
		);
	}
	return (
		pending.nextState.status === 'open' &&
		((pending.nextState.currentRound === state.currentRound + 1 &&
			pending.nextState.maxRoundsExhausted === false) ||
			(pending.nextState.currentRound === state.currentRound &&
				pending.nextState.maxRoundsExhausted === true))
	);
}

function parseState(
	raw: string,
	expectedIdentityDigest: string,
): CouncilRoundState {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new CouncilRoundStateUncertainError('council round state is corrupt');
	}
	if (!isSnapshot(value)) {
		throw new CouncilRoundStateUncertainError('council round state is invalid');
	}
	const state = value as CouncilRoundState;
	if (state.identityDigest !== expectedIdentityDigest) {
		throw new CouncilRoundStateUncertainError(
			'council round state identity does not match the request scope',
		);
	}
	if (state.pending) {
		const pending = state.pending;
		if (
			!isUuid(pending.attemptId) ||
			!isDigest(pending.digest) ||
			!isRound(pending.round) ||
			!isSnapshot(pending.nextState) ||
			!isTransition(pending.transition) ||
			!isDisposition(pending.disposition) ||
			!isGateEffect(pending.gateEffect) ||
			typeof pending.evidenceExpected !== 'boolean' ||
			pending.evidenceExpected !== (pending.evidenceRef !== undefined) ||
			(pending.evidenceRef !== undefined &&
				!isEvidenceRef(pending.evidenceRef)) ||
			(pending.verdict !== undefined && !isVerdict(pending.verdict)) ||
			(pending.quorumSize !== undefined &&
				(!Number.isInteger(pending.quorumSize) ||
					pending.quorumSize < 0 ||
					pending.quorumSize > 5)) ||
			(pending.verdict === undefined) !== (pending.quorumSize === undefined) ||
			!pendingMatchesParent(state, pending)
		) {
			throw new CouncilRoundStateUncertainError(
				'pending council state is invalid',
			);
		}
	}
	return state;
}

function parseAuditRecord(
	line: string,
	expectedScope: AuditScope,
): AttemptRecord {
	try {
		const record = JSON.parse(line) as AttemptRecord;
		if (
			record.version !== VERSION ||
			!['received', 'finalized', 'recovered'].includes(record.event) ||
			!isUuid(record.attemptId) ||
			typeof record.timestamp !== 'string' ||
			record.timestamp.length > 40 ||
			!Number.isFinite(Date.parse(record.timestamp)) ||
			!sameAuditScope(record.scope, expectedScope) ||
			(record.clientRound !== undefined && !isRound(record.clientRound)) ||
			!isRound(record.authoritativeRound) ||
			!isDigest(record.digest) ||
			(record.sessionHash !== undefined && !isDigest(record.sessionHash)) ||
			!isDisposition(record.disposition) ||
			!Number.isInteger(record.verdictCount) ||
			record.verdictCount < 0 ||
			record.verdictCount > 5 ||
			!Array.isArray(record.members) ||
			record.members.length > 5 ||
			record.members.some(
				(member) =>
					typeof member !== 'string' ||
					member.length === 0 ||
					member.length > 32,
			) ||
			new Set(record.members).size !== record.members.length
		) {
			throw new Error('invalid');
		}
		if (record.event === 'received') {
			if (
				record.disposition !== 'received' ||
				record.transition !== undefined ||
				record.gateEffect !== undefined ||
				record.nextState !== undefined ||
				record.evidenceRef !== undefined
			) {
				throw new Error('invalid');
			}
		} else if (
			!isTransition(record.transition) ||
			!isGateEffect(record.gateEffect) ||
			!isSnapshot(record.nextState) ||
			record.nextState.lastAttemptId !== record.attemptId ||
			record.nextState.lastDigest !== record.digest ||
			!auditTransitionIsConsistent(record)
		) {
			throw new Error('invalid');
		}
		if (record.verdict !== undefined && !isVerdict(record.verdict)) {
			throw new Error('invalid');
		}
		if (
			record.quorumSize !== undefined &&
			(!Number.isInteger(record.quorumSize) ||
				record.quorumSize < 0 ||
				record.quorumSize > 5)
		) {
			throw new Error('invalid');
		}
		if ((record.verdict === undefined) !== (record.quorumSize === undefined)) {
			throw new Error('invalid');
		}
		if (
			record.evidenceRef !== undefined &&
			!isEvidenceRef(record.evidenceRef)
		) {
			throw new Error('invalid');
		}
		return record;
	} catch {
		throw new CouncilRoundStateUncertainError(
			'council attempt audit is corrupt',
		);
	}
}

function appendAudit(path: string, record: AttemptRecord): void {
	mkdirSync(dirname(path), { recursive: true });
	const descriptor = openSync(path, 'a');
	try {
		writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8');
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

interface AuditTail {
	records: AttemptRecord[];
	truncated: boolean;
}

function readAuditTail(path: string, scope: CouncilRoundScope): AuditTail {
	if (!existsSync(path)) return { records: [], truncated: false };
	const size = statSync(path).size;
	if (size === 0) return { records: [], truncated: false };
	const offset = Math.max(0, size - MAX_AUDIT_TAIL);
	const length = size - offset;
	const descriptor = openSync(path, 'r');
	const buffer = Buffer.alloc(length);
	try {
		readSync(descriptor, buffer, 0, length, offset);
	} finally {
		closeSync(descriptor);
	}
	let text = buffer.toString('utf8');
	if (!text.endsWith('\n')) {
		throw new CouncilRoundStateUncertainError(
			'council attempt audit has a partial tail',
		);
	}
	if (offset > 0) {
		const firstNewline = text.indexOf('\n');
		if (firstNewline < 0) {
			throw new CouncilRoundStateUncertainError(
				'council attempt audit tail is oversized',
			);
		}
		text = text.slice(firstNewline + 1);
	}
	const expectedScope = auditScope(scope);
	return {
		records: text
			.split('\n')
			.filter(Boolean)
			.map((line) => parseAuditRecord(line, expectedScope)),
		truncated: offset > 0,
	};
}

function initialState(identityDigest: string): CouncilRoundState {
	return {
		version: VERSION,
		identityDigest,
		currentRound: 1,
		status: 'open',
		maxRoundsExhausted: false,
	};
}

function snapshot(state: CouncilRoundState): StateSnapshot {
	return {
		version: VERSION,
		identityDigest: state.identityDigest,
		currentRound: state.currentRound,
		status: state.status,
		maxRoundsExhausted: state.maxRoundsExhausted,
		lastAttemptId: state.lastAttemptId,
		lastDigest: state.lastDigest,
	};
}

function sameSnapshot(left: StateSnapshot, right: StateSnapshot): boolean {
	return (
		left.version === right.version &&
		left.currentRound === right.currentRound &&
		left.status === right.status &&
		left.maxRoundsExhausted === right.maxRoundsExhausted &&
		left.lastAttemptId === right.lastAttemptId &&
		left.lastDigest === right.lastDigest
	);
}

function pendingTerminalMatches(
	state: CouncilRoundState,
	record: AttemptRecord,
): boolean {
	const pending = state.pending;
	if (
		!pending ||
		record.attemptId !== pending.attemptId ||
		record.digest !== pending.digest ||
		record.authoritativeRound !== pending.round ||
		!record.nextState
	) {
		return false;
	}
	if (record.event === 'finalized') {
		return (
			record.disposition === pending.disposition &&
			record.transition === pending.transition &&
			record.gateEffect === pending.gateEffect &&
			record.verdict === pending.verdict &&
			record.quorumSize === pending.quorumSize &&
			record.evidenceRef === pending.evidenceRef &&
			sameSnapshot(record.nextState, pending.nextState)
		);
	}
	if (record.event !== 'recovered') return false;
	if (record.disposition === 'pending_evidence_recovered') {
		return (
			record.transition === pending.transition &&
			record.gateEffect === pending.gateEffect &&
			record.verdict === pending.verdict &&
			record.quorumSize === pending.quorumSize &&
			record.evidenceRef === pending.evidenceRef &&
			sameSnapshot(record.nextState, pending.nextState)
		);
	}
	if (record.disposition !== 'orphan_recovered') return false;
	return (
		record.transition === 'stay' &&
		record.gateEffect === 'none' &&
		record.verdict === pending.verdict &&
		record.quorumSize === pending.quorumSize &&
		record.evidenceRef === pending.evidenceRef &&
		sameSnapshot(record.nextState, {
			...snapshot(state),
			lastAttemptId: pending.attemptId,
			lastDigest: pending.digest,
		})
	);
}

function transitionState(
	state: CouncilRoundState,
	attemptId: string,
	digest: string,
	transition: CouncilRoundTransition,
	maxRounds: number,
): StateSnapshot {
	const configuredLimit = Math.max(1, Math.min(MAX_ROUND, maxRounds));
	// A later config reduction must never move persisted authority backwards.
	const limit = Math.max(state.currentRound, configuredLimit);
	let currentRound = state.currentRound;
	let status: 'open' | 'closed' = 'open';
	let maxRoundsExhausted = state.maxRoundsExhausted;
	if (transition === 'advance') {
		if (currentRound < limit) {
			currentRound++;
			maxRoundsExhausted = false;
		} else {
			maxRoundsExhausted = true;
		}
	} else if (transition === 'close') {
		status = 'closed';
	}
	return {
		version: VERSION,
		identityDigest: state.identityDigest,
		currentRound,
		status,
		maxRoundsExhausted,
		lastAttemptId: attemptId,
		lastDigest: digest,
	};
}

async function writeState(
	path: string,
	state: CouncilRoundState,
): Promise<void> {
	mkdirSync(dirname(path), { recursive: true });
	await _internals.atomicWrite(path, JSON.stringify(state, null, 2));
}

function baseRecord(
	input: CouncilAttemptInput,
	attemptId: string,
	digest: string,
	round: number,
	disposition: string,
): Omit<AttemptRecord, 'event'> {
	return {
		version: VERSION,
		attemptId,
		timestamp: _internals.now(),
		scope: auditScope(input.scope),
		clientRound: input.clientRound,
		authoritativeRound: round,
		digest,
		sessionHash: input.sessionID ? sha256(input.sessionID) : undefined,
		disposition: disposition.slice(0, 80),
		verdictCount: Math.max(0, Math.min(5, input.verdictCount)),
		members: input.members.slice(0, 5).map((member) => member.slice(0, 32)),
	};
}

function latestRecord(
	records: AttemptRecord[],
	attemptId: string,
): AttemptRecord | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		if (records[index]?.attemptId === attemptId) return records[index];
	}
	return undefined;
}

async function loadState(
	paths: ReturnType<typeof councilRoundStatePaths>,
	scope: CouncilRoundScope,
): Promise<CouncilRoundState> {
	if (existsSync(paths.state))
		return parseState(readFileSync(paths.state, 'utf8'), scope.identityDigest);
	const tail = _internals.readAuditTail(paths.audit, scope);
	const records = tail.records;
	const recovered = recoverAuditHistory(tail, scope.identityDigest);
	if (tail.truncated && !recovered) {
		throw new CouncilRoundStateUncertainError(
			'council state is missing and the bounded audit tail has no recoverable transition',
		);
	}
	if (!recovered && records.length > 0) {
		throw new CouncilRoundStateUncertainError(
			'council state is missing and the audit has no complete transition',
		);
	}
	const state = recovered ?? initialState(scope.identityDigest);
	await writeState(paths.state, state);
	return state;
}

function persistenceFailure(round: number, error: unknown): string {
	return JSON.stringify(
		{
			success: false,
			reason: 'council_round_state_persistence_failed',
			authoritativeRound: round,
			message: error instanceof Error ? error.message : String(error),
		},
		null,
		2,
	);
}

function uncertainFailure(error: unknown): string {
	return JSON.stringify(
		{
			success: false,
			reason: 'council_round_state_uncertain',
			message: error instanceof Error ? error.message : String(error),
		},
		null,
		2,
	);
}

/**
 * Append one bounded, durable max-rounds exhaustion event (issue #2102
 * contract F / #1650). Emitted only on the false→true exhaustion transition
 * so repeated submissions cannot flood the log. The configured
 * `escalateOnMaxRounds` handler/webhook string is NEVER persisted or logged —
 * only this boolean is recorded — and no outbound execution ever happens.
 * Best-effort: failures are logged non-fatally and never change the verdict.
 */
async function recordMaxRoundsExhaustionEvent(
	directory: string,
	input: CouncilAttemptInput,
	round: number,
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT' | undefined,
	options?: { onlyIfMissing?: boolean },
): Promise<void> {
	await _internals.withLock(
		directory,
		EXHAUSTION_EVENT_RELATIVE_PATH,
		STATE_AGENT,
		'exhaustion-event',
		async () => {
			const path = join(directory, '.swarm', EXHAUSTION_EVENT_RELATIVE_PATH);
			const record = {
				version: VERSION,
				type: 'max_rounds_exhausted',
				timestamp: _internals.now(),
				level: input.scope.kind,
				scopeToken: scopeToken(input.scope),
				identityDigest: input.scope.identityDigest,
				round,
				...(verdict !== undefined ? { verdict } : {}),
				escalationConfigured: input.escalationConfigured === true,
			};
			mkdirSync(dirname(path), { recursive: true });
			if (options?.onlyIfMissing && hasExhaustionEvent(path, record)) {
				return;
			}
			const descriptor = openSync(path, 'a');
			try {
				writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8');
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
		},
	);
}

/**
 * Reader-side check used by the recovery path: does the events file already
 * carry an exhaustion event for this scope token + round? Tolerates a torn
 * trailing line (diagnostics-grade artifact): unparseable lines are skipped,
 * never fatal.
 */
function hasExhaustionEvent(
	path: string,
	record: { scopeToken: string; round: number },
): boolean {
	try {
		const lines = readFileSync(path, 'utf8').split('\n');
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as {
					type?: unknown;
					scopeToken?: unknown;
					round?: unknown;
				};
				if (
					parsed.type === 'max_rounds_exhausted' &&
					parsed.scopeToken === record.scopeToken &&
					parsed.round === record.round
				) {
					return true;
				}
			} catch {
				// Torn/partial line — skip; diagnostics-grade tolerance.
			}
		}
		return false;
	} catch {
		return false;
	}
}

export async function runCouncilAttempt(
	input: CouncilAttemptInput,
): Promise<string> {
	const paths = councilRoundStatePaths(input.directory, input.scope);
	let authoritativeRound = 1;
	try {
		return await _internals.withLock(
			input.directory,
			paths.lock,
			STATE_AGENT,
			scopeToken(input.scope),
			async () => {
				let state = await loadState(paths, input.scope);
				if (state.pending) {
					const tail = _internals.readAuditTail(paths.audit, input.scope);
					const latest = latestRecord(tail.records, state.pending.attemptId);
					if (tail.truncated && !latest) {
						throw new CouncilRoundStateUncertainError(
							'pending council attempt is outside the bounded audit tail',
						);
					}
					if (!latest) {
						throw new CouncilRoundStateUncertainError(
							'pending council attempt has no matching audit record',
						);
					}
					if (
						(latest.event === 'finalized' || latest.event === 'recovered') &&
						latest.nextState
					) {
						if (!pendingTerminalMatches(state, latest)) {
							throw new CouncilRoundStateUncertainError(
								'terminal council audit contradicts pending state',
							);
						}
						state = latest.nextState;
					} else {
						const committed =
							state.pending.evidenceExpected && input.probePendingEvidence
								? await input.probePendingEvidence(
										state.pending.attemptId,
										state.pending.round,
										state.pending.evidenceRef,
									)
								: false;
						const recovered = committed
							? state.pending.nextState
							: {
									...snapshot(state),
									lastAttemptId: state.pending.attemptId,
									lastDigest: state.pending.digest,
								};
						_internals.appendAudit(paths.audit, {
							...baseRecord(
								input,
								state.pending.attemptId,
								state.pending.digest,
								state.pending.round,
								committed ? 'pending_evidence_recovered' : 'orphan_recovered',
							),
							event: 'recovered',
							transition: committed ? state.pending.transition : 'stay',
							gateEffect: committed ? state.pending.gateEffect : 'none',
							verdict: state.pending.verdict,
							quorumSize: state.pending.quorumSize,
							evidenceRef: state.pending.evidenceRef,
							nextState: recovered,
						});
						state = recovered;
					}
					await writeState(paths.state, state);
				}

				// Recovery-side exhaustion-event closure (PRR-020): if the
				// authoritative state is already exhausted, make sure the
				// durable event exists — a crash between writeState(next) and
				// the original best-effort event write would otherwise lose it
				// forever (the false→true transition cannot re-fire). The
				// reader-side check dedupes, so this is idempotent. Best-effort
				// and non-fatal, like the original emission.
				if (state.maxRoundsExhausted) {
					try {
						await recordMaxRoundsExhaustionEvent(
							input.directory,
							input,
							state.currentRound,
							undefined,
							{ onlyIfMissing: true },
						);
					} catch {
						// Diagnostics-grade: never changes the verdict.
					}
				}

				authoritativeRound = state.currentRound;
				const digest = councilRequestDigest(input.request, authoritativeRound);
				const attemptId = _internals.uuid();
				const received = baseRecord(
					input,
					attemptId,
					digest,
					authoritativeRound,
					'received',
				);
				_internals.appendAudit(paths.audit, { ...received, event: 'received' });

				if (
					input.clientRound !== undefined &&
					input.clientRound !== authoritativeRound
				) {
					const next = {
						...snapshot(state),
						lastAttemptId: attemptId,
						lastDigest: digest,
					};
					_internals.appendAudit(paths.audit, {
						...received,
						event: 'finalized',
						disposition: 'council_round_mismatch',
						transition: 'stay',
						gateEffect: 'none',
						nextState: next,
					});
					await writeState(paths.state, next);
					return JSON.stringify(
						{
							success: false,
							reason: 'council_round_mismatch',
							authoritativeRound,
							submittedRound: input.clientRound,
						},
						null,
						2,
					);
				}

				if (state.status === 'closed') {
					const disposition =
						state.lastDigest === digest
							? 'duplicate_submission'
							: 'council_round_closed';
					const next = {
						...snapshot(state),
						lastAttemptId: attemptId,
						lastDigest: digest,
					};
					_internals.appendAudit(paths.audit, {
						...received,
						event: 'finalized',
						disposition,
						transition: 'stay',
						gateEffect: 'none',
						nextState: next,
					});
					await writeState(paths.state, next);
					return JSON.stringify(
						{ success: false, reason: disposition, authoritativeRound },
						null,
						2,
					);
				}

				let evaluation: CouncilAttemptEvaluation;
				try {
					evaluation = await input.evaluate(authoritativeRound);
				} catch (error) {
					evaluation = {
						disposition: 'council_evaluation_failed',
						response: {
							success: false,
							reason: 'council_evaluation_failed',
							message: error instanceof Error ? error.message : String(error),
						},
						transition: 'stay',
						gateEffect: 'none',
					};
				}
				const next = transitionState(
					state,
					attemptId,
					digest,
					evaluation.transition,
					input.maxRounds,
				);
				const pending: PendingAttempt = {
					attemptId,
					digest,
					round: authoritativeRound,
					transition: evaluation.transition,
					nextState: next,
					disposition: evaluation.disposition.slice(0, 80),
					gateEffect: evaluation.gateEffect,
					evidenceExpected: Boolean(evaluation.evidence),
					evidenceRef: evaluation.evidence?.reference.slice(0, 240),
					verdict: evaluation.verdict,
					quorumSize: evaluation.quorumSize,
				};
				try {
					await writeState(paths.state, { ...snapshot(state), pending });
				} catch (error) {
					const failed = {
						...snapshot(state),
						lastAttemptId: attemptId,
						lastDigest: digest,
					};
					// Pair the already-durable received record before surfacing the
					// persistence failure. This prevents a later attempt from creating
					// overlapping audit history if the snapshot is subsequently lost.
					_internals.appendAudit(paths.audit, {
						...received,
						event: 'finalized',
						disposition: 'council_pending_state_write_failed',
						transition: 'stay',
						gateEffect: 'none',
						nextState: failed,
					});
					try {
						await writeState(paths.state, failed);
					} catch {
						// The paired audit is sufficient for snapshot-loss recovery.
					}
					throw error;
				}
				await evaluation.evidence?.commit(attemptId);
				_internals.appendAudit(paths.audit, {
					...received,
					event: 'finalized',
					disposition: evaluation.disposition.slice(0, 80),
					transition: evaluation.transition,
					gateEffect: evaluation.gateEffect,
					verdict: evaluation.verdict,
					quorumSize: evaluation.quorumSize,
					evidenceRef: evaluation.evidence?.reference.slice(0, 240),
					nextState: next,
				});
				await writeState(paths.state, next);
				if (!state.maxRoundsExhausted && next.maxRoundsExhausted) {
					// Durable exhaustion signal (#2102 contract F): best-effort,
					// never changes the verdict, never executes anything outbound.
					try {
						await recordMaxRoundsExhaustionEvent(
							input.directory,
							input,
							authoritativeRound,
							evaluation.verdict,
						);
					} catch (eventError) {
						// Non-fatal: the verdict, audit, and state are already durable.
						// Intentionally no payload logging — the event record is what
						// would carry escalation hints, and it simply was not written.
						void eventError;
					}
				}
				try {
					await evaluation.afterCommit?.();
				} catch {
					// Non-critical reward/advisory side effects never change the verdict.
				}
				return JSON.stringify(
					{
						...evaluation.response,
						authoritativeRound,
						nextRound: next.currentRound,
						maxRoundsExhausted: next.maxRoundsExhausted,
						...(next.maxRoundsExhausted
							? {
									escalationRequired: true,
									escalationMessage:
										'Max council rounds exhausted without an accepting verdict — surface the unified feedback to the user and escalate; do not auto-advance.',
								}
							: {}),
					},
					null,
					2,
				);
			},
		);
	} catch (error) {
		await recordUnscopedCouncilAttempt(
			input.directory,
			input.scope.kind,
			error instanceof CouncilRoundStateUncertainError
				? 'council_round_state_uncertain'
				: 'council_round_state_persistence_failed',
			input.request,
			[],
			input.sessionID,
		);
		if (error instanceof CouncilRoundStateUncertainError)
			return uncertainFailure(error);
		return persistenceFailure(authoritativeRound, error);
	}
}

export async function recordUnscopedCouncilAttempt(
	directory: string,
	level: 'task' | 'phase' | 'final',
	disposition: string,
	raw: unknown,
	issues: Array<{ path: Array<PropertyKey>; code: string }>,
	sessionID?: string,
): Promise<string | null> {
	const path = join(
		directory,
		'.swarm',
		'council',
		'attempts',
		'unscoped.jsonl',
	);
	const known =
		raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const fingerprint = sha256(
		JSON.stringify({
			level,
			taskIdType: typeof known.taskId,
			phaseType: typeof known.phase,
			phaseNumberType: typeof known.phaseNumber,
			roundNumberType: typeof known.roundNumber,
			verdictCount: Array.isArray(known.verdicts)
				? Math.min(6, known.verdicts.length)
				: -1,
			issues: issues.slice(0, 20).map((issue) => ({
				path: issue.path.slice(0, 8).map(String),
				code: issue.code.slice(0, 40),
			})),
		}),
	);
	try {
		await _internals.withLock(
			directory,
			join('council', 'attempts', 'unscoped.jsonl'),
			STATE_AGENT,
			'unscoped',
			async () => {
				mkdirSync(dirname(path), { recursive: true });
				const descriptor = openSync(path, 'a');
				try {
					writeSync(
						descriptor,
						`${JSON.stringify({
							version: VERSION,
							event: 'unscoped',
							attemptId: _internals.uuid(),
							timestamp: _internals.now(),
							level,
							disposition: disposition.slice(0, 80),
							fingerprint,
							sessionHash: sessionID ? sha256(sessionID) : undefined,
						})}\n`,
						undefined,
						'utf8',
					);
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
			},
		);
		return null;
	} catch (error) {
		return persistenceFailure(1, error);
	}
}

export const _internals = {
	now: (): string => new Date().toISOString(),
	uuid: randomUUID,
	appendAudit,
	readAuditTail,
	atomicWrite: atomicWriteFile,
	withLock: withEvidenceLock,
};
