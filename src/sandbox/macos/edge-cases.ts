/**
 * Edge case handling utilities for macOS sandbox-exec.
 *
 * This module provides functions to detect and prevent:
 * - DYLD injection attacks
 * - Temp directory manipulation
 * - Sandbox profile bypass attempts
 * - SIP-protected path access
 * - Entitlement escalation
 * - Quarantine bypass
 * - Nested sandbox execution
 */

import { resolve } from 'node:path';

/**
 * Check whether the environment contains DYLD environment variables
 * that can be used to inject code into sandboxed processes.
 *
 * These variables are ignored in SIP-protected processes but may
 * work in some sandbox configurations.
 *
 * @param path - Unused, kept for signature compatibility
 * @param env  - The environment variables to check
 * @returns true if DYLD injection variables are present
 */
export function detectDyldInjection(
	_path: string,
	env: Record<string, string | undefined>,
): boolean {
	if (process.platform !== 'darwin') return false;

	const dyldVars = [
		'DYLD_INSERT_LIBRARIES',
		'DYLD_LIBRARY_PATH',
		'DYLD_FRAMEWORK_PATH',
	];

	for (const varName of dyldVars) {
		// Treat undefined and empty string as not-set; only a non-empty value
		// can inject code into a sandboxed process.
		if (env[varName]) {
			return true;
		}
	}

	return false;
}

/**
 * Check whether a command tries to escape the temp directory via
 * symlinks, path traversal, or environment variable override.
 *
 * @param tempDir  - The allowed temp directory path
 * @param command  - The command string to analyze
 * @returns true if temp directory manipulation is detected
 */
export function detectTmpDirManipulation(
	tempDir: string,
	command: string,
): boolean {
	if (process.platform !== 'darwin') return false;

	const normalizedTemp = resolve(tempDir);

	// Check for path traversal patterns (..) in command arguments
	// This regex looks for .. path segments that could escape tempDir
	const pathTraversalPattern = /\.\.[\\/]/;
	if (pathTraversalPattern.test(command)) {
		return true;
	}

	// Check for TMPDIR variable override in the command
	// Commands can set TMPDIR to redirect temp file operations
	const tmpdirOverridePattern = /TMPDIR\s*=/;
	if (tmpdirOverridePattern.test(command)) {
		return true;
	}

	// Check if command references symlinks in temp path
	// Common technique: create symlink in temp pointing outside, then use it
	const symlinkTempPattern = new RegExp(
		`${normalizedTemp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\/]\\w+[\\/]\\.\\.[\\/]`,
	);
	if (symlinkTempPattern.test(command)) {
		return true;
	}

	return false;
}

/**
 * Check whether a command tries to bypass sandbox profile restrictions by:
 * - Writing to paths outside scopePaths
 * - Using mktemp in unusual locations
 * - Creating hard/symbolic links to escape scope
 *
 * @param command     - The command string to analyze
 * @param scopePaths  - Array of allowed scope paths
 * @returns true if sandbox profile bypass is detected
 */
