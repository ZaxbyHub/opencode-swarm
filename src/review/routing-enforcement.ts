/**
 * Versioned semantic-review routing receipts (issue #2491).
 *
 * A route is an authorization input for Stage B, not an advisory message. A
 * successful receipt names the exact reviewer/test-engineer identities that
 * owe an independent completion. Router failures have a separate typed
 * receipt; an absent or malformed success receipt never receives fail-open
 * treatment.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../evidence/task-file.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { assertProjectRoot } from '../utils/project-boundary.js';

export const REVIEW_ROUTE_RECEIPT_VERSION = 1 as const;

const IdentitySchema = z.string().trim().min(1).max(256);

export const ReviewRouteReceiptSchema = z
	.object({
		kind: z.literal('review_route_receipt'),
		version: z.literal(REVIEW_ROUTE_RECEIPT_VERSION),
		sessionId: IdentitySchema,
		taskId: IdentitySchema,
		complexity: z.string().trim().min(1).max(80),
		semanticRisk: z.string().trim().min(1).max(120),
		required: z.object({
			reviewers: z.number().int().nonnegative().max(16),
			testEngineers: z.number().int().nonnegative().max(16),
		}),
		identities: z.object({
			reviewers: z.array(IdentitySchema).max(16),
			testEngineers: z.array(IdentitySchema).max(16),
		}),
		slots: z
			.object({
				reviewers: z.array(IdentitySchema).max(16),
				testEngineers: z.array(IdentitySchema).max(16),
			})
			.optional(),
		createdAt: z.string().trim().min(1).max(80).optional(),
	})
	.strict();

export const ReviewRouteRouterErrorReceiptSchema = z
	.object({
		kind: z.literal('review_route_router_error'),
		version: z.literal(REVIEW_ROUTE_RECEIPT_VERSION),
		code: z.enum(['NO_CHANGED_FILES', 'ROUTER_UNAVAILABLE', 'ROUTER_FAILED']),
		failOpen: z.literal(true),
		sessionId: IdentitySchema.optional(),
		taskId: IdentitySchema.optional(),
		detail: z.string().trim().max(512).optional(),
		createdAt: z.string().trim().min(1).max(80).optional(),
	})
	.strict();

const ReviewRoutePendingReceiptSchema = z
	.object({
		kind: z.literal('review_route_pending'),
		version: z.literal(REVIEW_ROUTE_RECEIPT_VERSION),
		sessionId: IdentitySchema,
		taskId: IdentitySchema,
		createdAt: z.string().trim().min(1).max(80).optional(),
	})
	.strict();

export type ReviewRouteReceipt = z.infer<typeof ReviewRouteReceiptSchema>;
export type ReviewRouteRouterErrorReceipt = z.infer<
	typeof ReviewRouteRouterErrorReceiptSchema
>;
export type ReviewRouteRecord =
	| ReviewRouteReceipt
	| ReviewRouteRouterErrorReceipt
	| ReviewRoutePendingReceipt;
export type ReviewRoutePendingReceipt = z.infer<
	typeof ReviewRoutePendingReceiptSchema
>;

export interface BuildReviewRouteReceiptArgs {
	sessionId: string;
	taskId: string;
	complexity: string;
	semanticRisk: string;
	requiredReviewers: readonly string[];
	requiredTestEngineers: readonly string[];
	/** Optional explicit slot IDs. If absent they are deterministic by index. */
	reviewerSlots?: readonly string[];
	testEngineerSlots?: readonly string[];
	createdAt?: string;
}

export interface ReviewRouteEvidence {
	role: 'reviewer' | 'test_engineer';
	identity: string;
	/** Optional exact route binding fields used by live Stage-B callers. */
	sessionId?: string;
	taskId?: string;
	slotId?: string;
	callId?: string;
	childSessionId?: string;
	generation?: number;
}

export interface EnforceReviewRouteReceiptArgs {
	enforcementEnabled: boolean;
	routeReceipt: unknown;
	receipts: readonly ReviewRouteEvidence[];
	sessionId?: string;
	taskId?: string;
	/** Live callers must provide the full call/child/generation-bound tuple. */
	requireEvidenceBindings?: boolean;
	/** Current live dispatch tuple, when a caller is authorizing one completion. */
	expectedDispatch?: Pick<
		ReviewRouteEvidence,
		'role' | 'identity' | 'callId' | 'childSessionId' | 'generation'
	>;
	/**
	 * When false, authorize the current exact dispatch tuple without requiring
	 * every route slot. Callers use this admission check before publishing the
	 * completion; the full-route check remains the advancement barrier.
	 */
	requireCompleteEvidence?: boolean;
}

