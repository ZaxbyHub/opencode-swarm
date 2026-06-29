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
import { PluginConfigSchema, stripKnownSwarmPrefix } from '../config/schema';
import { log } from '../utils';

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
	}
> = new Map([
	[
		'skill_improver.model',
		{
			message: 'deprecated',
			replacement: 'agents.skill_improver.model',
			isDefaultValue: (v: unknown) => v === null,
		},
	],
	[
		'skill_improver.fallback_models',
		{
			message: 'deprecated',
			replacement: 'agents.skill_improver.fallback_models',
			isDefaultValue: (v: unknown) => Array.isArray(v) && v.length === 0,
		},
	],
	[
		'spec_writer.model',
		{
			message: 'deprecated',
			replacement: 'agents.spec_writer.model',
			isDefaultValue: (v: unknown) => v === null,
		},
	],
	[
		'spec_writer.fallback_models',
		{
			message: 'deprecated',
			replacement: 'agents.spec_writer.fallback_models',
			isDefaultValue: (v: unknown) => Array.isArray(v) && v.length === 0,
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
	const swarmDir = path.resolve(path.join(directory, '.swarm'));
	const resolvedBackup = path.resolve(backupPath);
	if (
		!resolvedBackup.startsWith(swarmDir + path.sep) &&
		resolvedBackup !== swarmDir
	) {
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

		case 'full_auto': {
			emitObjectTypeMismatch('full_auto', value, findings);
			break;
		}

		case 'pr_monitor': {
			emitObjectTypeMismatch('pr_monitor', value, findings);
			break;
		}

		case 'external_skills': {
			emitObjectTypeMismatch('external_skills', value, findings);
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

	return {
		findings,
		summary,
		hasAutoFixableIssues,
		timestamp: Date.now(),
		configSource,
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
): {
	appliedFixes: ConfigFix[];
	updatedConfigPath: string | null;
} {
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

	// Filter for safe fixes only
	const safeFixes = result.findings.filter(
		(f) => f.autoFixable && f.proposedFix?.risk === 'low',
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
	if (canonicalStray === rootSwarm || canonicalStray === canonicalRoot) {
		return {
			success: false,
			message: 'Refusing to remove root .swarm/ directory',
		};
	}

	// Verify it's actually inside the project
	if (!canonicalStray.startsWith(canonicalRoot + path.sep)) {
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