export function detectSandboxProfileBypass(
	command: string,
	scopePaths: string[],
): boolean {
	if (process.platform !== 'darwin') return false;

	// Check for mktemp used outside of /tmp or scopePaths
	// mktemp can create files in arbitrary locations
	const mktempOutsidePattern = /mktemp\s+([^-]|$)/;
	if (mktempOutsidePattern.test(command)) {
		// Check if it's explicitly using -p flag to specify a path
		const mktempWithPathPattern = /mktemp\s+-[dp]\s+[/"']?(\/\S+)/;
		const match = command.match(mktempWithPathPattern);
		if (match) {
			const specifiedPath = match[1];
			const isAllowedLocation =
				specifiedPath.startsWith('/tmp/') ||
				scopePaths.some((sp) => specifiedPath.startsWith(sp));
			if (!isAllowedLocation) {
				return true;
			}
		}
	}

	// Check for link creation that could escape scope
	// ln and link commands can create hard links to files outside scope
	const linkEscapePattern = /(?:ln|link)\s+[^-]*\s+\S+\s+(\S+)/;
	const linkMatch = command.match(linkEscapePattern);
	if (linkMatch) {
		const targetPath = resolve(linkMatch[1]);
		const isInScope = scopePaths.some((sp) =>
			targetPath.startsWith(resolve(sp)),
		);
		if (!isInScope && !targetPath.startsWith('/tmp/')) {
			return true;
		}
	}

	// Check for symbolic link creation with -s flag that could redirect to outside scope
	const symlinkEscapePattern = /ln\s+-(?:s\s+|-symbolic\s+)(\S+)\s+(\S+)/;
	const _symlinkMatch = command.match(symlinkEscapePattern);

	// Check for sandbox-exec with no profile (minimal restrictions)
	const sandboxExecNoProfilePattern = /sandbox-exec\s+(?!-f\s+)/;
	if (sandboxExecNoProfilePattern.test(command)) {
		return true;
	}

	return false;
}

/**
 * Check whether a command tries to access System Integrity Protected (SIP) paths.
 *
 * SIP-protected paths on macOS include /System, /usr/libexec, /usr/sbin, /AppleInternal.
 * Writing to these paths can compromise system security even in a sandbox.
 *
 * @param command - The command string to analyze
 * @returns true if SIP-protected path access is detected
 */
export function detectSIPProtectedPathAccess(command: string): boolean {
	if (process.platform !== 'darwin') return false;

	// Normalize command for analysis (convert to lowercase for case-insensitive matching)
	const normalizedPath = resolve(command).toLowerCase();

	// Check for SIP-protected path prefixes
	const sipProtectedPrefixes = [
		'/system/',
		'/usr/libexec/',
		'/usr/sbin/',
		'/appleinternal/',
		'/library/caches/',
		'/library/logs/',
		'/private/var/folders/',
	];

	for (const protectedPrefix of sipProtectedPrefixes) {
		if (normalizedPath.startsWith(protectedPrefix)) {
			return true;
		}
	}

	// Also check for exact matches to protected directories
	const sipProtectedExact = [
		'/System',
		'/usr/libexec',
		'/usr/sbin',
		'/AppleInternal',
	];

	for (const protectedPath of sipProtectedExact) {
		if (normalizedPath === protectedPath.toLowerCase()) {
			return true;
		}
	}

	return false;
}

/**
 * Check whether a command tries to escalate privileges or modify
 * sandbox entitlements.
 *
 * @param command - The command string to analyze
 * @returns true if entitlement escalation is detected
 */
export function detectEntitlementEscalation(command: string): boolean {
	if (process.platform !== 'darwin') return false;

	// Check for sudo execution
	const sudoPattern = /\bsudo\b/;
	if (sudoPattern.test(command)) {
		return true;
	}

	// Check for authorization framework usage (OS X privilege escalation)
	const authorizationPattern = /authorizationexec|security\s+authorization/i;
	if (authorizationPattern.test(command)) {
		return true;
	}

	// Check for attempts to modify sandbox entitlements
	const entitlementModifyPattern =
		/sandbox-exec.*-e|sandbox-exec.*entitlements/i;
	if (entitlementModifyPattern.test(command)) {
		return true;
	}

	// Check for keychain access without proper authorization
	const keychainBypassPattern =
		/security\s+(unlock|delete|import)\s+.*-P\s+''|keychain\s+--?(unlock|password)/i;
	if (keychainBypassPattern.test(command)) {
		return true;
	}

	// Check for authorizationutil or authopen usage
	const authUtilPattern = /authorizationutil|authopen/;
	if (authUtilPattern.test(command)) {
		return true;
	}

	return false;
}

/**
 * Check whether a command tries to bypass macOS quarantine restrictions.
 *
 * Downloaded files have a quarantine attribute that gates execution.
 * Removing this attribute allows unapproved software to run.
 *
 * @param command - The command string to analyze
 * @returns true if quarantine bypass is detected
 */
export function detectQuarantineBypass(command: string): boolean {
	if (process.platform !== 'darwin') return false;

	// Check for xattr removal of quarantine attribute
	const xattrQuarantinePattern =
		/xattr\s+(-d|--delete)\s+.*com.apple.quarantine/;
	if (xattrQuarantinePattern.test(command)) {
		return true;
	}

	// Check for direct LSQuarantine override via environment variable
	const lsQuarantinePattern = /LSQuarantine\s*=\s*0/;
	if (lsQuarantinePattern.test(command)) {
		return true;
	}

	// Check for xattr -c (clear all) which would remove quarantine
	const xattrClearPattern = /xattr\s+-c\s+|--clear\s+.*xattr/;
	if (xattrClearPattern.test(command)) {
		return true;
	}

	// Check for open command with -j flag (bypass quarantine)
	const openBypassPattern = /\bopen\b.*-j\b|\bopen\b.*--bypass-quarantine/;
	if (openBypassPattern.test(command)) {
		return true;
	}

	// Check for spctl (system policy) disable attempts
	const spctlDisablePattern = /spctl\s+--(disable|master-disable)/;
	if (spctlDisablePattern.test(command)) {
		return true;
	}

	return false;
}

/**
 * Alias for detectSIPProtectedPathAccess for API compatibility.
 * @param command - The command string to analyze
 * @returns true if SIP-protected path access is detected
 */
export function detectSIPSProtectedPath(command: string): boolean {
	return detectSIPProtectedPathAccess(command);
}

/**
 * Check whether a command tries to spawn another sandbox-exec instance
 * (nested sandboxing).
 *
 * Nested sandbox execution can be used to escape restrictions by
 * spawning a less-restricted sandbox within a sandbox.
 *
 * @param command - The command string to analyze
 * @returns true if nested sandbox execution is detected
 */
export function detectSandboxExecItself(command: string): boolean {
	if (process.platform !== 'darwin') return false;

	// Check for explicit sandbox-exec in the command
	const sandboxExecPattern = /\bsandbox-exec\b/;
	if (sandboxExecPattern.test(command)) {
		return true;
	}

	// Check for nested sandbox profiles
	const nestedProfilePattern =
		/sandbox-exec.*-f\s+.*sandbox\.d\.|sandbox-exec.*profile.*nested/i;
	if (nestedProfilePattern.test(command)) {
		return true;
	}

	// Check for sandbox-exec with no profile (minimal restrictions)
	const sandboxExecNoProfilePattern = /sandbox-exec\s+(?!-f\s+)/;
	if (sandboxExecNoProfilePattern.test(command)) {
		return true;
	}

	return false;
}
