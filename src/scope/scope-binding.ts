import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Plan } from '../config/plan-schema';
import { computePlanStructureHash } from '../plan/ledger';
import { derivePlanId } from '../plan/utils';
import { canonicalExistingFilesystemPath } from '../utils/filesystem-identity.js';
import {
	getPathFlavor,
	normalizePathIdentity,
	sanitizeDiagnosticText,
	unsafePathTextReason,
} from './path-identity';

export const MAX_PENDING_SCOPE_BINDINGS = 256;
export const DEFAULT_SCOPE_BINDING_TTL_MS = 60 * 60 * 1000;
export const MAX_SCOPE_BINDING_TOMBSTONES = 256;

export type ScopeBindingLifecycleState =
	| 'live'
	| 'expired'
	| 'revoked'
	| 'superseded';

export type ScopeBindingSource =
	| 'declare_scope'
	| 'plan'
	| 'file_directive'
	| 'pr_feedback'
	| 'worktree_derived';

export interface ScopeBinding {
	version: 2;
	/** Stable logical authority identity across lifecycle generations. */
	bindingId: string;
	/** Exact immutable generation identity used by persistence and cleanup. */
	generationId: string;
	/** Monotonic CAS revision within one generation. */
	revision: number;
	lifecycleState: ScopeBindingLifecycleState;
	workspaceIdentity: string;
	planId: string;
	planStructureHash: string;
	taskId: string;
	ownerSessionId: string;
	ownerMessageId: string;
	/** Exact Task tool call that activated this binding. Declarations omit it. */
	dispatchCallId?: string;
	activation: 'declaration' | 'pending_child' | 'active';
	parentOwnerSessionId?: string;
	parentCallId?: string;
	predecessorGenerationId?: string;
	childSessionId?: string;
	/** PR_FEEDBACK bindings carry their parent workflow identity and revision. */
	workflowSessionId?: string;
	workflowRevisionDigest?: string;
	source: ScopeBindingSource;
	files: string[];
	declaredAt: number;
	updatedAt: number;
	leaseStartedAt: number;
	expiresAt: number;
}

const pendingScopeBindings = new Map<string, ScopeBinding>();
const scopeBindingTombstones = new Map<string, ScopeBinding>();
export const MAX_SCOPE_PATH_BYTES = 4096;
export const MAX_SCOPE_FILES_BYTES = 1024 * 1024;

export type ScopeBindingAdmissionResult =
	| { ok: true; binding: ScopeBinding }
	| {
			ok: false;
			code: 'SCOPE_BINDING_CAPACITY' | 'SCOPE_BINDING_STALE';
			message: string;
	  };

export type ScopeBindingResolution =
	| { status: 'found'; binding: ScopeBinding }
	| { status: 'expired'; candidates: ScopeBinding[]; totalCandidates: number }
	| { status: 'ambiguous'; candidates: ScopeBinding[]; totalCandidates: number }
	| { status: 'not_declared' };

function newIdentity(): string {
	return randomUUID();
}

export function isScopeBindingIdentity(value: unknown): value is string {
	return (
		typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)
	);
}

export function canonicalWorkspaceIdentity(directory: string): string | null {
	return canonicalExistingFilesystemPath(directory);
}

function isStrictTaskId(value: string): boolean {
	return /^\d+\.\d+(?:\.\d+)*$/.test(value);
}