export interface EnforceReviewRouteReceiptResult {
	canAdvance: boolean;
	mode?: 'enforced' | 'disabled' | 'fail_open' | 'legacy_unrouted';
	reason?: string;
	routerFailure?: ReviewRouteRouterErrorReceipt['code'];
}

function normalizedIdentity(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > 256) {
		throw new Error(`ROUTE_RECEIPT_INVALID_IDENTITY: ${label}`);
	}
	return normalized;
}

function uniqueIdentities(values: readonly string[], label: string): string[] {
	const result = values.map((value) => normalizedIdentity(value, label));
	if (new Set(result).size !== result.length) {
		throw new Error(`ROUTE_RECEIPT_DUPLICATE: ${label}`);
	}
	return [...result];
}

function slotsFor(
	role: 'reviewer' | 'test_engineer',
	identities: readonly string[],
	provided: readonly string[] | undefined,
	taskId: string,
): string[] {
	const slots = provided
		? uniqueIdentities(provided, `${role} slots`)
		: identities.map((_, index) => `${taskId}:${role}:${index + 1}`);
	if (slots.length !== identities.length) {
		throw new Error(`ROUTE_RECEIPT_SLOT_COUNT_MISMATCH: ${role}`);
	}
	return slots;
}

export function buildReviewRouteReceipt(
	input: BuildReviewRouteReceiptArgs,
): ReviewRouteReceipt {
	const sessionId = normalizedIdentity(input.sessionId, 'sessionId');
	const taskId = normalizedIdentity(input.taskId, 'taskId');
	const reviewers = uniqueIdentities(input.requiredReviewers, 'reviewers');
	const testEngineers = uniqueIdentities(
		input.requiredTestEngineers,
		'test_engineers',
	);
	return ReviewRouteReceiptSchema.parse({
		kind: 'review_route_receipt',
		version: REVIEW_ROUTE_RECEIPT_VERSION,
		sessionId,
		taskId,
		complexity: input.complexity,
		semanticRisk: input.semanticRisk,
		required: {
			reviewers: reviewers.length,
			testEngineers: testEngineers.length,
		},
		identities: { reviewers, testEngineers },
		slots: {
			reviewers: slotsFor('reviewer', reviewers, input.reviewerSlots, taskId),
			testEngineers: slotsFor(
				'test_engineer',
				testEngineers,
				input.testEngineerSlots,
				taskId,
			),
		},
		createdAt: input.createdAt ?? new Date().toISOString(),
	});
}

export function buildReviewRouteRouterError(input: {
	code: ReviewRouteRouterErrorReceipt['code'];
	sessionId: string;
	taskId: string;
	detail?: string;
	createdAt?: string;
}): ReviewRouteRouterErrorReceipt {
	return ReviewRouteRouterErrorReceiptSchema.parse({
		kind: 'review_route_router_error',
		version: REVIEW_ROUTE_RECEIPT_VERSION,
		code: input.code,
		failOpen: true,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.detail ? { detail: input.detail.slice(0, 512) } : {}),
		createdAt: input.createdAt ?? new Date().toISOString(),
	});
}

export function buildReviewRoutePending(input: {
	sessionId: string;
	taskId: string;
	createdAt?: string;
}): ReviewRoutePendingReceipt {
	return ReviewRoutePendingReceiptSchema.parse({
		kind: 'review_route_pending',
		version: REVIEW_ROUTE_RECEIPT_VERSION,
		sessionId: input.sessionId,
		taskId: input.taskId,
		createdAt: input.createdAt ?? new Date().toISOString(),
	});
}

function routeReceiptRelativePath(sessionId: string, taskId: string): string {
	const safeSession = normalizedIdentity(sessionId, 'sessionId').replace(
		/[^A-Za-z0-9_.-]/g,
		'_',
	);
	const safeTask = normalizedIdentity(taskId, 'taskId').replace(
		/[^A-Za-z0-9_.-]/g,
		'_',
	);
	return path.join(
		'pr-review',
		'route-receipts',
		`${safeSession}--${safeTask}.json`,
	);
}

function routeReceiptPath(
	directory: string,
	sessionId: string,
	taskId: string,
): string {
	return validateSwarmPath(
		directory,
		routeReceiptRelativePath(sessionId, taskId),
	);
}

