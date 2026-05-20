import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { type PluginConfig, PluginConfigSchema } from './schema';

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
			console.warn(
				`[opencode-swarm] Config file too large (max 100 KB): ${configPath}`,
			);
			console.warn(
				'[opencode-swarm] ⚠️ SECURITY: Config file exceeds size limit. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}

		const content = fs.readFileSync(configPath, 'utf-8');
		// TOCTOU guard: re-check size after read (file may have grown between statSync and readFileSync)
		if (content.length > MAX_CONFIG_FILE_BYTES) {
			console.warn(
				`[opencode-swarm] Config file too large after read (max 100 KB): ${configPath}`,
			);
			console.warn(
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
			console.warn(
				`[opencode-swarm] Invalid config at ${configPath}: expected an object`,
			);
			console.warn(
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
			console.warn(
				`[opencode-swarm] ⚠️ CONFIG LOAD FAILURE — config exists at ${configPath} but could not be loaded: ${errorMessage}`,
			);
			console.warn(
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
			console.warn(
				'[opencode-swarm] Migrated v6.12 presets config to agents format. Consider updating your opencode-swarm.json.',
			);
			return migrated;
		}
	}
	return raw;
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

	// Migrate v6.12 presets format to v6.13+ agents format
	mergedRaw = migratePresetsConfig(mergedRaw);

	// Validate merged config with Zod (applies defaults ONCE).
	// Nested optional schemas (e.g. council.general) surface automatically
	// here because the parser recursively resolves the full schema tree;
	// no destructuring of unknown keys occurs.
	const result = PluginConfigSchema.safeParse(mergedRaw);
	if (!result.success) {
		// If merged config fails validation, try user config alone
		// (project config may have invalid values that should be ignored)
		if (rawUserConfig) {
			const userParseResult = PluginConfigSchema.safeParse(rawUserConfig);
			if (userParseResult.success) {
				console.warn(
					'[opencode-swarm] Project config ignored due to validation errors. Using user config.',
				);
				return userParseResult.data;
			}
		}
		// Neither merged nor user config is valid, return defaults with guardrails ENABLED (fail-secure)
		console.warn('[opencode-swarm] Merged config validation failed:');
		console.warn(result.error.format());
		console.warn(
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
	const config = loadPluginConfig(directory);
	return { config, loadedFromFile };
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
			console.warn(
				`[opencode-swarm] Config file too large (max 100 KB): ${configPath}`,
			);
			console.warn(
				'[opencode-swarm] ⚠️ SECURITY: Config file exceeds size limit. Falling back to safe defaults with guardrails ENABLED.',
			);
			return { config: null, fileExisted: true, hadError: true };
		}
		const content = await fsPromises.readFile(configPath, 'utf-8');
		if (content.length > MAX_CONFIG_FILE_BYTES) {
			console.warn(
				`[opencode-swarm] Config file too large after read (max 100 KB): ${configPath}`,
			);
			console.warn(
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
			console.warn(
				`[opencode-swarm] Invalid config at ${configPath}: expected an object`,
			);
			console.warn(
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
		console.warn(
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
	const result = PluginConfigSchema.safeParse(mergedRaw);
	if (!result.success) {
		if (rawUserConfig) {
			const userParseResult = PluginConfigSchema.safeParse(rawUserConfig);
			if (userParseResult.success) {
				console.warn(
					'[opencode-swarm] Project config ignored due to validation errors. Using user config.',
				);
				return userParseResult.data;
			}
		}
		console.warn('[opencode-swarm] Merged config validation failed:');
		console.warn(result.error.format());
		console.warn(
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
	return { config, loadedFromFile };
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
			console.warn(
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
			console.warn(
				`[opencode-swarm] Error reading append prompt ${appendPromptPath}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	return result;
}