function normalizeScopePath(value: string): string | null {
	if (typeof value !== 'string') return null;
	// Scope is both persisted and rendered in denial messages. Reject every
	// control/formatting class that can alter logs, terminals, or path display.
	if (unsafePathTextReason(value)) return null;
	const trimmed = value.trim().replace(/\\/g, '/');
	if (
		trimmed.length === 0 ||
		trimmed.includes('\0') ||
		trimmed.split('/').includes('..') ||
		path.posix.isAbsolute(trimmed) ||
		/^[A-Za-z]:\//.test(trimmed)
	)
		return null;
	const normalized = path.posix.normalize(trimmed).replace(/^\.\//, '');
	if (normalized === '.' || normalized === '..' || normalized.startsWith('../'))
		return null;
	return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function normalizeScopeFiles(files: readonly string[]): string[] | null {
	if (!Array.isArray(files) || files.length === 0 || files.length > 10_000)
		return null;
	const normalized = new Set<string>();
	let totalBytes = 0;
	for (const file of files) {
		const candidate = normalizeScopePath(file);
		if (!candidate) return null;
		const bytes = Buffer.byteLength(candidate, 'utf8');
		totalBytes += bytes;
		if (bytes > MAX_SCOPE_PATH_BYTES || totalBytes > MAX_SCOPE_FILES_BYTES) {
			return null;
		}
		normalized.add(candidate);
	}
	return normalized.size > 0 ? [...normalized].sort() : null;
}

function bindingKey(binding: { generationId: string }): string {
	return binding.generationId;
}

export function createScopeBinding(input: {
	directory: string;
	plan: Plan;
	taskId: string;
	files: readonly string[];
	ownerSessionId: string;
	ownerMessageId: string;
	source: Exclude<ScopeBindingSource, 'pr_feedback' | 'worktree_derived'>;
	dispatchCallId?: string;
	activation?: ScopeBinding['activation'];
	ttlMs?: number;
}): ScopeBinding | null {
	if (
		!input.ownerSessionId.trim() ||
		!input.ownerMessageId.trim() ||
		!isStrictTaskId(input.taskId)
	)
		return null;
	const workspaceIdentity = canonicalWorkspaceIdentity(input.directory);
	const files = normalizeScopeFiles(input.files);
	if (!workspaceIdentity || !files) return null;
	const now = Date.now();
	const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_SCOPE_BINDING_TTL_MS);
	return {
		version: 2,
		bindingId: newIdentity(),
		generationId: newIdentity(),
		revision: 1,
		lifecycleState: 'live',
		workspaceIdentity,
		planId: derivePlanId(input.plan),
		planStructureHash: computePlanStructureHash(input.plan),
		taskId: input.taskId,
		ownerSessionId: input.ownerSessionId,
		ownerMessageId: input.ownerMessageId,
		dispatchCallId: input.dispatchCallId,
		activation:
			input.activation ??
			(input.dispatchCallId ? 'pending_child' : 'declaration'),
		source: input.source,
		files,
		declaredAt: now,
		updatedAt: now,
		leaseStartedAt: now,
		expiresAt: now + ttlMs,
	};
}

function sweepExpired(now = Date.now()): void {
	for (const [key, binding] of pendingScopeBindings) {
		if (binding.expiresAt <= now) {
			pendingScopeBindings.delete(key);
			const expired: ScopeBinding = {
				...binding,
				revision: binding.revision + 1,
				lifecycleState: 'expired',
				updatedAt: now,
			};
			scopeBindingTombstones.set(bindingKey(expired), expired);
		}
	}
	while (scopeBindingTombstones.size > MAX_SCOPE_BINDING_TOMBSTONES) {
		const oldest = scopeBindingTombstones.keys().next().value as
			| string
			| undefined;
		if (!oldest) break;
		scopeBindingTombstones.delete(oldest);
	}
}

export function registerScopeBinding(
	binding: ScopeBinding,
): ScopeBindingAdmissionResult {
	sweepExpired();
	if (binding.lifecycleState !== 'live' || binding.expiresAt <= Date.now()) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_CAPACITY',
			message: 'Only an unexpired live binding can be admitted.',
		};
	}
	const exact = pendingScopeBindings.get(bindingKey(binding));
	if (exact && exact.bindingId !== binding.bindingId) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_STALE',
			message: 'The generation identity collides with a different binding.',
		};
	}
	if (exact && exact.revision > binding.revision) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_STALE',
			message: 'A newer revision of this generation is already admitted.',
		};
	}
	if (!exact && pendingScopeBindings.size >= MAX_PENDING_SCOPE_BINDINGS) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_CAPACITY',
			message: `Scope binding capacity ${MAX_PENDING_SCOPE_BINDINGS} is exhausted; complete or expire a live task before retrying.`,
		};
	}
	if (
		binding.activation === 'declaration' &&
		binding.dispatchCallId === undefined
	) {
		for (const [existingKey, existing] of pendingScopeBindings) {
			if (
				existing.generationId !== binding.generationId &&
				existing.activation === 'declaration' &&
				existing.dispatchCallId === undefined &&
				existing.workspaceIdentity === binding.workspaceIdentity &&
				existing.taskId === binding.taskId &&
				existing.ownerSessionId === binding.ownerSessionId
			) {
				pendingScopeBindings.delete(existingKey);
				scopeBindingTombstones.set(existingKey, {
					...existing,
					revision: existing.revision + 1,
					lifecycleState: 'superseded',
					updatedAt: Date.now(),
				});
			}
		}
	}
	const key = bindingKey(binding);
	pendingScopeBindings.delete(key);
	pendingScopeBindings.set(key, binding);
	return { ok: true, binding };
}

/**
 * Resolve the binding created for one fully-approved parent Task dispatch.
 * An already-claimed child binding wins over its pending parent precursor;
 * multiple candidates at either specificity fail closed.
 */
