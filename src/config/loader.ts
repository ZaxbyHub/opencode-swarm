import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { z } from 'zod';
import { advisoryWarn } from '../services/warning-buffer.js';
import { sanitizeMalformedValues } from './sanitize-malformed-values';
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
function sanitizeExternalSkillsConfig(raw: Record<string, unknown>): {
	result: Record<string, unknown>;
	strippedKeys: string[];
} {
	if (!('external_skills' in raw) || raw.external_skills === undefined) {
		return { result: raw, strippedKeys: [] };
	}
	const esResult = ExternalSkillsConfigSchema.safeParse(raw.external_skills);
	if (esResult.success) {
		return {
			result: {
				...raw,
				external_skills: resolveExternalSkillsConfig(esResult.data),
			},
			strippedKeys: [],
		};
	}
	advisoryWarn(
		'[opencode-swarm] external_skills config validation failed:',
		formatZodIssues(esResult.error),
	);
	advisoryWarn(
		'[opencode-swarm] External skills curation disabled due to invalid config. Fix the external_skills section to enable it.',
	);
	const cleaned = { ...raw };
	delete cleaned.external_skills;
	return { result: cleaned, strippedKeys: ['external_skills'] };
}

function sanitizeGatesConfig(raw: Record<string, unknown>): {
	result: Record<string, unknown>;
	strippedKeys: string[];
} {
	const strippedKeys: string[] = [];
	if (!('gates' in raw) || raw.gates === undefined) {
		return { result: raw, strippedKeys };
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
		strippedKeys.push('gates');
		return { result: cleaned, strippedKeys };
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
			strippedKeys.push(`gates.${key}`);
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
					strippedKeys.push(`gates.${key}.${fieldName}`);
				}
			}
			sectionValue = cleanedSection;
			cleanedGates[key] = cleanedSection;
		}
		const sectionResult = schema.safeParse(sectionValue);
		if (!sectionResult.success) {
			advisoryWarn(
				`[opencode-swarm] gates.${key} config validation failed; that gate section will use defaults and other config sections remain active:`,
				formatZodIssues(sectionResult.error),
			);
			delete cleanedGates[key];
			if (!strippedKeys.includes(`gates.${key}`)) {
				strippedKeys.push(`gates.${key}`);
			}
		}
	}

	const gatesResult = GateConfigSchema.safeParse(cleanedGates);
	if (gatesResult.success) {
		return {
			result: { ...raw, gates: gatesResult.data },
			strippedKeys,
		};
	}

	advisoryWarn(
		'[opencode-swarm] gates config validation failed after section cleanup; quality gates will use defaults and other config sections remain active:',
		formatZodIssues(gatesResult.error),
	);
	const cleaned = { ...raw };
	delete cleaned.gates;
	if (!strippedKeys.includes('gates')) {
		strippedKeys.push('gates');
	}
	return { result: cleaned, strippedKeys };
}

function sanitizeSectionConfigs(raw: Record<string, unknown>): {
	result: Record<string, unknown>;
	strippedKeys: string[];
} {
	const { result: afterExternal, strippedKeys: externalStripped } =
		sanitizeExternalSkillsConfig(raw);
	const { result, strippedKeys: gatesStripped } =
		sanitizeGatesConfig(afterExternal);
	return { result, strippedKeys: [...externalStripped, ...gatesStripped] };
}

/**
 * Flatten a ZodError into a compact, single-line, human-readable summary that
 * names each failing config path and why it failed, e.g.
 *   "agents.architect.fallback_models: Too big: expected array to have <=3 items"
 *
 * Surfaced to operators via `advisoryWarn` → `/swarm diagnose` so a config
 * validation failure tells the user exactly what to fix, instead of the bare
 * `"... validation failed:"` line they used to see (issue #1886). Replaces
 * `error.format()` (a nested object that `advisoryWarn` dropped from the
 * operator-visible buffer). It emits issue paths and messages only — never a
 * raw dump of the user's config values.
 */
export function formatZodIssues(error: z.ZodError): string {
	if (error.issues.length === 0) return '';
	return error.issues
		.map((issue) => {
			// Guard the JOINED path, not the raw array: an empty `path` array is
			// truthy in JS, so a top-level issue must fall through to message-only.
			const dotted = issue.path.map(String).join('.');
			return dotted ? `${dotted}: ${issue.message}` : issue.message;
		})
		.join('; ');
}