async function ensureSafeParent(
	directory: string,
	filePath: string,
): Promise<void> {
	assertProjectRoot(directory, undefined, 'review route receipt');
	const swarmRoot = path.resolve(directory, '.swarm');
	const parent = path.dirname(filePath);
	const relative = path.relative(swarmRoot, parent);
	if (
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(
			'ROUTE_RECEIPT_PATH_ESCAPE: route receipt is outside .swarm',
		);
	}
	await fsp.mkdir(parent, { recursive: true });
	for (const candidate of [
		swarmRoot,
		path.join(swarmRoot, 'pr-review'),
		parent,
	]) {
		const stat = await fsp.lstat(candidate);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(
				'ROUTE_RECEIPT_PATH_UNSAFE: receipt parent is not a real directory',
			);
		}
	}
}

const MAX_ROUTE_RECEIPT_BYTES = 64 * 1024;

export async function persistReviewRouteReceipt(input: {
	projectRoot: string;
	receipt: ReviewRouteRecord;
}): Promise<{ persisted: true; path: string }> {
	const parsed =
		input.receipt.kind === 'review_route_receipt'
			? ReviewRouteReceiptSchema.parse(input.receipt)
			: input.receipt.kind === 'review_route_router_error'
				? ReviewRouteRouterErrorReceiptSchema.parse(input.receipt)
				: ReviewRoutePendingReceiptSchema.parse(input.receipt);
	const sessionId =
		parsed.kind === 'review_route_receipt'
			? parsed.sessionId
			: (parsed.sessionId ?? 'router');
	const taskId =
		parsed.kind === 'review_route_receipt'
			? parsed.taskId
			: (parsed.taskId ?? 'unknown');
	const filePath = routeReceiptPath(input.projectRoot, sessionId, taskId);
	await ensureSafeParent(input.projectRoot, filePath);
	const encoded = JSON.stringify(parsed, null, 2);
	if (Buffer.byteLength(encoded, 'utf8') > MAX_ROUTE_RECEIPT_BYTES) {
		throw new Error('ROUTE_RECEIPT_OVERSIZED: receipt exceeds size bound');
	}
	await atomicWriteFile(filePath, `${encoded}\n`);
	return { persisted: true, path: filePath };
}

export async function readReviewRouteReceipt(input: {
	projectRoot: string;
	sessionId: string;
	taskId: string;
}): Promise<ReviewRouteRecord | null> {
	const filePath = routeReceiptPath(
		input.projectRoot,
		input.sessionId,
		input.taskId,
	);
	let stat: Awaited<ReturnType<typeof fsp.lstat>>;
	try {
		stat = await fsp.lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	if (
		stat.isSymbolicLink() ||
		!stat.isFile() ||
		stat.size > MAX_ROUTE_RECEIPT_BYTES
	) {
		throw new Error(
			'ROUTE_RECEIPT_UNREADABLE: receipt is not a bounded regular file',
		);
	}
	const raw = await fsp.readFile(filePath, 'utf8');
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('ROUTE_RECEIPT_INVALID_JSON: receipt is not valid JSON');
	}
	const parsed =
		typeof value === 'object' &&
		value !== null &&
		(value as { kind?: unknown }).kind === 'review_route_receipt'
			? ReviewRouteReceiptSchema.safeParse(value)
			: (value as { kind?: unknown }).kind === 'review_route_router_error'
				? ReviewRouteRouterErrorReceiptSchema.safeParse(value)
				: ReviewRoutePendingReceiptSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error('ROUTE_RECEIPT_INVALID: receipt failed schema validation');
	}
	if (
		(parsed.data.kind === 'review_route_receipt' ||
			parsed.data.kind === 'review_route_pending') &&
		(parsed.data.sessionId !== input.sessionId ||
			parsed.data.taskId !== input.taskId)
	) {
		throw new Error(
			'ROUTE_RECEIPT_IDENTITY_MISMATCH: receipt path and payload differ',
		);
	}
	if (
		parsed.data.kind === 'review_route_router_error' &&
		parsed.data.sessionId !== undefined &&
		parsed.data.taskId !== undefined &&
		(parsed.data.sessionId !== input.sessionId ||
			parsed.data.taskId !== input.taskId)
	) {
		throw new Error(
			'ROUTE_RECEIPT_IDENTITY_MISMATCH: receipt path and payload differ',
		);
	}
	return parsed.data;
}