export function getScopeBindingForParentDispatch(input: {
	parentSessionId: string;
	dispatchCallId: string;
}): ScopeBinding | null {
	sweepExpired();
	if (!input.parentSessionId.trim() || !input.dispatchCallId.trim())
		return null;
	const active = [...pendingScopeBindings.values()].filter(
		(binding) =>
			binding.activation === 'active' &&
			binding.parentOwnerSessionId === input.parentSessionId &&
			binding.parentCallId === input.dispatchCallId &&
			binding.dispatchCallId === input.dispatchCallId,
	);
	if (active.length > 1) return null;
	if (active.length === 1) return active[0];
	const pending = [...pendingScopeBindings.values()].filter(
		(binding) =>
			binding.activation === 'pending_child' &&
			binding.ownerSessionId === input.parentSessionId &&
			binding.ownerMessageId === input.dispatchCallId &&
			binding.dispatchCallId === input.dispatchCallId,
	);
	return pending.length === 1 ? pending[0] : null;
}

export function getScopeBinding(input: {
	directory: string;
	plan: Plan;
	taskId: string;
	ownerSessionId: string;
	ownerMessageId?: string;
}): ScopeBinding | null {
	sweepExpired();
	const workspaceIdentity = canonicalWorkspaceIdentity(input.directory);
	if (!workspaceIdentity || !isStrictTaskId(input.taskId)) return null;
	const candidates = [...pendingScopeBindings.values()].filter(
		(binding) =>
			binding.workspaceIdentity === workspaceIdentity &&
			binding.planStructureHash === computePlanStructureHash(input.plan) &&
			binding.taskId === input.taskId &&
			binding.ownerSessionId === input.ownerSessionId &&
			binding.activation === 'declaration' &&
			binding.dispatchCallId === undefined &&
			(input.ownerMessageId === undefined ||
				binding.ownerMessageId === input.ownerMessageId),
	);
	if (candidates.length !== 1) return null;
	const candidate = candidates[0];
	if (!candidate || candidate.planId !== derivePlanId(input.plan)) return null;
	return candidate;
}

export function createPrFeedbackScopeBinding(input: {
	directory: string;
	taskId: string;
	files: readonly string[];
	ownerSessionId: string;
	ownerMessageId: string;
	workflowSessionId: string;
	workflowRevisionDigest: string;
	dispatchCallId?: string;
	activation?: ScopeBinding['activation'];
}): ScopeBinding | null {
	if (
		!input.ownerSessionId.trim() ||
		!input.ownerMessageId.trim() ||
		!input.workflowSessionId.trim() ||
		!input.workflowRevisionDigest.trim() ||
		!isStrictTaskId(input.taskId)
	)
		return null;
	const workspaceIdentity = canonicalWorkspaceIdentity(input.directory);
	const files = normalizeScopeFiles(input.files);
	if (!workspaceIdentity || !files) return null;
	const now = Date.now();
	const workflowIdentity = `pr-feedback:${input.workflowSessionId}`;
	return {
		version: 2,
		bindingId: newIdentity(),
		generationId: newIdentity(),
		revision: 1,
		lifecycleState: 'live',
		workspaceIdentity,
		planId: workflowIdentity,
		planStructureHash: input.workflowRevisionDigest,
		taskId: input.taskId,
		ownerSessionId: input.ownerSessionId,
		ownerMessageId: input.ownerMessageId,
		dispatchCallId: input.dispatchCallId,
		activation:
			input.activation ??
			(input.dispatchCallId ? 'pending_child' : 'declaration'),
		source: 'pr_feedback',
		files,
		declaredAt: now,
		updatedAt: now,
		leaseStartedAt: now,
		expiresAt: now + DEFAULT_SCOPE_BINDING_TTL_MS,
		workflowSessionId: input.workflowSessionId,
		workflowRevisionDigest: input.workflowRevisionDigest,
	};
}

export function getAuthorizedPrFeedbackScopeBinding(input: {
	directory: string;
	activeSessionId: string;
	taskId?: string;
}): ScopeBinding | null {
	sweepExpired();
	const workspaceIdentity = canonicalWorkspaceIdentity(input.directory);
	if (!workspaceIdentity || !input.activeSessionId.trim()) return null;
	const matches = [...pendingScopeBindings.values()].filter(
		(binding) =>
			binding.workspaceIdentity === workspaceIdentity &&
			binding.source === 'pr_feedback' &&
			binding.activation === 'active' &&
			binding.ownerSessionId === input.activeSessionId &&
			(!input.taskId || binding.taskId === input.taskId) &&
			typeof binding.dispatchCallId === 'string' &&
			binding.dispatchCallId.length > 0 &&
			binding.ownerMessageId === binding.dispatchCallId &&
			typeof binding.parentOwnerSessionId === 'string' &&
			binding.parentOwnerSessionId.length > 0 &&
			binding.ownerSessionId !== binding.parentOwnerSessionId &&
			binding.parentCallId === binding.dispatchCallId &&
			typeof binding.workflowSessionId === 'string' &&
			binding.workflowSessionId === binding.parentOwnerSessionId &&
			typeof binding.workflowRevisionDigest === 'string' &&
			binding.workflowRevisionDigest.length > 0 &&
			binding.planId === `pr-feedback:${binding.workflowSessionId}` &&
			binding.planStructureHash === binding.workflowRevisionDigest,
	);
	return matches.length === 1 ? matches[0] : null;
}

