/**
 * Config Doctor Service
 *
 * Validates opencode-swarm config shape, detects stale/invalid settings,
 * classifies findings by severity, and proposes safe auto-fixes.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_AGENT_NAMES } from '../config/constants';
import type { PluginConfig } from '../config/schema';
import {
	FALLBACK_MODELS_MAX,
	GATE_CONFIG_KNOWN_SECTION_KEYS,
	GateConfigSchema,
	PluginConfigSchema,
	stripKnownSwarmPrefix,
} from '../config/schema';
import { TOOL_NAME_SET } from '../tools/tool-metadata';
import { log } from '../utils';
import { sameExistingFilesystemPath } from '../utils/filesystem-identity';
import { isCanonicalPathWithinRoot } from '../utils/path-security';

const CONFIG_DOCTOR_MAX_CONFIG_FILE_BYTES = 102_400;

/**
 * Cached set of all top-level keys from PluginConfigSchema.
 * Used by validateConfigKey default case to distinguish known vs unknown keys.
 */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
	Object.keys(PluginConfigSchema.shape),
);

/**
 * Map of deprecated config fields that should emit INFO findings
 * when set to non-default values.
 */
const DEPRECATED_FIELDS: ReadonlyMap<
	string,
	{
		message: string;
		replacement: string;
		isDefaultValue: (v: unknown) => boolean;
		deprecatedIn: number;
		sinceVersion: number;
	}
> = new Map([
	[
		'skill_improver.model',
		{
			message: 'deprecated',
			replacement: 'agents.skill_improver.model',
			isDefaultValue: (v: unknown) => v === null,
			deprecatedIn: 2,
			sinceVersion: 1,
		},
	],
	[
		'skill_improver.fallback_models',
		{
			message: 'deprecated',
			replacement: 'agents.skill_improver.fallback_models',
			isDefaultValue: (v: unknown) => Array.isArray(v) && v.length === 0,
			deprecatedIn: 2,
			sinceVersion: 1,
		},
	],
	[
		'spec_writer.model',
		{
			message: 'deprecated',
			replacement: 'agents.spec_writer.model',
			isDefaultValue: (v: unknown) => v === null,
			deprecatedIn: 2,
			sinceVersion: 1,
		},
	],
	[
		'spec_writer.fallback_models',
		{
			message: 'deprecated',
			replacement: 'agents.spec_writer.fallback_models',
			isDefaultValue: (v: unknown) => Array.isArray(v) && v.length === 0,
			deprecatedIn: 2,
			sinceVersion: 1,
		},
	],
]);

/**
 * Compute Levenshtein distance between two strings.
 * Callers must lowercase inputs for case-insensitive matching.
 */
function levenshteinDistance(a: string, b: string): number {
	const al = a.length;
	const bl = b.length;
	const matrix: number[][] = [];

	for (let i = 0; i <= al; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= bl; j++) {
		matrix[0]![j] = j;
	}

	for (let i = 1; i <= al; i++) {
		for (let j = 1; j <= bl; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i]![j] = Math.min(
				matrix[i - 1]![j]! + 1,
				matrix[i]![j - 1]! + 1,
				matrix[i - 1]![j - 1]! + cost,
			);
		}
	}

	return matrix[al]![bl]!;
}

/**
 * Emit a type-mismatch finding for object-type config keys.
 */
function emitObjectTypeMismatch(
	key: string,
	value: unknown,
	findings: ConfigFinding[],
): void {
	if (
		value !== undefined &&
		(typeof value !== 'object' || Array.isArray(value) || value === null)
	) {
		findings.push({
			id: `invalid-${key}-type`,
			title: `Invalid ${key} type`,
			description: `"${key}" must be an object, got ${typeof value}`,
			severity: 'error',
			path: key,
			currentValue: value,
			autoFixable: false,
		});
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Council policy visibility findings (issue #2102 contracts C/E/F), driven by
 * the RAW config files so they fire ONLY when the user explicitly wrote the
 * key — schema defaults never produce noise.
 */
function collectRawCouncilPolicyFindings(directory: string): ConfigFinding[] {
	const findings: ConfigFinding[] = [];
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);

	for (const configPath of [userConfigPath, projectConfigPath]) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const stats = fs.statSync(configPath);
			if (stats.size > CONFIG_DOCTOR_MAX_CONFIG_FILE_BYTES) continue;
			const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
			if (!isPlainObject(raw) || raw.council === undefined) continue;
			if (!isPlainObject(raw.council)) continue;
			const council = raw.council;

			if ('parallelTimeoutMs' in council) {
				findings.push({
					id: 'council-parallel-timeout-deprecated',
					title: 'Deprecated and inert: council.parallelTimeoutMs',
					description:
						'Config field "council.parallelTimeoutMs" (in ' +
						configPath +
						') is deprecated and inert: no runtime consumer exists and no timeout is enforced. It is accepted only for parse compatibility. Remove the key — dispatch timeouts are governed by the agent host. The field is scheduled for removal in a future release.',
					severity: 'warn',
					path: 'council.parallelTimeoutMs',
					currentValue: council.parallelTimeoutMs,
					autoFixable: false,
				});
			}
			if ('escalateOnMaxRounds' in council) {
				findings.push({
					id: 'council-escalate-inert',
					title: 'Inert: council.escalateOnMaxRounds',
					description:
						'Config field "council.escalateOnMaxRounds" (in ' +
						configPath +
						') is set, but the handler/webhook remains INERT in this release: no handler, webhook, or outbound execution exists or was added (issue #1650). Max-rounds exhaustion emits a durable structured event (.swarm/council/events/max-rounds-exhaustion.jsonl) and a user escalation message instead; the run stays fail-closed. Wiring real outbound escalation requires a separate security review.',
					severity: 'warn',
					path: 'council.escalateOnMaxRounds',
					currentValue: '[redacted: handler/webhook strings are never echoed]',
					autoFixable: false,
				});
			}
			if (
				isPlainObject(council.finalCompletionPolicy) &&
				council.finalCompletionPolicy.mode === 'quorum'
			) {
				findings.push({
					id: 'council-final-quorum-weaker',
					title:
						'council.finalCompletionPolicy.mode "quorum" weakens the strict final council',
					description:
						'Final-council completion is configured in quorum mode (in ' +
						configPath +
						'): a bounded minimum of distinct canonical members can accept the project instead of the strict default (all five canonical roles, zero absentees). This is weaker than the strict default. Any change to this policy invalidates previously accepted final-council evidence.',
					severity: 'warn',
					path: 'council.finalCompletionPolicy',
					currentValue: council.finalCompletionPolicy,
					autoFixable: false,
				});
			}
		} catch {
			// Malformed raw config is reported by the strict-section collector.
		}
	}
	return findings;
}

/**
 * Lean Turbo evidence-requiring gates and the registered producer tool that
 * writes each gate's evidence (issue #2470: every evidence-requiring gate must
 * have a reachable producer). Exported so the satisfiability guard test can
 * assert the registry covers every gate verifyLeanTurboPhaseReady enforces.
 */
export const LEAN_TURBO_GATE_PRODUCERS = [
	{
		gate: 'phase_critic',
		producerTool: 'lean_turbo_critic',
		evidencePathConvention: '.swarm/evidence/{phase}/lean-turbo-critic.json',
	},
	{
		gate: 'phase_reviewer',
		producerTool: 'lean_turbo_review',
		evidencePathConvention: '.swarm/evidence/{phase}/lean-turbo-reviewer.json',
	},
	{
		gate: 'integrated_diff_required',
		producerTool: 'lean_turbo_run_phase',
		evidencePathConvention:
			'.swarm/evidence/{phase}/lean-turbo/lean-turbo-phase.json',
	},
] as const;

/**
 * Gate-satisfiability lint (issue #2470): for every enabled evidence-requiring
 * Lean Turbo gate, its producer tool must be present in the registered tool
 * set. This is the config-doctor half of the #2007 regression tripwire — in a
 * healthy build every producer is registered and the lint emits nothing; if a
 * producer tool is ever unregistered while its gate stays default-true, the
 * gate becomes structurally unsatisfiable and this lint fails with an error.
 */
export function collectLeanTurboGateSatisfiabilityFindings(
	config: PluginConfig,
	registeredToolNames: ReadonlySet<string> = TOOL_NAME_SET,
): ConfigFinding[] {
	const findings: ConfigFinding[] = [];
	const lean = config?.turbo?.lean;
	for (const entry of LEAN_TURBO_GATE_PRODUCERS) {
		const enabled = lean?.[entry.gate] ?? true;
		if (!enabled) continue;
		if (registeredToolNames.has(entry.producerTool)) continue;
		findings.push({
			id: `lean-turbo-gate-unsatisfiable-${entry.gate}`,
			title: `turbo.lean.${entry.gate} gate has no registered producer tool`,
			description:
				`turbo.lean.${entry.gate} is enabled (default true), but its evidence producer tool ` +
				`"${entry.producerTool}" is not registered, so the gate that reads ` +
				`${entry.evidencePathConvention} is structurally unsatisfiable in production and ` +
				'Lean Turbo phase_complete would dead-end. Re-register the producer tool or disable the gate (issue #2470 / #2007).',
			severity: 'error',
			path: `turbo.lean.${entry.gate}`,
			currentValue: enabled,
			autoFixable: false,
		});
	}
	return findings;
}

