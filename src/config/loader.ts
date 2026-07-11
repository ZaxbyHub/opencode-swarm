import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { advisoryWarn } from '../services/warning-buffer.js';
import {
	ExternalSkillsConfigSchema,
	GATE_CONFIG_KNOWN_SECTION_KEYS,
	GateConfigSchema,
	type PluginConfig,
	PluginConfigSchema,
	resolveExternalSkillsConfig,
} from './schema';

const CONFIG_FILENAME = 'opencode-swarm.json';
const PROMPTS_DIR_NAME = 'opencode-swarm';

export const MAX_CONFIG_FILE_BYTES = 102_400;

/**
 * Get the user's configuration directory (XDG Base Directory spec).
 */
function getUserConfigDir(): string {
	return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/**
 * Load raw config JSON from a file path without Zod validation.
 * Returns the raw JSON object for pre-validation merging.
 * Also returns whether the file existed (vs. not existing at all).
 */
function loadRawConfigFromPath(configPath: string): {
	config: Record<string, unknown> | null;
	fileExisted: boolean;
	hadError: boolean;
} {
	try {
		const stats = fs.statSync(configPath);
		if (stats.size > MAX_CONFIG_FILE_BYTES) {
			advisoryWarn(
				`[opencode-swarm] Config file too large (max 100 KB): ${configPath}`,
			);
			advisoryWarn(
				'[opencode-swarm] ⚠️ SECURITY: Config file exceeds size limit. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}

		const content = fs.readFileSync(configPath, 'utf-8');
		// TOCTOU guard: re-check size after read (file may have grown between statSync and readFileSync)
		if (content.length > MAX_CONFIG_FILE_BYTES) {
			advisoryWarn(
				`[opencode-swarm] Config file too large after read (max 100 KB): ${configPath}`,
			);
			advisoryWarn(
				'[opencode-swarm] ⚠️ SECURITY: Config file exceeds size limit. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}

		// SECURITY: Strip UTF-8 BOM from file content
		// BOM is a common marker that should be normalized, but must be at start of file
		let sanitizedContent = content;
		if (content.charCodeAt(0) === 0xfeff) {
			sanitizedContent = content.slice(1);
		}
		const rawConfig = JSON.parse(sanitizedContent);

		if (
			typeof rawConfig !== 'object' ||
			rawConfig === null ||
			Array.isArray(rawConfig)
		) {
			advisoryWarn(
				`[opencode-swarm] Invalid config at ${configPath}: expected an object`,
			);
			advisoryWarn(
				'[opencode-swarm] ⚠️ SECURITY: Config format invalid. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}

		return {
			config: rawConfig as Record<string, unknown>,
			fileExisted: true,
			hadError: false,
		};
	} catch (error) {
		// Check if this is a file-not-found error (ENOENT)
		const isFileNotFoundError =
			error instanceof Error &&
			'code' in error &&
			(error as NodeJS.ErrnoException).code === 'ENOENT';

		if (!isFileNotFoundError) {
			// Any other error (JSON parse error, permission denied, etc.) - treat as load failure
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			advisoryWarn(
				`[opencode-swarm] ⚠️ CONFIG LOAD FAILURE — config exists at ${configPath} but could not be loaded: ${errorMessage}`,
			);
			advisoryWarn(
				'[opencode-swarm] ⚠️ SECURITY: Config load failed. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}
		// File doesn't exist - not an error, just no config
		return { config: null, fileExisted: false, hadError: false };
	}
}

import { deepMerge as deepMergeFn } from '../utils/merge';

// Re-export deepMerge and MAX_MERGE_DEPTH from src/utils/merge for backward compatibility.
// Tests and src/config/constants.ts import these from loader.ts directly.
export { deepMerge, MAX_MERGE_DEPTH } from '../utils/merge';

/**
 * Migrate v6.12 presets-format config to v6.13+ agents format.
 * v6.12 install() generated: { preset: 'remote', presets: { remote: { architect: {...} } } }
 * v6.13+ expects:            { agents: { architect: {...} } }
 */
function migratePresetsConfig(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	if (raw.presets && typeof raw.presets === 'object' && !raw.agents) {
		const presetName = (raw.preset as string) || 'remote';
		const presets = raw.presets as Record<string, unknown>;
		const activePreset = presets[presetName] || Object.values(presets)[0];

		if (activePreset && typeof activePreset === 'object') {
			const migrated = { ...raw, agents: activePreset } as Record<
				string,
				unknown
			>;
			delete migrated.preset;
			delete migrated.presets;
			delete migrated.swarm_mode;
			advisoryWarn(
				'[opencode-swarm] Migrated v6.12 presets config to agents format. Consider updating your opencode-swarm.json.',
			);
			return migrated;
		}
	}
	return raw;
}

/**
 * Preprocess the external_skills section of raw config.
 * If the section is present but invalid, warn and strip it so the rest
 * of the config loads cleanly (AGENTS.md #1 fail-open).
 */
function sanitizeExternalSkillsConfig(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	if (!('external_skills' in raw) || raw.external_skills === undefined) {
		return raw;
	}
	const esResult = ExternalSkillsConfigSchema.safeParse(raw.external_skills);
	if (esResult.success) {
		return {
			...raw,
			external_skills: resolveExternalSkillsConfig(esResult.data),
		};
	}
	advisoryWarn(
		'[opencode-swarm] external_skills config validation failed:',
		esResult.error.format(),
	);
	advisoryWarn(
		'[opencode-swarm] External skills curation disabled due to invalid config. Fix the external_skills section to enable it.',
	);
	const cleaned = { ...raw };
	delete cleaned.external_skills;
	return cleaned;
}

function sanitizeGatesConfig(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	if (!('gates' in raw) || raw.gates === undefined) {
		return raw;
	}
	if (
		typeof raw.gates !== 'object' ||
		raw.gates === null ||
		Array.isArray(raw.gates)
	) {
		advisoryWarn(
			'[opencode-swarm] gates config validation failed: expected an object. Quality gates will use defaults; other config sections remain active.',
		);
		const cleaned = { ...raw };
		delete cleaned.gates;
		return cleaned;
	}

	const gateSchemas = GateConfigSchema.shape;
	const cleanedGates = { ...(raw.gates as Record<string, unknown>) };
	for (const [key, value] of Object.entries(cleanedGates)) {
		const schema = gateSchemas[key as keyof typeof gateSchemas];
		if (!schema) {
			advisoryWarn(
				`[opencode-swarm] Unknown gates config section "gates.${key}" ignored. Other config sections remain active.`,
			);
			delete cleanedGates[key];
			continue;
		}
		const knownFields =
			GATE_CONFIG_KNOWN_SECTION_KEYS[
				key as keyof typeof GATE_CONFIG_KNOWN_SECTION_KEYS
			];
		let sectionValue = value;
		if (
			knownFields &&
			typeof value === 'object' &&
			value !== null &&
			!Array.isArray(value)
		) {
			const cleanedSection = { ...(value as Record<string, unknown>) };
			const knownFieldSet = new Set<string>(knownFields);
			for (const fieldName of Object.keys(cleanedSection)) {
				if (!knownFieldSet.has(fieldName)) {
					advisoryWarn(
						`[opencode-swarm] Unknown gates config key "gates.${key}.${fieldName}" ignored. Other config sections remain active.`,
					);
					delete cleanedSection[fieldName];
				}
			}
			sectionValue = cleanedSection;
			cleanedGates[key] = cleanedSection;
		}
		const sectionResult = schema.safeParse(sectionValue);
		if (!sectionResult.success) {
			advisoryWarn(
				`[opencode-swarm] gates.${key} config validation failed; that gate section will use defaults and other config sections remain active:`,
				sectionResult.error.format(),
			);
			delete cleanedGates[key];
		}
	}

	const gatesResult = GateConfigSchema.safeParse(cleanedGates);
	if (gatesResult.success) {
		return {
			...raw,
			gates: gatesResult.data,
		};
	}

	advisoryWarn(
		'[opencode-swarm] gates config validation failed after section cleanup; quality gates will use defaults and other config sections remain active:',
		gatesResult.error.format(),
	);
	const cleaned = { ...raw };
	delete cleaned.gates;
	return cleaned;
}

function sanitizeSectionConfigs(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	return sanitizeGatesConfig(sanitizeExternalSkillsConfig(raw));
}

/**
 * Load plugin configuration from user and project config files.
 *
 * Config locations:
 * 1. User config: ~/.config/opencode/opencode-swarm.json
 * 2. Project config: <directory>/.opencode/opencode-swarm.json
 *
 * Project config takes precedence. Nested objects are deep-merged.
 * IMPORTANT: Raw configs are merged BEFORE Zod parsing so that
 * Zod defaults don't override explicit user values.
 */
/** True when a raw (pre-Zod) config object sets `full_auto.locked: true`. */
function rawFullAutoLocked(raw: Record<string, unknown> | null): boolean {
	if (!raw || typeof raw !== 'object') return false;
	const fullAuto = raw.full_auto;
	if (!fullAuto || typeof fullAuto !== 'object' || Array.isArray(fullAuto)) {
		return false;
	}
	return (fullAuto as Record<string, unknown>).locked === true;
}

export function loadPluginConfig(directory: string): PluginConfig {
	const userConfigPath = path.join(
		getUserConfigDir(),
		'opencode',
		CONFIG_FILENAME,
	);

	const projectConfigPath = path.join(directory, '.opencode', CONFIG_FILENAME);

	// Load raw configs (no Zod defaults applied yet)
	const userResult = loadRawConfigFromPath(userConfigPath);
	const projectResult = loadRawConfigFromPath(projectConfigPath);

	const rawUserConfig = userResult.config;
	const rawProjectConfig = projectResult.config;

	// Track whether any config files existed AND whether there were load errors
	// Use fileExisted to track if files existed (regardless of whether they loaded successfully)
	const loadedFromFile = userResult.fileExisted || projectResult.fileExisted;
	const configHadErrors = userResult.hadError || projectResult.hadError;

	// Deep-merge raw objects before Zod parsing so that
	// Zod defaults don't override explicit user values
	let mergedRaw: Record<string, unknown> = rawUserConfig ?? {};
	if (rawProjectConfig) {
		mergedRaw = deepMergeFn(mergedRaw, rawProjectConfig) as Record<
			string,
			unknown
		>;
	}

	// `full_auto.locked` is an administrative hard-off and must OR across
	// config levels: a project-level `locked: false` must NOT override a
	// user-level `locked: true` (deep-merge alone would let a repo-controlled
	// .opencode/opencode-swarm.json defeat the user's lock).
	if (rawFullAutoLocked(rawUserConfig) || rawFullAutoLocked(rawProjectConfig)) {
		const fullAutoRaw =
			mergedRaw.full_auto &&
			typeof mergedRaw.full_auto === 'object' &&
			!Array.isArray(mergedRaw.full_auto)
				? (mergedRaw.full_auto as Record<string, unknown>)
				: {};
		mergedRaw = {
			...mergedRaw,
			full_auto: { ...fullAutoRaw, locked: true },
		};
	}

	// Migrate v6.12 presets format to v6.13+ agents format
	mergedRaw = migratePresetsConfig(mergedRaw);

	// Pre-validate section-local configs so one invalid section doesn't block plugin load.
	mergedRaw = sanitizeSectionConfigs(mergedRaw);

	// Validate merged config with Zod (applies defaults ONCE).
	// Nested optional schemas (e.g. council.general) surface automatically
	// here because the parser recursively resolves the full schema tree;
	// no destructuring of unknown keys occurs.
	const result = PluginConfigSchema.safeParse(mergedRaw);
	if (!result.success) {
		// If merged config fails validation, try user config alone
		// (project config may have invalid values that should be ignored)
		if (rawUserConfig) {
			const userParseResult = PluginConfigSchema.safeParse(
				sanitizeSectionConfigs(rawUserConfig ?? {}),
			);
			if (userParseResult.success) {
				advisoryWarn(
					'[opencode-swarm] Project config ignored due to validation errors. Using user config.',
				);
				return userParseResult.data;
			}
		}
		// Neither merged nor user config is valid, return defaults with guardrails ENABLED (fail-secure)
		advisoryWarn(
			'[opencode-swarm] Merged config validation failed:',
			result.error.format(),
		);
		advisoryWarn(
			'[opencode-swarm] ⚠️ SECURITY: Falling back to conservative defaults with guardrails ENABLED. Fix the config file to restore custom configuration.',
		);
		// Fail-secure: return defaults with guardrails explicitly enabled
		return PluginConfigSchema.parse({
			guardrails: { enabled: true },
		});
	}

	// If config files existed but had load errors, apply fail-secure defaults
	if (loadedFromFile && configHadErrors) {
		// Merge the valid parts with fail-secure guardrails
		return PluginConfigSchema.parse({
			...mergedRaw,
			guardrails: { enabled: true },
		});
	}

	return result.data;
}

/**
 * Internal variant of loadPluginConfig that also returns loader metadata.
 * Used only by src/index.ts to determine guardrails fallback behavior.
 * NOT part of the public API — use loadPluginConfig() for all other callers.
 */
export function loadPluginConfigWithMeta(directory: string): {
	config: PluginConfig;
	loadedFromFile: boolean;
	/** True when a config file existed but could not be loaded (corrupt JSON,
	 *  oversized, permission error). Consumers with fail-closed semantics —
	 *  e.g. the Full-Auto `locked` activation guard — must treat this as
	 *  "config unknown", not "config defaults". */
	configHadErrors: boolean;
} {
	const userConfigPath = path.join(
		getUserConfigDir(),
		'opencode',
		CONFIG_FILENAME,
	);
	const projectConfigPath = path.join(directory, '.opencode', CONFIG_FILENAME);
	const userResult = loadRawConfigFromPath(userConfigPath);
	const projectResult = loadRawConfigFromPath(projectConfigPath);
	// Use fileExisted to track if files existed (regardless of load success)
	const loadedFromFile = userResult.fileExisted || projectResult.fileExisted;
	const configHadErrors = userResult.hadError || projectResult.hadError;
	const config = loadPluginConfig(directory);
	return { config, loadedFromFile, configHadErrors };
}

/**
 * Async variant of `loadRawConfigFromPath` — same shape, same validation,
 * but uses `node:fs/promises`. Issue #704: the plugin init path must avoid
 * synchronous fs calls so a slow filesystem (network home, iCloud) cannot
 * pin the event loop while the plugin host awaits `server(input, options)`.
 */
async function loadRawConfigFromPathAsync(configPath: string): Promise<{
	config: Record<string, unknown> | null;
	fileExisted: boolean;
	hadError: boolean;
}> {
	try {
		const stats = await fsPromises.stat(configPath);
		if (stats.size > MAX_CONFIG_FILE_BYTES) {
			advisoryWarn(
				`[opencode-swarm] Config file too large (max 100 KB): ${configPath}`,
			);
			advisoryWarn(
				'[opencode-swarm] ⚠️ SECURITY: Config file exceeds size limit. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}
		const content = await fsPromises.readFile(configPath, 'utf-8');
		if (content.length > MAX_CONFIG_FILE_BYTES) {
			advisoryWarn(
				`[opencode-swarm] Config file too large after read (max 100 KB): ${configPath}`,
			);
			advisoryWarn(
				'[opencode-swarm] ⚠️ SECURITY: Config file exceeds size limit. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}
		let sanitizedContent = content;
		if (content.charCodeAt(0) === 0xfeff) {
			sanitizedContent = content.slice(1);
		}
		const rawConfig = JSON.parse(sanitizedContent);
		if (
			typeof rawConfig !== 'object' ||
			rawConfig === null ||
			Array.isArray(rawConfig)
		) {
			advisoryWarn(
				`[opencode-swarm] Invalid config at ${configPath}: expected an object`,
			);
			advisoryWarn(
				'[opencode-swarm] ⚠️ SECURITY: Config format invalid. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}
		return {
			config: rawConfig as Record<string, unknown>,
			fileExisted: true,
			hadError: false,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			return { config: null, fileExisted: false, hadError: false };
		}
		advisoryWarn(
			`[opencode-swarm] Failed to load config from ${configPath}:`,
			error instanceof Error ? error.message : String(error),
		);
		return { config: null, fileExisted: true, hadError: true };
	}
}

function reduceParsedConfig(
	rawUserConfig: Record<string, unknown> | null,
	rawProjectConfig: Record<string, unknown> | null,
	loadedFromFile: boolean,
	configHadErrors: boolean,
): PluginConfig {
	let mergedRaw: Record<string, unknown> = rawUserConfig ?? {};
	if (rawProjectConfig) {
		mergedRaw = deepMergeFn(mergedRaw, rawProjectConfig) as Record<
			string,
			unknown
		>;
	}
	mergedRaw = migratePresetsConfig(mergedRaw);
	mergedRaw = sanitizeSectionConfigs(mergedRaw);
	const result = PluginConfigSchema.safeParse(mergedRaw);
	if (!result.success) {
		if (rawUserConfig) {
			const userParseResult = PluginConfigSchema.safeParse(
				sanitizeSectionConfigs(rawUserConfig ?? {}),
			);
			if (userParseResult.success) {
				advisoryWarn(
					'[opencode-swarm] Project config ignored due to validation errors. Using user config.',
				);
				return userParseResult.data;
			}
		}
		advisoryWarn(
			'[opencode-swarm] Merged config validation failed:',
			result.error.format(),
		);
		advisoryWarn(
			'[opencode-swarm] ⚠️ SECURITY: Falling back to conservative defaults with guardrails ENABLED. Fix the config file to restore custom configuration.',
		);
		return PluginConfigSchema.parse({ guardrails: { enabled: true } });
	}
	if (loadedFromFile && configHadErrors) {
		return PluginConfigSchema.parse({
			...mergedRaw,
			guardrails: { enabled: true },
		});
	}
	return result.data;
}

/**
 * Async variant of `loadPluginConfigWithMeta`. Used by the plugin entry
 * (issue #704) so initialization does not perform synchronous fs reads.
 */
export async function loadPluginConfigWithMetaAsync(
	directory: string,
): Promise<{
	config: PluginConfig;
	loadedFromFile: boolean;
	configHadErrors: boolean;
}> {
	const userConfigPath = path.join(
		getUserConfigDir(),
		'opencode',
		CONFIG_FILENAME,
	);
	const projectConfigPath = path.join(directory, '.opencode', CONFIG_FILENAME);
	const [userResult, projectResult] = await Promise.all([
		loadRawConfigFromPathAsync(userConfigPath),
		loadRawConfigFromPathAsync(projectConfigPath),
	]);
	const loadedFromFile = userResult.fileExisted || projectResult.fileExisted;
	const configHadErrors = userResult.hadError || projectResult.hadError;
	const config = reduceParsedConfig(
		userResult.config,
		projectResult.config,
		loadedFromFile,
		configHadErrors,
	);
	return { config, loadedFromFile, configHadErrors };
}

/**
 * Load custom prompt for an agent from the prompts directory.
 * Checks for {agent}.md (replaces default) and {agent}_append.md (appends).
 */
export function loadAgentPrompt(agentName: string): {
	prompt?: string;
	appendPrompt?: string;
} {
	const promptsDir = path.join(
		getUserConfigDir(),
		'opencode',
		PROMPTS_DIR_NAME,
	);
	const result: { prompt?: string; appendPrompt?: string } = {};

	// Check for replacement prompt
	const promptPath = path.join(promptsDir, `${agentName}.md`);
	if (fs.existsSync(promptPath)) {
		try {
			result.prompt = fs.readFileSync(promptPath, 'utf-8');
		} catch (error) {
			advisoryWarn(
				`[opencode-swarm] Error reading prompt file ${promptPath}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	// Check for append prompt
	const appendPromptPath = path.join(promptsDir, `${agentName}_append.md`);
	if (fs.existsSync(appendPromptPath)) {
		try {
			result.appendPrompt = fs.readFileSync(appendPromptPath, 'utf-8');
		} catch (error) {
			advisoryWarn(
				`[opencode-swarm] Error reading append prompt ${appendPromptPath}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	return result;
}