/** Resolve the one Task-correlated authorization for an executing coder. */
export function getAuthorizedScopeBinding(input: {
	directory: string;
	plan: Plan;
	taskId: string;
	activeSessionId: string;
}): ScopeBinding | null {
	return getAuthorizedScopeBindingByPlanIdentity({
		directory: input.directory,
		planId: derivePlanId(input.plan),
		planStructureHash: computePlanStructureHash(input.plan),
		taskId: input.taskId,
		activeSessionId: input.activeSessionId,
	});
}

export function getAuthorizedScopeBindingByPlanIdentity(input: {
	directory: string;
	planId: string;
	planStructureHash: string;
	taskId: string;
	activeSessionId: string;
}): ScopeBinding | null {
	const resolution = resolveAuthorizedScopeBindingByPlanIdentity(input);
	return resolution.status === 'found' ? resolution.binding : null;
}

/** Resolve authorization without collapsing expired and ambiguous states. */
export function resolveAuthorizedScopeBindingByPlanIdentity(input: {
	directory: string;
	planId: string;
	planStructureHash: string;
	taskId: string;
	activeSessionId: string;
}): ScopeBindingResolution {
	sweepExpired();
	const workspaceIdentity = canonicalWorkspaceIdentity(input.directory);
	if (!workspaceIdentity || !isStrictTaskId(input.taskId))
		return { status: 'not_declared' };
	const matches = [...pendingScopeBindings.values()].filter(
		(binding) =>
			binding.workspaceIdentity === workspaceIdentity &&
			binding.planId === input.planId &&
			binding.planStructureHash === input.planStructureHash &&
			binding.taskId === input.taskId &&
			binding.ownerSessionId === input.activeSessionId &&
			binding.activation === 'active' &&
			typeof binding.dispatchCallId === 'string' &&
			binding.dispatchCallId.length > 0 &&
			binding.ownerMessageId === binding.dispatchCallId &&
			typeof binding.parentOwnerSessionId === 'string' &&
			binding.parentOwnerSessionId.length > 0 &&
			binding.ownerSessionId !== binding.parentOwnerSessionId &&
			binding.parentCallId === binding.dispatchCallId,
	);
	if (matches.length > 1)
		return {
			status: 'ambiguous',
			candidates: matches.slice(0, 8),
			totalCandidates: matches.length,
		};
	if (matches.length === 1) return { status: 'found', binding: matches[0] };
	const expired = [...scopeBindingTombstones.values()].filter(
		(binding) =>
			(binding.lifecycleState !== 'live' || binding.expiresAt <= Date.now()) &&
			binding.workspaceIdentity === workspaceIdentity &&
			binding.planId === input.planId &&
			binding.planStructureHash === input.planStructureHash &&
			binding.taskId === input.taskId &&
			binding.ownerSessionId === input.activeSessionId &&
			binding.activation === 'active',
	);
	return expired.length > 0
		? {
				status: 'expired',
				candidates: expired.slice(0, 8),
				totalCandidates: expired.length,
			}
		: { status: 'not_declared' };
}

