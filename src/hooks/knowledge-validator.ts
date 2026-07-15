/** Three-layer validation gate for the opencode-swarm v6.17 knowledge system. */

import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../evidence/task-file.js';
import {
	authorizeCuration,
	type CurationAuthorizationInput,
	type CurationContext,
} from '../knowledge/curation-policy.js';
import { warn } from '../utils/logger.js';
import { resolveKnowledgeStoreDir } from './knowledge-link.js';
import {
	findNearDuplicate,
	inferTags,
	readKnowledge,
	resolveSwarmKnowledgePath,
	resolveSwarmRejectedPath,
	transactKnowledge,
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

export const DANGEROUS_COMMAND_ERROR_PATTERNS: RegExp[] = [
	/\brm\s+-rf\b/,
	/\bsudo\s+rm\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/:\(\)\s*\{/,
	/\bchmod\s+-R\s+777\b/i,
	/\bdeltree\b/,
	/\brmdir\s+\/s\b/,
];

export const DANGEROUS_COMMAND_WARNING_PATTERNS: RegExp[] = [
	/\bformat\b/,
	/\bkill\s+-9\b/,
	/\bpkill\b/,
	/\bkillall\b/,
	/`[^`]*`/,
	/\$\([^)]*\)/,
];

export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
	...DANGEROUS_COMMAND_ERROR_PATTERNS,
	...DANGEROUS_COMMAND_WARNING_PATTERNS,
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

/**
 * Layer-2 content-safety scan for a single string value. Runs the same
 * *blocking* pattern sets {@link validateLesson}'s Layer-2 block uses —
 * dangerous-command errors, security-degrading instructions, and
 * prompt-injection patterns — over an arbitrary short string (e.g. a
 * directive-action field value such as `triggers` / `required_actions` /
 * `forbidden_actions` / `verification_checks`).
 *
 * Returns a blocking reason string on the first match, or `null` when the value
 * is content-safe. Mirrors validateLesson's normalization exactly: NFKC +
 * invisible-format-char stripping + whitespace collapse + lowercase for the
 * dangerous/security scans, and tests the RAW string for the injection patterns
 * (normalization would strip the very control/invisible characters those
 * patterns are meant to detect).
 *
 * The warning-severity dangerous-command patterns are intentionally NOT applied
 * here: validateLesson treats them as non-blocking warnings (they match benign
 * shell snippets like backticks and `$(...)` that legitimately appear in
 * actionable directives), so promoting them to hard rejections on field values
 * would create false positives without a corresponding safety gain.
 */
export function scanContentSafety(text: string): string | null {
	if (typeof text !== 'string' || text.length === 0) return null;
	const normalized = text
		.normalize('NFKC')
		.replace(INVISIBLE_FORMAT_CHARS, ' ')
		.replace(/\s+/g, ' ')
		.toLowerCase();
	for (const pattern of DANGEROUS_COMMAND_ERROR_PATTERNS) {
		if (pattern.test(normalized)) return 'dangerous command pattern detected';
	}
	for (const pattern of SECURITY_DEGRADING_PATTERNS) {
		if (pattern.test(normalized)) {
			return 'security-degrading instruction detected';
		}
	}
	for (const pattern of INJECTION_PATTERNS) {
		// Test the RAW string — normalization above removes the control/invisible
		// characters the leading injection patterns are meant to catch.
		if (pattern.test(text)) return 'injection pattern detected';
	}
	return null;
}

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
 * Extract context words around each occurrence of a target word (single tokens within a window).
 * Context window is 3 words before and after, excluding the target word itself.
 * Handles multi-word terms (e.g. "must not", "don't use") by scanning word slices.
 *
 * Note: this is an exact-word-match heuristic. Synonyms (e.g. "use" / "utilize")
 * will not match across lessons. The 3-token window is bounded; more distant
 * negation attachments will not be detected as contradictions.
 */
function extractContextWords(
	text: string,
	word: string,
	contextWindow = 3,
): Set<string> {
	const words = text.split(' ');
	const context = new Set<string>();

	// Single-word term: iterate every occurrence
	if (!word.includes(' ')) {
		let from = 0;
		let idx = words.indexOf(word, from);
		while (idx !== -1) {
			const start = Math.max(0, idx - contextWindow);
			const end = Math.min(words.length, idx + contextWindow + 1);
			for (let i = start; i < end; i++) {
				if (i !== idx && words[i] && words[i].length > 0) {
					context.add(words[i]);
				}
			}
			from = idx + 1;
			idx = words.indexOf(word, from);
		}
		return context;
	}

	// Multi-word term: scan contiguous word slices, accumulate across all matches
	const termLen = word.split(' ').length;
	let i = 0;
	while (i <= words.length - termLen) {
		const slice = words.slice(i, i + termLen).join(' ');
		if (slice === word) {
			const start = Math.max(0, i - contextWindow);
			const end = Math.min(words.length, i + termLen + contextWindow);
			for (let j = start; j < end; j++) {
				if (j < i || j >= i + termLen) {
					if (words[j] && words[j].length > 0) {
						context.add(words[j]);
					}
				}
			}
			i += termLen; // skip past this match
		} else {
			i += 1;
		}
	}

	return context;
}

/**
 * Check if two sets of words have significant overlap (at least one word in common).
 */
function hasSignificantOverlap(set1: Set<string>, set2: Set<string>): boolean {
	if (set1.size === 0 || set2.size === 0) return false;
	return [...set1].some((word) => set2.has(word));
}

/**
 * Detect contradiction between candidate and existing lessons.
 * Only compares pairs that share at least 1 tag in common.
 * Requires negation words to attach to overlapping content to flag as contradiction.
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
			// Case 1: candidate has wordA, existing has wordB
			if (candidateNorm.includes(wordA) && existingNorm.includes(wordB)) {
				const contextA = extractContextWords(candidateNorm, wordA);
				const contextB = extractContextWords(existingNorm, wordB);
				if (hasSignificantOverlap(contextA, contextB)) {
					return true;
				}
			}

			// Case 2: candidate has wordB, existing has wordA
			if (candidateNorm.includes(wordB) && existingNorm.includes(wordA)) {
				const contextB = extractContextWords(candidateNorm, wordB);
				const contextA = extractContextWords(existingNorm, wordA);
				if (hasSignificantOverlap(contextA, contextB)) {
					return true;
				}
			}
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

	for (const pattern of DANGEROUS_COMMAND_ERROR_PATTERNS) {
		if (pattern.test(normalizedCandidate)) {
			return {
				valid: false,
				layer: 2,
				reason: 'dangerous command pattern detected',
				severity: 'error',
			};
		}
	}

	for (const pattern of DANGEROUS_COMMAND_WARNING_PATTERNS) {
		if (pattern.test(normalizedCandidate)) {
			return {
				valid: true,
				layer: 2,
				reason: 'potentially dangerous command pattern queued for review',
				severity: 'warning',
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
	// Contradiction detection is heuristic; store with warning for review.
	if (detectContradiction(candidate, existingLessons)) {
		return {
			valid: true,
			layer: 3,
			reason: 'possible contradiction with an existing lesson with shared tags',
			severity: 'warning',
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
/**
 * Maximum retired_skill_history entries. Must match the FIFO cap in
 * src/services/skill-generator.ts's clearSkillLinks (`if (history.length > 50)`).
 */
export const RETIRED_SKILL_HISTORY_MAX = 50;
/** Allowed agent / tool name shape (snake_case, alnum/underscore, bounded). */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Allowed source ref shape: prevents path traversal and control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitation
const SOURCE_REF_FORBIDDEN = /(\.\.\/|\.\.\\|\0|[\x00-\x1f\x7f])/;
/** Generated skill paths must be repo-local under one of these prefixes. */
export const ALLOWED_SKILL_PATH_PREFIXES = [
	'.opencode/skills/generated/',
	'.swarm/skills/proposals/',
	'.swarm/skills/candidates/',
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

/**
 * Validate that a path is a valid candidate storage path under `.swarm/skills/candidates/`.
 * The filename must be a UUID v4 (canonical, no braces) with `.json` extension.
 */
export function validateSkillCandidatePath(p: unknown): boolean {
	if (typeof p !== 'string') return false;
	if (p.length === 0 || p.length > 256) return false;
	if (p.includes('\0')) return false;
	if (path.isAbsolute(p)) return false;
	if (p.includes('..')) return false;
	const norm = p.replace(/\\/g, '/');
	if (!norm.startsWith('.swarm/skills/candidates/')) return false;
	// Filename must be <uuid-v4>.json
	const filename = norm.slice('.swarm/skills/candidates/'.length);
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(
		filename,
	);
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
			// M10: directive-action field values are injected into agent context
			// verbatim (via the delegate/architect directive blocks), so they must
			// pass the same Layer-2 content-safety scan validateLesson runs on the
			// lesson text. Structural checks above (length/count/control-char) are
			// preserved; this is an added gate, not a replacement.
			const unsafe = scanContentSafety(item);
			if (unsafe) {
				errors.push(`${name} contains unsafe content: ${unsafe}`);
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

	// G10/G12 (issue #1717): validate the new draft/retire fields.
	if (fields.draft_generated_skill_slug !== undefined) {
		if (
			typeof fields.draft_generated_skill_slug !== 'string' ||
			!/^[a-z0-9][a-z0-9-]{0,63}$/.test(fields.draft_generated_skill_slug)
		) {
			errors.push('draft_generated_skill_slug must be a kebab-case slug');
		}
	}
	if (
		fields.draft_generated_skill_path !== undefined &&
		!validateSkillPath(fields.draft_generated_skill_path)
	) {
		errors.push(
			'draft_generated_skill_path must be repo-local under allowed prefix',
		);
	}
	if (fields.retired_skill_history !== undefined) {
		if (!Array.isArray(fields.retired_skill_history)) {
			errors.push('retired_skill_history must be an array of slugs');
		} else {
			// PR #1731 review M1-001: match the producer's own FIFO cap
			// (src/services/skill-generator.ts clearSkillLinks) so a tampered or
			// malformed entry can't carry an unbounded history array through
			// validation. Not ACTIONABLE_LIST_MAX (20) — retired_skill_history is
			// intentionally capped at 50 by its only writer.
			if (fields.retired_skill_history.length > RETIRED_SKILL_HISTORY_MAX) {
				errors.push(
					`retired_skill_history exceeds ${RETIRED_SKILL_HISTORY_MAX} items`,
				);
			} else if (
				!fields.retired_skill_history.every(
					(s: unknown) =>
						typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s),
				)
			) {
				errors.push('retired_skill_history entries must be kebab-case slugs');
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

export type { ActionableDirectiveFields, DirectivePriority };

// ============================================================================
// Layer 5 — Actionability (Change 4)
// ============================================================================

export interface ActionabilityResult {
	actionable: boolean;
	/** Present only when not actionable. */
	reason?:
		| 'missing_predicate'
		| 'missing_scope'
		| 'missing_predicate_and_scope';
}

function hasNonEmptyList(v: unknown): boolean {
	return Array.isArray(v) && v.length > 0;
}

/**
 * Layer 5: an entry is actionable only when it carries at least one
 * machine-checkable predicate AND at least one scope tag.
 *
 *   predicate := forbidden_actions | required_actions | verification_checks
 *                | verification_predicate
 *   scope     := applies_to_tools | applies_to_agents
 *
 * Plain-prose lessons (no predicate, no scope) are NOT actionable and must be
 * quarantined rather than activated.
 */
export function validateActionability(
	entry: Pick<
		KnowledgeEntryBase,
		| 'forbidden_actions'
		| 'required_actions'
		| 'verification_checks'
		| 'verification_predicate'
		| 'applies_to_tools'
		| 'applies_to_agents'
	>,
): ActionabilityResult {
	const hasPredicate =
		hasNonEmptyList(entry.forbidden_actions) ||
		hasNonEmptyList(entry.required_actions) ||
		hasNonEmptyList(entry.verification_checks) ||
		(typeof entry.verification_predicate === 'string' &&
			entry.verification_predicate.trim().length > 0);
	const hasScope =
		hasNonEmptyList(entry.applies_to_tools) ||
		hasNonEmptyList(entry.applies_to_agents);

	if (hasPredicate && hasScope) return { actionable: true };
	const reason: ActionabilityResult['reason'] =
		!hasPredicate && !hasScope
			? 'missing_predicate_and_scope'
			: !hasPredicate
				? 'missing_predicate'
				: 'missing_scope';
	return { actionable: false, reason };
}

/** Returns the knowledge-unactionable.jsonl path for the given directory (link-aware). */
export function resolveUnactionablePath(directory: string): string {
	return path.join(
		resolveKnowledgeStoreDir(directory),
		'knowledge-unactionable.jsonl',
	);
}

/** One quarantined-unactionable record. */
export interface UnactionableRecord extends KnowledgeEntryBase {
	status: 'quarantined_unactionable';
	unactionable_reason: string;
	quarantined_at: string;
}

/**
 * Persist an entry that failed the actionability layer to the unactionable
 * queue (held out of the active store, pending hardening by the skill-improver).
 * FIFO-capped at 200. Best-effort: throws only on lock failure for tests.
 *
 * Duplicate or near-duplicate prose lessons are deduped under the same lock used
 * for the append/trim transaction. This keeps hook-first/phase_complete replay
 * from filling the bounded queue with equivalent quarantines.
 */
export async function appendUnactionable(
	directory: string,
	entry: KnowledgeEntryBase,
	reason: string,
): Promise<void> {
	const filePath = resolveUnactionablePath(directory);
	const dirPath = path.dirname(filePath);
	await mkdir(dirPath, { recursive: true });
	await transactKnowledge<UnactionableRecord>(filePath, (existing) => {
		const record: UnactionableRecord = {
			...entry,
			status: 'quarantined_unactionable',
			unactionable_reason: reason,
			quarantined_at: new Date().toISOString(),
		};
		const duplicate = findNearDuplicate(record.lesson, existing, 0.6);
		if (duplicate?.unactionable_reason === reason) {
			duplicate.quarantined_at = record.quarantined_at;
			duplicate.updated_at = record.updated_at;
			return existing;
		}
		const next = [...existing, record];
		return next.length > 200 ? next.slice(-200) : next;
	});
}

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
	/** #1848: cohort-safe curation context. When provided, the quarantine is
	 * authorized through the shared curation policy BEFORE mutating; an
	 * unauthorized action becomes a non-destructive no-op (the policy records a
	 * proposal). When omitted, the legacy behavior applies (used by
	 * deterministic validation-failure withholds and non-cohort callers). */
	curationContext?: {
		input: CurationAuthorizationInput;
		context: CurationContext;
	},
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

	// 2. Build paths (link-aware: redirect to the shared store when linked).
	const knowledgePath = resolveSwarmKnowledgePath(directory);
	const quarantinePath = path.join(
		resolveKnowledgeStoreDir(directory),
		'knowledge-quarantined.jsonl',
	);
	const rejectedPath = resolveSwarmRejectedPath(directory);
	const swarmDir = resolveKnowledgeStoreDir(directory);

	// 3. Ensure .swarm store dir exists
	await mkdir(swarmDir, { recursive: true });

	// 4. Acquire lock FIRST, then read and write (all inside lock)
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(swarmDir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		// Read INSIDE lock
		const entries = await readKnowledge<KnowledgeEntryBase>(knowledgePath);
		const entry = entries.find((e) => e.id === entryId);
		if (!entry) {
			return;
		}

		// #1848 §2: cohort-safe authorization. When a curation context is
		// supplied, quarantine is gated by the shared policy. Pre-transaction
		// authorization over the freshest entry (just read inside the lock);
		// the revision CAS inside the mutation guards against drift between
		// authorize and apply (C-4 fix).
		if (curationContext) {
			const refreshedContext: CurationContext = {
				...curationContext.context,
				entry: entry as CurationContext['entry'],
			};
			const decision = await authorizeCuration(
				curationContext.input,
				refreshedContext,
			);
			if (!decision.authorized) {
				warn(
					`[knowledge-validator] quarantineEntry blocked by cohort-safety policy ` +
						`(basis: ${decision.basis}): ${decision.detail}`,
				);
				return; // non-destructive no-op; the policy recorded a proposal
			}
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

		// Write remaining entries back to knowledge.jsonl INSIDE lock (crash-atomic)
		// Fix empty file case: write '' not '\n'
		const jsonlContent =
			remaining.length > 0
				? `${remaining.map((e) => JSON.stringify(e)).join('\n')}\n`
				: '';
		await atomicWriteFile(knowledgePath, jsonlContent);

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
			// Fix empty file case: write '' not '\n' (crash-atomic)
			const capContent =
				trimmed.length > 0
					? `${trimmed.map((e) => JSON.stringify(e)).join('\n')}\n`
					: '';
			await atomicWriteFile(quarantinePath, capContent);
		}

		// 6. Append fingerprint to rejected file INSIDE lock
		const rejectedRecord: RejectedLesson = {
			id: entryId,
			lesson: entry.lesson,
			rejection_reason: sanitizedReason,
			rejected_at: new Date().toISOString(),
			rejection_layer: 3,
		};
		await appendFile(
			rejectedPath,
			`${JSON.stringify(rejectedRecord)}\n`,
			'utf-8',
		);
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
	/** #1848 §2: cohort-safe curation context (optional). When provided, the
	 * restore is authorized through the shared policy before mutating. */
	curationContext?: {
		input: CurationAuthorizationInput;
		context: CurationContext;
	},
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

	// 1. Build paths (same as quarantineEntry; link-aware via resolveKnowledgeStoreDir).
	const storeDir = resolveKnowledgeStoreDir(directory);
	const knowledgePath = resolveSwarmKnowledgePath(directory);
	const quarantinePath = path.join(storeDir, 'knowledge-quarantined.jsonl');
	const rejectedPath = resolveSwarmRejectedPath(directory);
	const swarmDir = storeDir;

	// 2. Ensure .swarm dir exists
	await mkdir(swarmDir, { recursive: true });

	// 3. Acquire lock FIRST, then read and write (all inside lock)
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(swarmDir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		// Read quarantined entries INSIDE lock
		const quarantinedEntries =
			await readKnowledge<QuarantinedEntry>(quarantinePath);

		// Find entry to restore
		const entryToRestore = quarantinedEntries.find((e) => e.id === entryId);
		if (!entryToRestore) {
			return; // No-op if not found
		}

		// #1848 §2 (IR-3 fix): cohort-safe authorization for restore. When a
		// curation context is supplied, the restore is gated by the shared policy.
		if (curationContext) {
			const refreshedContext: CurationContext = {
				...curationContext.context,
				entry: entryToRestore as CurationContext['entry'],
			};
			const decision = await authorizeCuration(
				curationContext.input,
				refreshedContext,
			);
			if (!decision.authorized) {
				warn(
					`[knowledge-validator] restoreEntry blocked by cohort-safety policy ` +
						`(basis: ${decision.basis}): ${decision.detail}`,
				);
				return;
			}
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

		// Write remaining quarantined entries back INSIDE lock (crash-atomic)
		// Fix empty file case: write '' not '\n'
		const jsonlContent =
			remaining.length > 0
				? `${remaining.map((e) => JSON.stringify(e)).join('\n')}\n`
				: '';
		await atomicWriteFile(quarantinePath, jsonlContent);

		// Append original entry back to knowledge.jsonl INSIDE lock
		await appendFile(knowledgePath, `${JSON.stringify(original)}\n`, 'utf-8');

		// Remove from rejected file INSIDE lock (crash-atomic)
		const rejectedEntries = await readKnowledge<RejectedLesson>(rejectedPath);
		const filtered = rejectedEntries.filter((e) => e.id !== entryId);
		// Fix empty file case: write '' not '\n'
		const rejectedContent =
			filtered.length > 0
				? `${filtered.map((e) => JSON.stringify(e)).join('\n')}\n`
				: '';
		await atomicWriteFile(rejectedPath, rejectedContent);
	} finally {
		if (release) {
			await release();
		}
	}
}

// ============================================================================
// Unarchive Entry (G6 #1716) — restore an archived entry to its prior status
// ============================================================================

export interface UnarchiveResult {
	restored: boolean;
	restored_to?: string;
	reason?:
		| 'not_found'
		| 'not_archived'
		| 'invalid_lesson'
		| 'blocked_by_policy';
}

/**
 * G6 (#1716): restore an `archived`-status entry from `knowledge.jsonl` to its
 * pre-archive status (`archived_from` if recorded, else `'candidate'`). Swarm-only
 * — matches `quarantineEntry`'s scope. Uses the same lock + atomicWrite pattern
 * as `restoreEntry`. Also resets G7 demotion counters so a restored entry
 * (especially one restored to `promoted`) is not demoted almost immediately
 * under the new demotion window.
 */
export async function unarchiveEntry(
	directory: string,
	entryId: string,
	/** #1848 §2 (IR-3 fix): cohort-safe curation context (optional). */
	curationContext?: {
		input: CurationAuthorizationInput;
		context: CurationContext;
	},
): Promise<UnarchiveResult> {
	// Guard against path traversal
	if (!directory || directory.includes('..')) {
		warn(
			'[knowledge-validator] unarchiveEntry: directory traversal attempt blocked',
		);
		return { restored: false, reason: 'not_found' };
	}

	if (!entryId || entryId.includes('\0') || entryId.includes('\n')) {
		warn('[knowledge-validator] unarchiveEntry: invalid entryId rejected');
		return { restored: false, reason: 'not_found' };
	}

	const storeDir = resolveKnowledgeStoreDir(directory);
	const knowledgePath = resolveSwarmKnowledgePath(directory);
	const swarmDir = storeDir;

	// Ensure .swarm store dir exists
	await mkdir(swarmDir, { recursive: true });

	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(swarmDir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		const entries = await readKnowledge<KnowledgeEntryBase>(knowledgePath);
		const target = entries.find((e) => e.id === entryId);
		if (!target) {
			return { restored: false, reason: 'not_found' };
		}
		if (target.status !== 'archived') {
			return { restored: false, reason: 'not_archived' };
		}

		// #1848 §2 (IR-3 fix): cohort-safe authorization for unarchive.
		if (curationContext) {
			const refreshedContext: CurationContext = {
				...curationContext.context,
				entry: target as CurationContext['entry'],
			};
			const decision = await authorizeCuration(
				curationContext.input,
				refreshedContext,
			);
			if (!decision.authorized) {
				warn(
					`[knowledge-validator] unarchiveEntry blocked by cohort-safety policy ` +
						`(basis: ${decision.basis}): ${decision.detail}`,
				);
				return { restored: false, reason: 'blocked_by_policy' };
			}
		}

		// Re-validate before restoring — an archived entry may have been blocked
		// for safety reasons and must pass content checks before being reactivated.
		const validation = validateLesson(target.lesson, [], {
			category: target.category,
			scope: target.scope,
			confidence: target.confidence,
		});
		if (!validation.valid) {
			warn(
				`[knowledge-validator] unarchiveEntry: entry ${entryId} failed re-validation: ${validation.reason}`,
			);
			return { restored: false, reason: 'invalid_lesson' };
		}

		const restoredStatus: KnowledgeEntryBase['status'] =
			target.archived_from ?? 'candidate';

		// PRR-019: defense-in-depth — re-validate that archived_from is one of
		// the retrieval-ACTIVE statuses. An archived entry should restore to
		// candidate/established/promoted; if the store was corrupted to set
		// archived_from to an inactive status (or garbage), restoring to it
		// would silently leave the entry inactive. Fall back to 'candidate'.
		const validRestoreTargets: ReadonlySet<string> = new Set([
			'candidate',
			'established',
			'promoted',
		]);
		const finalStatus: KnowledgeEntryBase['status'] = validRestoreTargets.has(
			restoredStatus,
		)
			? restoredStatus
			: 'candidate';

		// Strip archive metadata, restore status, and reset G7 demotion counters
		// so a restored-promoted entry gets a fresh window rather than inheriting
		// stale negativity from before archival.
		const {
			archived_from: _af,
			archived_at: _at,
			recent_negative_phase_count: _rnpc,
			last_demotion_phase: _ldp,
			...rest
		} = target;
		const restored: KnowledgeEntryBase = {
			...rest,
			status: finalStatus,
			updated_at: new Date().toISOString(),
			recent_negative_phase_count: 0,
			last_demotion_phase: undefined,
		};

		const next = entries.map((e) => (e.id === entryId ? restored : e));
		const jsonlContent =
			next.length > 0
				? `${next.map((e) => JSON.stringify(e)).join('\n')}\n`
				: '';
		await atomicWriteFile(knowledgePath, jsonlContent);

		return { restored: true, restored_to: finalStatus };
	} finally {
		if (release) {
			await release();
		}
	}
}

export const _internals: {
	validateLesson: typeof validateLesson;
	auditEntryHealth: typeof auditEntryHealth;
	quarantineEntry: typeof quarantineEntry;
	restoreEntry: typeof restoreEntry;
	unarchiveEntry: typeof unarchiveEntry;
	extractContextWords: typeof extractContextWords;
	hasSignificantOverlap: typeof hasSignificantOverlap;
} = {
	validateLesson,
	auditEntryHealth,
	quarantineEntry,
	restoreEntry,
	unarchiveEntry,
	extractContextWords,
	hasSignificantOverlap,
};