/**
 * Surgically remove the exact keys Zod reported as `unrecognized_keys` from a
 * clone of `raw`, returning the cleaned config and a list of dotted key paths
 * removed. Only keys Zod *confirmed* invalid for a `.strict()` section are
 * removed — `z.record(...)` fields (agents, swarms, presets, env_overrides, …)
 * never produce `unrecognized_keys`, so their arbitrary user keys are never
 * touched. This is the safe alternative to whole-config-wipe or blanket
 * key-stripping (issue #1778 H6, generalizing the #1690/#1732 gates-only fix to
 * every strict section: council, checkpoint, pr_monitor, turbo.epic, …).
 */
function stripUnrecognizedKeys(
	raw: Record<string, unknown>,
	error: z.ZodError,
): { cleaned: Record<string, unknown>; removed: string[] } {
	const removed: string[] = [];
	// Structured clone so we never mutate the caller's object.
	const cleaned = structuredClone(raw);
	for (const issue of error.issues) {
		if (issue.code !== 'unrecognized_keys') continue;
		const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
		// Walk to the object named by issue.path.
		let node: unknown = cleaned;
		for (const seg of issue.path) {
			if (node && typeof node === 'object') {
				node = (node as Record<string | number, unknown>)[
					seg as string | number
				];
			} else {
				node = undefined;
				break;
			}
		}
		if (!node || typeof node !== 'object') continue;
		for (const key of keys) {
			if (key in (node as Record<string, unknown>)) {
				delete (node as Record<string, unknown>)[key];
				const dotted = [...issue.path.map(String), key].join('.');
				removed.push(dotted);
			}
		}
	}
	return { cleaned, removed };
}

/**
 * Recovery classification returned by `buildConfigWithMeta`.
 *
 *   'none'               – config parsed cleanly, no keys removed.
 *   'stripped_keys'      – pre-Zod section sanitization (gates, external_skills)
 *                          and/or Zod-targeted key removal dropped some keys;
 *                          the remaining configuration was preserved.
 *   'user_only'          – project config was discarded (failed validation and
 *                          targeted recovery); user config alone was used.
 *   'sanitized_values'   – merged and user configs both failed, but recursive
 *                          malformed-value recovery (step 7b, issue #1690)
 *                          dropped the smallest invalid leaves/sections so the
 *                          remaining valid configuration could load.
 *   'guardrails_defaults'– neither merged nor user config was recoverable;
 *                          fell back to fail-secure guardrails-only defaults.
 */
export type ConfigRecovery =
	| 'none'
	| 'stripped_keys'
	| 'user_only'
	| 'sanitized_values'
	| 'guardrails_defaults';

/** Full result from the shared config-build core. */
export type ConfigBuildResult = {
	config: PluginConfig;
	recovery: ConfigRecovery;
	/** Dotted key paths that were removed during recovery (gates, Zod strict, etc.). */
	removedKeys: string[];
	/** Human-readable summary messages about the recovery action. */
	warnings: string[];
};

/**
 * Full result from `loadPluginConfigWithMeta` and `loadPluginConfigWithMetaAsync`.
 * Extends `ConfigBuildResult` with I/O-layer fields about whether a config
 * file was found and whether it could be read.
 */
export type ConfigLoadResult = ConfigBuildResult & {
	/** True when at least one config file (user or project) existed on disk. */
	loadedFromFile: boolean;
	/** True when a config file existed but could not be loaded (corrupt JSON,
	 *  oversized, permission error). Consumers with fail-closed semantics —
	 *  e.g. the Full-Auto `locked` activation guard — must treat this as
	 *  "config unknown", not "config defaults". */
	configHadErrors: boolean;
};

/** True when a raw (pre-Zod) config object sets `full_auto.locked: true`. */
function rawFullAutoLocked(raw: Record<string, unknown> | null): boolean {
	if (!raw || typeof raw !== 'object') return false;
	const fullAuto = raw.full_auto;
	if (!fullAuto || typeof fullAuto !== 'object' || Array.isArray(fullAuto)) {
		return false;
	}
	return (fullAuto as Record<string, unknown>).locked === true;
}