/** Synchronous twin for the existing synchronous reviewer-gate predicate. */
export function readReviewRouteReceiptSync(input: {
	projectRoot: string;
	sessionId: string;
	taskId: string;
}): ReviewRouteRecord | null {
	const filePath = routeReceiptPath(
		input.projectRoot,
		input.sessionId,
		input.taskId,
	);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	if (
		stat.isSymbolicLink() ||
		!stat.isFile() ||
		stat.size > MAX_ROUTE_RECEIPT_BYTES
	) {
		throw new Error(
			'ROUTE_RECEIPT_UNREADABLE: receipt is not a bounded regular file',
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error('ROUTE_RECEIPT_INVALID_JSON: receipt is not valid JSON');
		}
		throw error;
	}
	const parsed =
		typeof value === 'object' &&
		value !== null &&
		(value as { kind?: unknown }).kind === 'review_route_receipt'
			? ReviewRouteReceiptSchema.safeParse(value)
			: (value as { kind?: unknown }).kind === 'review_route_router_error'
				? ReviewRouteRouterErrorReceiptSchema.safeParse(value)
				: ReviewRoutePendingReceiptSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error('ROUTE_RECEIPT_INVALID: receipt failed schema validation');
	}
	if (
		(parsed.data.kind === 'review_route_receipt' ||
			parsed.data.kind === 'review_route_pending') &&
		(parsed.data.sessionId !== input.sessionId ||
			parsed.data.taskId !== input.taskId)
	) {
		throw new Error(
			'ROUTE_RECEIPT_IDENTITY_MISMATCH: receipt path and payload differ',
		);
	}
	if (
		parsed.data.kind === 'review_route_router_error' &&
		parsed.data.sessionId !== undefined &&
		parsed.data.taskId !== undefined &&
		(parsed.data.sessionId !== input.sessionId ||
			parsed.data.taskId !== input.taskId)
	) {
		throw new Error(
			'ROUTE_RECEIPT_IDENTITY_MISMATCH: receipt path and payload differ',
		);
	}
	return parsed.data;
}