/**
 * Issue #2002 recurrence guardrail (detection half).
 *
 * The defect class is: *a hook constructed once with the plugin-root
 * `ctx.directory` applies that root to sessions that actually execute in a
 * different root.* Its signature failure is silent — a binding for this exact
 * session exists and is otherwise valid, but `workspaceIdentity` (filter
 * condition #1 in `getAuthorizedScopeBindingByPlanIdentity`) never matches, so
 * the lookup returns null and the caller reports a generic
 * `SCOPE_NOT_DECLARED` that names neither root.
 *
 * This turns that silence into a precise, self-describing diagnostic at the one
 * user-visible failure site (`src/hooks/scope-guard.ts`). It catches the class
 * at ANY call site that resolves a binding with the wrong root — present or
 * future — rather than only at the two gates fixed for this issue.
 *
 * Diagnostic-only: never grants or denies authorization. Callers still fall
 * back to the ordinary `SCOPE_NOT_DECLARED` denial whenever this returns null.
 *
 * The candidate filter mirrors every non-workspace correlation clause
 * `getAuthorizedScopeBindingByPlanIdentity` requires for an otherwise-valid
 * Task-scoped authorization — dispatch correlation (`dispatchCallId` present
 * and equal to `ownerMessageId`/`parentCallId`) plus a genuine parent/child
 * session split — so a stale or malformed "active" leftover that never went
 * through the real claim/derive path cannot be mislabeled as a workspace
 * mismatch just because it happens to share session + task + `activation`.
 * `pr_feedback` bindings are excluded outright: they resolve through an
 * entirely separate authorization path
 * (`getAuthorizedPrFeedbackScopeBinding` / `resolveAuthorizedPrFeedbackScopeBindingFromDisk`)
 * that the caller already attempted before falling into this diagnostic, and
 * a live `pr_feedback` binding otherwise satisfies every correlation clause
 * above.
 *
 * `planId`/`planStructureHash` are deliberately NOT compared here: a
 * plan-drifted binding at the SAME root is already excluded by the
 * `workspaceIdentity` clause below (it would never have reached this
 * diagnostic branch in the first place — the ordinary lookup would have
 * rejected it on plan identity, not returned null for lack of a match at
 * all). Reading the plan at `input.directory` to compare identities would
 * also be unreliable here: `input.directory` is, by construction, the root
 * this diagnostic suspects is wrong, so its `.swarm/plan.json` may not exist
 * or may belong to an unrelated project — silently disabling the guardrail
 * exactly where it matters most.
 *
 * Returns null (no mismatch claim) whenever `input.directory` itself cannot
 * be resolved to a canonical identity (e.g. a deleted lane directory) —
 * otherwise every active binding for the session would trivially satisfy
 * `workspaceIdentity !== null`, misreporting a missing-directory failure as a
 * wrong-root failure.
 *
 * @param input.directory - The root the caller resolved against
 * @param input.activeSessionId - The session attempting the write
 * @param input.taskId - Optional task filter
 * @returns A human-readable mismatch description, or null
 */
export function describeScopeWorkspaceMismatch(input: {
	directory: string;
	activeSessionId: string;
	taskId?: string | null;
}): string | null {
	sweepExpired();
	if (!input.activeSessionId.trim()) return null;
	const workspaceIdentity = canonicalWorkspaceIdentity(input.directory);
	if (!workspaceIdentity) return null;
	const mismatched = [...pendingScopeBindings.values()].filter(
		(binding) =>
			binding.ownerSessionId === input.activeSessionId &&
			binding.activation === 'active' &&
			binding.source !== 'pr_feedback' &&
			(!input.taskId || binding.taskId === input.taskId) &&
			typeof binding.dispatchCallId === 'string' &&
			binding.dispatchCallId.length > 0 &&
			binding.ownerMessageId === binding.dispatchCallId &&
			typeof binding.parentOwnerSessionId === 'string' &&
			binding.parentOwnerSessionId.length > 0 &&
			binding.ownerSessionId !== binding.parentOwnerSessionId &&
			binding.parentCallId === binding.dispatchCallId &&
			binding.workspaceIdentity !== workspaceIdentity,
	);
	const first = mismatched[0];
	if (!first) return null;
	return (
		`SCOPE_WORKSPACE_MISMATCH: an active scope binding for session ` +
		`"${sanitizeDiagnosticText(input.activeSessionId)}" (task ${first.taskId}, source ${first.source}) is rooted at ` +
		`"${sanitizeDiagnosticText(first.workspaceIdentity)}", but this gate resolved "${sanitizeDiagnosticText(workspaceIdentity)}". ` +
		`The gate is using the wrong workspace root for this session.`
	);
}

export function clearScopeBindings(
	predicate?: (binding: ScopeBinding) => boolean,
): ScopeBinding[] {
	const removed: ScopeBinding[] = [];
	if (!predicate) {
		removed.push(...pendingScopeBindings.values());
		pendingScopeBindings.clear();
		scopeBindingTombstones.clear();
		return removed;
	}
	for (const [key, binding] of pendingScopeBindings) {
		if (predicate(binding)) {
			removed.push(binding);
			pendingScopeBindings.delete(key);
		}
	}
	return removed;
}

/** Remove one exact generation; sibling generations are never affected. */
export function clearExactScopeBinding(input: {
	bindingId: string;
	generationId: string;
}): ScopeBinding | null {
	const candidate = pendingScopeBindings.get(input.generationId);
	if (!candidate || candidate.bindingId !== input.bindingId) return null;
	pendingScopeBindings.delete(input.generationId);
	return candidate;
}

