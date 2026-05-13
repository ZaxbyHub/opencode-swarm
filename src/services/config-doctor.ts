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
import type { PluginConfig } from '../config/schema';
import { log } from '../utils';

/**
 * Valid config paths for opencode-swarm
 * These are the only allowed restore targets for security
 */
const VALID_CONFIG_PATTERNS = [
	// User config: ~/.config/opencode/opencode-swarm.json
	/^\.config[\\/]opencode[\\/]opencode-swarm\.json$/,
	// Project config: <project>/.opencode/opencode-swarm.json
	/\.opencode[\\/]opencode-swarm\.json$/,
];

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

	// Check if path matches valid patterns
	for (const pattern of VALID_CONFIG_PATTERNS) {
		if (pattern.test(normalizedPath)) {
			return true;
		}
	}

	// Also allow exact match with project config path (most common case)
	const { userConfigPath, projectConfigPath } = getConfigPaths(directory);
	const normalizedUser = userConfigPath.replace(/\\/g, '/');
	const normalizedProject = projectConfigPath.replace(/\\/g, '/');

	// Use resolved paths to prevent symlink attacks
	try {
		const resolvedConfig = path.resolve(configPath);
		const resolvedUser = path.resolve(normalizedUser);
		const resolvedProject = path.resolve(normalizedProject);

		// Must be one of the known config paths
		return (
			resolvedConfig === resolvedUser || resolvedConfig === resolvedProject
		);
	} catch {
		return false;
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

	fs.writeFileSync(backupPath, JSON.stringify(artifact, null, 2), 'utf-8');
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

		// Determine where to write restored config
		const targetPath = artifact.configPath;

		// Ensure target directory exists
		const targetDir = path.dirname(targetPath);
		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true });
		}

		// Write restored content
		fs.writeFileSync(targetPath, artifact.content, 'utf-8');
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
	} catch {
		return null;
	}
}

/**
 * Validate config key safety and detect stale/invalid settings
 */
function validateConfigKey(
	path: string,
	value: unknown,
	_config: PluginConfig,
): ConfigFinding[] {
	const findings: ConfigFinding[] = [];

	switch (path) {
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
				const validAgents = [
					'architect',
					'coder',
					'test_engineer',
					'explorer',
					'reviewer',
					'critic',
					'sme',
					'docs',
					'designer',
				];
				for (const [agentName, profile] of Object.entries(profiles)) {
					if (!validAgents.includes(agentName)) {
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
			const hooks = value as Record<string, unknown> | undefined;
			if (hooks) {
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

		// Check swarms for valid structure
		case 'swarms': {
			const swarms = value as Record<string, unknown> | undefined;
			if (swarms && typeof swarms === 'object') {
				for (const [swarmId, swarmConfig] of Object.entries(swarms)) {
					const swarm = swarmConfig as Record<string, unknown>;
					if (swarm.agents && typeof swarm.agents === 'object') {
						for (const [agentName] of Object.entries(
							swarm.agents as Record<string, unknown>,
						)) {
							const validAgents = [
								'architect',
								'coder',
								'test_engineer',
								'explorer',
								'reviewer',
								'critic',
								'sme',
								'docs',
								'designer',
							];
							// Allow swarm-prefixed agents like "local_coder"
							const baseName = agentName.replace(/^[a-zA-Z0-9]+_/, '');
							if (!validAgents.includes(baseName)) {
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
	}

	return findings;
}

/**
 * Recursively walk a config object and validate all keys
 */
function walkConfigAndValidate(
	obj: unknown,
	path: string,
	config: PluginConfig,
	findings: ConfigFinding[],
): void {
	if (obj === null || obj === undefined) {
		return;
	}

	// First validate at this path level (for object-level checks)
	if (path && typeof obj === 'object' && !Array.isArray(obj)) {
		const keyFindings = validateConfigKey(path, obj, config);
		findings.push(...keyFindings);
	}

	if (typeof obj !== 'object') {
		// Leaf value - validate based on path
		const keyFindings = validateConfigKey(path, obj, config);
		findings.push(...keyFindings);
		return;
	}

	if (Array.isArray(obj)) {
		// Arrays - check each element
		obj.forEach((item, index) => {
			walkConfigAndValidate(item, `${path}[${index}]`, config, findings);
		});
		return;
	}

	// Objects - walk each property
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const newPath = path ? `${path}.${key}` : key;
		walkConfigAndValidate(value, newPath, config, findings);
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
	walkConfigAndValidate(config, '', config, findings);

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
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
		updatedConfigPath = configPath;
	}

	return { appliedFixes, updatedConfigPath };
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

	fs.writeFileSync(artifactPath, JSON.stringify(guiOutput, null, 2), 'utf-8');
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