function collectRawGatesConfigFindings(directory: string): ConfigFinding[] {
	const findings: ConfigFinding[] = [];
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);

	for (const configPath of [userConfigPath, projectConfigPath]) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const stats = fs.statSync(configPath);
			if (stats.size > CONFIG_DOCTOR_MAX_CONFIG_FILE_BYTES) continue;
			const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
			if (!isPlainObject(raw) || raw.gates === undefined) continue;

			if (!isPlainObject(raw.gates)) {
				findings.push({
					id: 'invalid-gates-config',
					title: 'Invalid gates config',
					description: `"gates" in ${configPath} must be an object. The loader ignores that section and keeps other valid config sections active.`,
					severity: 'error',
					path: 'gates',
					currentValue: raw.gates,
					autoFixable: false,
				});
				continue;
			}

			for (const [sectionName, sectionValue] of Object.entries(raw.gates)) {
				const schema =
					GateConfigSchema.shape[
						sectionName as keyof typeof GateConfigSchema.shape
					];
				if (!schema) {
					findings.push({
						id: 'unknown-gates-section',
						title: 'Unknown gates config section',
						description: `Unknown gates section "gates.${sectionName}" in ${configPath} is ignored by the loader.`,
						severity: 'warn',
						path: `gates.${sectionName}`,
						currentValue: sectionValue,
						autoFixable: false,
					});
					continue;
				}

				const knownFields =
					GATE_CONFIG_KNOWN_SECTION_KEYS[
						sectionName as keyof typeof GATE_CONFIG_KNOWN_SECTION_KEYS
					];
				if (knownFields && isPlainObject(sectionValue)) {
					const knownFieldSet = new Set<string>(knownFields);
					for (const fieldName of Object.keys(sectionValue)) {
						if (!knownFieldSet.has(fieldName)) {
							findings.push({
								id: 'unknown-gates-key',
								title: 'Unknown gates config key',
								description: `Unknown gates key "gates.${sectionName}.${fieldName}" in ${configPath} is ignored by the loader.`,
								severity: 'warn',
								path: `gates.${sectionName}.${fieldName}`,
								currentValue: sectionValue[fieldName],
								autoFixable: false,
							});
						}
					}
				}

				const sectionResult = schema.safeParse(sectionValue);
				if (!sectionResult.success) {
					findings.push({
						id: 'invalid-gates-section',
						title: 'Invalid gates config section',
						description: `"gates.${sectionName}" in ${configPath} failed validation. The loader uses defaults for that gate section and keeps other valid config sections active.`,
						severity: 'error',
						path: `gates.${sectionName}`,
						currentValue: sectionValue,
						autoFixable: false,
					});
				}
			}
		} catch {
			// Raw config load failures are already handled by the loader; the doctor
			// should stay best-effort and non-blocking.
		}
	}

	return findings;
}

/**
 * Surface unrecognized keys in ANY strict config section (council, checkpoint,
 * pr_monitor, turbo.epic, …) by re-reading the raw on-disk config and running
 * the full schema. Without this, config-doctor only ever saw the already-parsed
 * (post-recovery) config, so a nested typo produced no finding (issue #1778 H6).
 * The loader now recovers such keys instead of wiping the config; the doctor
 * makes the ignored key visible and actionable. Gates keys are already reported
 * by collectRawGatesConfigFindings, so gates.* issues are skipped here to avoid
 * duplicate findings.
 */
function collectRawStrictSectionFindings(directory: string): ConfigFinding[] {
	const findings: ConfigFinding[] = [];
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);

	for (const configPath of [userConfigPath, projectConfigPath]) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const stats = fs.statSync(configPath);
			if (stats.size > CONFIG_DOCTOR_MAX_CONFIG_FILE_BYTES) continue;
			const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
			if (!isPlainObject(raw)) continue;

			const parsed = PluginConfigSchema.safeParse(raw);
			if (parsed.success) continue;

			const seen = new Set<string>();
			for (const issue of parsed.error.issues) {
				if (issue.code !== 'unrecognized_keys') continue;
				if (issue.path[0] === 'gates') continue; // covered elsewhere
				const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
				for (const key of keys) {
					const dotted = [...issue.path.map(String), key].join('.');
					if (seen.has(dotted)) continue;
					seen.add(dotted);
					findings.push({
						id: 'unknown-config-key',
						title: 'Unknown config key',
						description: `Unrecognized key "${dotted}" in ${configPath} is ignored by the loader (the rest of your config is preserved). Fix or remove it.`,
						severity: 'warn',
						path: dotted,
						currentValue: undefined,
						autoFixable: false,
					});
				}
			}
		} catch {
			// Best-effort, non-blocking (see collectRawGatesConfigFindings).
		}
	}

	return findings;
}

/**
 * Walk a raw (pre-parse) config object by a Zod issue path, returning the value
 * at that location or `undefined` if the path does not resolve.
 */
function getRawValueAtPath(
	raw: unknown,
	issuePath: ReadonlyArray<PropertyKey>,
): unknown {
	let node: unknown = raw;
	for (const seg of issuePath) {
		if (node === null || typeof node !== 'object') return undefined;
		node = (node as Record<PropertyKey, unknown>)[seg];
	}
	return node;
}

/**
 * Surface value-constraint config failures (issue #1886 follow-up).
 *
 * `collectRawStrictSectionFindings` only reports UNRECOGNIZED keys, and
 * `runConfigDoctor` otherwise inspects the already-parsed config — which, for a
 * config rejected on a value constraint, is the fail-secure DEFAULTS. So a
 * `too_big`/`too_small`/`invalid_type`/… failure (e.g. an agent's
 * `fallback_models` array exceeding the schema max) produced NO finding, leaving
 * the user to guess why their config was discarded.
 *
 * This re-reads the raw user + project configs, runs the full schema, and:
 *   - reports every value-constraint issue so the doctor names WHY the config is
 *     rejected, and
 *   - for an over-length `fallback_models` array, attaches an opt-in, lossy
 *     auto-fix that trims it to the schema max. The trim is applied ONLY via the
 *     explicit `/swarm config doctor --fix` command (see `applySafeAutoFixes`
 *     `applyLossy`), never at startup.
 *
 * `unrecognized_keys` (owned by `collectRawStrictSectionFindings`) and `gates.*`
 * (owned by `collectRawGatesConfigFindings`) issues are skipped to avoid
 * duplicate findings.
 */
function collectRawValueConstraintFindings(directory: string): ConfigFinding[] {
	const findings: ConfigFinding[] = [];
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);

	// The file `applySafeAutoFixes` will actually write (project wins when it
	// exists). Only a finding in THIS file is marked auto-fixable, so `--fix`
	// never claims to trim an array it would not touch.
	const applyTargetPath = fs.existsSync(projectConfigPath)
		? projectConfigPath
		: userConfigPath;

	// One dedupe set across both files so a key present in user AND project
	// configs is reported once. Iterate the apply-target file FIRST so that, on a
	// same-path collision, the dedupe keeps the FIXABLE (apply-target) variant
	// instead of a report-only one that points at the merge-losing file — which
	// would make `--fix` silently no-op on a repairable config.
	const seen = new Set<string>();
	const filesInApplyOrder =
		applyTargetPath === projectConfigPath
			? [projectConfigPath, userConfigPath]
			: [userConfigPath, projectConfigPath];

	for (const configPath of filesInApplyOrder) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const stats = fs.statSync(configPath);
			if (stats.size > CONFIG_DOCTOR_MAX_CONFIG_FILE_BYTES) continue;
			const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
			if (!isPlainObject(raw)) continue;

			const parsed = PluginConfigSchema.safeParse(raw);
			if (parsed.success) continue;

			for (const issue of parsed.error.issues) {
				// Owned by sibling collectors — skip to avoid duplicate findings.
				if (issue.code === 'unrecognized_keys') continue;
				if (issue.path[0] === 'gates') continue;

				const dotted = issue.path.map(String).join('.');
				const dedupeKey = `${dotted}|${issue.code}`;
				if (seen.has(dedupeKey)) continue;
				seen.add(dedupeKey);

				const current = getRawValueAtPath(raw, issue.path);

				// Opt-in lossy auto-fix: an over-length fallback_models array can be
				// mechanically trimmed to the schema max — the one value constraint we
				// can repair without guessing user intent.
				if (
					issue.code === 'too_big' &&
					dotted.endsWith('fallback_models') &&
					Array.isArray(current) &&
					current.length > FALLBACK_MODELS_MAX
				) {
					const trimmed = current.slice(0, FALLBACK_MODELS_MAX);
					const dropped = current.slice(FALLBACK_MODELS_MAX).map(String);
					const inApplyTarget = configPath === applyTargetPath;
					const drop = `${dropped.length} entr${dropped.length === 1 ? 'y' : 'ies'}`;
					findings.push({
						id: 'fallback-models-too-many',
						title: 'Too many fallback models',
						description:
							`"${dotted}" in ${configPath} lists ${current.length} models; the maximum is ${FALLBACK_MODELS_MAX}. ` +
							`A config that fails validation is discarded in favor of safe defaults. ` +
							(inApplyTarget
								? `Run /swarm config doctor --fix to trim to the first ${FALLBACK_MODELS_MAX} (drops ${drop}: ${dropped.join(', ')}), or edit the file yourself.`
								: `Remove ${drop} from that file (would drop: ${dropped.join(', ')}).`),
						severity: 'error',
						path: dotted,
						currentValue: current,
						autoFixable: inApplyTarget,
						proposedFix: {
							type: 'update',
							path: dotted,
							value: trimmed,
							description: `Trim "${dotted}" to the first ${FALLBACK_MODELS_MAX} models`,
							risk: 'low',
							lossy: true,
						},
					});
					continue;
				}

				// General detection: report every other value-constraint failure so
				// the doctor names exactly what is invalid.
				findings.push({
					id: 'invalid-config-value',
					title: 'Invalid config value',
					description:
						`"${dotted || '(root)'}" in ${configPath} is invalid: ${issue.message}. ` +
						`A config that fails validation is discarded in favor of safe defaults until this is fixed.`,
					severity: 'error',
					path: dotted,
					currentValue: current,
					autoFixable: false,
				});
			}
		} catch {
			// Best-effort, non-blocking (see collectRawGatesConfigFindings).
		}
	}

	return findings;
}

function collectRawAutoReviewCompatibilityFindings(
	directory: string,
): ConfigFinding[] {
	const findings: ConfigFinding[] = [];
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);
	for (const configPath of [userConfigPath, projectConfigPath]) {
		if (!fs.existsSync(configPath)) continue;
		try {
			const stats = fs.statSync(configPath);
			if (stats.size > CONFIG_DOCTOR_MAX_CONFIG_FILE_BYTES) continue;
			const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
			if (!isPlainObject(raw) || !isPlainObject(raw.auto_review)) continue;
			const autoReview = raw.auto_review;
			if (
				autoReview.structured_findings === false &&
				isPlainObject(autoReview.final_review) &&
				autoReview.final_review.mode === 'gate'
			) {
				findings.push({
					id: 'invalid-auto-review-gate-compatibility',
					title: 'Invalid auto-review gate configuration',
					description:
						'auto_review.final_review.mode="gate" requires auto_review.structured_findings=true so gate evidence is machine-verifiable.',
					severity: 'error',
					path: 'auto_review.structured_findings',
					currentValue: false,
					autoFixable: false,
				});
				break;
			}
		} catch {
			// Raw compatibility diagnostics are best-effort and non-blocking.
		}
	}
	return findings;
}

