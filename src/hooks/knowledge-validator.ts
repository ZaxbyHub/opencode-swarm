/** Three-layer validation gate for the opencode-swarm v6.17 knowledge system. */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { warn } from '../utils/logger.js';
import {
	appendKnowledge,
	inferTags,
	readKnowledge,
} from './knowledge-store.js';
import type {
	ActionableDirectiveFields,
	DirectivePriority,
	KnowledgeCategory,
	KnowledgeEntryBase,
	RejectedLesson,
} from './knowledge-types.js';

// ============================================================================
// Exported Types
// ============================================================================

export interface ValidationResult {
	valid: boolean;
	layer: 1 | 2 | 3 | null; // null when valid
	reason: string | null; // null when valid
	severity: 'error' | 'warning' | null; // null when valid
}

// ============================================================================
// Layer 2 — Content Safety Constants
// ============================================================================

export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
	/\brm\s+-rf\b/,
	/\bsudo\s+rm\b/,
	/\bformat\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{/,
	/\bchmod\s+-R\s+777\b/,
	/\bdeltree\b/,
	/\brmdir\s+\/s\b/,
	/\bkill\s+-9\b/,
	/\bpkill\b/,
	/\bkillall\b/,
	/`[^`]*`/,
	/\$\([^)]*\)/,
];

export const SECURITY_DEGRADING_PATTERNS: RegExp[] = [
	/disable\s+.{0,50}firewall/i,
	/turn\s+off\s+.{0,50}security/i,
	/skip\s+.{0,50}auth/i,
	/bypass\s+.{0,50}auth/i,
	/ignore\s+.{0,50}certificate/i,
	/disable\s+.{0,50}tls/i,
	/disable\s+.{0,50}ssl/i,
	/no\s+.{0,50}validation/i,
	/disable\s+.{0,50}2fa/i,
	/remove\s+.{0,50}password/i,
];

export const INVISIBLE_FORMAT_CHARS =
	/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export const INJECTION_PATTERNS: RegExp[] = [
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — pattern detects injected control characters
	/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f\x0d]/,
	/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/, // invisible format chars
	/^system\s*:/i,
	/<script/i,
	/javascript:/i,
	/\beval\(/i,
	/\b__proto__\b/,
	/\bconstructor\[/,
	/\.prototype\[/,
];

// ============================================================================
// Internal Helpers
// ============================================================================

const VALID_CATEGORIES = new Set<string>([
	'process',
	'architecture',
	'tooling',
	'security',
	'testing',
	'debugging',
	'performance',
	'integration',
	'todo',
	'other',
]);

const TECH_REFERENCE_WORDS = new Set([
	'git',
	'docker',
	'typescript',
	'bun',
	'vitest',
	'node',
	'python',
	'react',
	'sql',
	'api',
	'hook',
	'test',
	'schema',
	'config',
	'file',
	'function',
	'class',
	'module',
	'import',
	'export',
]);

const ACTION_VERB_WORDS = new Set([
	'use',
	'avoid',
	'prefer',
	'run',
	'check',
	'always',
	'never',
	'ensure',
	'call',
	'write',
	'add',
	'remove',
	'update',
	'set',
	'enable',
	'disable',
]);

const NEGATION_PAIRS: [string, string][] = [
	['always', 'never'],
	['must', 'must not'],
	['must', 'should not'],
	['enable', 'disable'],
	['use', 'avoid'],
	['use', "don't use"],
	['recommended', 'not recommended'],
];

function normalizeText(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Detect contradiction between candidate and existing lessons.
 * Only compares pairs that share at least 1 tag in common.
 * Returns true if a contradiction is found.
 */
function detectContradiction(
	candidate: string,
	existingLessons: string[],
): boolean {
	const candidateTags = inferTags(candidate);
	if (candidateTags.length === 0) return false;

	const candidateNorm = normalizeText(candidate);

	for (const existing of existingLessons) {
		const existingTags = inferTags(existing);

		// Only compare if they share at least one tag
		const shared = candidateTags.some((t) => existingTags.includes(t));
		if (!shared) continue;

		const existingNorm = normalizeText(existing);

		// Check for negation pairs
		for (const [wordA, wordB] of NEGATION_PAIRS) {
			const hasA =
				candidateNorm.includes(wordA) && existingNorm.includes(wordB);
			const hasB =
				candidateNorm.includes(wordB) && existingNorm.includes(wordA);
			if (hasA || hasB) return true;
		}
	}

	return false;
}

/**
 * Check if a lesson is too vague (lacks both tech reference and action verb).
 * Returns true if vague.
 */
function isVagueLesson(lesson: string): boolean {
	const lower = normalizeText(lesson);
	const words = lower.split(/\s+/);

	const hasTechRef = words.some((w) => TECH_REFERENCE_WORDS.has(w));
	const hasActionVerb = words.some((w) => ACTION_VERB_WORDS.has(w));

	return !hasTechRef && !hasActionVerb;
}

// ============================================================================
// Main Validation Function
// ============================================================================

export function validateLesson(
	candidate: string,
	existingLessons: string[],
	meta: {
		category: KnowledgeCategory;
		scope: string;
		confidence: number;
	},
): ValidationResult {
	// Null/undefined input guards
	if (!candidate || typeof candidate !== 'string') {
		return {
			valid: false,
			layer: 1,
			reason: 'lesson too short (min 15 chars)',
			severity: 'error',
		};
	}
	if (!Array.isArray(existingLessons)) {
		existingLessons = [];
	}

	// Layer 1 — Structural Checks
	if (candidate.length < 15) {
		return {
			valid: false,
			layer: 1,
			reason: 'lesson too short (min 15 chars)',
			severity: 'error',
		};
	}

	if (candidate.length > 280) {
		return {
			valid: false,
			layer: 1,
			reason: 'lesson too long (max 280 chars)',
			severity: 'error',
		};
	}

	if (!VALID_CATEGORIES.has(meta.category)) {
		return {
			valid: false,
			layer: 1,
			reason: `invalid category: ${meta.category}`,
			severity: 'error',
		};
	}

	const isGlobalScope = meta.scope === 'global';
	const isStackScope = /^stack:[a-zA-Z0-9_-]{1,64}$/.test(meta.scope);
	if (!isGlobalScope && !isStackScope) {
		return {
			valid: false,
			layer: 1,
			reason: "invalid scope: must be 'global' or 'stack:<name>'",
			severity: 'error',
		};
	}

	if (!(meta.confidence >= 0.0 && meta.confidence <= 1.0)) {
		return {
			valid: false,
			layer: 1,
			reason: 'confidence out of range [0.0, 1.0]',
			severity: 'error',
		};
	}

	// Layer 2 — Content Safety Checks
	// Normalize text before content safety checks to prevent Unicode homoglyph bypass
	const normalizedCandidate = candidate
		.normalize('NFKC')
		.replace(INVISIBLE_FORMAT_CHARS, ' ')
		.replace(/\s+/g, ' ')
		.toLowerCase();

	for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
		if (pattern.test(normalizedCandidate)) {
			return {
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			};
		}
	}

	for (const pattern of SECURITY_DEGRADING_PATTERNS) {
		if (pattern.test(normalizedCandidate)) {
			return {
				valid: false,
				layer: 2,
				reason: 'security-degrading instruction detected',
				severity: 'error',
			};
		}
	}

	for (const pattern of INJECTION_PATTERNS) {
		// Test original candidate (not normalized) because normalization removes control characters
		if (pattern.test(candidate)) {
			return {
				valid: false,
				layer: 2,
				reason: 'injection pattern detected',
				severity: 'error',
			};
		}
	}

	// Layer 3 — Semantic Quality Checks
	// Contradiction detection (error)
	if (detectContradiction(candidate, existingLessons)) {
		return {
			valid: false,
			layer: 3,
			reason: 'lesson contradicts an existing lesson with shared tags',
			severity: 'error',
		};
	}

	// Vagueness check (warning — does not block)
	if (isVagueLesson(candidate)) {
		return {
			valid: true,
			layer: 3,
			reason: 'lesson may be too vague (no tech reference or action verb)',
			severity: 'warning',
		};
	}

	// All checks passed
	return {
		valid: true,
		layer: null,
		reason: null,
		severity: null,
	};
}

// ============================================================================
// v2: Actionable directive metadata validation
// ============================================================================

/** Maximum chars allowed per trigger / required-action / forbidden-action string. */
export const ACTIONABLE_STRING_MAX = 200;
/** Maximum number of items in any actionable list (triggers, required_actions, etc.). */
export const ACTIONABLE_LIST_MAX = 20;
/** Allowed agent / tool name shape (snake_case, alnum/underscore, bounded). */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Allowed source ref shape: prevents path traversal and control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitation
const SOURCE_REF_FORBIDDEN = /(\.\.\/|\.\.\\|\0|[\x00-\x1f\x7f])/;
/** Generated skill paths must be repo-local under one of these prefixes. */
export const ALLOWED_SKILL_PATH_PREFIXES = [
	'.opencode/skills/generated/',
	'.swarm/skills/proposals/',
];

const VALID_DIRECTIVE_PRIORITIES = new Set<string>([
	'low',
	'medium',
	'high',
	'critical',
]);

export interface ActionableValidationResult {
	valid: boolean;
	errors: string[];
}

function isCleanShortString(s: unknown): s is string {
	if (typeof s !== 'string') return false;
	if (s.length === 0 || s.length > ACTIONABLE_STRING_MAX) return false;
	// Reject control characters and null bytes.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitation
	return !/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(s);
}

/** Validate a generated_skill_path: must be repo-local and under an allowed prefix. */
export function validateSkillPath(p: unknown): boolean {
	if (typeof p !== 'string') return false;
	if (p.length === 0 || p.length > 256) return false;
	if (p.includes('\0')) return false;
	if (path.isAbsolute(p)) return false;
	if (p.includes('..')) return false;
	const norm = p.replace(/\\/g, '/');
	return ALLOWED_SKILL_PATH_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

/** Validate the optional ActionableDirectiveFields block on a knowledge entry. */
export function validateActionableFields(
	fields: ActionableDirectiveFields | undefined,
): ActionableValidationResult {
	const errors: string[] = [];
	if (!fields) return { valid: true, errors };

	function checkStringList(name: string, list: unknown): void {
		if (list === undefined) return;
		if (!Array.isArray(list)) {
			errors.push(`${name} must be an array`);
			return;
		}
		if (list.length > ACTIONABLE_LIST_MAX) {
			errors.push(`${name} exceeds ${ACTIONABLE_LIST_MAX} items`);
		}
		for (const item of list) {
			if (!isCleanShortString(item)) {
				errors.push(`${name} contains invalid string`);
				return;
			}
		}
	}

	function checkNameList(name: string, list: unknown): void {
		if (list === undefined) return;
		if (!Array.isArray(list)) {
			errors.push(`${name} must be an array`);
			return;
		}
		if (list.length > ACTIONABLE_LIST_MAX) {
			errors.push(`${name} exceeds ${ACTIONABLE_LIST_MAX} items`);
		}
		for (const item of list) {
			if (typeof item !== 'string' || !NAME_PATTERN.test(item)) {
				errors.push(`${name} contains invalid name`);
				return;
			}
		}
	}

	checkStringList('triggers', fields.triggers);
	checkStringList('required_actions', fields.required_actions);
	checkStringList('forbidden_actions', fields.forbidden_actions);
	checkStringList('verification_checks', fields.verification_checks);
	checkNameList('applies_to_agents', fields.applies_to_agents);
	checkNameList('applies_to_tools', fields.applies_to_tools);

	if (fields.source_refs !== undefined) {
		if (!Array.isArray(fields.source_refs)) {
			errors.push('source_refs must be an array');
		} else if (fields.source_refs.length > ACTIONABLE_LIST_MAX) {
			errors.push(`source_refs exceeds ${ACTIONABLE_LIST_MAX} items`);
		} else {
			for (const ref of fields.source_refs) {
				if (
					typeof ref !== 'string' ||
					ref.length === 0 ||
					ref.length > ACTIONABLE_STRING_MAX ||
					SOURCE_REF_FORBIDDEN.test(ref)
				) {
					errors.push('source_refs contains invalid value');
					break;
				}
			}
		}
	}

	if (fields.source_knowledge_ids !== undefined) {
		if (!Array.isArray(fields.source_knowledge_ids)) {
			errors.push('source_knowledge_ids must be an array');
		} else {
			for (const id of fields.source_knowledge_ids) {
				if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
					errors.push('source_knowledge_ids contains invalid value');
					break;
				}
			}
		}
	}

	if (
		fields.directive_priority !== undefined &&
		!VALID_DIRECTIVE_PRIORITIES.has(String(fields.directive_priority))
	) {
		errors.push('directive_priority must be low|medium|high|critical');
	}

	if (fields.generated_skill_slug !== undefined) {
		if (
			typeof fields.generated_skill_slug !== 'string' ||
			!/^[a-z0-9][a-z0-9-]{0,63}$/.test(fields.generated_skill_slug)
		) {
			errors.push('generated_skill_slug must be a kebab-case slug');
		}
	}

	if (
		fields.generated_skill_path !== undefined &&
		!validateSkillPath(fields.generated_skill_path)
	) {
		errors.push('generated_skill_path must be repo-local under allowed prefix');
	}

	return { valid: errors.length === 0, errors };
}

export type { ActionableDirectiveFields, DirectivePriority };

// ============================================================================
// Quarantine Types
// ============================================================================

export interface QuarantinedEntry extends KnowledgeEntryBase {
	original_status: string;
	quarantine_reason: string;
	quarantined_at: string; // ISO 8601
	reported_by: 'architect' | 'user' | 'auto';
}

export interface EntryHealthResult {
	healthy: boolean;
	concern?: string;
}

// ============================================================================
// Entry Health Check (Pure Function)
// ============================================================================

export function auditEntryHealth(entry: KnowledgeEntryBase): EntryHealthResult {
	// Check for low-utility entry: high shown count but low utility score.
	// v2 NOTE: We now read shown_count (replaced legacy applied_count, which
	// was incremented for every "shown" event before v2 and is frozen now).
	// For older v1 entries the normalizer copies applied_count → shown_count,
	// so existing on-disk data continues to trip this audit correctly.
	const utilityScore = (entry as { utility_score?: number }).utility_score;
	const ro = entry.retrieval_outcomes as unknown as Record<
		string,
		number | undefined
	>;
	const shownCount =
		ro?.shown_count ?? entry.retrieval_outcomes?.applied_count ?? 0;

	if (shownCount >= 5 && utilityScore !== undefined && utilityScore <= 0) {
		return { healthy: false, concern: 'Low-utility entry' };
	}

	// Check for near-zero confidence
	if (entry.confidence < 0.1) {
		return { healthy: false, concern: 'Near-zero confidence' };
	}

	// Check for unconfirmed auto-generated entry
	if (entry.auto_generated === true && entry.confirmed_by.length === 0) {
		return { healthy: false, concern: 'Unconfirmed auto-generated' };
	}

	return { healthy: true };
}

// ============================================================================
// Quarantine Entry (With Lockfile)
// ============================================================================

export async function quarantineEntry(
	directory: string,
	entryId: string,
	reason: string,
	reportedBy: 'architect' | 'user' | 'auto',
): Promise<void> {
	// Guard against path traversal
	if (!directory || directory.includes('..')) {
		warn(
			'[knowledge-validator] quarantineEntry: directory traversal attempt blocked',
		);
		return;
	}

	// 1. Validate inputs
	if (!entryId || entryId.includes('\0') || entryId.includes('\n')) {
		warn('[knowledge-validator] quarantineEntry: invalid entryId rejected');
		return;
	}

	const validReportedBy = ['architect', 'user', 'auto'] as const;
	if (
		!validReportedBy.includes(reportedBy as (typeof validReportedBy)[number])
	) {
		return;
	}

	const sanitizedReason = reason
		.slice(0, 500)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strips control characters from user-supplied input
		.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f\x0d]/g, '');

	// 2. Build paths
	const knowledgePath = path.join(directory, '.swarm', 'knowledge.jsonl');
	const quarantinePath = path.join(
		directory,
		'.swarm',
		'knowledge-quarantined.jsonl',
	);
	const rejectedPath = path.join(
		directory,
		'.swarm',
		'knowledge-rejected.jsonl',
	);
	const swarmDir = path.join(directory, '.swarm');

	// 3. Ensure .swarm dir exists
	await mkdir(swarmDir, { recursive: true });

	// 4. Acquire lock FIRST, then read and write (all inside lock)
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(swarmDir, {
			retries: { retries: 3, minTimeout: 100 },
		});

		// Read INSIDE lock
		const entries = await readKnowledge<KnowledgeEntryBase>(knowledgePath);
		const entry = entries.find((e) => e.id === entryId);
		if (!entry) {
			return;
		}

		// Separate: remaining entries
		const remaining = entries.filter((e) => e.id !== entryId);

		// Build quarantine record
		const quarantined: QuarantinedEntry = {
			...entry,
			status: 'quarantined',
			original_status: entry.status,
			quarantine_reason: sanitizedReason,
			quarantined_at: new Date().toISOString(),
			reported_by: reportedBy,
		};

		// Write remaining entries back to knowledge.jsonl INSIDE lock
		// Fix empty file case: write '' not '\n'
		const jsonlContent =
			remaining.length > 0
				? `${remaining.map((e) => JSON.stringify(e)).join('\n')}\n`
				: '';
		await writeFile(knowledgePath, jsonlContent, 'utf-8');

		// Append to quarantine file INSIDE lock
		await appendFile(
			quarantinePath,
			`${JSON.stringify(quarantined)}\n`,
			'utf-8',
		);

		// FIFO max-100 cap on quarantine file INSIDE lock
		const quarantinedEntries =
			await readKnowledge<QuarantinedEntry>(quarantinePath);
		if (quarantinedEntries.length > 100) {
			// Keep last 100 (FIFO - drop oldest)
			const trimmed = quarantinedEntries.slice(-100);
			// Fix empty file case: write '' not '\n'
			const capContent =
				trimmed.length > 0
					? `${trimmed.map((e) => JSON.stringify(e)).join('\n')}\n`
					: '';
			await writeFile(quarantinePath, capContent, 'utf-8');
		}

		// 6. Append fingerprint to rejected file INSIDE lock
		const rejectedRecord: RejectedLesson = {
			id: entryId,
			lesson: entry.lesson,
			rejection_reason: sanitizedReason,
			rejected_at: new Date().toISOString(),
			rejection_layer: 3,
		};
		await appendKnowledge<RejectedLesson>(rejectedPath, rejectedRecord);
	} finally {
		if (release) {
			await release();
		}
	}
}

// ============================================================================
// Restore Entry (With Lockfile)
// ============================================================================

export async function restoreEntry(
	directory: string,
	entryId: string,
): Promise<void> {
	// Guard against path traversal
	if (!directory || directory.includes('..')) {
		warn(
			'[knowledge-validator] restoreEntry: directory traversal attempt blocked',
		);
		return;
	}

	// 0. Validate entryId
	if (!entryId || entryId.includes('\0') || entryId.includes('\n')) {
		warn('[knowledge-validator] restoreEntry: invalid entryId rejected');
		return;
	}

	// 1. Build paths (same as quarantineEntry)
	const knowledgePath = path.join(directory, '.swarm', 'knowledge.jsonl');
	const quarantinePath = path.join(
		directory,
		'.swarm',
		'knowledge-quarantined.jsonl',
	);
	const rejectedPath = path.join(
		directory,
		'.swarm',
		'knowledge-rejected.jsonl',
	);
	const swarmDir = path.join(directory, '.swarm');

	// 2. Ensure .swarm dir exists
	await mkdir(swarmDir, { recursive: true });

	// 3. Acquire lock FIRST, then read and write (all inside lock)
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(swarmDir, {
			retries: { retries: 3, minTimeout: 100 },
		});

		// Read quarantined entries INSIDE lock
		const quarantinedEntries =
			await readKnowledge<QuarantinedEntry>(quarantinePath);

		// Find entry to restore
		const entryToRestore = quarantinedEntries.find((e) => e.id === entryId);
		if (!entryToRestore) {
			return; // No-op if not found
		}

		// Separate: remaining quarantined entries
		const remaining = quarantinedEntries.filter((e) => e.id !== entryId);

		// Strip quarantine fields to recover original entry.
		// Also strip the 'quarantined' status and spurious original_status,
		// restoring the status the entry had before quarantine.
		const {
			quarantine_reason,
			quarantined_at,
			reported_by,
			original_status,
			status: _quarantineStatus,
			...rest
		} = entryToRestore;
		const original = { ...rest, status: original_status ?? 'candidate' };

		// Re-validate before restoring — a quarantined entry may have been blocked
		// for safety reasons (e.g., dangerous commands) and must pass content checks
		// before being reintroduced to knowledge.jsonl
		const validation = validateLesson(original.lesson, [], {
			category: original.category,
			scope: original.scope,
			confidence: original.confidence,
		});
		if (!validation.valid) {
			warn(
				`[knowledge-validator] restoreEntry: entry ${entryId} failed re-validation: ${validation.reason}`,
			);
			return; // Skip restore — entry remains in quarantine
		}

		// Write remaining quarantined entries back INSIDE lock
		// Fix empty file case: write '' not '\n'
		const jsonlContent =
			remaining.length > 0
				? `${remaining.map((e) => JSON.stringify(e)).join('\n')}\n`
				: '';
		await writeFile(quarantinePath, jsonlContent, 'utf-8');

		// Append original entry back to knowledge.jsonl INSIDE lock
		await appendFile(knowledgePath, `${JSON.stringify(original)}\n`, 'utf-8');

		// Remove from rejected file INSIDE lock
		const rejectedEntries = await readKnowledge<RejectedLesson>(rejectedPath);
		const filtered = rejectedEntries.filter((e) => e.id !== entryId);
		// Fix empty file case: write '' not '\n'
		const rejectedContent =
			filtered.length > 0
				? `${filtered.map((e) => JSON.stringify(e)).join('\n')}\n`
				: '';
		await writeFile(rejectedPath, rejectedContent, 'utf-8');
	} finally {
		if (release) {
			await release();
		}
	}
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals: {
	validateLesson: typeof validateLesson;
	auditEntryHealth: typeof auditEntryHealth;
	quarantineEntry: typeof quarantineEntry;
	restoreEntry: typeof restoreEntry;
} = {
	validateLesson,
	auditEntryHealth,
	quarantineEntry,
	restoreEntry,
};