function parseRouteReceipt(value: unknown): ReviewRouteRecord | null {
	if (!value || typeof value !== 'object') return null;
	const kind = (value as { kind?: unknown }).kind;
	const parsed =
		kind === 'review_route_receipt'
			? ReviewRouteReceiptSchema.safeParse(value)
			: kind === 'review_route_router_error'
				? ReviewRouteRouterErrorReceiptSchema.safeParse(value)
				: ReviewRoutePendingReceiptSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function fail(reason: string): EnforceReviewRouteReceiptResult {
	return { canAdvance: false, mode: 'enforced', reason };
}

/**
 * Authorize Stage-B advancement from the exact route receipt. The explicit
 * router error is the only enabled fail-open branch; malformed/absent records
 * fail closed. Optional identity fields on evidence are checked when present
 * so old callers can migrate without fabricating bindings.
 */
export function enforceReviewRouteReceipt(
	input: EnforceReviewRouteReceiptArgs,
): EnforceReviewRouteReceiptResult {
	if (!input.enforcementEnabled) {
		return { canAdvance: true, mode: 'disabled' };
	}
	const route = parseRouteReceipt(input.routeReceipt);
	if (!route) return fail('ROUTE_RECEIPT_MISSING');
	if (route.kind === 'review_route_router_error') {
		if (
			input.sessionId &&
			(!route.sessionId ||
				!route.taskId ||
				route.sessionId !== input.sessionId ||
				route.taskId !== input.taskId)
		) {
			return fail('ROUTE_RECEIPT_IDENTITY_MISMATCH');
		}
		return {
			canAdvance: true,
			mode: 'fail_open',
			routerFailure: route.code,
		};
	}
	if (route.kind === 'review_route_pending') {
		return fail('ROUTE_RECEIPT_PENDING');
	}
	if (
		(input.sessionId && route.sessionId !== input.sessionId) ||
		(input.taskId && route.taskId !== input.taskId)
	) {
		return fail('ROUTE_RECEIPT_IDENTITY_MISMATCH');
	}
	if (
		route.required.reviewers !== route.identities.reviewers.length ||
		route.required.testEngineers !== route.identities.testEngineers.length
	) {
		return fail('ROUTE_RECEIPT_COUNT_MISMATCH');
	}
	const expected = new Map<string, 'reviewer' | 'test_engineer'>();
	for (const identity of route.identities.reviewers) {
		if (expected.has(identity)) return fail('ROUTE_RECEIPT_DUPLICATE');
		expected.set(identity, 'reviewer');
	}
	for (const identity of route.identities.testEngineers) {
		if (expected.has(identity)) return fail('ROUTE_RECEIPT_DUPLICATE');
		expected.set(identity, 'test_engineer');
	}
	if (
		input.requireEvidenceBindings &&
		input.requireCompleteEvidence === false &&
		expected.size > 0 &&
		!input.expectedDispatch
	) {
		return fail('ROUTE_RECEIPT_DISPATCH_REQUIRED');
	}
	const seen = new Set<string>();
	const seenSlots = new Set<string>();
	for (const evidence of input.receipts) {
		if (
			input.requireEvidenceBindings &&
			(!evidence.sessionId ||
				!evidence.taskId ||
				!evidence.slotId ||
				!evidence.callId ||
				!evidence.childSessionId ||
				typeof evidence.generation !== 'number')
		) {
			return fail('ROUTE_RECEIPT_BINDING_MISSING');
		}
		const identity = evidence.identity.trim();
		const expectedRole = expected.get(identity);
		if (!expectedRole) return fail('ROUTE_RECEIPT_IDENTITY_UNLISTED');
		if (expectedRole !== evidence.role)
			return fail('ROUTE_RECEIPT_ROLE_MISMATCH');
		if (seen.has(identity)) return fail('ROUTE_RECEIPT_DUPLICATE');
		if (!identity || identity.length > 256) {
			return fail('ROUTE_RECEIPT_INVALID_IDENTITY');
		}
		if (evidence.sessionId && evidence.sessionId !== route.sessionId) {
			return fail('ROUTE_RECEIPT_SESSION_MISMATCH');
		}
		if (evidence.taskId && evidence.taskId !== route.taskId) {
			return fail('ROUTE_RECEIPT_TASK_MISMATCH');
		}
		if (evidence.slotId) {
			if (seenSlots.has(evidence.slotId))
				return fail('ROUTE_RECEIPT_DUPLICATE');
			const slots =
				evidence.role === 'reviewer'
					? route.slots?.reviewers
					: route.slots?.testEngineers;
			if (slots && !slots.includes(evidence.slotId)) {
				return fail('ROUTE_RECEIPT_SLOT_UNLISTED');
			}
			if (slots) {
				const expectedIndex =
					evidence.role === 'reviewer'
						? route.identities.reviewers.indexOf(identity)
						: route.identities.testEngineers.indexOf(identity);
				if (expectedIndex < 0 || slots[expectedIndex] !== evidence.slotId) {
					return fail('ROUTE_RECEIPT_SLOT_MISMATCH');
				}
			}
			seenSlots.add(evidence.slotId);
		}
		seen.add(identity);
	}
	if (input.expectedDispatch) {
		const expected = input.expectedDispatch;
		const matching = input.receipts.find(
			(evidence) =>
				evidence.role === expected.role &&
				evidence.identity === expected.identity,
		);
		if (
			!matching ||
			matching.callId !== expected.callId ||
			matching.childSessionId !== expected.childSessionId ||
			matching.generation !== expected.generation
		) {
			return fail('ROUTE_RECEIPT_DISPATCH_MISMATCH');
		}
	}
	if (input.requireCompleteEvidence !== false && seen.size !== expected.size) {
		return fail('ROUTE_RECEIPT_INCOMPLETE');
	}
	return { canAdvance: true, mode: 'enforced' };
}

export function routeReceiptPathForTask(
	directory: string,
	sessionId: string,
	taskId: string,
): string {
	return routeReceiptPath(directory, sessionId, taskId);
}

/**
 * Read and enforce one task's persisted route using the synchronous gate
 * contract. A missing receipt is intentionally a hard failure for new work;
 * callers that have positively identified pre-version legacy state may opt
 * into the disclosed one-release compatibility result.
 */
export function enforcePersistedReviewRouteReceipt(input: {
	projectRoot: string;
	sessionId: string;
	taskId: string;
	receipts: readonly ReviewRouteEvidence[];
	enforcementEnabled: boolean;
	legacyUnrouted?: boolean;
	requireEvidenceBindings?: boolean;
	expectedDispatch?: EnforceReviewRouteReceiptArgs['expectedDispatch'];
	requireCompleteEvidence?: boolean;
}): EnforceReviewRouteReceiptResult {
	if (!input.enforcementEnabled) {
		return { canAdvance: true, mode: 'disabled' };
	}
	const route = readReviewRouteReceiptSync({
		projectRoot: input.projectRoot,
		sessionId: input.sessionId,
		taskId: input.taskId,
	});
	if (!route && input.legacyUnrouted) {
		return {
			canAdvance: true,
			mode: 'legacy_unrouted',
			reason: 'legacy_unrouted: route receipt predates version-1 enforcement',
		};
	}
	return enforceReviewRouteReceipt({
		enforcementEnabled: true,
		routeReceipt: route,
		receipts: input.receipts,
		sessionId: input.sessionId,
		taskId: input.taskId,
		requireEvidenceBindings: input.requireEvidenceBindings,
		expectedDispatch: input.expectedDispatch,
		requireCompleteEvidence: input.requireCompleteEvidence,
	});
}