/**
 * Single shared core: merges, migrates, sanitizes, and parses raw user +
 * project configs, applying `full_auto.locked` OR-semantics and fail-secure
 * defaults.  All entry points (sync and async) call this function; only the
 * I/O layer (reading the files) differs between them.
 *
 * Recovery order:
 *   1. Deep-merge → locked-OR → migrate → sanitize → first Zod parse.
 *   2. On Zod failure: surgically drop only the confirmed unrecognized keys
 *      and re-parse (issue #1778 H6 — one typo must not wipe the whole config).
 *   3. If still invalid: retry user-config alone.
 *   4. Recursive malformed-value recovery (step 7b, issue #1690): drop the
 *      smallest invalid leaves/sections via the fixed-point sanitizer so a
 *      single wrong-type value does not wipe the rest. Skipped when the raw
 *      config explicitly sets `guardrails.enabled: false` (double-disable guard).
 *   5. Last resort: fail-secure guardrails-only defaults.
 *
 * Returns `ConfigBuildResult` so callers that need metadata (e.g.
 * `loadPluginConfigWithMeta[Async]`) have it without a second file-read.
 */
function buildConfigWithMeta(
	rawUserConfig: Record<string, unknown> | null,
	rawProjectConfig: Record<string, unknown> | null,
	loadedFromFile: boolean,
	configHadErrors: boolean,
): ConfigBuildResult {
	// 1. Deep-merge raw objects before Zod parsing so Zod defaults never
	//    override explicit user values.
	let mergedRaw: Record<string, unknown> = rawUserConfig ?? {};
	if (rawProjectConfig) {
		mergedRaw = deepMergeFn(mergedRaw, rawProjectConfig) as Record<
			string,
			unknown
		>;
	}

	// 2. `full_auto.locked` is an administrative hard-off: a project-level
	//    `locked: false` must NOT override a user-level `locked: true`.
	//    OR across both raw configs before merging so deep-merge cannot
	//    silently flip it back to false.
	//    rawFullAutoLocked(raw): returns true when raw?.full_auto?.locked === true.
	if (rawFullAutoLocked(rawUserConfig) || rawFullAutoLocked(rawProjectConfig)) {
		const fa =
			mergedRaw.full_auto &&
			typeof mergedRaw.full_auto === 'object' &&
			!Array.isArray(mergedRaw.full_auto)
				? (mergedRaw.full_auto as Record<string, unknown>)
				: {};
		mergedRaw = { ...mergedRaw, full_auto: { ...fa, locked: true } };
	}

	// 3. Migrate v6.12 presets format to v6.13+ agents format.
	mergedRaw = migratePresetsConfig(mergedRaw);

	// 4. Pre-validate section-local configs so one invalid section doesn't
	//    block plugin load.  Track which gates keys were stripped so we can
	//    report them in the recovery metadata (issue #1900 FR-3).
	const { result: sanitized, strippedKeys: gatesStripped } =
		sanitizeSectionConfigs(mergedRaw);
	mergedRaw = sanitized;

	// Fail-secure closure: when a config file existed but could not be loaded,
	// force guardrails ENABLED on any recovered config (issue #1778 H6 F2).
	const secure = (cfg: PluginConfig): PluginConfig =>
		loadedFromFile && configHadErrors
			? PluginConfigSchema.parse({
					...(cfg as Record<string, unknown>),
					guardrails: { enabled: true },
				})
			: cfg;

	// 5. First parse attempt.
	const firstResult = PluginConfigSchema.safeParse(mergedRaw);
	if (firstResult.success) {
		const config = secure(firstResult.data);
		if (loadedFromFile && configHadErrors) {
			advisoryWarn(
				'[opencode-swarm] ⚠️ SECURITY: Falling back to conservative defaults with guardrails ENABLED. Fix the config file to restore custom configuration.',
			);
			return {
				config,
				recovery: 'guardrails_defaults',
				removedKeys: [...gatesStripped],
				warnings: [],
			};
		}
		return {
			config,
			recovery: gatesStripped.length > 0 ? 'stripped_keys' : 'none',
			removedKeys: [...gatesStripped],
			warnings: [],
		};
	}

	// 6. Targeted recovery: drop only Zod-confirmed unrecognized keys and
	//    re-parse so a single typo does not discard the user's entire config.
	const { cleaned, removed } = stripUnrecognizedKeys(
		mergedRaw,
		firstResult.error,
	);
	if (removed.length > 0) {
		const recovered = PluginConfigSchema.safeParse(cleaned);
		if (recovered.success) {
			advisoryWarn(
				`[opencode-swarm] Ignored ${removed.length} unrecognized config key(s): ${removed.join(', ')}. The rest of your configuration was preserved. Fix or remove these keys.`,
			);
			return {
				config: secure(recovered.data),
				recovery: 'stripped_keys',
				removedKeys: [...gatesStripped, ...removed],
				warnings: [],
			};
		}
	}

	// 7. User-config-alone fallback: a broken project config should not defeat
	//    a valid user config.
	if (rawUserConfig) {
		const { result: userSanitized, strippedKeys: userGatesStripped } =
			sanitizeSectionConfigs(rawUserConfig);
		const userParseResult = PluginConfigSchema.safeParse(userSanitized);
		if (userParseResult.success) {
			advisoryWarn(
				'[opencode-swarm] Project config ignored due to validation errors. Using user config.',
			);
			return {
				config: secure(userParseResult.data),
				recovery: 'user_only',
				removedKeys: [...gatesStripped, ...userGatesStripped],
				warnings: [
					'Project config ignored due to validation errors; using user config.',
				],
			};
		}
		// Last targeted attempt: strip unrecognized keys from user config too.
		const userStripped = stripUnrecognizedKeys(
			userSanitized,
			userParseResult.error,
		);
		if (userStripped.removed.length > 0) {
			const userRecovered = PluginConfigSchema.safeParse(userStripped.cleaned);
			if (userRecovered.success) {
				advisoryWarn(
					`[opencode-swarm] Project config ignored; also ignored ${userStripped.removed.length} unrecognized user-config key(s): ${userStripped.removed.join(', ')}.`,
				);
				return {
					config: secure(userRecovered.data),
					recovery: 'user_only',
					removedKeys: [
						...gatesStripped,
						...userGatesStripped,
						...userStripped.removed,
					],
					warnings: [
						'Project config ignored due to validation errors; using user config.',
					],
				};
			}
		}
	}

	// 7b. Recursive malformed-value recovery (issue #1690): if user-config
	//     fallback also failed, the remaining failure is likely a malformed
	//     VALUE (wrong type). Drop the smallest recoverable unit (leaf field
	//     → parent section) so valid sections survive. This is the last
	//     targeted recovery before bare guardrails defaults.
	//
	//     SECURITY: skip recovery when the raw config explicitly sets
	//     guardrails.enabled: false. In that case, fall through to step 8
	//     (guardrails defaults) so the user's non-guardrails values are
	//     NOT preserved alongside a forced guardrails override — preventing
	//     the "Double-disable" attack vector (adversarial test v6.1.2 AV8).
	const rawGuardrailsDisabled =
		mergedRaw.guardrails &&
		typeof mergedRaw.guardrails === 'object' &&
		!Array.isArray(mergedRaw.guardrails) &&
		(mergedRaw.guardrails as Record<string, unknown>).enabled === false;

	if (!rawGuardrailsDisabled) {
		const valueRecovery = sanitizeMalformedValues(
			PluginConfigSchema,
			mergedRaw,
		);
		if (valueRecovery.recoveryWarnings.length > 0) {
			const recoveredParse = PluginConfigSchema.safeParse(valueRecovery.config);
			if (recoveredParse.success) {
				const removedKeys = [
					...gatesStripped,
					...valueRecovery.recoveryWarnings.map((w) => w.section),
				];
				// Force guardrails enabled on recovery — the user's config had
				// invalid values, so we apply the same fail-secure default as
				// step 8 (guardrails_defaults) to preserve the security posture.
				// Use safeParse (not parse) so a future schema refinement or an
				// edge-case merge artifact cannot throw and bypass step 8's
				// guardrails_defaults fallback (review PRR-009). On failure we
				// fall through to step 8 rather than throwing.
				const secureParse = PluginConfigSchema.safeParse({
					...(recoveredParse.data as Record<string, unknown>),
					guardrails: {
						...((recoveredParse.data as Record<string, unknown>).guardrails as
							| Record<string, unknown>
							| undefined),
						enabled: true,
					},
				});
				if (secureParse.success) {
					// Only announce recovery once it has actually succeeded —
					// otherwise the "rest of your configuration was preserved"
					// message would be misleading on the safeParse-failure path
					// that falls through to step 8 (which discards everything).
					advisoryWarn(
						`[opencode-swarm] Ignored ${removedKeys.length} invalid or unrecognized config key(s): ${removedKeys.join(', ')}. The rest of your configuration was preserved. Fix or remove these keys.`,
					);
					return {
						config: secure(secureParse.data),
						recovery: 'sanitized_values',
						removedKeys,
						warnings: [],
					};
				}
			}
		}
	} // end if (!rawGuardrailsDisabled)

	// 8. Guardrails defaults: nothing was recoverable.
	const offending = stripUnrecognizedKeys(mergedRaw, firstResult.error).removed;
	if (offending.length > 0) {
		advisoryWarn(
			`[opencode-swarm] Merged config validation failed. Unrecognized key(s): ${offending.join(', ')}.`,
		);
	} else {
		advisoryWarn(
			'[opencode-swarm] Merged config validation failed:',
			formatZodIssues(firstResult.error),
		);
	}
	advisoryWarn(
		'[opencode-swarm] ⚠️ SECURITY: Falling back to conservative defaults with guardrails ENABLED. Fix the config file to restore custom configuration.',
	);
	return {
		config: PluginConfigSchema.parse({ guardrails: { enabled: true } }),
		recovery: 'guardrails_defaults',
		removedKeys: [...gatesStripped],
		warnings: [
			'Config failed validation; using safe defaults with guardrails enabled.',
		],
	};
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
	const userResult = loadRawConfigFromPath(userConfigPath);
	const projectResult = loadRawConfigFromPath(projectConfigPath);
	const loadedFromFile = userResult.fileExisted || projectResult.fileExisted;
	const configHadErrors = userResult.hadError || projectResult.hadError;
	// Delegate all merge→locked-OR→migrate→sanitize→parse→fallback logic to
	// the shared core so this path can never diverge from the async path.
	return buildConfigWithMeta(
		userResult.config,
		projectResult.config,
		loadedFromFile,
		configHadErrors,
	).config;
}

