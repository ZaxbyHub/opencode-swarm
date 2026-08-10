import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScopeBinding } from './scope-binding.js';
import {
	refreshScopeBindingLease,
	type ScopePersistenceResult,
} from './scope-persistence.js';

const MAX_CANDIDATES = 256;
const MAX_TARGETS = 256;
const MAX_HASH_BYTES = 4 * 1024 * 1024;
const MAX_AGGREGATE_HASH_BYTES = 8 * 1024 * 1024;
const CANDIDATE_TTL_MS = 10 * 60 * 1000;

interface FileFingerprint {
	kind: 'missing' | 'file' | 'other' | 'unsafe';
	size?: number;
	mtimeMs?: number;
	hash?: string;
}

interface ExpectedEffect {
	exactContent?: string;
	containsText?: string;
}

interface LeaseCandidate {
	createdAt: number;
	callID: string;
	sessionID: string;
	tool: string;
	directory: string;
	bindingId: string;
	generationId: string;
	expectedRevision: number;
	taskId: string;
	targets: Array<{
		path: string;
		before: FileFingerprint;
		expected: ExpectedEffect;
	}>;
}

export interface ScopeLeaseCandidateInput {
	callID: string;
	sessionID: string;
	tool: string;
	directory: string;
	binding: ScopeBinding;
	targets: string[];
	args?: unknown;
}

export interface ScopeLeaseAfterOutput {
	title?: unknown;
	output?: unknown;
	metadata?: unknown;
}

export interface ScopeLeaseRenewalTracker {
	remember(input: ScopeLeaseCandidateInput): void;
	consume(input: {
		callID: string;
		sessionID: string;
		tool: string;
		output: ScopeLeaseAfterOutput | null | undefined;
	}): Promise<ScopePersistenceResult | null>;
}

type RefreshLease = typeof refreshScopeBindingLease;

function fingerprint(
	filePath: string,
	budget: { remaining: number },
): FileFingerprint {
	try {
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink()) return { kind: 'unsafe' };
		if (!stat.isFile()) {
			return { kind: 'unsafe' };
		}
		if (stat.size > MAX_HASH_BYTES || stat.size > budget.remaining) {
			return { kind: 'unsafe' };
		}
		budget.remaining -= stat.size;
		const result: FileFingerprint = {
			kind: 'file',
			size: stat.size,
			mtimeMs: stat.mtimeMs,
		};
		result.hash = createHash('sha256')
			.update(fs.readFileSync(filePath))
			.digest('hex');
		return result;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT'
			? { kind: 'missing' }
			: { kind: 'unsafe' };
	}
}

function changed(before: FileFingerprint, after: FileFingerprint): boolean {
	if (before.kind === 'unsafe' || after.kind === 'unsafe') return false;
	if (before.kind !== after.kind) return true;
	if (before.kind === 'missing') return false;
	if (before.hash !== undefined || after.hash !== undefined) {
		return before.hash !== after.hash;
	}
	return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function effectFor(
	tool: string,
	args: unknown,
	targetCount: number,
): ExpectedEffect {
	if (targetCount !== 1 || !args || typeof args !== 'object') return {};
	const record = args as Record<string, unknown>;
	if (tool === 'write' || tool === 'create_file') {
		for (const key of ['content', 'file_text', 'text']) {
			if (typeof record[key] === 'string') return { exactContent: record[key] };
		}
	}
	if (tool === 'edit' || tool === 'replace') {
		for (const key of ['newString', 'new_string', 'replacement']) {
			if (typeof record[key] === 'string' && record[key] !== '') {
				return { containsText: record[key] };
			}
		}
	}
	return {};
}

function matchesExpected(
	filePath: string,
	expected: ExpectedEffect,
	budget: { remaining: number },
): boolean {
	if (
		expected.exactContent === undefined &&
		expected.containsText === undefined
	) {
		return true;
	}
	try {
		const stat = fs.statSync(filePath);
		if (
			!stat.isFile() ||
			stat.size > MAX_HASH_BYTES ||
			stat.size > budget.remaining
		) {
			return false;
		}
		budget.remaining -= stat.size;
		const content = fs.readFileSync(filePath, 'utf8');
		if (expected.exactContent !== undefined) {
			return content === expected.exactContent;
		}
		return content.includes(expected.containsText ?? '');
	} catch {
		return false;
	}
}

function numericExitCodes(metadata: unknown): number[] {
	if (!metadata || typeof metadata !== 'object') return [];
	const record = metadata as Record<string, unknown>;
	return ['exitCode', 'exit_code', 'exit']
		.map((key) => record[key])
		.filter((value): value is number => typeof value === 'number');
}

function directSuccess(output: ScopeLeaseAfterOutput): boolean {
	const text = typeof output.output === 'string' ? output.output.trim() : '';
	const metadata =
		output.metadata && typeof output.metadata === 'object'
			? (output.metadata as Record<string, unknown>)
			: null;
	const exitCodes = numericExitCodes(output.metadata);
	if (exitCodes.some((code) => code !== 0)) return false;
	if (metadata?.success === true) return true;
	if (
		metadata &&
		typeof metadata.status === 'string' &&
		['success', 'completed', 'ok', 'applied'].includes(
			metadata.status.toLowerCase(),
		)
	) {
		return true;
	}
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		if (parsed.success === true && parsed.dryRun !== true) return true;
	} catch {
		/* Native tools return bounded text, not JSON. */
	}
	return /^(?:Wrote file successfully\.|Edit applied successfully\.|Done!|Patch applied successfully\.|File (?:created|updated) successfully\.)/i.test(
		text,
	);
}