function emitWorktreeIsolationLayeringAdvisory(
	config: PluginConfig,
	findings: ConfigFinding[],
): void {
	const parallelization = config.parallelization;
	const worktreePolicy = config.worktree?.policy ?? 'auto';

	if (
		parallelization?.enabled === true &&
		(parallelization.maxConcurrentTasks ?? 1) > 1 &&
		worktreePolicy !== 'disabled'
	) {
		findings.push({
			id: 'worktree-isolation-baseline-active',
			title:
				'Worktree isolation is already active for standard parallel coders',
			description:
				'Standard parallel coders already use baseline worktree isolation through the parallel execution profile plus top-level worktree.policy. Lean Turbo and Epic are additive strategies, not requirements for obtaining worktree isolation.',
			severity: 'warn',
			path: 'worktree.policy',
			currentValue: worktreePolicy,
			autoFixable: false,
		});
	}
}

/** Severity levels for config findings */
export type FindingSeverity = 'info' | 'warn' | 'error';

/** A single config finding */
export interface ConfigFinding {
	/** Unique identifier for this finding type */
	id: string;
	/** Human-readable title */
	title: string;
	/** Detailed description */
	description: string;
	/** Severity level */
	severity: FindingSeverity;
	/** Path to the config key (dot notation) */
	path: string;
	/** Current invalid/stale value */
	currentValue?: unknown;
	/** Proposed safe fix (if available) */
	proposedFix?: ConfigFix;
	/** Whether this is auto-fixable (safe, non-destructive) */
	autoFixable: boolean;
}

/** A proposed config fix */
export interface ConfigFix {
	/** Type of fix */
	type: 'remove' | 'update' | 'add';
	/** Path to the config key (dot notation) */
	path: string;
	/** Value to set (for update/add) */
	value?: unknown;
	/** Description of what the fix does */
	description: string;
	/** Risk level - only 'low' is auto-fixable */
	risk: 'low' | 'medium' | 'high';
	/**
	 * When true, the fix loses user-authored data (e.g. trimming an over-length
	 * array). Lossy fixes are applied ONLY when the caller explicitly opts in via
	 * `applySafeAutoFixes(..., { applyLossy: true })` — the interactive
	 * `/swarm config doctor --fix` command does; the passive startup autofix path
	 * never does. This keeps a lossy repair from being applied silently (#1886).
	 */
	lossy?: boolean;
}

/** Result of running the config doctor */
export interface ConfigDoctorResult {
	/** All findings from the doctor run */
	findings: ConfigFinding[];
	/** Findings by severity */
	summary: {
		info: number;
		warn: number;
		error: number;
	};
	/** Whether any auto-fixable issues were found */
	hasAutoFixableIssues: boolean;
	/** Timestamp of the run */
	timestamp: number;
	/** The config that was analyzed */
	configSource: string;
	/**
	 * Migration availability metadata. Present when the loaded config's
	 * config_format_version predates the deprecatedIn version of any
	 * DEPRECATED_FIELDS entry.
	 */
	availableMigrations?: Array<{
		field: string;
		replacement: string;
		deprecatedIn: number;
		sinceVersion: number;
		currentFormatVersion: number;
	}>;
}

/** Backup artifact for rollback */
export interface ConfigBackup {
	/** When the backup was created */
	createdAt: number;
	/** The backed up config content */
	configPath: string;
	/** The raw config content */
	content: string;
	/** Hash of content for integrity verification */
	contentHash: string;
}

/**
 * Get the user configuration directory
 */