export function installScopeBindingTombstone(binding: ScopeBinding): void {
	pendingScopeBindings.delete(binding.generationId);
	scopeBindingTombstones.delete(binding.generationId);
	scopeBindingTombstones.set(binding.generationId, binding);
	while (scopeBindingTombstones.size > MAX_SCOPE_BINDING_TOMBSTONES) {
		const oldest = scopeBindingTombstones.keys().next().value as
			| string
			| undefined;
		if (!oldest) break;
		scopeBindingTombstones.delete(oldest);
	}
}

export function hasScopeBindingDenyOverlay(binding: ScopeBinding): boolean {
	const tombstone = scopeBindingTombstones.get(binding.generationId);
	return Boolean(
		tombstone &&
			tombstone.bindingId === binding.bindingId &&
			tombstone.revision >= binding.revision &&
			tombstone.lifecycleState !== 'live',
	);
}

/**
 * Issue #2271 bug 5: deny check that ignores purely time-based (sweep)
 * tombstones. `sweepExpired` installs an 'expired'-lifecycle tombstone at
 * revision+1 for every lapsed generation on ANY scope read — that is not a
 * deliberate denial, and the durable CAS in the idle-revival path re-verifies
 * the on-disk generation anyway. Deliberate revocation classes
 * ('revoked'/'superseded') and any failed-revocation overlay still deny.
 */
export function hasDeliberateScopeBindingDenyOverlay(
	binding: ScopeBinding,
): boolean {
	const tombstone = scopeBindingTombstones.get(binding.generationId);
	return Boolean(
		tombstone &&
			tombstone.bindingId === binding.bindingId &&
			tombstone.revision >= binding.revision &&
			tombstone.lifecycleState !== 'live' &&
			tombstone.lifecycleState !== 'expired',
	);
}

/**
 * Issue #2271 bug 5: remove a sweep-signature tombstone so a durable-CAS
 * revival can be admitted in memory. Only 'expired'-lifecycle tombstones at
 * or below the revived revision are cleared — deliberate revocations and any
 * newer overlay are preserved.
 */
export function clearSweepTombstoneForRevival(binding: ScopeBinding): void {
	const tombstone = scopeBindingTombstones.get(binding.generationId);
	if (
		tombstone &&
		tombstone.bindingId === binding.bindingId &&
		tombstone.lifecycleState === 'expired' &&
		tombstone.revision <= binding.revision
	) {
		scopeBindingTombstones.delete(binding.generationId);
	}
}

/** Fail-closed overlay used only when durable revocation cannot be verified. */
export function installFailedRevocationOverlay(
	binding: ScopeBinding,
	reason: Exclude<ScopeBindingLifecycleState, 'live'>,
): boolean {
	const current = pendingScopeBindings.get(binding.generationId);
	if (
		!current ||
		current.bindingId !== binding.bindingId ||
		current.revision !== binding.revision
	)
		return false;
	const now = Date.now();
	installScopeBindingTombstone({
		...current,
		revision: current.revision + 1,
		lifecycleState: reason,
		updatedAt: now,
		expiresAt: Math.min(current.expiresAt, now),
	});
	return true;
}

/**
 * Installs an immediate generation-wide deny intent before durable retirement
 * contends with refresh. Unlike the failure-only overlay, cleanup owns the
 * whole exact generation and therefore deliberately follows a newer revision.
 */
export function installScopeBindingRetirementIntent(
	binding: Pick<ScopeBinding, 'bindingId' | 'generationId'> &
		Partial<ScopeBinding>,
): ScopeBinding | null {
	const current = pendingScopeBindings.get(binding.generationId);
	const source =
		current ?? (binding.version === 2 ? (binding as ScopeBinding) : null);
	if (!source || source.bindingId !== binding.bindingId) return null;
	const now = Date.now();
	const tombstone: ScopeBinding = {
		...source,
		revision: source.revision + 1,
		lifecycleState: 'revoked',
		updatedAt: now,
		expiresAt: Math.min(source.expiresAt, now),
	};
	installScopeBindingTombstone(tombstone);
	return tombstone;
}

export function updateExactScopeBinding(
	binding: ScopeBinding,
): ScopeBindingAdmissionResult {
	const current = pendingScopeBindings.get(binding.generationId);
	if (
		!current ||
		current.bindingId !== binding.bindingId ||
		binding.revision <= current.revision
	)
		return {
			ok: false,
			code: 'SCOPE_BINDING_CAPACITY',
			message: 'The exact binding generation is stale or no longer active.',
		};
	pendingScopeBindings.set(binding.generationId, binding);
	return { ok: true, binding };
}