function successful(tool: string, output: ScopeLeaseAfterOutput): boolean {
	if (tool === 'bash' || tool === 'shell') {
		const exitCodes = numericExitCodes(output.metadata);
		return exitCodes.length > 0 && exitCodes.every((code) => code === 0);
	}
	return directSuccess(output);
}

export function createScopeLeaseRenewalTracker(
	refresh: RefreshLease = refreshScopeBindingLease,
	now: () => number = Date.now,
): ScopeLeaseRenewalTracker {
	const candidates = new Map<string, LeaseCandidate>();
	const candidateKey = (sessionID: string, callID: string): string =>
		`${sessionID}\u0000${callID}`;

	const sweep = (): void => {
		const cutoff = now() - CANDIDATE_TTL_MS;
		for (const [key, candidate] of candidates) {
			if (candidate.createdAt < cutoff) candidates.delete(key);
		}
		while (candidates.size >= MAX_CANDIDATES) {
			const oldest = candidates.keys().next().value;
			if (oldest === undefined) break;
			candidates.delete(oldest);
		}
	};

	return {
		remember(input): void {
			sweep();
			const binding = input.binding;
			if (
				binding.activation !== 'active' ||
				binding.lifecycleState !== 'live' ||
				binding.expiresAt <= now() ||
				binding.ownerSessionId !== input.sessionID ||
				input.targets.length === 0 ||
				input.targets.length > MAX_TARGETS
			) {
				return;
			}
			const uniqueTargets = [
				...new Set(input.targets.map((target) => path.resolve(target))),
			];
			if (uniqueTargets.length === 0 || uniqueTargets.length > MAX_TARGETS)
				return;
			const expected = effectFor(input.tool, input.args, uniqueTargets.length);
			const hashBudget = { remaining: MAX_AGGREGATE_HASH_BYTES };
			const targets = uniqueTargets.map((target) => ({
				path: target,
				before: fingerprint(target, hashBudget),
				expected,
			}));
			if (targets.some((target) => target.before.kind === 'unsafe')) return;
			candidates.set(candidateKey(input.sessionID, input.callID), {
				createdAt: now(),
				callID: input.callID,
				sessionID: input.sessionID,
				tool: input.tool,
				directory: input.directory,
				bindingId: binding.bindingId,
				generationId: binding.generationId,
				expectedRevision: binding.revision,
				taskId: binding.taskId,
				targets,
			});
		},

		async consume(input): Promise<ScopePersistenceResult | null> {
			const key = candidateKey(input.sessionID, input.callID);
			const candidate = candidates.get(key);
			candidates.delete(key);
			if (
				!candidate ||
				candidate.sessionID !== input.sessionID ||
				candidate.tool !== input.tool ||
				now() - candidate.createdAt > CANDIDATE_TTL_MS ||
				!input.output ||
				!successful(candidate.tool, input.output)
			) {
				return null;
			}
			const hashBudget = { remaining: MAX_AGGREGATE_HASH_BYTES };
			const contentBudget = { remaining: MAX_AGGREGATE_HASH_BYTES };
			for (const target of candidate.targets) {
				const after = fingerprint(target.path, hashBudget);
				if (
					!changed(target.before, after) ||
					!matchesExpected(target.path, target.expected, contentBudget)
				) {
					return null;
				}
			}
			return refresh({
				directory: candidate.directory,
				bindingId: candidate.bindingId,
				generationId: candidate.generationId,
				expectedRevision: candidate.expectedRevision,
				activeSessionId: candidate.sessionID,
				taskId: candidate.taskId,
			});
		},
	};
}