function getUserConfigDir(): string {
	return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Get config file paths
 */
export function getConfigPaths(directory: string): {
	userConfigPath: string;
	projectConfigPath: string;
} {
	const userConfigPath = path.join(
		getUserConfigDir(),
		'opencode',
		'opencode-swarm.json',
	);
	const projectConfigPath = path.join(
		directory,
		'.opencode',
		'opencode-swarm.json',
	);
	return { userConfigPath, projectConfigPath };
}

/**
 * Compute a cryptographic hash for content verification
 * Uses SHA-256 for integrity checking
 */
function computeHash(content: string): string {
	// Use SHA-256 for cryptographic integrity verification
	return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Verify if a config path is within allowed paths for opencode-swarm
 * Rejects path traversal attempts and restricts to known config locations
 */
function isValidConfigPath(configPath: string, directory: string): boolean {
	// Normalize the path to handle different separators
	const normalizedPath = configPath.replace(/\\/g, '/');

	// Check for path traversal patterns
	const pathParts = normalizedPath.split('/');
	for (const part of pathParts) {
		if (part === '..' || part === '') {
			// Allow empty parts (from leading/trailing slashes) but not '..'
			if (part === '..') {
				return false;
			}
		}
	}

	// Use resolved paths for exact-match validation only
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);

	try {
		const resolvedConfig = path.resolve(configPath);
		const resolvedUser = path.resolve(userConfigPath);
		const resolvedProject = path.resolve(projectConfigPath);

		// Must exactly match one of the two known config paths
		if (resolvedConfig !== resolvedUser && resolvedConfig !== resolvedProject) {
			return false;
		}

		// Symlink rejection: if the config file exists, verify its realpath
		// matches the resolved path. A symlink at the allowed location that
		// points elsewhere is a write-through attack vector.
		try {
			if (fs.existsSync(resolvedConfig)) {
				const realConfig = fs.realpathSync(resolvedConfig);
				if (realConfig !== resolvedConfig) {
					return false;
				}
			}
		} catch {
			// realpathSync fails if file doesn't exist yet (first run) — allow
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * Atomic file write: writes to a temp file then renames.
 * Prevents corrupt config files on crash mid-write.
 * On Windows, fs.renameSync can fail if the target already exists;
 * the try/catch handles this by unlinking the target before renaming.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
	const tmpPath = `${filePath}.tmp.${process.pid}`;
	fs.writeFileSync(tmpPath, content, 'utf-8');
	try {
		fs.renameSync(tmpPath, filePath);
	} catch {
		// Windows: target may exist — unlink first, then rename
		try {
			fs.unlinkSync(filePath);
		} catch {
			// Ignore unlink failure — best effort
		}
		fs.renameSync(tmpPath, filePath);
	}
}

/**
 * Create a backup of the current config
 */
export function createConfigBackup(directory: string): ConfigBackup | null {
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);

	// Try project config first (higher priority)
	let configPath = projectConfigPath;
	let content: string | null = null;

	if (fs.existsSync(projectConfigPath)) {
		try {
			content = fs.readFileSync(projectConfigPath, 'utf-8');
		} catch (error) {
			log('[ConfigDoctor] project config read failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Fall back to user config
	if (content === null && fs.existsSync(userConfigPath)) {
		configPath = userConfigPath;
		try {
			content = fs.readFileSync(userConfigPath, 'utf-8');
		} catch (error) {
			log('[ConfigDoctor] user config read failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (content === null) {
		return null; // No config to backup
	}

	return {
		createdAt: Date.now(),
		configPath,
		content,
		contentHash: computeHash(content),
	};
}

/**
 * Write a backup artifact to .swarm directory
 * Persists full backup content to support rollback/restore
 */
export function writeBackupArtifact(
	directory: string,
	backup: ConfigBackup,
): string {
	const swarmDir = path.join(directory, '.swarm');
	if (!fs.existsSync(swarmDir)) {
		fs.mkdirSync(swarmDir, { recursive: true });
	}

	const backupFilename = `config-backup-${backup.createdAt}.json`;
	const backupPath = path.join(swarmDir, backupFilename);

	// Store full content to support rollback/restore
	const artifact = {
		createdAt: backup.createdAt,
		configPath: backup.configPath,
		contentHash: backup.contentHash,
		// Full content for rollback capability
		content: backup.content,
		// Preview for UI display
		preview:
			backup.content.substring(0, 500) +
			(backup.content.length > 500 ? '...' : ''),
	};

	atomicWriteFileSync(backupPath, JSON.stringify(artifact, null, 2));
	return backupPath;
}

/**
 * Restore config from a backup artifact
 * @param backupPath - Path to the backup artifact file
 * @param directory - The working directory (for validating config paths)
 * @returns the path to the restored config file, or null if restore failed
 */
export function restoreFromBackup(
	backupPath: string,
	directory: string,
): string | null {
	if (!fs.existsSync(backupPath)) {
		return null;
	}

	// Validate backupPath is within .swarm/ directory
	const swarmDir = path.resolve(directory, '.swarm');
	const resolvedBackup = path.resolve(backupPath);
	if (!isCanonicalPathWithinRoot(resolvedBackup, swarmDir)) {
		return null; // backupPath is outside .swarm/ — reject
	}

	try {
		const artifact = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));

		// Validate artifact has required fields
		if (!artifact.content || !artifact.configPath || !artifact.contentHash) {
			return null;
		}

		// SECURITY: Validate configPath to prevent path traversal attacks
		// Only allow restore to known opencode-swarm config locations
		if (!isValidConfigPath(artifact.configPath, directory)) {
			// Invalid restore target - potential path traversal attempt
			return null;
		}

		// Verify content integrity (supports both old weak hashes and new SHA-256)
		const computedHash = computeHash(artifact.content);
		const storedHash = artifact.contentHash;

		// Handle backward compatibility: old hashes were numeric strings
		// New SHA-256 hashes are hex strings
		const isLegacyHash = /^\d+$/.test(storedHash);
		if (!isLegacyHash && computedHash !== storedHash) {
			// Content hash mismatch - may be corrupted
			return null;
		}
		// For legacy hashes, log a warning but allow restore (backward compat)
		// In production, consider migrating to SHA-256 on next write
		log(
			'[ConfigDoctor] Warning: restoring from backup with legacy numeric hash (pre-SHA-256). Consider re-backing up.',
			{},
		);

		// Determine where to write restored config
		const targetPath = artifact.configPath;

		// Ensure target directory exists
		const targetDir = path.dirname(targetPath);
		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true });
		}

		// Write restored content
		atomicWriteFileSync(targetPath, artifact.content);
		return targetPath;
	} catch {
		// Failed to parse or restore
		return null;
	}
}

/**
 * Read the current config from file (re-read after fixes)
 */
function readConfigFromFile(directory: string): {
	config: Record<string, unknown>;
	configPath: string;
} | null {
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);

	let configPath = projectConfigPath;
	let configContent: string | null = null;

	if (fs.existsSync(projectConfigPath)) {
		configPath = projectConfigPath;
		configContent = fs.readFileSync(projectConfigPath, 'utf-8');
	} else if (fs.existsSync(userConfigPath)) {
		configPath = userConfigPath;
		configContent = fs.readFileSync(userConfigPath, 'utf-8');
	}

	if (configContent === null) {
		return null;
	}

	try {
		const config = JSON.parse(configContent);
		return { config: config as Record<string, unknown>, configPath };
	} catch (error) {
		log(`[ConfigDoctor] Failed to parse config file: ${configPath}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Validate config key safety and detect stale/invalid settings
 */
function validateConfigKey(path: string, value: unknown): ConfigFinding[] {
	const findings: ConfigFinding[] = [];

	// ── DEPRECATED FIELDS PRE-CHECK (before switch) ──
	for (const [depPath, depInfo] of DEPRECATED_FIELDS) {
		if (path === depPath && !depInfo.isDefaultValue(value)) {
			findings.push({
				id: 'deprecated-field',
				title: `Deprecated config field: ${depPath}`,
				description: `Config field "${depPath}" is deprecated. Replacement: ${depInfo.replacement}.`,
				severity: 'info',
				path: depPath,
				currentValue: value,
				autoFixable: false,
			});
		}
	}

	switch (path) {
		// ── EXISTING SPECIFIC VALIDATION CASES ──

		// Check deprecated fields
		case 'agents': {
			if (value !== undefined) {
				// Legacy agents config - warn about migration
				findings.push({
					id: 'deprecated-agents-config',
					title: 'Deprecated agents configuration',
					description:
						'The "agents" field is deprecated. Use "swarms" instead for multi-swarm support.',
					severity: 'warn',
					path: 'agents',
					currentValue: value,
					autoFixable: false,
					proposedFix: {
						type: 'remove',
						path: 'agents',
						description: 'Remove deprecated agents config - use swarms instead',
						risk: 'low',
					},
				});
			}
			break;
		}

		// Check config_format_version type
		case 'config_format_version': {
			if (
				typeof value !== 'number' ||
				!Number.isFinite(value) ||
				!Number.isInteger(value) ||
				value < 0
			) {
				findings.push({
					id: 'type-mismatch',
					title: `Config field "${path}" has wrong type`,
					description: `Expected non-negative integer, got ${
						typeof value === 'number'
							? Number.isInteger(value)
								? value
								: `${value} (non-integer)`
							: typeof value
					}`,
					severity: 'error',
					path,
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		// Check guardrails settings
		case 'guardrails.enabled': {
			if (value === false) {
				findings.push({
					id: 'guardrails-disabled',
					title: 'Guardrails disabled',
					description:
						'Guardrails have been explicitly disabled. This removes safety limits.',
					severity: 'error',
					path: 'guardrails.enabled',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		// Check guardrails profiles for unknown agents
		case 'guardrails.profiles': {
			const profiles = value as Record<string, unknown> | undefined;
			if (profiles) {
				const validAgents = new Set(ALL_AGENT_NAMES as readonly string[]);
				for (const [agentName, profile] of Object.entries(profiles)) {
					if (!validAgents.has(agentName)) {
						findings.push({
							id: 'unknown-agent-profile',
							title: 'Unknown agent profile',
							description: `Profile for unknown agent "${agentName}" will be ignored.`,
							severity: 'info',
							path: `guardrails.profiles.${agentName}`,
							currentValue: profile,
							autoFixable: true,
							proposedFix: {
								type: 'remove',
								path: `guardrails.profiles.${agentName}`,
								description: `Remove unknown agent profile "${agentName}"`,
								risk: 'low',
							},
						});
					}
				}
			}
			break;
		}

		// Check automation mode
		case 'automation.mode': {
			const validModes = ['manual', 'hybrid', 'auto'];
			if (value !== undefined && !validModes.includes(value as string)) {
				findings.push({
					id: 'invalid-automation-mode',
					title: 'Invalid automation mode',
					description: `Invalid automation mode "${value}". Valid: ${validModes.join(', ')}`,
					severity: 'error',
					path: 'automation.mode',
					currentValue: value,
					autoFixable: true,
					proposedFix: {
						type: 'update',
						path: 'automation.mode',
						value: 'manual',
						description: 'Reset to safe default "manual"',
						risk: 'low',
					},
				});
			}
			break;
		}

		// Check automation capabilities - all should be boolean
		case 'automation.capabilities': {
			const caps = value as Record<string, unknown> | undefined;
			if (caps) {
				const capabilityNames = [
					'plan_sync',
					'phase_preflight',
					'config_doctor_on_startup',
					'evidence_auto_summaries',
					'decision_drift_detection',
				];
				for (const [name, capValue] of Object.entries(caps)) {
					if (capabilityNames.includes(name) && typeof capValue !== 'boolean') {
						findings.push({
							id: 'invalid-capability-type',
							title: 'Invalid capability type',
							description: `Capability "${name}" must be boolean, got ${typeof capValue}`,
							severity: 'error',
							path: `automation.capabilities.${name}`,
							currentValue: capValue,
							autoFixable: true,
							proposedFix: {
								type: 'update',
								path: `automation.capabilities.${name}`,
								value: false,
								description: `Reset capability "${name}" to false`,
								risk: 'low',
							},
						});
					}
				}
			}
			break;
		}

		// Check hooks configuration
		case 'hooks': {
			emitObjectTypeMismatch('hooks', value, findings);
			if (
				value !== undefined &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				value !== null
			) {
				const hooks = value as Record<string, unknown>;
				// Check for deprecated/unknown hook fields
				const validHooks = [
					'system_enhancer',
					'compaction',
					'agent_activity',
					'delegation_tracker',
					'agent_awareness_max_chars',
					'delegation_gate',
					'delegation_max_chars',
				];
				for (const hookName of Object.keys(hooks)) {
					if (!validHooks.includes(hookName)) {
						findings.push({
							id: 'unknown-hook-field',
							title: 'Unknown hook configuration',
							description: `Unknown hook "${hookName}" will be ignored.`,
							severity: 'info',
							path: `hooks.${hookName}`,
							currentValue: hooks[hookName],
							autoFixable: true,
							proposedFix: {
								type: 'remove',
								path: `hooks.${hookName}`,
								description: `Remove unknown hook "${hookName}"`,
								risk: 'low',
							},
						});
					}
				}
			}
			break;
		}

		// Check max_iterations bounds
		case 'max_iterations': {
			const numValue = value as number;
			if (typeof numValue === 'number') {
				if (numValue < 1 || numValue > 10) {
					findings.push({
						id: 'out-of-bounds-iterations',
						title: 'max_iterations out of bounds',
						description: `max_iterations must be 1-10, got ${numValue}`,
						severity: 'error',
						path: 'max_iterations',
						currentValue: numValue,
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'max_iterations',
							value: Math.max(1, Math.min(10, numValue)),
							description: 'Clamp to valid range 1-10',
							risk: 'low',
						},
					});
				}
			}
			break;
		}

		// Check qa_retry_limit bounds
		case 'qa_retry_limit': {
			const numValue = value as number;
			if (typeof numValue === 'number') {
				if (numValue < 1 || numValue > 10) {
					findings.push({
						id: 'out-of-bounds-retry-limit',
						title: 'qa_retry_limit out of bounds',
						description: `qa_retry_limit must be 1-10, got ${numValue}`,
						severity: 'error',
						path: 'qa_retry_limit',
						currentValue: numValue,
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'qa_retry_limit',
							value: Math.max(1, Math.min(10, numValue)),
							description: 'Clamp to valid range 1-10',
							risk: 'low',
						},
					});
				}
			}
			break;
		}

		// Check swarms for valid structure (with type guard, empty, path-traversal)
		case 'swarms': {
			if (value !== undefined) {
				if (
					typeof value !== 'object' ||
					Array.isArray(value) ||
					value === null
				) {
					findings.push({
						id: 'invalid-swarms-type',
						title: 'Invalid swarms type',
						description: `"swarms" must be an object, got ${typeof value}`,
						severity: 'error',
						path: 'swarms',
						currentValue: value,
						autoFixable: false,
					});
					break;
				}
				const swarms = value as Record<string, unknown>;

				// Empty swarms check
				if (Object.keys(swarms).length === 0) {
					findings.push({
						id: 'empty-swarms',
						title: 'Empty swarms configuration',
						description:
							'The "swarms" field is an empty object. No swarm configurations are defined.',
						severity: 'info',
						path: 'swarms',
						autoFixable: false,
					});
				}

				// Path-traversal check on swarm IDs
				for (const swarmId of Object.keys(swarms)) {
					if (
						swarmId.includes('..') ||
						swarmId.includes('/') ||
						swarmId.includes('\\') ||
						swarmId.includes('\0')
					) {
						findings.push({
							id: 'swarm-id-path-traversal',
							title: 'Path traversal in swarm ID',
							description: `Swarm ID "${swarmId}" contains path traversal characters.`,
							severity: 'error',
							path: `swarms.${swarmId}`,
							autoFixable: false,
						});
					}
				}

				// Existing agent validation
				const validAgents = new Set(ALL_AGENT_NAMES as readonly string[]);
				for (const [swarmId, swarmConfig] of Object.entries(swarms)) {
					const swarm = swarmConfig as Record<string, unknown>;
					if (swarm.agents && typeof swarm.agents === 'object') {
						for (const [agentName] of Object.entries(
							swarm.agents as Record<string, unknown>,
						)) {
							const baseName = stripKnownSwarmPrefix(agentName);
							if (
								baseName !== agentName &&
								agentName.startsWith(`${swarmId}_`) &&
								validAgents.has(baseName)
							) {
								findings.push({
									id: 'prefixed-swarm-agent-override',
									title: 'Prefixed agent override is ignored',
									description:
										`Agent "${agentName}" in swarm "${swarmId}" uses a generated agent name. ` +
										`Per-swarm overrides must use the canonical key "${baseName}", e.g. ` +
										`"swarms.${swarmId}.agents.${baseName}.model". Otherwise the override is ignored and the agent falls back to its default model.`,
									severity: 'warn',
									path: `swarms.${swarmId}.agents.${agentName}`,
									currentValue: (swarm.agents as Record<string, unknown>)[
										agentName
									],
									autoFixable: false,
								});
							} else if (!validAgents.has(baseName)) {
								findings.push({
									id: 'unknown-swarm-agent',
									title: 'Unknown agent in swarm',
									description: `Agent "${agentName}" in swarm "${swarmId}" may not be recognized.`,
									severity: 'info',
									path: `swarms.${swarmId}.agents.${agentName}`,
									currentValue: (swarm.agents as Record<string, unknown>)[
										agentName
									],
									autoFixable: false,
								});
							}
						}
					}
				}
			}
			break;
		}

		// ── NEW TYPE-CHECK CASES FOR ALL REMAINING TOP-LEVEL KEYS ──

		case 'default_agent': {
			if (value !== undefined && typeof value !== 'string') {
				findings.push({
					id: 'invalid-default_agent-type',
					title: 'Invalid default_agent type',
					description: `"default_agent" must be a string, got ${typeof value}`,
					severity: 'error',
					path: 'default_agent',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'auto_select_architect': {
			if (
				value !== undefined &&
				typeof value !== 'boolean' &&
				typeof value !== 'string'
			) {
				findings.push({
					id: 'invalid-auto_select_architect-type',
					title: 'Invalid auto_select_architect type',
					description: `"auto_select_architect" must be a boolean or string, got ${typeof value}`,
					severity: 'error',
					path: 'auto_select_architect',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'pipeline': {
			emitObjectTypeMismatch('pipeline', value, findings);
			break;
		}

		case 'harness_evolution': {
			emitObjectTypeMismatch('harness_evolution', value, findings);
			break;
		}

		case 'phase_complete': {
			emitObjectTypeMismatch('phase_complete', value, findings);
			break;
		}

		case 'execution_mode': {
			const validModes = ['strict', 'balanced', 'fast'];
			if (value !== undefined && !validModes.includes(value as string)) {
				findings.push({
					id: 'invalid-execution_mode-type',
					title: 'Invalid execution_mode',
					description: `"execution_mode" must be one of: ${validModes.join(', ')}, got "${value}"`,
					severity: 'error',
					path: 'execution_mode',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'inject_phase_reminders': {
			if (value !== undefined && typeof value !== 'boolean') {
				findings.push({
					id: 'invalid-inject_phase_reminders-type',
					title: 'Invalid inject_phase_reminders type',
					description: `"inject_phase_reminders" must be a boolean, got ${typeof value}`,
					severity: 'error',
					path: 'inject_phase_reminders',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'gates': {
			emitObjectTypeMismatch('gates', value, findings);
			break;
		}

		case 'context_budget': {
			emitObjectTypeMismatch('context_budget', value, findings);
			break;
		}

		case 'pricing': {
			emitObjectTypeMismatch('pricing', value, findings);
			break;
		}

		case 'guardrails': {
			emitObjectTypeMismatch('guardrails', value, findings);
			break;
		}

		case 'watchdog': {
			emitObjectTypeMismatch('watchdog', value, findings);
			break;
		}

		case 'self_review': {
			emitObjectTypeMismatch('self_review', value, findings);
			break;
		}

		case 'tool_filter': {
			emitObjectTypeMismatch('tool_filter', value, findings);
			break;
		}

		case 'authority': {
			emitObjectTypeMismatch('authority', value, findings);
			break;
		}

		case 'plan_cursor': {
			emitObjectTypeMismatch('plan_cursor', value, findings);
			break;
		}

		case 'context_map': {
			emitObjectTypeMismatch('context_map', value, findings);
			break;
		}

		case 'evidence': {
			emitObjectTypeMismatch('evidence', value, findings);
			break;
		}

		case 'summaries': {
			emitObjectTypeMismatch('summaries', value, findings);
			break;
		}

		case 'auto_review': {
			emitObjectTypeMismatch('auto_review', value, findings);
			break;
		}

		case 'repo_graph': {
			emitObjectTypeMismatch('repo_graph', value, findings);
			break;
		}

		// issue #2483: retention { enabled, dry_run } — object-structural
		// validation only; Zod owns the leaf types (RetentionConfigSchema).
		case 'retention': {
			emitObjectTypeMismatch('retention', value, findings);
			break;
		}

		case 'review_passes': {
			emitObjectTypeMismatch('review_passes', value, findings);
			break;
		}

		case 'adversarial_detection': {
			emitObjectTypeMismatch('adversarial_detection', value, findings);
			break;
		}

		case 'adversarial_testing': {
			emitObjectTypeMismatch('adversarial_testing', value, findings);
			break;
		}

		case 'integration_analysis': {
			emitObjectTypeMismatch('integration_analysis', value, findings);
			break;
		}

		case 'docs': {
			emitObjectTypeMismatch('docs', value, findings);
			break;
		}

		case 'design_docs': {
			emitObjectTypeMismatch('design_docs', value, findings);
			break;
		}

		case 'git': {
			emitObjectTypeMismatch('git', value, findings);
			break;
		}

		// `git.binary` overrides which git executable the plugin spawns.
		// `GitConfigSchema` deliberately does NOT `.refine()` this field: a refine
		// failure fails the WHOLE config parse, and a config that cannot load is
		// precisely the "config value makes git unreachable" outcome the field is
		// meant to avoid (see the comment above GitConfigSchema in
		// src/config/schema.ts). Validation is therefore owed here, where a
		// finding is advisory and non-fatal — without it a typo'd or blank
		// override is accepted silently and only surfaces as a spawn failure.
		//
		// These findings are SOURCE-AGNOSTIC by construction: this validator
		// receives a key/value pair, not the file it came from. The trust
		// decision that a project-level `git.binary` is refused outright
		// (CWE-427) therefore lives in the loader, which does see provenance —
		// `enforceGitBinaryProvenance` in src/config/loader.ts.
		case 'git.binary': {
			if (value !== undefined && typeof value !== 'string') {
				findings.push({
					id: 'invalid-git-binary-type',
					title: 'Invalid git.binary type',
					description: `"git.binary" must be a string, got ${typeof value}`,
					severity: 'error',
					path: 'git.binary',
					currentValue: value,
					autoFixable: false,
				});
			} else if (typeof value === 'string' && value.trim() === '') {
				findings.push({
					id: 'empty-git-binary',
					title: 'Empty git.binary',
					description:
						'"git.binary" is blank, so no git executable is named. Remove the key to fall back to the default `git` lookup, or set it to a real git executable path.',
					severity: 'error',
					path: 'git.binary',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'ui_review': {
			emitObjectTypeMismatch('ui_review', value, findings);
			break;
		}

		case 'compaction_advisory': {
			emitObjectTypeMismatch('compaction_advisory', value, findings);
			break;
		}

		case 'lint': {
			emitObjectTypeMismatch('lint', value, findings);
			break;
		}

		case 'secretscan': {
			emitObjectTypeMismatch('secretscan', value, findings);
			break;
		}

		case 'checkpoint': {
			emitObjectTypeMismatch('checkpoint', value, findings);
			break;
		}

		case 'apply_patch': {
			emitObjectTypeMismatch('apply_patch', value, findings);
			break;
		}

		case 'automation': {
			emitObjectTypeMismatch('automation', value, findings);
			break;
		}

		case 'knowledge': {
			emitObjectTypeMismatch('knowledge', value, findings);
			break;
		}

		case 'memory': {
			emitObjectTypeMismatch('memory', value, findings);
			break;
		}

		case 'observability': {
			emitObjectTypeMismatch('observability', value, findings);
			// #2485: useful, bounded advisories for the opt-in OTLP export.
			// Shape errors themselves are already surfaced by schema parsing;
			// these catch the two misconfigurations that would silently
			// no-op or ship secrets to a plaintext remote endpoint.
			if (
				typeof value === 'object' &&
				value !== null &&
				!Array.isArray(value)
			) {
				const exportCfg = (value as Record<string, unknown>).export;
				if (
					typeof exportCfg === 'object' &&
					exportCfg !== null &&
					(exportCfg as Record<string, unknown>).enabled === true
				) {
					const endpoint = (exportCfg as Record<string, unknown>).endpoint;
					let problem: string | null = null;
					if (typeof endpoint !== 'string' || endpoint.length === 0) {
						problem =
							'observability.export.enabled is true but endpoint is empty — the exporter stays disabled until an endpoint is configured.';
					} else {
						try {
							const url = new URL(endpoint);
							const isLoopback =
								url.hostname === 'localhost' ||
								url.hostname === '127.0.0.1' ||
								url.hostname === '::1';
							if (url.protocol !== 'https:' && !isLoopback) {
								problem =
									'observability.export.endpoint uses plain http: for a non-loopback host — exported telemetry would travel unencrypted; use https: outside local test collectors.';
							}
						} catch {
							problem =
								'observability.export.endpoint is not a valid URL — the exporter stays disabled.';
						}
					}
					if (problem !== null) {
						findings.push({
							id: 'observability-export-endpoint-policy',
							title: 'OTLP export endpoint policy',
							description: problem,
							severity: 'warn',
							path: 'observability.export.endpoint',
							autoFixable: false,
						});
					}
				}
			}
			break;
		}

		case 'learning': {
			emitObjectTypeMismatch('learning', value, findings);
			break;
		}

		case 'consensus': {
			emitObjectTypeMismatch('consensus', value, findings);
			break;
		}

		case 'curator': {
			emitObjectTypeMismatch('curator', value, findings);
			break;
		}

		case 'architectural_supervision': {
			emitObjectTypeMismatch('architectural_supervision', value, findings);
			break;
		}

		case 'knowledge_application': {
			emitObjectTypeMismatch('knowledge_application', value, findings);
			break;
		}

		case 'skillPropagation': {
			emitObjectTypeMismatch('skillPropagation', value, findings);
			break;
		}

		case 'skill_improver': {
			emitObjectTypeMismatch('skill_improver', value, findings);
			break;
		}

		case 'skills': {
			emitObjectTypeMismatch('skills', value, findings);
			break;
		}

		case 'spec_writer': {
			emitObjectTypeMismatch('spec_writer', value, findings);
			break;
		}

		case 'tool_output': {
			emitObjectTypeMismatch('tool_output', value, findings);
			break;
		}

		case 'slop_detector': {
			emitObjectTypeMismatch('slop_detector', value, findings);
			break;
		}

		case 'todo_gate': {
			emitObjectTypeMismatch('todo_gate', value, findings);
			break;
		}

		case 'incremental_verify': {
			emitObjectTypeMismatch('incremental_verify', value, findings);
			break;
		}

		case 'compaction_service': {
			emitObjectTypeMismatch('compaction_service', value, findings);
			break;
		}

		case 'prm': {
			emitObjectTypeMismatch('prm', value, findings);
			break;
		}

		case 'council': {
			emitObjectTypeMismatch('council', value, findings);
			// Council policy visibility findings (issue #2102 contracts C/E/F)
			// live in collectRawCouncilPolicyFindings: they must fire only when
			// the user EXPLICITLY wrote the key, and the parsed config always
			// carries schema defaults (e.g. parallelTimeoutMs), so raw config is
			// the only correct source.
			break;
		}

		case 'parallelization': {
			emitObjectTypeMismatch('parallelization', value, findings);
			break;
		}

		case 'worktree': {
			emitObjectTypeMismatch('worktree', value, findings);
			break;
		}

		case 'turbo': {
			emitObjectTypeMismatch('turbo', value, findings);
			break;
		}

		case 'turbo_mode': {
			if (value !== undefined && typeof value !== 'boolean') {
				findings.push({
					id: 'invalid-turbo_mode-type',
					title: 'Invalid turbo_mode type',
					description: `"turbo_mode" must be a boolean, got ${typeof value}`,
					severity: 'error',
					path: 'turbo_mode',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'quiet': {
			if (value !== undefined && typeof value !== 'boolean') {
				findings.push({
					id: 'invalid-quiet-type',
					title: 'Invalid quiet type',
					description: `"quiet" must be a boolean, got ${typeof value}`,
					severity: 'error',
					path: 'quiet',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'version_check': {
			if (value !== undefined && typeof value !== 'boolean') {
				findings.push({
					id: 'invalid-version_check-type',
					title: 'Invalid version_check type',
					description: `"version_check" must be a boolean, got ${typeof value}`,
					severity: 'error',
					path: 'version_check',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case '$schema': {
			// Inert editor metadata (issue #1663). The loader's zod schema
			// degrades malformed values to absent, so a non-string here is only
			// reachable via direct doctor invocation — but the case must exist
			// so the every-key validation ratchet holds and direct callers get
			// an accurate finding.
			if (value !== undefined && typeof value !== 'string') {
				findings.push({
					id: 'invalid-$schema-type',
					title: 'Invalid $schema type',
					description: `"$schema" must be a string (JSON Schema URL), got ${typeof value}`,
					severity: 'error',
					path: '$schema',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'full_auto': {
			emitObjectTypeMismatch('full_auto', value, findings);
			break;
		}

		case 'pr_monitor': {
			emitObjectTypeMismatch('pr_monitor', value, findings);
			break;
		}

		case 'pr_review_resilience': {
			emitObjectTypeMismatch('pr_review_resilience', value, findings);
			break;
		}

		case 'lane_liveness_watchdog': {
			emitObjectTypeMismatch('lane_liveness_watchdog', value, findings);
			break;
		}

		case 'dispatch_protection': {
			emitObjectTypeMismatch('dispatch_protection', value, findings);
			break;
		}

		case 'pr_review_legacy_transcript_compatibility': {
			if (value !== undefined && typeof value !== 'boolean') {
				findings.push({
					id: 'invalid-pr_review_legacy_transcript_compatibility-type',
					title: 'Invalid pr_review_legacy_transcript_compatibility type',
					description: `"pr_review_legacy_transcript_compatibility" must be a boolean, got ${typeof value}`,
					severity: 'error',
					path: 'pr_review_legacy_transcript_compatibility',
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}

		case 'external_skills': {
			emitObjectTypeMismatch('external_skills', value, findings);
			break;
		}
		case 'skill_opt': {
			emitObjectTypeMismatch('skill_opt', value, findings);
			break;
		}

		// ── DEFAULT CASE: Unknown config key detection + Levenshtein suggestion ──
		default: {
			// Extract top-level segment from the path
			const topLevel = path.split('.')[0];
			if (KNOWN_TOP_LEVEL_KEYS.has(topLevel)) {
				break; // Nested key under a valid parent — silently accept
			}

			// Top-level is unknown — find closest match via Levenshtein
			// Skip Levenshtein computation for unreasonably long keys to prevent
			// O(n²) CPU/memory allocation during plugin init (invariant #1).
			const MAX_SUGGESTION_KEY_LENGTH = 100;
			const lowerTopLevel = topLevel.toLowerCase();
			let suggestion: string | undefined;
			let matchCount = 0;
			if (lowerTopLevel.length <= MAX_SUGGESTION_KEY_LENGTH) {
				for (const knownKey of KNOWN_TOP_LEVEL_KEYS) {
					if (levenshteinDistance(lowerTopLevel, knownKey.toLowerCase()) <= 2) {
						matchCount++;
						if (matchCount === 1) {
							suggestion = knownKey;
						}
					}
				}
			}

			if (matchCount === 1 && suggestion) {
				findings.push({
					id: 'unknown-config-key',
					title: `Unknown config key: ${topLevel}`,
					description: `Unknown config key "${path}" is not in the schema. Did you mean "${suggestion}"?`,
					severity: 'warn',
					path,
					currentValue: value,
					autoFixable: false,
				});
			} else {
				findings.push({
					id: 'unknown-config-key',
					title: `Unknown config key: ${topLevel}`,
					description: `Unknown config key "${path}" is not in the schema.`,
					severity: 'warn',
					path,
					currentValue: value,
					autoFixable: false,
				});
			}
			break;
		}
	}

	return findings;
}

/**
 * Recursively walk a config object and validate all keys.
 * Uses a WeakSet to detect circular references and prevent stack overflow.
 */
function walkConfigAndValidate(
	obj: unknown,
	path: string,
	findings: ConfigFinding[],
	visited: WeakSet<object> = new WeakSet(),
): void {
	if (obj === null || obj === undefined) {
		return;
	}

	// First validate at this path level (for object-level checks)
	if (path && typeof obj === 'object' && !Array.isArray(obj)) {
		const keyFindings = validateConfigKey(path, obj);
		findings.push(...keyFindings);
	}

	if (typeof obj !== 'object') {
		// Leaf value - validate based on path
		const keyFindings = validateConfigKey(path, obj);
		findings.push(...keyFindings);
		return;
	}

	// Circular reference check — covers BOTH arrays and plain objects.
	// Must run before Array.isArray branching so self-referential arrays are caught.
	if (visited.has(obj as object)) {
		findings.push({
			id: 'circular-reference',
			title: `Circular reference detected at ${path}`,
			description: `Config value at "${path}" contains a circular reference. Validation stopped at this path to prevent stack overflow.`,
			severity: 'error',
			path,
			currentValue: '[circular]',
			autoFixable: false,
		});
		return;
	}
	visited.add(obj as object);

	if (Array.isArray(obj)) {
		// Validate the array itself at this path level before recursing into elements
		const arrayFindings = validateConfigKey(path, obj);
		findings.push(...arrayFindings);
		// Arrays - check each element
		obj.forEach((item, index) => {
			walkConfigAndValidate(item, `${path}[${index}]`, findings, visited);
		});
		return;
	}

	// Objects - walk each property
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const newPath = path ? `${path}.${key}` : key;
		walkConfigAndValidate(value, newPath, findings, visited);
	}
}

/**
 * Run the config doctor on a loaded config
 */
export function runConfigDoctor(
	config: PluginConfig,
	directory: string,
): ConfigDoctorResult {
	const findings: ConfigFinding[] = [];

	// Walk the config and validate
	walkConfigAndValidate(config, '', findings);
	findings.push(...collectRawGatesConfigFindings(directory));
	findings.push(...collectRawCouncilPolicyFindings(directory));
	findings.push(...collectRawStrictSectionFindings(directory));
	findings.push(...collectRawValueConstraintFindings(directory));
	findings.push(...collectRawAutoReviewCompatibilityFindings(directory));
	findings.push(...collectLeanTurboGateSatisfiabilityFindings(config));
	emitWorktreeIsolationLayeringAdvisory(config, findings);

	// Count by severity
	const summary = {
		info: findings.filter((f) => f.severity === 'info').length,
		warn: findings.filter((f) => f.severity === 'warn').length,
		error: findings.filter((f) => f.severity === 'error').length,
	};

	// Check if any auto-fixable issues exist
	const hasAutoFixableIssues = findings.some(
		(f) => f.autoFixable && f.proposedFix?.risk === 'low',
	);

	// Determine config source
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);
	let configSource = 'defaults';
	if (fs.existsSync(projectConfigPath)) {
		configSource = projectConfigPath;
	} else if (fs.existsSync(userConfigPath)) {
		configSource = userConfigPath;
	}

	// -- Migration availability detection --
	// The config normally arrives Zod-validated (config_format_version is a
	// non-negative int with .default(1)). Guard against a raw/unvalidated object
	// bypassing Zod (e.g. the readConfigFromFile cast in runConfigDoctorWithFixes):
	// `NaN < deprecatedIn` is false, which would silently suppress migrations.
	const rawConfigVersion = config.config_format_version;
	// Coerce any non-finite, non-integer, or negative value back to the schema
	// default of 1. The config normally arrives Zod-validated (which rejects
	// these), but a raw object can bypass Zod (e.g. the readConfigFromFile cast
	// in runConfigDoctorWithFixes): `NaN < deprecatedIn` is false and would
	// silently suppress migrations, while a negative version is nonsensical.
	const configVersion =
		typeof rawConfigVersion === 'number' &&
		Number.isFinite(rawConfigVersion) &&
		Number.isInteger(rawConfigVersion) &&
		rawConfigVersion >= 0
			? rawConfigVersion
			: 1;
	const availableMigrations: Array<{
		field: string;
		replacement: string;
		deprecatedIn: number;
		sinceVersion: number;
		currentFormatVersion: number;
	}> = [];

	for (const [depPath, depInfo] of DEPRECATED_FIELDS) {
		if (configVersion < depInfo.deprecatedIn) {
			availableMigrations.push({
				field: depPath,
				replacement: depInfo.replacement,
				deprecatedIn: depInfo.deprecatedIn,
				sinceVersion: depInfo.sinceVersion,
				currentFormatVersion: configVersion,
			});
		}
	}

	return {
		findings,
		summary,
		hasAutoFixableIssues,
		timestamp: Date.now(),
		configSource,
		...(availableMigrations.length > 0 ? { availableMigrations } : {}),
	};
}

/**
 * Dangerous path segments that can cause prototype pollution
 */
const DANGEROUS_PATH_SEGMENTS = new Set([
	'__proto__',
	'constructor',
	'prototype',
]);

/**
 * Check if a path segment is dangerous (can cause prototype pollution)
 */
function isDangerousPathSegment(segment: string): boolean {
	return DANGEROUS_PATH_SEGMENTS.has(segment);
}

/**
 * Validate that a fix path does not contain dangerous segments
 * Returns true if the path is safe, false if it contains dangerous segments
 */
function isPathSafe(fixPath: string): boolean {
	const segments = fixPath.split('.');
	for (const segment of segments) {
		if (isDangerousPathSegment(segment)) {
			return false;
		}
	}
	return true;
}

/**
 * Apply safe auto-fixes to config
 * Only applies low-risk, non-destructive fixes
 */
export function applySafeAutoFixes(
	directory: string,
	result: ConfigDoctorResult,
	options: { applyLossy?: boolean } = {},
): {
	appliedFixes: ConfigFix[];
	updatedConfigPath: string | null;
} {
	// Lossy fixes (e.g. trimming an over-length array, which drops user-authored
	// entries) are applied ONLY when the caller explicitly opts in — the
	// interactive `/swarm config doctor --fix` command does; the passive startup
	// autofix path never does (issue #1886 follow-up).
	const applyLossy = options.applyLossy === true;
	const appliedFixes: ConfigFix[] = [];
	let updatedConfigPath: string | null = null;

	// Get config paths
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);

	// Determine which config to modify (prefer project config)
	let configPath = projectConfigPath;
	let configContent: string;

	if (fs.existsSync(projectConfigPath)) {
		configPath = projectConfigPath;
		configContent = fs.readFileSync(projectConfigPath, 'utf-8');
	} else if (fs.existsSync(userConfigPath)) {
		configPath = userConfigPath;
		configContent = fs.readFileSync(userConfigPath, 'utf-8');
	} else {
		// No config file to fix
		return { appliedFixes, updatedConfigPath: null };
	}

	// Parse current config
	let config: Record<string, unknown>;
	try {
		config = JSON.parse(configContent);
	} catch {
		// Invalid JSON - can't fix
		return { appliedFixes, updatedConfigPath: null };
	}

	// Filter for safe fixes only. Lossy fixes are held back unless the caller
	// opted in (see `applyLossy` above).
	const safeFixes = result.findings.filter(
		(f) =>
			f.autoFixable &&
			f.proposedFix?.risk === 'low' &&
			(applyLossy || !f.proposedFix?.lossy),
	);

	// Apply each safe fix
	for (const finding of safeFixes) {
		const fix = finding.proposedFix;
		if (!fix) continue;

		// Reject fixes with dangerous path segments to prevent prototype pollution
		if (!isPathSafe(fix.path)) {
			continue;
		}

		// Navigate to the parent of the target path, creating intermediate objects as needed
		const pathParts = fix.path.split('.');
		let current: unknown = config;
		let navigated = true;

		for (let i = 0; i < pathParts.length - 1; i++) {
			const part = pathParts[i];

			// If current is null or undefined, we can't navigate further - fix will fail
			if (current === null || current === undefined) {
				navigated = false;
				break;
			}

			// If current is not an object, we can't navigate further - fix will fail
			if (typeof current !== 'object' || Array.isArray(current)) {
				navigated = false;
				break;
			}

			const obj = current as Record<string, unknown>;

			// Check if intermediate object exists and is valid
			if (obj[part] === undefined) {
				// Create intermediate object if it doesn't exist
				obj[part] = {};
			} else if (obj[part] === null) {
				// Null intermediate - cannot safely create path, skip fix
				navigated = false;
				break;
			} else if (typeof obj[part] !== 'object') {
				// Non-object intermediate - can't create path - fix will fail
				navigated = false;
				break;
			}

			current = obj[part];
		}

		// Skip fix if we couldn't navigate to the target path
		if (!navigated) {
			continue;
		}

		const lastPart = pathParts[pathParts.length - 1];

		// Apply the fix
		switch (fix.type) {
			case 'remove':
				if (
					current !== null &&
					current !== undefined &&
					typeof current === 'object'
				) {
					delete (current as Record<string, unknown>)[lastPart];
					appliedFixes.push(fix);
				}
				break;

			case 'update':
				if (
					current !== null &&
					current !== undefined &&
					typeof current === 'object'
				) {
					(current as Record<string, unknown>)[lastPart] = fix.value;
					appliedFixes.push(fix);
				}
				break;

			case 'add':
				if (
					current !== null &&
					current !== undefined &&
					typeof current === 'object'
				) {
					(current as Record<string, unknown>)[lastPart] = fix.value;
					appliedFixes.push(fix);
				}
				break;
		}
	}

	// Apply deprecated-field migrations. Like lossy fixes, these rewrite
	// user-authored config (moving a legacy key's value to its replacement
	// path and removing the legacy key), so they run only under the
	// interactive `--fix` command (applyLossy === true), never the passive
	// startup autofix path (issue #1886). Only fields holding a non-default
	// value are migrated; a default-valued legacy key is a no-op.
	if (
		applyLossy &&
		result.availableMigrations &&
		result.availableMigrations.length > 0
	) {
		for (const migration of result.availableMigrations) {
			// Legacy key lives at a top-level object path (e.g.
			// `skill_improver.model` → config.skill_improver.model).
			if (!isPathSafe(migration.field) || !isPathSafe(migration.replacement)) {
				continue;
			}
			const legacyParts = migration.field.split('.');
			// Read the current legacy value, navigating to its parent.
			let legacyParent: unknown = config;
			let legacyNavigated = true;
			for (let i = 0; i < legacyParts.length - 1; i++) {
				const part = legacyParts[i];
				if (
					legacyParent === null ||
					legacyParent === undefined ||
					typeof legacyParent !== 'object' ||
					Array.isArray(legacyParent)
				) {
					legacyNavigated = false;
					break;
				}
				const obj = legacyParent as Record<string, unknown>;
				if (obj[part] === undefined || obj[part] === null) {
					legacyNavigated = false;
					break;
				}
				legacyParent = obj[part];
			}
			if (!legacyNavigated) {
				continue;
			}
			const legacyKey = legacyParts[legacyParts.length - 1]!;
			const legacyHolder = legacyParent as Record<string, unknown>;
			if (!(legacyKey in legacyHolder)) {
				// Legacy key absent — nothing to migrate.
				continue;
			}
			const legacyValue = legacyHolder[legacyKey];

			// Skip if the legacy value is at its schema default (mirrors the
			// deprecated-field finding-emission logic: only non-default values
			// warrant migration).
			const depInfo = DEPRECATED_FIELDS.get(migration.field);
			if (!depInfo || depInfo.isDefaultValue(legacyValue)) {
				continue;
			}

			// Navigate/create the replacement path's parent.
			const replParts = migration.replacement.split('.');
			let replParent: unknown = config;
			let replNavigated = true;
			for (let i = 0; i < replParts.length - 1; i++) {
				const part = replParts[i];
				if (
					replParent === null ||
					replParent === undefined ||
					typeof replParent !== 'object' ||
					Array.isArray(replParent)
				) {
					replNavigated = false;
					break;
				}
				const obj = replParent as Record<string, unknown>;
				if (obj[part] === undefined) {
					obj[part] = {};
				} else if (obj[part] === null || typeof obj[part] !== 'object') {
					replNavigated = false;
					break;
				}
				replParent = obj[part];
			}
			if (!replNavigated) {
				continue;
			}
			const replKey = replParts[replParts.length - 1]!;
			(replParent as Record<string, unknown>)[replKey] = legacyValue;
			delete legacyHolder[legacyKey];
			appliedFixes.push({
				type: 'update',
				path: migration.replacement,
				value: legacyValue,
				description: `Migrate deprecated field \`${migration.field}\` → \`${migration.replacement}\``,
				risk: 'low',
				lossy: true,
			});
			appliedFixes.push({
				type: 'remove',
				path: migration.field,
				description: `Remove deprecated field \`${migration.field}\` (migrated to \`${migration.replacement}\`)`,
				risk: 'low',
				lossy: true,
			});
		}
	}

	// If we applied any fixes, write the updated config
	if (appliedFixes.length > 0) {
		// Ensure directory exists
		const configDir = path.dirname(configPath);
		if (!fs.existsSync(configDir)) {
			fs.mkdirSync(configDir, { recursive: true });
		}

		// Write updated config
		atomicWriteFileSync(configPath, JSON.stringify(config, null, 2));
		updatedConfigPath = configPath;
	}

	return { appliedFixes, updatedConfigPath };
}

