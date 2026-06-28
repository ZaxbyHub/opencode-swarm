/**
 * Validation gates for external skill candidates.
 *
 * Provides shared types and individual gate functions that scan candidate
 * fields for security threats (prompt injection, unsafe instructions,
 * provenance integrity).  Each gate returns a structured `ValidationGateResult`
 * that the curation pipeline can use to block, warn, or pass a candidate.
 *
 * Gate 1 — `scanPromptInjection`: static regex-based detection of prompt-
 * injection patterns, prototype pollution, script injection, and obfuscated
 * content in candidate fields.  Severity is modulated by the candidate's trust
 * level (FR-004).
 *
 * Uses an `_internals` DI seam for testability — no `mock.module` leakage.
 */

import { createHash } from 'node:crypto';
import type { ExternalSkillCandidate } from '../config/schema';
import { INVISIBLE_FORMAT_CHARS } from '../hooks/knowledge-validator';

// ============================================================================
// Types
// ============================================================================

/** Result from a single validation gate scan. */
export interface ValidationGateResult {
	/** Which gate produced this result. */
	gate: 'prompt_injection' | 'unsafe_instructions' | 'provenance_integrity';
	/** Overall pass/fail/warn verdict. */
	verdict: 'pass' | 'fail' | 'warn';
	/** Individual findings from the scan. */
	findings: ValidationFinding[];
	/** The candidate fields that were scanned. */
	fields_scanned: string[];
}

/** A single finding from a validation gate. */
export interface ValidationFinding {
	/** What was detected. */
	pattern: string;
	/** Which candidate field triggered the finding. */
	field: string;
	/** Human-readable description. */
	description: string;
	/**
	 * Severity: 'error' blocks promotion, 'warning' is advisory
	 * (unless trust_level=low).
	 */
	severity: 'error' | 'warning';
	/** The matched text snippet (truncated to 100 chars for safety). */
	match: string;
}

/** Result of running all validation gates against a candidate. */
export interface CandidateEvaluationResult {
	/** Individual gate results. */
	gate_results: ValidationGateResult[];
	/** Aggregated verdict across all gates. */
	overall_verdict: 'passed' | 'quarantined';
	/** All findings from all gates combined. */
	all_findings: ValidationFinding[];
	/** Risk flags derived from findings (unique pattern names). */
	risk_flags: string[];
}

// ============================================================================
// Constants — Prompt Injection Patterns
// ============================================================================

/** Describes a single detection pattern used by the prompt-injection gate. */
export interface PromptInjectionPattern {
	/** Regex to test against field text. */
	pattern: RegExp;
	/** Human-readable name for the pattern. */
	name: string;
	/** Description shown in findings. */
	description: string;
	/** Base severity before trust-level modulation. */
	severity: 'error' | 'warning';
}

/**
 * Static regex patterns for the prompt-injection gate (FR-004).
 *
 * ERROR-severity patterns always block promotion.  WARNING-severity patterns
 * are modulated by the candidate's trust level:
 *   - trust_level='low'  → warnings promoted to errors
 *   - trust_level='medium'/'high' → warnings stay warnings
 */
