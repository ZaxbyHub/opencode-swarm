/**
 * Shared Helper Functions — Guardrails
 *
 * Extracted from tool-before.ts (task 1.4 / FR-005).
 * Contains pure utility functions used by the toolBefore handler
 * and potentially other guardrails submodules.
 */

import * as path from 'node:path';
import { WRITE_TOOL_NAMES } from '../../config/constants';
import { classifyFile } from '../../context/zone-classifier';
import { normalizeToolName } from '../normalize-tool-name';
import { getGlobMatcher } from './file-authority';

// ---- Constants ----

/**
 * Known verifier/linter config file glob patterns for config-zone logging.
 * Matches patterns from architect's blockedGlobs that represent config files.
 */
const KNOWN_VERIFIER_CONFIG_GLOBS = [
	'**/oxlintrc*',
	'**/.oxlintrc*',
	'**/.eslintrc*',
	'**/eslint.config.*',
	'**/.prettierrc*',
	'**/prettier.config.*',
	'**/biome.jsonc',
	'**/.secretscanignore',
	'**/.golangci*',
] as const;

// ---- Helper functions ----

/**
 * Checks if a file path is a config file either via zone classification
 * or by matching known verifier config glob patterns.
 */
export function isConfigFilePath(
	filePath: string,
	cwd: string,
	extraGlobs?: readonly string[],
): boolean {
	const normalized = path
		.relative(path.resolve(cwd), path.resolve(cwd, filePath))
		.replace(/\\/g, '/');

	const { zone } = classifyFile(normalized);
	if (zone === 'config') {
		return true;
	}

	const allGlobs =
		extraGlobs && extraGlobs.length > 0
			? [...KNOWN_VERIFIER_CONFIG_GLOBS, ...extraGlobs]
			: KNOWN_VERIFIER_CONFIG_GLOBS;
	for (const glob of allGlobs) {
		const matcher = getGlobMatcher(glob);
		if (matcher(normalized)) {
			return true;
		}
	}

	return false;
}

/**
 * Detects if a tool is a write-class tool that modifies file contents.
 */
export function isWriteTool(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	return (WRITE_TOOL_NAMES as readonly string[]).includes(normalized);
}

/**
 * Detects if a file path is outside the .swarm/ directory.
 */
export function isOutsideSwarmDir(
	filePath: string,
	directory: string,
): boolean {
	if (!filePath) return false;
	const swarmDir = path.resolve(directory, '.swarm');
	const resolved = path.resolve(directory, filePath);
	const relative = path.relative(swarmDir, resolved);
	return relative.startsWith('..') || path.isAbsolute(relative);
}

/**
 * Detects if a file path is source code (not docs, config, or metadata).
 */
export function isSourceCodePath(filePath: string): boolean {
	if (!filePath) return false;
	const normalized = filePath.replace(/\\/g, '/');
	const nonSourcePatterns = [
		/^README(\..+)?$/i,
		/\/README(\..+)?$/i,
		/^CHANGELOG(\..+)?$/i,
		/\/CHANGELOG(\..+)?$/i,
		/^package\.json$/,
		/\/package\.json$/,
		/^\.github\//,
		/\/\.github\//,
		/^docs\//,
		/\/docs\//,
		/^\.swarm\//,
		/\/\.swarm\//,
	];
	return !nonSourcePatterns.some((pattern) => pattern.test(normalized));
}

/**
 * Detect obvious traversal segments regardless of destination file type.
 */
export function hasTraversalSegments(filePath: string): boolean {
	if (!filePath) return false;
	const normalized = filePath.replace(/\\/g, '/');
	return (
		normalized.startsWith('..') ||
		normalized.includes('/../') ||
		normalized.endsWith('/..')
	);
}

/**
 * Check if a file path is within declared scope entries.
 * Handles both exact matches and directory containment.
 */
export function isInDeclaredScope(
	filePath: string,
	scopeEntries: string[],
	cwd?: string,
): boolean {
	const dir = cwd ?? process.cwd();
	const caseInsensitive = process.platform === 'win32';
	const resolvedFileRaw = path.resolve(dir, filePath);
	const resolvedFile = caseInsensitive
		? resolvedFileRaw.toLowerCase()
		: resolvedFileRaw;
	return scopeEntries.some((scope) => {
		const resolvedScopeRaw = path.resolve(dir, scope);
		const resolvedScope = caseInsensitive
			? resolvedScopeRaw.toLowerCase()
			: resolvedScopeRaw;
		if (resolvedFile === resolvedScope) return true;
		const rel = path.relative(resolvedScope, resolvedFile);
		return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
	});
}

/**
 * Redacts sensitive values from a shell command string before audit logging.
 * Covers env-var assignments, CLI flags, Bearer/Basic auth, and -H header flags.
 */
export function redactShellCommand(cmd: string): string {
	if (typeof cmd !== 'string') return '';
	let out = cmd.replace(
		/\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Z_0-9]*)\s*=\s*(\S+)/gi,
		'$1=[REDACTED]',
	);

	out = out.replace(
		/--([a-zA-Z-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[a-zA-Z-]*)=(\S+)/gi,
		'--$1=[REDACTED]',
	);

	out = out.replace(
		/(--[a-zA-Z-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[a-zA-Z-]*)(\s+)(?!--)(\S+)/gi,
		'$1$2[REDACTED]',
	);

	out = out.replace(
		/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{4,}/gi,
		'$1 [REDACTED]',
	);

	out = out.replace(
		/(-H\s+['"]?(?:Authorization|X-API-Key|X-Auth-Token|[A-Za-z][A-Za-z-]*-(?:key|token|secret|auth|credential)):\s*)([^'">\s][^'">\n]*)(['"]?)/gi,
		'$1[REDACTED]$3',
	);

	return out;
}