/** Summary data from a previous config-doctor artifact */
export interface DoctorArtifactSummary {
	/** ISO 8601 timestamp of the previous run */
	timestamp: string;
	/** Total number of findings in the previous run */
	findingsCount: number;
	/** Number of auto-fixable findings in the previous run */
	autoFixableCount: number;
}

/**
 * Read the last-run config-doctor artifact from .swarm/config-doctor.json.
 * Returns a compact summary or null if the artifact does not exist or cannot be parsed.
 * Fail-open: any I/O or parse error silently returns null.
 */
export function readDoctorArtifact(
	directory: string,
): DoctorArtifactSummary | null {
	try {
		const artifactPath = path.join(directory, '.swarm', 'config-doctor.json');
		if (!fs.existsSync(artifactPath)) {
			return null;
		}

		const content = fs.readFileSync(artifactPath, 'utf-8');
		const artifact = JSON.parse(content) as Record<string, unknown>;
		const summary = artifact.summary as Record<string, number> | undefined;

		if (!summary || typeof summary !== 'object') {
			return null;
		}

		// Validate summary fields are finite numbers; fail-open on corrupt data
		const infoVal = summary.info;
		const warnVal = summary.warn;
		const errorVal = summary.error;
		if (
			typeof infoVal !== 'number' ||
			!Number.isFinite(infoVal) ||
			typeof warnVal !== 'number' ||
			!Number.isFinite(warnVal) ||
			typeof errorVal !== 'number' ||
			!Number.isFinite(errorVal)
		) {
			return null;
		}

		// Validate timestamp is a finite number before constructing Date
		const ts = artifact.timestamp;
		if (typeof ts !== 'number' || !Number.isFinite(ts)) {
			return null;
		}

		const findingsCount = infoVal + warnVal + errorVal;
		const findings = artifact.findings as
			| Array<{ autoFixable?: boolean }>
			| undefined;
		const autoFixableCount = Array.isArray(findings)
			? findings.filter((f) => f.autoFixable === true).length
			: 0;

		return {
			timestamp: new Date(ts).toISOString(),
			findingsCount,
			autoFixableCount,
		};
	} catch {
		return null;
	}
}

