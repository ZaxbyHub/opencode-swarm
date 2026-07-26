import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../config/plan-schema';
import { computePlanStructureHash } from '../plan/ledger';
import { derivePlanId } from '../plan/utils';

export const MAX_PENDING_SCOPE_BINDINGS = 256;
const DEFAULT_SCOPE_BINDING_TTL_MS = 60 * 60 * 1000;

export type ScopeBindingSource =
	| 'declare_scope'
	| 'plan'
	| 'file_directive'
	| 'pr_feedback'
	| 'worktree_derived';

export interface ScopeBinding {
	version: 2;
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
	/** PR_FEEDBACK bindings carry their parent workflow identity and revision. */
	workflowSessionId?: string;
	workflowRevisionDigest?: string;
	source: ScopeBindingSource;
	files: string[];
	declaredAt: number;
	expiresAt: number;
}

const pendingScopeBindings = new Map<string, ScopeBinding>();

export function canonicalWorkspaceIdentity(directory: string): string | null {
	try {
		const real = fs.realpathSync(directory).replace(/\\/g, '/');
		return process.platform === 'win32' ? real.toLowerCase() : real;
	} catch {
		return null;
	}
}

function isStrictTaskId(value: string): boolean {
	return /^\d+\.\d+(?:\.\d+)*$/.test(value);
}

function normalizeScopePath(value: string): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().replace(/\\/g, '/');
	if (
		trimmed.length === 0 ||
		trimmed.includes('\0') ||
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
	for (const file of files) {
		const candidate = normalizeScopePath(file);
		if (!candidate) return null;
		normalized.add(candidate);
	}
	return normalized.size > 0 ? [...normalized].sort() : null;
}

function bindingKey(binding: {
	workspaceIdentity: string;
	planStructureHash: string;
	taskId: string;
	ownerSessionId: string;
	ownerMessageId?: string;
}): string {
	return [
		binding.workspaceIdentity,
		binding.planStructureHash,
		binding.taskId,
		binding.ownerSessionId,
		binding.ownerMessageId ?? '',
	].join('\0');
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
		expiresAt: now + ttlMs,
	};
}

function sweepExpired(now = Date.now()): void {
	for (const [key, binding] of pendingScopeBindings) {
		if (binding.expiresAt <= now) pendingScopeBindings.delete(key);
	}
}

export function registerScopeBinding(binding: ScopeBinding): void {
	sweepExpired();
	if (
		binding.activation === 'declaration' &&
		binding.dispatchCallId === undefined
	) {
		for (const [existingKey, existing] of pendingScopeBindings) {
			if (
				existing.activation === 'declaration' &&
				existing.dispatchCallId === undefined &&
				existing.workspaceIdentity === binding.workspaceIdentity &&
				existing.taskId === binding.taskId &&
				existing.ownerSessionId === binding.ownerSessionId
			)
				pendingScopeBindings.delete(existingKey);
		}
	}
	const key = bindingKey(binding);
	pendingScopeBindings.delete(key);
	pendingScopeBindings.set(key, binding);
	while (pendingScopeBindings.size > MAX_PENDING_SCOPE_BINDINGS) {
		const oldest = pendingScopeBindings.keys().next().value as
			| string
			| undefined;
		if (!oldest) break;
		pendingScopeBindings.delete(oldest);
	}
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
	sweepExpired();
	const workspaceIdentity = canonicalWorkspaceIdentity(input.directory);
	if (!workspaceIdentity || !isStrictTaskId(input.taskId)) return null;
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
	return matches.length === 1 ? matches[0] : null;
}

export function clearScopeBindings(
	predicate?: (binding: ScopeBinding) => boolean,
): ScopeBinding[] {
	const removed: ScopeBinding[] = [];
	if (!predicate) {
		removed.push(...pendingScopeBindings.values());
		pendingScopeBindings.clear();
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
	pendingScopeBindings.delete(bindingKey(previous));
	const claimed: ScopeBinding = {
		...previous,
		ownerSessionId: input.childSessionId,
		parentOwnerSessionId: input.parentSessionId,
		parentCallId: previous.dispatchCallId,
		activation: 'active',
	};
	registerScopeBinding(claimed);
	return { previous, claimed };
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
		workspaceIdentity,
		ownerSessionId: input.childSessionId,
		ownerMessageId: input.parentCallId,
		dispatchCallId: input.parentCallId,
		activation: 'active',
		parentOwnerSessionId: parent.ownerSessionId,
		parentCallId: input.parentCallId,
		source: 'worktree_derived',
		declaredAt: now,
		expiresAt: Math.min(parent.expiresAt, now + DEFAULT_SCOPE_BINDING_TTL_MS),
	};
}

function scopeContains(scope: readonly string[], candidate: string): boolean {
	return scope.some(
		(entry) => candidate === entry || candidate.startsWith(`${entry}/`),
	);
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
	| { ok: false; code: 'SCOPE_NOT_DECLARED' | 'SCOPE_CONFLICT' } {
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
		return { ok: false, code: 'SCOPE_NOT_DECLARED' };
	if (input.planFiles && input.planFiles.length > 0 && !plan)
		return { ok: false, code: 'SCOPE_NOT_DECLARED' };
	if (
		input.fileDirectiveFiles &&
		input.fileDirectiveFiles.length > 0 &&
		!directives
	)
		return { ok: false, code: 'SCOPE_NOT_DECLARED' };

	if (explicit) {
		if (
			(plan && !isSubset(plan, explicit)) ||
			(directives && !isSubset(directives, explicit))
		)
			return { ok: false, code: 'SCOPE_CONFLICT' };
		return { ok: true, files: explicit, source: 'declare_scope' };
	}
	if (plan) {
		if (directives && !isSubset(directives, plan))
			return { ok: false, code: 'SCOPE_CONFLICT' };
		return { ok: true, files: plan, source: 'plan' };
	}
	if (directives)
		return { ok: true, files: directives, source: 'file_directive' };
	return { ok: false, code: 'SCOPE_NOT_DECLARED' };
}