export const PROMPT_INJECTION_PATTERNS: PromptInjectionPattern[] = [
	// --- Error-severity patterns ---
	{
		pattern: /system\s*:/i,
		name: 'hidden_system_directive',
		description: 'Hidden system directive detected',
		severity: 'error',
	},
	{
		pattern:
			/(you are now|act as|pretend to be|ignore (previous|above|prior) instructions?)/i,
		name: 'role_redefinition',
		description: 'Role redefinition attempt',
		severity: 'error',
	},
	{
		pattern:
			/(reveal (your|the|initial)|show (your|the) (system|original|initial)|what (were|are) (you|your) (original|initial|first))/i,
		name: 'context_extraction',
		description: 'Context extraction instruction',
		severity: 'error',
	},
	{
		pattern: /\b__proto__\b/,
		name: 'prototype_pollution',
		description: 'Prototype pollution pattern',
		severity: 'error',
	},
	{
		pattern: /\bconstructor\[/,
		name: 'constructor_manipulation',
		description: 'Constructor prototype access',
		severity: 'error',
	},
	{
		pattern: /\.prototype\[/,
		name: 'prototype_access',
		description: 'Prototype property access',
		severity: 'error',
	},
	{
		pattern: /<script/i,
		name: 'script_injection',
		description: 'HTML script tag injection',
		severity: 'error',
	},
	{
		pattern: /javascript:/i,
		name: 'javascript_uri',
		description: 'JavaScript URI scheme',
		severity: 'error',
	},
	{
		pattern: /\beval\s*\(/i,
		name: 'eval_call',
		description: 'Direct eval() call',
		severity: 'error',
	},
	{
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — pattern detects injected control characters
		pattern: /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/,
		name: 'control_character_injection',
		description: 'Control character injection',
		severity: 'error',
	},

	// --- Warning-severity patterns ---
	{
		pattern: /begin-base64/i,
		name: 'base64_encoded_content',
		description: 'Potential base64-encoded content',
		severity: 'warning',
	},
	{
		pattern: /[A-Za-z0-9+/]{100,}={0,2}/,
		name: 'base64_long_run',
		description: 'Potential base64-encoded content',
		severity: 'warning',
	},
];

// ============================================================================
// Constants — Unsafe Instruction Patterns
// ============================================================================

/** Describes a single detection pattern used by the unsafe-instruction gate. */
export interface UnsafeInstructionPattern {
	/** Regex to test against field text. */
	pattern: RegExp;
	/** Human-readable name for the pattern. */
	name: string;
	/** Description shown in findings. */
	description: string;
	/** Base severity before trust-level modulation. */
	severity: 'error' | 'warning';
}

/**
 * Static regex patterns for the unsafe-instruction gate.
 *
 * Extends the DANGEROUS_COMMAND_PATTERNS and SECURITY_DEGRADING_PATTERNS from
 * knowledge-validator.ts with additional destructive command, privilege
 * escalation, shell execution, security bypass, and data exfiltration patterns.
 *
 * ERROR-severity patterns always block promotion.  WARNING-severity patterns
 * are modulated by the candidate's trust level:
 *   - trust_level='low'  → warnings promoted to errors
 *   - trust_level='medium'/'high' → warnings stay warnings
 */
export const UNSAFE_INSTRUCTION_PATTERNS: UnsafeInstructionPattern[] = [
	// --- Error-severity patterns ---

	// Destructive file / disk commands
	{
		pattern: /\brm\s+-rf\b/,
		name: 'destructive_file_removal',
		description: 'Destructive file removal command',
		severity: 'error',
	},
	{
		pattern: /\bsudo\s+rm\b/,
		name: 'privileged_file_removal',
		description: 'Privileged file removal',
		severity: 'error',
	},
	{
		pattern: /\bformat\b/,
		name: 'disk_format',
		description: 'Disk format command',
		severity: 'warning',
	},
	{
		pattern: /\bmkfs\b/,
		name: 'disk_mkfs',
		description: 'Filesystem creation command',
		severity: 'error',
	},
	{
		pattern: /\bdd\s+if=/,
		name: 'disk_dump',
		description: 'Raw disk copy command',
		severity: 'error',
	},
	{
		pattern: /:\(\)\s*\{/,
		name: 'fork_bomb',
		description: 'Fork bomb pattern',
		severity: 'error',
	},
	{
		pattern: /\bchmod\s+-R\s+777\b/,
		name: 'recursive_world_writable',
		description: 'Recursive world-writable permission change',
		severity: 'error',
	},
	{
		pattern: /\bdeltree\b/,
		name: 'tree_delete',
		description: 'Directory tree deletion',
		severity: 'error',
	},
	{
		pattern: /\brmdir\s+\/s\b/,
		name: 'recursive_dir_remove',
		description: 'Recursive directory removal',
		severity: 'error',
	},

	// Process termination
	{
		pattern: /\bkill\s+-9\b/,
		name: 'force_kill',
		description: 'Force process termination',
		severity: 'warning',
	},
	{
		pattern: /\bpkill\b/,
		name: 'process_group_kill',
		description: 'Process group kill',
		severity: 'warning',
	},
	{
		pattern: /\bkillall\b/,
		name: 'kill_all_processes',
		description: 'Kill all processes by name',
		severity: 'warning',
	},

	// Shell execution vectors
	{
		pattern: /`[^`]*`/,
		name: 'backtick_execution',
		description: 'Backtick shell execution',
		severity: 'warning',
	},
	{
		pattern: /\$\([^)]*\)/,
		name: 'shell_substitution',
		description: 'Shell command substitution',
		severity: 'warning',
	},

	// Security bypass instructions
	{
		pattern: /disable\s+.{0,50}firewall/i,
		name: 'firewall_disable',
		description: 'Firewall disable instruction',
		severity: 'error',
	},
	{
		pattern: /turn\s+off\s+.{0,50}security/i,
		name: 'security_turn_off',
		description: 'Security control disable',
		severity: 'error',
	},
	{
		pattern: /(skip|bypass)\s+.{0,50}auth/i,
		name: 'auth_bypass',
		description: 'Authentication bypass instruction',
		severity: 'error',
	},
	{
		pattern: /ignore\s+.{0,50}certificate/i,
		name: 'certificate_ignore',
		description: 'Certificate validation bypass',
		severity: 'error',
	},
	{
		pattern: /disable\s+.{0,50}(tls|ssl)/i,
		name: 'tls_ssl_disable',
		description: 'TLS/SSL disable instruction',
		severity: 'error',
	},
	{
		pattern: /no\s+.{0,50}validation/i,
		name: 'validation_disable',
		description: 'Validation bypass instruction',
		severity: 'error',
	},
	{
		pattern: /disable\s+.{0,50}2fa/i,
		name: 'two_factor_disable',
		description: 'Two-factor authentication disable',
		severity: 'error',
	},
	{
		pattern: /remove\s+.{0,50}password/i,
		name: 'password_removal',
		description: 'Password removal instruction',
		severity: 'error',
	},

	// Data exfiltration / sensitive file access
	{
		pattern: /(curl|wget)\s+.{0,200}\|\s*(sh|bash|zsh)/i,
		name: 'remote_code_execution_pipe',
		description: 'Remote code execution via download and pipe',
		severity: 'error',
	},
	{
		pattern: /\benv\b.*\b(export|printenv|echo)/i,
		name: 'env_variable_dump',
		description: 'Environment variable extraction',
		severity: 'error',
	},
	{
		pattern: /\bcat\s+\/etc\/(passwd|shadow|hosts)/i,
		name: 'sensitive_file_read',
		description: 'Sensitive file read',
		severity: 'error',
	},
];

/** Rate limit defaults for validation operations (FR-007). */
export const VALIDATION_RATE_LIMITS = {
	/** Maximum candidates per discovery invocation. */
	max_candidates_per_discovery: 50,
	/** Maximum concurrent fetch operations. */
	max_concurrent_fetches: 5,
	/** Timeout for individual fetch operations in milliseconds. */
	fetch_timeout_ms: 30000,
} as const;

// ============================================================================
// Helpers
// ============================================================================

/** A single scannable text field extracted from a candidate. */
interface CandidateField {
	field: string;
	value: string;
}

/**
 * Extract ALL scannable text fields from an `ExternalSkillCandidate` into an
 * array of `{ field, value }` pairs.  Undefined optional fields are skipped.
 */
function extractCandidateFields(
	candidate: ExternalSkillCandidate,
): CandidateField[] {
	const fields: CandidateField[] = [];

	// Required fields — always present
	fields.push({ field: 'skill_body', value: candidate.skill_body });
	fields.push({ field: 'source_url', value: candidate.source_url });
	fields.push({ field: 'publisher', value: candidate.publisher });
	fields.push({ field: 'id', value: candidate.id });

	// Optional fields — include only when present
	if (candidate.skill_name !== undefined) {
		fields.push({ field: 'skill_name', value: candidate.skill_name });
	}
	if (candidate.skill_description !== undefined) {
		fields.push({
			field: 'skill_description',
			value: candidate.skill_description,
		});
	}

	// risk_flags entries — scan each string individually for tag injection
	for (let i = 0; i < candidate.risk_flags.length; i++) {
		fields.push({
			field: `risk_flags[${i}]`,
			value: candidate.risk_flags[i],
		});
	}

	// Enum/string fields — validate even though schema-constrained (defense in depth)
	fields.push({ field: 'source_type', value: candidate.source_type });
	fields.push({ field: 'sha256', value: candidate.sha256 });
	fields.push({ field: 'fetched_at', value: candidate.fetched_at });
	fields.push({
		field: 'evaluation_verdict',
		value: candidate.evaluation_verdict,
	});

	// Nested evaluation_history entries — each string field is individually scannable
	for (let i = 0; i < candidate.evaluation_history.length; i++) {
		const entry = candidate.evaluation_history[i];
		fields.push({
			field: `evaluation_history[${i}].verdict`,
			value: entry.verdict,
		});
		fields.push({
			field: `evaluation_history[${i}].timestamp`,
			value: entry.timestamp,
		});
		fields.push({
			field: `evaluation_history[${i}].actor`,
			value: entry.actor,
		});
		if (entry.reason !== undefined) {
			fields.push({
				field: `evaluation_history[${i}].reason`,
				value: entry.reason,
			});
		}
	}

	return fields;
}

/**
 * Apply invisible-format-character detection to raw text.
 *
 * Unlike the other patterns, invisible format chars are detected by counting
 * occurrences in the raw string (not via regex .test), because we need the
 * match string and they are multi-codepoint.
 *
 * Returns an array of findings (empty if none found).
 */
function scanInvisibleFormatChars(
	text: string,
	fieldName: string,
): ValidationFinding[] {
	const findings: ValidationFinding[] = [];
	const matches = text.match(INVISIBLE_FORMAT_CHARS);
	if (matches !== null && matches.length > 0) {
		// Truncate the concatenated match to 100 chars
		const joined = matches.join('').slice(0, 100);
		findings.push({
			pattern: 'invisible_format_chars',
			field: fieldName,
			description: `Invisible format characters detected (${matches.length} occurrence(s))`,
			severity: 'error',
			match: joined,
		});
	}
	return findings;
}

interface MarkdownSegment {
	value: string;
	isCode: boolean;
}

type RemovalPatternName =
	| 'destructive_file_removal'
	| 'privileged_file_removal';

interface DangerousRemovalCommand {
	pattern: RemovalPatternName;
	description: string;
	match: string;
}

const CODE_SPAN_OR_FENCE_REGEX = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;
const CODE_WARNING_ONLY_PATTERNS = new Set([
	'backtick_execution',
	'shell_substitution',
	'disk_format',
	'force_kill',
	'process_group_kill',
	'kill_all_processes',
]);

function splitMarkdownCodeSegments(text: string): MarkdownSegment[] {
	const segments: MarkdownSegment[] = [];
	let cursor = 0;

	for (const match of text.matchAll(CODE_SPAN_OR_FENCE_REGEX)) {
		const index = match.index ?? 0;
		if (index > cursor) {
			segments.push({ value: text.slice(cursor, index), isCode: false });
		}
		segments.push({ value: match[0], isCode: true });
		cursor = index + match[0].length;
	}

	if (cursor < text.length) {
		segments.push({ value: text.slice(cursor), isCode: false });
	}

	return segments.length === 0 ? [{ value: text, isCode: false }] : segments;
}

function getUnsafeInstructionMetadata(name: RemovalPatternName): {
	description: string;
	severity: 'error' | 'warning';
} {
	const entry = UNSAFE_INSTRUCTION_PATTERNS.find((item) => item.name === name);
	return {
		description: entry?.description ?? 'Destructive file removal command',
		severity: entry?.severity ?? 'error',
	};
}

function tokenizeShellArgs(input: string): string[] {
	const tokens: string[] = [];
	const tokenRegex =
		/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g;
	for (const match of input.matchAll(tokenRegex)) {
		const token = match[1] ?? match[2] ?? match[0];
		if (token.length > 0) tokens.push(token);
	}
	return tokens;
}

function rmFlagHasShortOption(token: string, option: string): boolean {
	return /^-[A-Za-z]+$/.test(token) && token.slice(1).includes(option);
}

function isRmOption(token: string): boolean {
	return token.startsWith('-') && token !== '-';
}

function isDangerousRemovalTarget(rawTarget: string): boolean {
	const target = rawTarget.replace(/\\/g, '/');
	if (/^[A-Za-z]:[/\\]?$/.test(target)) return true;
	return (
		target === '/' ||
		target === '/*' ||
		target === '.' ||
		target === '..' ||
		target.startsWith('.swarm') ||
		target.startsWith('/.swarm') ||
		target.startsWith('~') ||
		target.startsWith('$') ||
		target.startsWith('${') ||
		target.startsWith('%') ||
		target.startsWith('/home') ||
		target.startsWith('/Users') ||
		target.startsWith('/etc') ||
		target.startsWith('/bin') ||
		target.startsWith('/sbin') ||
		target.startsWith('/usr') ||
		target.startsWith('/var') ||
		/^[A-Za-z]:\/(?:Users|Windows)(?:\/|$)/.test(target)
	);
}

function findDangerousRemovalCommands(text: string): DangerousRemovalCommand[] {
	const commands: DangerousRemovalCommand[] = [];
	const rmCommandRegex = /\b(?<sudo>sudo\s+)?rm\b(?<args>[^\r\n`;&|]*)/gi;

	for (const match of text.matchAll(rmCommandRegex)) {
		const args = tokenizeShellArgs(match.groups?.args ?? '');
		const hasRecursive = args.some(
			(token) =>
				token === '--recursive' ||
				token === '-R' ||
				rmFlagHasShortOption(token, 'r') ||
				rmFlagHasShortOption(token, 'R'),
		);
		const hasForce = args.some(
			(token) =>
				token === '--force' ||
				token === '-f' ||
				rmFlagHasShortOption(token, 'f'),
		);
		if (!hasRecursive || !hasForce) continue;

		if (
			!args.some(
				(token) => !isRmOption(token) && isDangerousRemovalTarget(token),
			)
		) {
			continue;
		}

		const pattern: RemovalPatternName =
			match.groups?.sudo === undefined
				? 'destructive_file_removal'
				: 'privileged_file_removal';
		commands.push({
			pattern,
			description: getUnsafeInstructionMetadata(pattern).description,
			match: match[0].trim().slice(0, 100),
		});
	}

	return commands;
}

function hasDangerousRemovalTarget(text: string): boolean {
	return findDangerousRemovalCommands(text).length > 0;
}

function shouldScanUnsafePatternInSegment(
	entry: UnsafeInstructionPattern,
	segment: MarkdownSegment,
): boolean {
	if (!segment.isCode) return true;
	if (CODE_WARNING_ONLY_PATTERNS.has(entry.name)) return false;
	if (
		entry.name === 'destructive_file_removal' ||
		entry.name === 'privileged_file_removal'
	) {
		return false;
	}
	return true;
}

function getUnsafeScanSegments(
	field: string,
	value: string,
): MarkdownSegment[] {
	if (field !== 'skill_body') {
		return [{ value, isCode: false }];
	}
	return splitMarkdownCodeSegments(value);
}

// ============================================================================
// Gate 1 — scanPromptInjection (FR-004)
// ============================================================================

/**
 * Scan an external skill candidate for prompt-injection patterns.
 *
 * Returns a `ValidationGateResult` with gate=`'prompt_injection'`.
 * The verdict is modulated by `trustLevel`:
 *   - `'low'`: warnings promoted to errors → verdict is `'fail'` if any finding.
 *   - `'medium'`/`'high'`: warnings stay warnings → verdict is `'warn'` if only
 *     warnings, `'fail'` if any error-severity finding.
 */
export function scanPromptInjection(
	candidate: ExternalSkillCandidate,
	trustLevel: 'low' | 'medium' | 'high' = 'low',
): ValidationGateResult {
	const fields = extractCandidateFields(candidate);
	const findings: ValidationFinding[] = [];
	const fieldsScanned: string[] = [];

	for (const { field, value } of fields) {
		fieldsScanned.push(field);

		// Oversized field check (warning) — checked early for DoS prevention
		if (value.length > 10_000) {
			findings.push({
				pattern: 'oversized_field',
				field,
				description: 'Unusually large field value',
				severity: 'warning',
				match: value.slice(0, 100),
			});
		}

		// Invisible format chars — special handling (not regex .test)
		const invisibleFindings = scanInvisibleFormatChars(value, field);
		findings.push(...invisibleFindings);

		// Regex-based patterns
		for (const entry of PROMPT_INJECTION_PATTERNS) {
			const match = entry.pattern.exec(value);
			if (match !== null) {
				findings.push({
					pattern: entry.name,
					field,
					description: entry.description,
					severity: entry.severity,
					match: match[0].slice(0, 100),
				});
			}
		}
	}

	// Suspicious formatting in non-body fields (warning)
	for (const { field, value } of fields) {
		if (field !== 'skill_body' && /\n{3,}/.test(value)) {
			findings.push({
				pattern: 'suspicious_formatting',
				field,
				description: 'Suspicious formatting in metadata',
				severity: 'warning',
				match: value.slice(0, 100),
			});
		}
	}

	// Trust-level modulation
	const promoteWarnings = trustLevel === 'low';
	const modulatedFindings: ValidationFinding[] = findings.map((f) =>
		promoteWarnings && f.severity === 'warning'
			? { ...f, severity: 'error' as const }
			: f,
	);

	const hasErrors = modulatedFindings.some((f) => f.severity === 'error');
	const hasWarnings = modulatedFindings.some((f) => f.severity === 'warning');

	let verdict: 'pass' | 'fail' | 'warn';
	if (hasErrors) {
		verdict = 'fail';
	} else if (hasWarnings) {
		verdict = 'warn';
	} else {
		verdict = 'pass';
	}

	return {
		gate: 'prompt_injection',
		verdict,
		findings: modulatedFindings,
		fields_scanned: fieldsScanned,
	};
}

// ============================================================================
// Gate 2 — scanUnsafeInstructions
// ============================================================================

/**
 * Scan an external skill candidate for unsafe instruction patterns.
 *
 * Covers destructive commands, privilege escalation, shell execution
 * vectors, security bypass instructions, and data exfiltration indicators.
 *
 * Returns a `ValidationGateResult` with gate=`'unsafe_instructions'`.
 * The verdict is modulated by `trustLevel`:
 *   - `'low'`: warnings promoted to errors → verdict is `'fail'` if any finding.
 *   - `'medium'`/`'high'`: warnings stay warnings → verdict is `'warn'` if only
 *     warnings, `'fail'` if any error-severity finding.
 */
export function scanUnsafeInstructions(
	candidate: ExternalSkillCandidate,
	trustLevel: 'low' | 'medium' | 'high' = 'low',
): ValidationGateResult {
	const fields = extractCandidateFields(candidate);
	const findings: ValidationFinding[] = [];
	const fieldsScanned: string[] = [];

	for (const { field, value } of fields) {
		fieldsScanned.push(field);
		const scanSegments = getUnsafeScanSegments(field, value);

		if (field === 'skill_body') {
			for (const segment of scanSegments) {
				if (!segment.isCode) continue;
				for (const command of findDangerousRemovalCommands(segment.value)) {
					findings.push({
						pattern: command.pattern,
						field,
						description: command.description,
						severity: 'error',
						match: command.match,
					});
				}
			}
		}

		for (const entry of UNSAFE_INSTRUCTION_PATTERNS) {
			for (const segment of scanSegments) {
				if (!shouldScanUnsafePatternInSegment(entry, segment)) continue;
				const match = entry.pattern.exec(segment.value);
				if (match !== null) {
					findings.push({
						pattern: entry.name,
						field,
						description: entry.description,
						severity: entry.severity,
						match: match[0].slice(0, 100),
					});
					break;
				}
			}
		}
	}

	// Trust-level modulation
	const promoteWarnings = trustLevel === 'low';
	const modulatedFindings: ValidationFinding[] = findings.map((f) =>
		promoteWarnings && f.severity === 'warning'
			? { ...f, severity: 'error' as const }
			: f,
	);

	const hasErrors = modulatedFindings.some((f) => f.severity === 'error');
	const hasWarnings = modulatedFindings.some((f) => f.severity === 'warning');

	let verdict: 'pass' | 'fail' | 'warn';
	if (hasErrors) {
		verdict = 'fail';
	} else if (hasWarnings) {
		verdict = 'warn';
	} else {
		verdict = 'pass';
	}

	return {
		gate: 'unsafe_instructions',
		verdict,
		findings: modulatedFindings,
		fields_scanned: fieldsScanned,
	};
}

// ============================================================================
// Gate 3 — scanProvenanceIntegrity
// ============================================================================

const SHA256_FORMAT_REGEX = /^[a-f0-9]{64}$/;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Scan an external skill candidate for provenance field integrity.
 *
 * Validates SHA-256 hash format, fetched_at timing (not in future, not stale),
 * source_url validity, publisher presence, and content-hash verification.
 *
 * Returns a `ValidationGateResult` with gate=`'provenance_integrity'`.
 * The verdict is modulated by `trustLevel`:
 *   - `'low'`: warnings promoted to errors → verdict is `'fail'` if any finding.
 *   - `'medium'`/`'high'`: warnings stay warnings → verdict is `'warn'` if only
 *     warnings, `'fail'` if any error-severity finding.
 */
export function scanProvenanceIntegrity(
	candidate: ExternalSkillCandidate,
	trustLevel: 'low' | 'medium' | 'high' = 'low',
	ttlDays?: number,
): ValidationGateResult {
	const findings: ValidationFinding[] = [];
	const fieldsScanned: string[] = [];

	// 1. SHA-256 format validation
	fieldsScanned.push('sha256');
	if (candidate.sha256.length !== 64) {
		findings.push({
			pattern: 'sha256_length',
			field: 'sha256',
			description: 'SHA-256 hash has incorrect length',
			severity: 'error',
			match: candidate.sha256.slice(0, 100),
		});
	} else if (!SHA256_FORMAT_REGEX.test(candidate.sha256)) {
		findings.push({
			pattern: 'sha256_format',
			field: 'sha256',
			description:
				'SHA-256 hash has invalid format (expected 64 lowercase hex characters)',
			severity: 'error',
			match: candidate.sha256.slice(0, 100),
		});
	}

	// 2. fetched_at valid date
	fieldsScanned.push('fetched_at');
	const now = new Date(_internals.getTimestamp()).getTime();
	const fetchedAtMs = new Date(candidate.fetched_at).getTime();
	if (Number.isNaN(fetchedAtMs)) {
		findings.push({
			pattern: 'invalid_fetched_at',
			field: 'fetched_at',
			description: 'Fetched timestamp is not a valid date',
			severity: 'error',
			match: candidate.fetched_at.slice(0, 100),
		});
	} else if (fetchedAtMs > now + FUTURE_TOLERANCE_MS) {
		findings.push({
			pattern: 'fetched_at_future',
			field: 'fetched_at',
			description: 'Fetched timestamp is in the future',
			severity: 'error',
			match: candidate.fetched_at,
		});
	}

	// 3. fetched_at staleness
	if (ttlDays !== undefined && ttlDays > 0) {
		const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
		if (now - fetchedAtMs > ttlMs) {
			findings.push({
				pattern: 'fetched_at_stale',
				field: 'fetched_at',
				description: `Candidate source is stale (fetched more than ${ttlDays} days ago)`,
				severity: 'warning',
				match: candidate.fetched_at,
			});
		}
	}

	// 4. source_url format and protocol
	fieldsScanned.push('source_url');
	try {
		const parsedUrl = new URL(candidate.source_url);
		// Only allow http(s) URLs — reject file:, data:, javascript:, etc.
		const allowedProtocols = ['http:', 'https:'];
		if (!allowedProtocols.includes(parsedUrl.protocol)) {
			findings.push({
				pattern: 'unsafe_source_url_scheme',
				field: 'source_url',
				description: `Source URL uses unsafe protocol '${parsedUrl.protocol}' — only http: and https: are allowed`,
				severity: 'error',
				match: candidate.source_url.slice(0, 100),
			});
		}
	} catch {
		findings.push({
			pattern: 'source_url_invalid',
			field: 'source_url',
			description: 'Source URL is not a valid URL',
			severity: 'error',
			match: candidate.source_url.slice(0, 100),
		});
	}

	// 5. publisher non-empty
	fieldsScanned.push('publisher');
	if (candidate.publisher.trim().length === 0) {
		findings.push({
			pattern: 'publisher_empty',
			field: 'publisher',
			description: 'Publisher field is empty',
			severity: 'error',
			match: candidate.publisher.slice(0, 100),
		});
	}

	// 6. skill_body hash verification
	fieldsScanned.push('skill_body');
	const computedHash = _internals.computeSha256(candidate.skill_body);
	if (computedHash !== candidate.sha256) {
		findings.push({
			pattern: 'content_hash_mismatch',
			field: 'skill_body',
			description:
				'Content hash mismatch — skill body does not match recorded SHA-256',
			severity: 'error',
			match: computedHash.slice(0, 100),
		});
	}

	// Trust-level modulation
	const promoteWarnings = trustLevel === 'low';
	const modulatedFindings: ValidationFinding[] = findings.map((f) =>
		promoteWarnings && f.severity === 'warning'
			? { ...f, severity: 'error' as const }
			: f,
	);

	const hasErrors = modulatedFindings.some((f) => f.severity === 'error');
	const hasWarnings = modulatedFindings.some((f) => f.severity === 'warning');

	let verdict: 'pass' | 'fail' | 'warn';
	if (hasErrors) {
		verdict = 'fail';
	} else if (hasWarnings) {
		verdict = 'warn';
	} else {
		verdict = 'pass';
	}

	return {
		gate: 'provenance_integrity',
		verdict,
		findings: modulatedFindings,
		fields_scanned: fieldsScanned,
	};
}

// ============================================================================
// Orchestration — evaluateCandidate
// ============================================================================

/**
 * Run all three validation gates against a candidate and produce an
 * aggregated evaluation result (FR-004, FR-007).
 *
 * Gates are run sequentially: prompt-injection → unsafe-instructions →
 * provenance-integrity.  Any gate that returns `'fail'` causes the overall
 * verdict to be `'quarantined'`.  Warnings are advisory unless trust_level
 * is `'low'` (which promotes them to errors inside each gate).
 */
export function evaluateCandidate(
	candidate: ExternalSkillCandidate,
	options?: {
		trust_level?: 'low' | 'medium' | 'high';
		ttl_days?: number;
	},
): CandidateEvaluationResult {
	const trustLevel = options?.trust_level ?? 'low';

	const gate1Result = scanPromptInjection(candidate, trustLevel);
	const gate2Result = scanUnsafeInstructions(candidate, trustLevel);
	const gate3Result = scanProvenanceIntegrity(
		candidate,
		trustLevel,
		options?.ttl_days,
	);

	const gateResults: ValidationGateResult[] = [
		gate1Result,
		gate2Result,
		gate3Result,
	];
	const allFindings = gateResults.flatMap((r) => r.findings);
	const hasAnyFail = gateResults.some((r) => r.verdict === 'fail');
	const overallVerdict: 'passed' | 'quarantined' = hasAnyFail
		? 'quarantined'
		: 'passed';
	const riskFlags = [...new Set(allFindings.map((f) => f.pattern))];

	return {
		gate_results: gateResults,
		overall_verdict: overallVerdict,
		all_findings: allFindings,
		risk_flags: riskFlags,
	};
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals = {
	getTimestamp: (): string => new Date().toISOString(),
	computeSha256: (content: string): string =>
		createHash('sha256').update(content).digest('hex'),
	splitMarkdownCodeSegments,
	hasDangerousRemovalTarget,
	isDangerousRemovalTarget,
};
