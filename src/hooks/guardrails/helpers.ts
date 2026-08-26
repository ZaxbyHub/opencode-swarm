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
import { isPathWithinDeclaredScope } from '../../scope/path-identity';
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
	return isPathWithinDeclaredScope(filePath, scopeEntries, cwd);
}

/**
 * Redacts sensitive values from a shell command string before audit logging.
 *
 * Covers env-var assignments (POSIX/PowerShell `$env:`/cmd `set`), CLI flags
 * (sensitive names, both `=`-joined and space-separated), Bearer/Basic auth,
 * `-H` header flags, URL credentials (`scheme://user:pass@host`), well-known
 * token VALUE shapes (OpenAI/GitHub/AWS/Slack/Google — content-based, so they
 * fire regardless of the surrounding flag name), and long base64-like payload
 * runs (≥80 chars with mixed case + digit — the encoded-wrapper/heredoc
 * minimization class from issue #2040; plain hex SHAs and short payloads are
 * deliberately NOT matched).
 *
 * Deterministic: identical inputs always redact identically (correlation via
 * the audit `commandHash` relies on it). No pattern retains any reversible
 * secret material.
 */
export function redactShellCommand(cmd: string): string {
	if (typeof cmd !== 'string') return '';
	let out = cmd
		.replace(/\/home\/[^/\s"']+/g, '~')
		.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, '~')
		.replace(/\/Users\/[^/\s"']+/g, '~');

	// URL credentials: scheme://user:password@host -> scheme://user:[REDACTED]@host
	out = out.replace(
		/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'@/]+):([^@\s"'/]+)@/g,
		'$1:[REDACTED]@',
	);

	out = out.replace(
		/\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Z_0-9]*)\s*=\s*(\S+)/gi,
		'$1=[REDACTED]',
	);

	// PowerShell env assignment (sensitive names only — matches the POSIX
	// pattern's scope): $env:KEY="value" / $env:KEY='v' / $env:KEY=v
	out = out.replace(
		/(\$env:[A-Za-z_][A-Za-z_0-9]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Za-z_0-9]*)(\s*=\s*)(["'][^"']*["']|\S+)/gi,
		'$1=[REDACTED]',
	);

	// cmd.exe / command.com env assignment: set KEY=value (sensitive names only)
	out = out.replace(
		/\b(set|SET)(\s+"?)([A-Za-z_][A-Za-z_0-9]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Za-z_0-9]*)(=?)(\s+)(\S+)/gi,
		'$1$2$3=[REDACTED]',
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

	// Well-known token VALUE shapes (content-based; fires regardless of the
	// flag/variable name carrying them).
	out = out
		.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai]')
		.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, '[REDACTED:github]')
		.replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED:github]')
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws]')
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack]')
		.replace(/\bAIza[A-Za-z0-9_-]{30,}/g, '[REDACTED:google]');

	// Long base64-like payload runs (encoded wrappers, heredoc payloads).
	// Requires ≥80 chars of base64 charset AND at least one uppercase, one
	// lowercase, and one digit — hex-only SHAs (lowercase+digit) and short
	// payloads stay visible (no-over-redaction guards pin them).
	out = out.replace(
		/(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{80,}={0,2}/g,
		'[REDACTED:base64]',
	);

	return out;
}