/**
 * Write doctor result to .swarm directory for GUI consumption
 */
export function writeDoctorArtifact(
	directory: string,
	result: ConfigDoctorResult,
): string {
	const swarmDir = path.join(directory, '.swarm');
	if (!fs.existsSync(swarmDir)) {
		fs.mkdirSync(swarmDir, { recursive: true });
	}

	const artifactFilename = 'config-doctor.json';
	const artifactPath = path.join(swarmDir, artifactFilename);

	// Create GUI-friendly output
	const guiOutput = {
		timestamp: result.timestamp,
		summary: result.summary,
		hasAutoFixableIssues: result.hasAutoFixableIssues,
		configSource: result.configSource,
		findings: result.findings.map((f) => ({
			id: f.id,
			title: f.title,
			description: f.description,
			severity: f.severity,
			path: f.path,
			autoFixable: f.autoFixable,
			proposedFix: f.proposedFix
				? {
						type: f.proposedFix.type,
						path: f.proposedFix.path,
						description: f.proposedFix.description,
						risk: f.proposedFix.risk,
						lossy: f.proposedFix.lossy === true,
					}
				: null,
		})),
	};

	atomicWriteFileSync(artifactPath, JSON.stringify(guiOutput, null, 2));
	return artifactPath;
}

/**
 * Check if config doctor should run on startup
 */