/**
 * Atomically claim the pending scope for the exact Task call whose upstream
 * metadata identified the actual OpenCode child session. The call id is part of
 * the authorization identity; parent-session FIFO guessing is never used.
 */
export function claimScopeBindingForChild(input: {
	directory: string;
	parentSessionId: string;
	childSessionId: string;
	dispatchCallId: string;
}): { previous: ScopeBinding; claimed: ScopeBinding } | null {
	sweepExpired();
	const workspaceIdentity = canonicalWorkspaceIdentity(input.directory);
	if (
		!workspaceIdentity ||
		!input.parentSessionId.trim() ||
		!input.childSessionId.trim() ||
		!input.dispatchCallId.trim() ||
		input.parentSessionId === input.childSessionId
	)
		return null;
	const matches = [...pendingScopeBindings.values()].filter(
		(binding) =>
			binding.workspaceIdentity === workspaceIdentity &&
			binding.ownerSessionId === input.parentSessionId &&
			binding.activation === 'pending_child' &&
			binding.ownerMessageId === input.dispatchCallId &&
			binding.dispatchCallId === input.dispatchCallId,
	);
	if (matches.length !== 1) return null;
	const previous = matches[0];
	const claimed = createClaimedScopeBinding(previous, {
		parentSessionId: input.parentSessionId,
		childSessionId: input.childSessionId,
		dispatchCallId: input.dispatchCallId,
	});
	const admitted = registerScopeBinding(claimed);
	if (!admitted.ok) return null;
	pendingScopeBindings.delete(bindingKey(previous));
	return { previous, claimed };
}

export function createClaimedScopeBinding(
	previous: ScopeBinding,
	input: {
		parentSessionId: string;
		childSessionId: string;
		dispatchCallId: string;
	},
): ScopeBinding {
	const now = Date.now();
	return {
		...previous,
		generationId: newIdentity(),
		revision: 1,
		ownerSessionId: input.childSessionId,
		childSessionId: input.childSessionId,
		ownerMessageId: input.dispatchCallId,
		dispatchCallId: input.dispatchCallId,
		parentOwnerSessionId: input.parentSessionId,
		parentCallId: input.dispatchCallId,
		activation: 'active',
		predecessorGenerationId: previous.generationId,
		updatedAt: now,
		leaseStartedAt: now,
		expiresAt: now + DEFAULT_SCOPE_BINDING_TTL_MS,
	};
}

export function deriveChildScopeBinding(
	parent: ScopeBinding,
	input: {
		childDirectory: string;
		childSessionId: string;
		parentCallId: string;
	},
): ScopeBinding {
	const workspaceIdentity = canonicalWorkspaceIdentity(input.childDirectory);
	if (
		!workspaceIdentity ||
		!input.childSessionId.trim() ||
		!input.parentCallId.trim()
	) {
		throw new Error(
			'Cannot derive child scope binding without verified identity',
		);
	}
	const now = Date.now();
	return {
		...parent,
		generationId: newIdentity(),
		revision: 1,
		workspaceIdentity,
		ownerSessionId: input.childSessionId,
		ownerMessageId: input.parentCallId,
		dispatchCallId: input.parentCallId,
		activation: 'active',
		parentOwnerSessionId: parent.ownerSessionId,
		parentCallId: input.parentCallId,
		predecessorGenerationId: parent.generationId,
		childSessionId: input.childSessionId,
		source: 'worktree_derived',
		declaredAt: now,
		updatedAt: now,
		leaseStartedAt: now,
		expiresAt: now + DEFAULT_SCOPE_BINDING_TTL_MS,
	};
}

/**
 * Containment predicate shared by every scope consumer: a candidate path is
 * covered by a scope entry when it is that entry or lives beneath it. Exported
 * so authority-minting callers (e.g. the Lean Turbo lane publisher) narrow a
 * candidate file set against plan authority using the *same* semantics the
 * write gates later enforce, instead of re-implementing containment.
 */
export function scopeContains(
	scope: readonly string[],
	candidate: string,
): boolean {
	const flavor = getPathFlavor();
	const candidateIdentity = normalizePathIdentity(candidate, flavor).replace(
		/\\/g,
		'/',
	);
	return scope.some((entry) => {
		const entryIdentity = normalizePathIdentity(entry, flavor).replace(
			/\\/g,
			'/',
		);
		return (
			candidateIdentity === entryIdentity ||
			candidateIdentity.startsWith(`${entryIdentity}/`)
		);
	});
}

