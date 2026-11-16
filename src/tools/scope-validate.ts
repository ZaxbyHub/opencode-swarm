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
	dcAnalyzeLauncherUncertainty,
	dcPreprocessWrappers,
	dcUnwrapWrappersBounded,
} from '../hooks/guardrails/destructive-command';
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
	getPathFlavor,
	normalizePathIdentity,
	unsafePathTextReason,
} from '../scope/path-identity';
import { normalizeScopeFiles } from '../scope/scope-binding';
import { classifyCommand } from '../security/command-classifier';
import {
	createTargetWithinRootValidator,
	isCanonicalPathWithinRoot,
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

function detectWrites(args: ScopeValidateArgs): {
	analysis: ReturnType<typeof detectPosixWrites>;
	command: string;
} {
	// #3568 review PRR-008 (+#3568 handoff item 2): the masked process-
	// substitution residual is the command text whose writes the live gate
	// resolves — `cd .. && echo hi > out.txt; true <(true)` parses CLEAN on
	// the raw text after masking, so the gate denies on the RESIDUAL's
	// cd-tracked landing while a raw-text resolution here answered ALLOWED
	// where the tool header claims live-guardrail parity. Resolve on the
	// residual when the POSIX analysis carries one, exactly like the gate's
	// detectionCommand substitution.
	if (args.shell !== 'posix') {
		return {
			analysis: detectWindowsWrites(args.command, args.shell),
			command: args.command,
		};
	}
	const analysis = detectPosixWrites(args.command);
	return {
		analysis,
		command:
			analysis.residualCommand !== undefined
				? analysis.residualCommand
				: args.command,
	};
}

/**
 * Build an indexed scope predicate. The previous `some()`-per-target scan was
 * quadratic for the schema's 10,000-entry upper bound. Walking a target's
 * bounded ancestor chain against a normalized Set keeps the same containment
 * semantics while making the scope-size cost linear.
 */
function createScopeMatcher(
	scopeEntries: readonly string[],
	directory: string,
): (filePath: string) => boolean {
	const flavor = getPathFlavor();
	const pathImpl = flavor === 'win32' ? path.win32 : path.posix;
	const scopeIdentities = new Set(
		scopeEntries.map((scope) =>
			normalizePathIdentity(pathImpl.resolve(directory, scope), flavor),
		),
	);
	return (filePath) => {
		let candidate = pathImpl.resolve(directory, filePath);
		while (true) {
			if (scopeIdentities.has(normalizePathIdentity(candidate, flavor))) {
				return true;
			}
			const parent = pathImpl.dirname(candidate);
			if (parent === candidate) return false;
			candidate = parent;
		}
	};
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
	const validateScopeTarget = createTargetWithinRootValidator(directory);
	for (const scopeFile of normalizedScope) {
		const unsafeReason = unsafePathTextReason(scopeFile);
		if (unsafeReason) fail('INVALID_SCOPE', unsafeReason);
		const reason = validateScopeTarget(scopeFile);
		if (reason) fail('INVALID_SCOPE', reason);
	}
	const isInScope = createScopeMatcher(normalizedScope, directory);

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
	// #3569 core: route posix commands through the SAME canonical wrapper
	// preprocessing the write gate and the explain service use
	// (dcPreprocessWrappers — chdir-bearing wrapper segments rewrite to
	// `( cd -- 'DIR' && inner )` so the wrapped command's writes resolve at
	// the child cwd). Without this, scope_validate resolved a wrapped
	// `tee`/`dd` operand at the parent cwd and diverged from the gate.
	// Merged with #3568's residual-aware detectWrites (main): the resolver
	// runs on the preprocessed command, and detectWrites' residualCommand
	// substitution still applies on top.
	const preprocessed =
		args.shell === 'posix' ? dcPreprocessWrappers(args.command) : null;
	if (preprocessed?.failClosed) {
		fail('UNPARSEABLE_COMMAND', 'command could not be parsed safely');
	}
	const preprocessedCommand =
		preprocessed?.changed && !preprocessed.failClosed
			? preprocessed.command
			: args.command;
	const detectArgs: ScopeValidateArgs =
		preprocessedCommand === args.command
			? args
			: { ...args, command: preprocessedCommand };
	const { analysis: preAnalysis, command: residualCommand } =
		detectWrites(detectArgs);
	const detectionCommand = residualCommand;
	let analysis = preAnalysis;
	if (analysis.parseError) {
		fail('UNPARSEABLE_COMMAND', 'command could not be parsed safely');
	}
	// #3569 4.5 r4 (reviewer Important): the gate compensates for the
	// preprocessor serializing brace words QUOTED (the preprocessed text
	// loses the expansion) by unioning the RAW analysis back (PRR-006
	// filter). scope_validate must union too or it ALLOWS wrapper+brace
	// shapes the gate denies (env -C src sed -i {s/a/b/,../../outside} y).
	if (detectionCommand !== args.command) {
		const { analysis: rawAnalysis } = detectWrites(args);
		const seen = new Set(
			analysis.writes.map(
				(w) => `${w.category}\u0000${w.operator}\u0000${w.path ?? ''}`,
			),
		);
		const regained = rawAnalysis.writes.filter(
			(w) =>
				!(
					w.category === 'interpreter_eval' &&
					w.path === null &&
					!w.operator.endsWith('[eval stdin]')
				) &&
				// Dedupe against the preprocessed analysis (the gate's
				// duplicate keys collapse downstream; sv renders the
				// target list, so collapse here).
				!seen.has(`${w.category}\u0000${w.operator}\u0000${w.path ?? ''}`),
		);
		if (regained.length > 0) {
			analysis = {
				...analysis,
				writes: [...analysis.writes, ...regained],
				hasWrites: analysis.hasWrites || regained.length > 0,
			};
		}
		// #3590 feedback (copilot review): the RAW analysis's depth refusal
		// must survive the union (mirror tool-before's mergeWriteAnalyses
		// OR) — a wrapper chain the bound cannot inspect never reports safe
		// here.
		if (rawAnalysis.unwrapDepthExceeded) {
			analysis = { ...analysis, unwrapDepthExceeded: true };
		}
	}
	// #3590 feedback (copilot review): fail-closed BEFORE the no-writes
	// early return — the detector sets this flag precisely so consumers
	// refuse an uninspectable wrapper chain even when it yields zero
	// writes (parity with tool-before).
	if (analysis.unwrapDepthExceeded) {
		fail(
			'UNPARSEABLE_COMMAND',
			'shell wrapper nesting exceeds the inspection bound — rejecting for safety',
		);
	}
	// #3572 review N-16: the live gate consults the launcher deny-on-
	// uncertainty channel and the paranoid-bound depth flag BEFORE its no-
	// write early return and BEFORE grammar dispatch, so parity requires both
	// channels for EVERY shell grammar (the reviewer's cmd/powershell
	// question: the live gate denies `sudo -i` on the raw command regardless
	// of the detected grammar).
	const uncertainty = dcAnalyzeLauncherUncertainty(args.command);
	if (uncertainty.deny) {
		fail(
			'UNPARSEABLE_COMMAND',
			uncertainty.reason ||
				'launcher option uncertainty — command could not be verified safely',
		);
	}
	const bounded = dcUnwrapWrappersBounded(args.command);
	if (bounded.depthExceeded) {
		fail(
			'UNPARSEABLE_COMMAND',
			'shell wrapper nesting exceeds the inspection bound — command could not be verified safely',
		);
	}
	if (!analysis.hasWrites) {
		return {
			allowed: true,
			shell: args.shell,
			command_digest: classification.originalDigest,
			targets: [],
		};
	}

	// Detection and resolution must use the SAME string (the resolver
	// re-parses it for cwd tracking — the gate's own contract; the
	// residual substitution is already folded into detectionCommand).
	const resolved = resolveWriteTargets(
		detectionCommand,
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
		if (!isInScope(relativeTarget)) {
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