export function shouldRunOnStartup(
	automationConfig:
		| { mode: string; capabilities?: Record<string, boolean> }
		| undefined,
): boolean {
	// Only run if:
	// 1. automation mode is NOT manual
	// 2. config_doctor_on_startup capability is enabled
	if (!automationConfig) {
		return false;
	}

	if (automationConfig.mode === 'manual') {
		return false;
	}

	return automationConfig.capabilities?.config_doctor_on_startup === true;
}

/**
 * Full config doctor run with backup and fix application
 */
export async function runConfigDoctorWithFixes(
	directory: string,
	config: PluginConfig,
	autoFix: boolean = false,
	options: { applyLossy?: boolean } = {},
): Promise<{
	result: ConfigDoctorResult;
	backupPath: string | null;
	appliedFixes: ConfigFix[];
	updatedConfigPath: string | null;
	artifactPath: string | null;
}> {
	// Run the doctor
	const result = runConfigDoctor(config, directory);

	// Write artifact
	const artifactPath = writeDoctorArtifact(directory, result);

	// If no auto-fix requested, return early
	if (!autoFix) {
		return {
			result,
			backupPath: null,
			appliedFixes: [],
			updatedConfigPath: null,
			artifactPath,
		};
	}

	// Create backup before applying fixes
	const backup = createConfigBackup(directory);
	let backupPath: string | null = null;

	if (backup) {
		backupPath = writeBackupArtifact(directory, backup);
	}

	// Apply safe auto-fixes
	const { appliedFixes, updatedConfigPath } = applySafeAutoFixes(
		directory,
		result,
		options,
	);

	// Re-run doctor after fixes to get post-fix result
	// Must re-read config from file to see actual changes
	if (appliedFixes.length > 0) {
		const freshConfig = readConfigFromFile(directory);
		if (freshConfig) {
			const newResult = runConfigDoctor(
				freshConfig.config as unknown as PluginConfig,
				directory,
			);
			writeDoctorArtifact(directory, newResult);
		}
	}

	return {
		result,
		backupPath,
		appliedFixes,
		updatedConfigPath,
		artifactPath,
	};
}