/**
 * Variant of `loadPluginConfig` that also returns loader metadata, including
 * recovery classification, removed keys, and warning messages.  All callers
 * that need to surface config-health information (doctor, command-return) use
 * this function.  `buildConfigWithMeta` is the shared core — files are read
 * exactly once, no double-read.
 */
export function loadPluginConfigWithMeta(directory: string): ConfigLoadResult {
	const userConfigPath = path.join(
		getUserConfigDir(),
		'opencode',
		CONFIG_FILENAME,
	);
	const projectConfigPath = path.join(directory, '.opencode', CONFIG_FILENAME);
	const userResult = loadRawConfigFromPath(userConfigPath);
	const projectResult = loadRawConfigFromPath(projectConfigPath);
	const loadedFromFile = userResult.fileExisted || projectResult.fileExisted;
	const configHadErrors = userResult.hadError || projectResult.hadError;
	const { config, recovery, removedKeys, warnings } = buildConfigWithMeta(
		userResult.config,
		projectResult.config,
		loadedFromFile,
		configHadErrors,
	);
	return {
		config,
		loadedFromFile,
		configHadErrors,
		recovery,
		removedKeys,
		warnings,
	};
}

/**
 * Safe-default `ConfigLoadResult` for init-path timeout / error fallback.
 *
 * Produces the same shape `loadPluginConfigWithMeta[Async]` returns when no
 * config file exists on disk: empty config + guardrails enabled + no recovery.
 * Used by `src/index.ts` when the parallelized config read times out or fails
 * (Invariant 1 — init must remain bounded). A parity test in
 * `tests/unit/config/loader-safe-default.test.ts` asserts this matches the
 * classification fields the loader returns for a missing config file.
 *
 * Classification fields:
 *   - `loadedFromFile: false` — on timeout we cannot know whether a file
 *     existed (the `stat` itself may have stalled); `false` is the safe
 *     choice that avoids the guardrails-disabled warning gated by this
 *     flag at `src/index.ts` (the only init-path consumer).
 *   - `configHadErrors: false` — we did not observe a corrupt/oversized
 *     config, only a slow one; fail-closed consumers (e.g. the Full-Auto
 *     `locked` activation guard) treat this as "config defaults", which
 *     matches the runtime behavior of the safe-default `PluginConfig`.
 */
export function getSafeDefaultConfigLoadResult(): ConfigLoadResult {
	const { config, recovery, removedKeys, warnings } = buildConfigWithMeta(
		null,
		null,
		false,
		false,
	);
	return {
		config,
		recovery,
		removedKeys,
		warnings,
		loadedFromFile: false,
		configHadErrors: false,
	};
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

/**
 * Async variant of `loadPluginConfigWithMeta`. Used by the plugin entry
 * (issue #704) so initialization does not perform synchronous fs reads.
 * Calls the same `buildConfigWithMeta` shared core as the sync path — the
 * only difference is that file I/O uses `node:fs/promises` (issue #1900 FR-1).
 */
export async function loadPluginConfigWithMetaAsync(
	directory: string,
): Promise<ConfigLoadResult> {
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
	const { config, recovery, removedKeys, warnings } = buildConfigWithMeta(
		userResult.config,
		projectResult.config,
		loadedFromFile,
		configHadErrors,
	);
	return {
		config,
		loadedFromFile,
		configHadErrors,
		recovery,
		removedKeys,
		warnings,
	};
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
