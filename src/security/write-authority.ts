import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { transactFile } from '../hooks/knowledge-store.js';
import { atomicWriteSwarmFile } from '../utils/atomic-write.js';
import { isPolicyProtectedPath } from './protected-path-policy.js';

export type WriteAuthorityOrigin =
	| 'autonomous'
	| 'optimizer_proposed'
	| 'critic_approved'
	| 'human_approved';

export type WriteApprovalAction = 'skill_improve';

export interface WriteApprovalRequest {
	targetSessionId: string;
	action: WriteApprovalAction;
	candidateId: string;
	candidateContentHash: string;
	allowedPathDigest?: string;
	generation?: number;
}

export interface WriteApprovalFactV1 extends WriteApprovalRequest {
	v: 1;
	id: string;
	issuingSessionId: string;
	issuedByCommand: 'approve-write';
	issuedAt: string;
	expiresAt: string;
}

interface IssuedLedgerEntry {
	kind: 'issued';
	fact: WriteApprovalFactV1;
}

interface ConsumedLedgerEntry {
	kind: 'consumed';
	factId: string;
	consumedAt: string;
	consumerSessionId: string;
}

type LedgerEntry = IssuedLedgerEntry | ConsumedLedgerEntry;

export interface WriteAuthorityContext {
	origin: WriteAuthorityOrigin;
	fact?: WriteApprovalFactV1;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_LEDGER_ENTRIES = 512;
const SHA256_RE = /^[a-f0-9]{64}$/;
const WRITE_APPROVAL_LEDGER_RELATIVE_PATH =
	'.swarm/authority/write-approvals.jsonl';

function formatTimestampIsoUtc(epochMs: number): string {
	const stamp = new Date(epochMs);
	const year = String(stamp.getUTCFullYear()).padStart(4, '0');
	const month = String(stamp.getUTCMonth() + 1).padStart(2, '0');
	const day = String(stamp.getUTCDate()).padStart(2, '0');
	const hour = String(stamp.getUTCHours()).padStart(2, '0');
	const minute = String(stamp.getUTCMinutes()).padStart(2, '0');
	const second = String(stamp.getUTCSeconds()).padStart(2, '0');
	const millisecond = String(stamp.getUTCMilliseconds()).padStart(3, '0');
	return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
}

interface AuthorityExtent {
	context: WriteAuthorityContext;
	active: boolean;
}
const authorityStore = new AsyncLocalStorage<AuthorityExtent>();
const consumedAuthorityFacts = new WeakSet<WriteApprovalFactV1>();

const ORIGIN_RANK: Record<WriteAuthorityOrigin, number> = {
	autonomous: 0,
	optimizer_proposed: 1,
	critic_approved: 2,
	human_approved: 3,
};

function ledgerPath(directory: string): string {
	if (!isPolicyProtectedPath(WRITE_APPROVAL_LEDGER_RELATIVE_PATH)) {
		throw new Error(
			'write approval ledger path must remain centrally protected',
		);
	}
	return path.join(directory, WRITE_APPROVAL_LEDGER_RELATIVE_PATH);
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => a.localeCompare(b));
		return `{${entries
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function ledgerRead(filePath: string): Promise<LedgerEntry[]> {
	if (!existsSync(filePath)) return Promise.resolve([]);
	const entries: LedgerEntry[] = [];
	for (const line of readFileSync(filePath, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as LedgerEntry;
			if (
				parsed &&
				typeof parsed === 'object' &&
				((parsed as LedgerEntry).kind === 'issued' ||
					(parsed as LedgerEntry).kind === 'consumed')
			) {
				entries.push(parsed);
			}
		} catch {
			throw new Error('write approval ledger is malformed');
		}
	}
	return Promise.resolve(entries.slice(-MAX_LEDGER_ENTRIES));
}

async function ledgerWrite(
	filePath: string,
	entries: LedgerEntry[],
): Promise<void> {
	const bounded = entries.slice(-MAX_LEDGER_ENTRIES);
	const content = bounded.map((entry) => JSON.stringify(entry)).join('\n');
	await atomicWriteSwarmFile(filePath, content ? `${content}\n` : '');
}

function normalizeRequest(request: WriteApprovalRequest): WriteApprovalRequest {
	return {
		targetSessionId: request.targetSessionId.trim(),
		action: request.action,
		candidateId: request.candidateId.trim(),
		candidateContentHash: request.candidateContentHash.trim().toLowerCase(),
		allowedPathDigest: request.allowedPathDigest?.trim().toLowerCase(),
		generation: request.generation ?? 0,
	};
}

function validateRequest(request: WriteApprovalRequest): void {
	const normalized = normalizeRequest(request);
	if (!normalized.targetSessionId) {
		throw new Error('write approval targetSessionId is required');
	}
	if (!normalized.candidateId) {
		throw new Error('write approval candidateId is required');
	}
	if (!SHA256_RE.test(normalized.candidateContentHash)) {
		throw new Error(
			'write approval candidateContentHash must be a lowercase sha256 digest',
		);
	}
	if (
		normalized.allowedPathDigest !== undefined &&
		!SHA256_RE.test(normalized.allowedPathDigest)
	) {
		throw new Error(
			'write approval allowedPathDigest must be a lowercase sha256 digest',
		);
	}
}

function matchesRequest(
	fact: WriteApprovalFactV1,
	request: WriteApprovalRequest,
): boolean {
	const normalized = normalizeRequest(request);
	return (
		fact.targetSessionId === normalized.targetSessionId &&
		fact.action === normalized.action &&
		fact.candidateId === normalized.candidateId &&
		fact.candidateContentHash === normalized.candidateContentHash &&
		(fact.allowedPathDigest ?? undefined) ===
			(normalized.allowedPathDigest ?? undefined) &&
		(fact.generation ?? 0) === (normalized.generation ?? 0)
	);
}

function selectUniqueActiveFact(
	entries: LedgerEntry[],
	request: WriteApprovalRequest,
	now: Date,
): WriteApprovalFactV1 | null {
	const consumedIds = new Set(
		entries
			.filter(
				(entry): entry is ConsumedLedgerEntry => entry.kind === 'consumed',
			)
			.map((entry) => entry.factId),
	);
	const matches = entries
		.filter((entry): entry is IssuedLedgerEntry => entry.kind === 'issued')
		.map((entry) => entry.fact)
		.filter((fact) => matchesRequest(fact, request))
		.filter((fact) => !consumedIds.has(fact.id))
		.filter((fact) => Date.parse(fact.expiresAt) >= now.getTime());
	return matches.length === 1 ? matches[0] : null;
}

function leastPrivilege(
	left: WriteAuthorityContext,
	right: WriteAuthorityContext,
): WriteAuthorityContext {
	return ORIGIN_RANK[left.origin] <= ORIGIN_RANK[right.origin] ? left : right;
}

export function computeWriteApprovalHash(
	input: Record<string, unknown>,
): string {
	return createHash('sha256').update(stableSerialize(input)).digest('hex');
}

export function getCurrentWriteAuthority(): WriteAuthorityContext {
	const extent = authorityStore.getStore();
	return extent?.active ? extent.context : { origin: 'autonomous' };
}

export async function withWriteAuthority<T>(
	context: WriteAuthorityContext,
	fn: () => Promise<T>,
): Promise<T> {
	const active = getCurrentWriteAuthority();
	const next =
		active.origin !== 'autonomous' ? leastPrivilege(active, context) : context;
	const extent: AuthorityExtent = { context: next, active: true };
	try {
		return await authorityStore.run(extent, fn);
	} finally {
		extent.active = false;
	}
}

export function buildHumanApprovedWriteAuthority(
	fact: WriteApprovalFactV1,
): WriteAuthorityContext {
	if (!consumedAuthorityFacts.has(fact)) {
		throw new Error(
			'human write authority requires a fact consumed from the authority ledger',
		);
	}
	return {
		origin: 'human_approved',
		fact,
	};
}

export function currentWriteAuthoritySatisfies(
	request: WriteApprovalRequest,
): boolean {
	const current = getCurrentWriteAuthority();
	return current.origin === 'human_approved'
		? current.fact !== undefined && matchesRequest(current.fact, request)
		: false;
}

export function formatApproveWriteCommand(
	request: WriteApprovalRequest,
): string {
	const normalized = normalizeRequest(request);
	const parts = [
		'/swarm approve-write',
		normalized.targetSessionId,
		normalized.action,
		normalized.candidateId,
		normalized.candidateContentHash,
	];
	if (normalized.allowedPathDigest) {
		parts.push('--allowed-path-digest', normalized.allowedPathDigest);
	}
	if ((normalized.generation ?? 0) > 0) {
		parts.push('--generation', String(normalized.generation ?? 0));
	}
	return parts.join(' ');
}

export async function findWriteApprovalFact(args: {
	directory: string;
	request: WriteApprovalRequest;
	now?: Date;
}): Promise<WriteApprovalFactV1 | null> {
	validateRequest(args.request);
	const now = args.now ?? new Date();
	const filePath = ledgerPath(args.directory);
	let match: WriteApprovalFactV1 | null = null;
	await transactFile<LedgerEntry[]>(
		filePath,
		ledgerRead,
		ledgerWrite,
		(entries) => {
			match = selectUniqueActiveFact(entries, args.request, now);
			return null;
		},
	);
	return match;
}

export async function issueWriteApprovalFact(args: {
	directory: string;
	request: WriteApprovalRequest;
	issuingSessionId: string;
	now?: Date;
	ttlMs?: number;
}): Promise<WriteApprovalFactV1> {
	validateRequest(args.request);
	const now = args.now ?? new Date();
	const issuedAtMs = now.getTime();
	const expiresAtMs = issuedAtMs + (args.ttlMs ?? DEFAULT_TTL_MS);
	const normalized = normalizeRequest(args.request);
	const fact: WriteApprovalFactV1 = {
		v: 1,
		id: `waf_${randomUUID()}`,
		issuingSessionId: args.issuingSessionId.trim(),
		issuedByCommand: 'approve-write',
		issuedAt: formatTimestampIsoUtc(issuedAtMs),
		expiresAt: formatTimestampIsoUtc(expiresAtMs),
		...normalized,
	};
	const filePath = ledgerPath(args.directory);
	let committed = false;
	await transactFile<LedgerEntry[]>(
		filePath,
		ledgerRead,
		ledgerWrite,
		(entries) => {
			entries.push({ kind: 'issued', fact });
			committed = true;
			return entries;
		},
	);
	if (!committed) {
		throw new Error('failed to persist write approval fact');
	}
	return fact;
}

export async function consumeWriteApprovalFact(args: {
	directory: string;
	request: WriteApprovalRequest;
	consumerSessionId: string;
	now?: Date;
}): Promise<WriteApprovalFactV1 | null> {
	validateRequest(args.request);
	const consumerSessionId = args.consumerSessionId.trim();
	if (!consumerSessionId) {
		throw new Error('write approval consumerSessionId is required');
	}
	const now = args.now ?? new Date();
	const filePath = ledgerPath(args.directory);
	let consumed: WriteApprovalFactV1 | null = null;
	const consumedAt = formatTimestampIsoUtc(now.getTime());
	await transactFile<LedgerEntry[]>(
		filePath,
		ledgerRead,
		ledgerWrite,
		(entries) => {
			const match = selectUniqueActiveFact(entries, args.request, now);
			if (!match) return null;
			consumed = match;
			entries.push({
				kind: 'consumed',
				factId: match.id,
				consumedAt,
				consumerSessionId,
			});
			return entries;
		},
	);
	if (consumed) consumedAuthorityFacts.add(consumed);
	return consumed;
}