/**
 * A stray .swarm directory found below the project root.
 * These are typically created by bugs in prior versions (see Issue #922).
 */
export interface StraySwarmFinding {
	/** Relative path from project root (forward-slash normalized) */
	path: string;
	/** Absolute path on disk */
	absolutePath: string;
	/** Contents summary (up to 20 entries) */
	contents: string[];
	/** Total number of entries in the directory */
	totalEntries: number;
}

/**
 * Detect stray .swarm directories in project subdirectories.
 * These are .swarm/ directories that exist below the project root,
 * typically created by bugs in prior versions (see Issue #922).
 *
 * Skips: node_modules/, .git/, dist/, .cache/, .next/, coverage/
 * and common tool/build output directories.
 */
export function detectStraySwarmDirs(projectRoot: string): StraySwarmFinding[] {
	const findings: StraySwarmFinding[] = [];

	const SKIP_DIRS = new Set([
		'node_modules',
		'.git',
		'dist',
		'.cache',
		'.next',
		'coverage',
		'.turbo',
		'.vercel',
		'.terraform',
		'__pycache__',
		'.tox',
	]);

	/** Maximum recursion depth to prevent runaway scans */
	const MAX_DEPTH = 10;

	/** Maximum number of directory entries to list per stray finding */
	const MAX_CONTENTS_ENTRIES = 20;

	function walk(dir: string, depth: number): void {
		if (depth > MAX_DEPTH) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // Permission denied or removed — skip silently
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const name = entry.name;
			const fullPath = path.join(dir, name);

			// Skip known non-project directories
			if (SKIP_DIRS.has(name)) continue;

			// Skip git submodule or nested standalone repo roots
			const gitPath = path.join(fullPath, '.git');
			try {
				const gitStat = fs.statSync(gitPath);
				if (gitStat.isFile() || gitStat.isDirectory()) continue; // submodule or nested repo — skip
			} catch {
				// .git doesn't exist or is unreadable — not a git root, continue
			}

			// Check if this directory IS .swarm
			if (name === '.swarm') {
				// Skip if this is the project root .swarm
				const parentDir = path.dirname(fullPath);
				if (parentDir === projectRoot) continue;

				// This is a stray .swarm directory
				let contents: string[] = [];
				try {
					contents = fs.readdirSync(fullPath);
				} catch {
					contents = ['<unreadable>'];
				}

				findings.push({
					path: path.relative(projectRoot, fullPath).replace(/\\/g, '/'),
					absolutePath: fullPath,
					contents: contents.slice(0, MAX_CONTENTS_ENTRIES),
					totalEntries: contents.length,
				});

				continue; // Don't recurse INTO .swarm directories
			}

			// Recurse into subdirectories
			walk(fullPath, depth + 1);
		}
	}

	walk(projectRoot, 0);
	return findings;
}

/**
 * Remove a stray .swarm directory.
 * NEVER removes the root .swarm/ directory.
 *
 * @returns `{ success, message }` indicating outcome
 */
export function removeStraySwarmDir(
	projectRoot: string,
	strayPath: string,
): { success: boolean; message: string } {
	let canonicalRoot: string;
	let canonicalStray: string;

	try {
		canonicalRoot = fs.realpathSync(projectRoot);
		canonicalStray = fs.realpathSync(
			path.isAbsolute(strayPath)
				? strayPath
				: path.resolve(projectRoot, strayPath),
		);
	} catch (err) {
		return {
			success: false,
			message: `Failed to resolve paths: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// Safety: never remove the root .swarm/
	const rootSwarm = path.join(canonicalRoot, '.swarm');
	if (
		sameExistingFilesystemPath(canonicalStray, rootSwarm) ||
		sameExistingFilesystemPath(canonicalStray, canonicalRoot)
	) {
		return {
			success: false,
			message: 'Refusing to remove root .swarm/ directory',
		};
	}

	// Verify it's actually inside the project
	if (!isCanonicalPathWithinRoot(canonicalStray, canonicalRoot)) {
		return {
			success: false,
			message: 'Path is outside project root — refusing to remove',
		};
	}

	// Verify the directory name ends with .swarm
	const normalizedStray = canonicalStray.replace(/\\/g, '/');
	if (!normalizedStray.endsWith('/.swarm')) {
		return {
			success: false,
			message: 'Path is not a .swarm directory — refusing to remove',
		};
	}

	try {
		fs.rmSync(canonicalStray, { recursive: true, force: true });
		return {
			success: true,
			message: `Removed stray .swarm directory: ${canonicalStray}`,
		};
	} catch (err) {
		return {
			success: false,
			message: `Failed to remove: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
