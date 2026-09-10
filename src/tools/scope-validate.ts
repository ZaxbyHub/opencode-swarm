/**
 * Read-only shell-write scope advisory for the MCP surface (#2500).
 *
 * This tool is deliberately an evaluator only. It never executes a command,
 * publishes an OpenCode scope binding, or persists any state. The decision is
 * composed from the same classifier, write detector, containment, and file
 * authority helpers used by the live guardrails.
 */

import path from 'node:path';
import { z } from 'zod';
import {
	checkFileAuthority,
	checkWriteTargetForSymlink,
} from '../hooks/guardrails/file-authority';
import {
	detectPosixWrites,
	detectWindowsWrites,
	resolveWriteTargets,
} from '../hooks/shell-write-detect';
import {
	isPathWithinDeclaredScope,
	unsafePathTextReason,
} from '../scope/path-identity';
import { normalizeScopeFiles } from '../scope/scope-binding';
import { classifyCommand } from '../security/command-classifier';
import {
	isCanonicalPathWithinRoot,
	validateTargetWithinRoot,
	validateWorkspaceRoot,
} from '../utils/path-security';
import { createSwarmTool } from './create-tool';

export const scopeValidateArgs = {
	command: z
		.string()
		.min(1)
		.max(64 * 1024)
		.describe('Shell command to inspect; it is never executed'),
	shell: z
		.enum(['posix', 'powershell', 'cmd'])
		.describe('Shell grammar used to inspect the command'),
	scope_files: z
		.array(z.string().min(1).max(4096))
		.min(1)
		.max(10_000)
		.describe('Workspace-relative paths the command is allowed to write'),
};

export const scopeValidateSchema = z.object(scopeValidateArgs);

export type ScopeValidateArgs = {
	command: string;
	shell: 'posix' | 'powershell' | 'cmd';
	scope_files: string[];
};

export interface ScopeValidateTarget {
	category: string;
	operator: string;
	path: string;
}

export interface ScopeValidateResult {
	allowed: true;
	shell: ScopeValidateArgs['shell'];
	command_digest: string;
	targets: ScopeValidateTarget[];
}

export class ScopeValidationError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = 'ScopeValidationError';
		this.code = code;
	}
}

function fail(code: string, message: string): never {
	throw new ScopeValidationError(code, message);
}

function detectWrites(args: ScopeValidateArgs) {
	if (args.shell === 'posix') return detectPosixWrites(args.command);
	return detectWindowsWrites(args.command, args.shell);
}

/**
 * Evaluate a shell command against an inline scope without executing it.
 * Every filesystem path is checked against the supplied root and scope before
 * a successful result is returned.
 */
export function evaluateScopeValidate(
	args: ScopeValidateArgs,
	directory: string,
): ScopeValidateResult {
	validateWorkspaceRoot(directory);
	if (!args || typeof args.command !== 'string') {
		fail('INVALID_INPUT', 'command must be a string');
	}
	if (!['posix', 'powershell', 'cmd'].includes(args.shell)) {
		fail('INVALID_INPUT', 'shell must be posix, powershell, or cmd');
	}
	if (!Array.isArray(args.scope_files)) {
		fail('INVALID_SCOPE', 'scope_files must be a non-empty array');
	}
	const normalizedScope = normalizeScopeFiles(args.scope_files);
	if (!normalizedScope) {
		fail(
			'INVALID_SCOPE',
			'scope_files must contain safe workspace-relative paths',
		);
	}
	for (const scopeFile of normalizedScope) {
		const unsafeReason = unsafePathTextReason(scopeFile);
		if (unsafeReason) fail('INVALID_SCOPE', unsafeReason);
		const reason = validateTargetWithinRoot(scopeFile, directory);
		if (reason) fail('INVALID_SCOPE', reason);
	}

	const classification = classifyCommand(args.command);
	if (classification.ambiguous) {
		fail('AMBIGUOUS_COMMAND', 'command syntax could not be verified safely');
	}
	if (
		classification.aggregate === 'catastrophic' ||
		classification.aggregate === 'destructive'
	) {
		fail('DESTRUCTIVE_COMMAND', 'destructive command intent is not permitted');
	}
	const analysis = detectWrites(args);
	if (analysis.parseError) {
		fail('UNPARSEABLE_COMMAND', 'command could not be parsed safely');
	}
	if (!analysis.hasWrites) {
		return {
			allowed: true,
			shell: args.shell,
			command_digest: classification.originalDigest,
			targets: [],
		};
	}

	const resolved = resolveWriteTargets(
		args.command,
		analysis.writes,
		directory,
	);
	const targets: ScopeValidateTarget[] = [];
	for (const target of resolved) {
		if (!target.resolved || !target.resolvedPath) {
			fail(
				'UNRESOLVED_TARGET',
				'a write target could not be resolved statically',
			);
		}
		const resolvedPath = path.resolve(target.resolvedPath);
		if (!isCanonicalPathWithinRoot(resolvedPath, directory)) {
			fail(
				'ROOT_ESCAPE',
				'a write target resolves outside the configured root',
			);
		}
		const symlinkReason = checkWriteTargetForSymlink(resolvedPath, directory);
		if (symlinkReason) {
			fail(
				'SYMLINK_ESCAPE',
				'a write target uses an unverifiable symlink or junction',
			);
		}
		const relativeTarget = path.relative(directory, resolvedPath);
		if (
			!isPathWithinDeclaredScope(relativeTarget, normalizedScope, directory)
		) {
			fail(
				'SCOPE_VIOLATION',
				'a write target is outside the inline declared scope',
			);
		}
		const authority = checkFileAuthority(
			'coder',
			relativeTarget,
			directory,
			undefined,
			{ declaredScope: normalizedScope },
		);
		if (!authority.allowed) {
			fail(
				'AUTHORITY_DENIED',
				'a write target is protected by file authority policy',
			);
		}
		targets.push({
			category: target.original.category,
			operator: target.original.operator,
			path: relativeTarget.replace(/\\/g, '/'),
		});
	}

	return {
		allowed: true,
		shell: args.shell,
		command_digest: classification.originalDigest,
		targets,
	};
}

export const scope_validate: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Validate a shell command against an inline workspace scope without executing it. Rejects destructive, ambiguous, unresolved, escaping, symlinked, protected, and out-of-scope writes.',
		args: scopeValidateArgs,
		execute: async (args: unknown, directory: string): Promise<string> =>
			JSON.stringify(
				evaluateScopeValidate(scopeValidateSchema.parse(args), directory),
			),
	});