function isSubset(
	candidate: readonly string[],
	authority: readonly string[],
): boolean {
	return candidate.every((file) => scopeContains(authority, file));
}

export function resolveCoderScopeSources(input: {
	explicitFiles: readonly string[] | null | undefined;
	planFiles: readonly string[] | null | undefined;
	fileDirectiveFiles: readonly string[] | null | undefined;
}):
	| {
			ok: true;
			files: string[];
			source: 'declare_scope' | 'plan' | 'file_directive';
	  }
	| {
			ok: false;
			code: 'SCOPE_NOT_DECLARED';
			sources?: ScopeSourceSets;
	  }
	| {
			ok: false;
			code: 'SCOPE_CONFLICT';
			authoritativeSource: 'declare_scope' | 'plan';
			authoritativeFiles: string[];
			conflictingSource: 'plan' | 'file_directive';
			conflictingFiles: string[];
			disagreement: string[];
			sources: ScopeSourceSets;
	  } {
	const explicit =
		input.explicitFiles && input.explicitFiles.length > 0
			? normalizeScopeFiles(input.explicitFiles)
			: null;
	const plan =
		input.planFiles && input.planFiles.length > 0
			? normalizeScopeFiles(input.planFiles)
			: null;
	const directives =
		input.fileDirectiveFiles && input.fileDirectiveFiles.length > 0
			? normalizeScopeFiles(input.fileDirectiveFiles)
			: null;
	if (input.explicitFiles && input.explicitFiles.length > 0 && !explicit)
		return {
			ok: false,
			code: 'SCOPE_NOT_DECLARED',
			sources: { explicit, plan, directives },
		};
	if (input.planFiles && input.planFiles.length > 0 && !plan)
		return {
			ok: false,
			code: 'SCOPE_NOT_DECLARED',
			sources: { explicit, plan, directives },
		};
	if (
		input.fileDirectiveFiles &&
		input.fileDirectiveFiles.length > 0 &&
		!directives
	)
		return {
			ok: false,
			code: 'SCOPE_NOT_DECLARED',
			sources: { explicit, plan, directives },
		};

	if (explicit) {
		const conflict =
			plan && !isSubset(plan, explicit)
				? { source: 'plan' as const, files: plan }
				: directives && !isSubset(directives, explicit)
					? { source: 'file_directive' as const, files: directives }
					: null;
		if (conflict)
			return {
				ok: false,
				code: 'SCOPE_CONFLICT',
				authoritativeSource: 'declare_scope',
				authoritativeFiles: explicit,
				conflictingSource: conflict.source,
				conflictingFiles: conflict.files,
				disagreement: conflict.files.filter(
					(file) => !scopeContains(explicit, file),
				),
				sources: { explicit, plan, directives },
			};
		return { ok: true, files: explicit, source: 'declare_scope' };
	}
	if (plan) {
		if (directives && !isSubset(directives, plan))
			return {
				ok: false,
				code: 'SCOPE_CONFLICT',
				authoritativeSource: 'plan',
				authoritativeFiles: plan,
				conflictingSource: 'file_directive',
				conflictingFiles: directives,
				disagreement: directives.filter((file) => !scopeContains(plan, file)),
				sources: { explicit, plan, directives },
			};
		return { ok: true, files: plan, source: 'plan' };
	}
	if (directives)
		return { ok: true, files: directives, source: 'file_directive' };
	return { ok: false, code: 'SCOPE_NOT_DECLARED' };
}

interface ScopeSourceSets {
	explicit: string[] | null;
	plan: string[] | null;
	directives: string[] | null;
}

function renderSet(values: readonly string[] | null, max = 8): string {
	if (!values) return '(none)';
	const shown = values.slice(0, max).map((value) => JSON.stringify(value));
	return `${shown.join(', ')}${values.length > max ? `, … +${values.length - max}` : ''}`;
}

/** One bounded renderer shared by normal and PR-feedback preflight paths. */
export function formatCoderScopeConflict(
	decision: Extract<ReturnType<typeof resolveCoderScopeSources>, { ok: false }>,
): string {
	if (decision.code !== 'SCOPE_CONFLICT')
		return 'SCOPE_NOT_DECLARED: coder delegation has no complete, valid, non-empty scope.';
	return (
		`SCOPE_CONFLICT: ${decision.authoritativeSource} authority [${renderSet(decision.authoritativeFiles)}] ` +
		`does not cover ${decision.conflictingSource} [${renderSet(decision.conflictingFiles)}]; ` +
		`outside authority: [${renderSet(decision.disagreement)}]. ` +
		'Architect: reconcile save_plan(files_touched), FILE directives, or declare_scope, then dispatch a new Task call.'
	);
}
