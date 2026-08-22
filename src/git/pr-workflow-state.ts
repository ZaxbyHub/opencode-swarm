import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	type PorcelainV2Snapshot,
	parsePorcelainV2Snapshot,
} from '../background/workspace-snapshot.js';
import { runExternalTool } from '../utils/external-tool-runner.js';
import { resolveGitExecutable } from '../utils/git-executable.js';

const GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 512 * 1024;
const MAX_EVIDENCE_PATHS = 20;
const MAX_EVIDENCE_PATH_LENGTH = 240;

export type PrWorkflowGitStateKind =
	| 'clean'
	| 'stashable'
	| 'recovery-required'
	| 'indeterminate';

export interface PrWorkflowGitState {
	kind: PrWorkflowGitStateKind;
	code:
		| 'CLEAN'
		| 'STASHABLE_CHANGES'
		| 'UNMERGED_INDEX'
		| 'GIT_OPERATION_IN_PROGRESS'
		| 'DIRTY_SUBMODULE'
		| 'SWARM_STATE_TRACKING_ERROR'
		| 'GIT_STATE_INDETERMINATE';
	retryable: boolean;
	requiredAction: string;
	evidence: {
		worktreeRoot: string | null;
		gitDir: string | null;
		operations: string[];
		unmergedCodes: string[];
		paths: string[];
		trackedCount: number;
		untrackedCount: number;
		pathsTruncated: boolean;
		detail?: string;
	};
}

interface GitCaptureResult {
	ok: boolean;
	stdout: string;
}

const OPERATION_MARKERS = [
	['merge', 'MERGE_HEAD'],
	['rebase-merge', 'rebase-merge'],
	['rebase-apply-or-am', 'rebase-apply'],
	['cherry-pick', 'CHERRY_PICK_HEAD'],
	['revert', 'REVERT_HEAD'],
	['bisect', 'BISECT_START'],
	['sequencer', 'sequencer'],
] as const;

function boundPath(value: string): string {
	const cleaned = value
		.replace(/[\p{Cc}]/gu, ' ')
		.replace(/[`<>]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.length > MAX_EVIDENCE_PATH_LENGTH
		? `${cleaned.slice(0, MAX_EVIDENCE_PATH_LENGTH)}...`
		: cleaned;
}

function evidence(
	parsed: PorcelainV2Snapshot | null,
	worktreeRoot: string | null,
	gitDir: string | null,
	operations: string[],
	detail?: string,
): PrWorkflowGitState['evidence'] {
	const allPaths = parsed
		? [
				...parsed.unmergedPaths,
				...parsed.dirtySubmodulePaths,
				...parsed.dirtyTrackedPaths,
				...parsed.untrackedPaths,
			]
		: [];
	const uniquePaths = [...new Set(allPaths)].map(boundPath);
	return {
		worktreeRoot: worktreeRoot ? boundPath(worktreeRoot) : null,
		gitDir: gitDir ? boundPath(gitDir) : null,
		operations,
		unmergedCodes: parsed ? [...new Set(parsed.unmergedCodes)].sort() : [],
		paths: uniquePaths.slice(0, MAX_EVIDENCE_PATHS),
		trackedCount: parsed?.dirtyTrackedPaths.length ?? 0,
		untrackedCount: parsed?.untrackedPaths.length ?? 0,
		pathsTruncated: uniquePaths.length > MAX_EVIDENCE_PATHS,
		...(detail ? { detail } : {}),
	};
}

async function runGitCapture(
	directory: string,
	args: readonly string[],
): Promise<GitCaptureResult> {
	const result = await runExternalTool({
		executable: resolveGitExecutable(),
		args: [...args],
		cwd: path.resolve(directory),
		timeoutMs: GIT_TIMEOUT_MS,
		maxStdoutBytes: MAX_GIT_OUTPUT_BYTES,
		maxStderrBytes: 64 * 1024,
	});
	return {
		ok:
			result.status === 'completed' &&
			result.exitCode === 0 &&
			!result.stdoutTruncated &&
			!result.stderrTruncated,
		stdout: result.stdout,
	};
}

async function activeOperations(gitDir: string): Promise<string[]> {
	const checks = await Promise.all(
		OPERATION_MARKERS.map(async ([name, marker]) => {
			try {
				await fsp.lstat(path.join(gitDir, marker));
				return name;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
				throw error;
			}
		}),
	);
	return checks.filter((value) => value !== null) as string[];
}

/**
 * Classify the checkout before a PR workflow can take ownership of it.
 * Unknown Git state fails closed; ordinary tracked/untracked dirt is explicitly
 * distinguished from conflict and in-progress-operation recovery states.
 */
export async function classifyPrWorkflowGitState(
	directory: string,
	options: { ignoredPaths?: readonly string[] } = {},
): Promise<PrWorkflowGitState> {
	const [statusResult, rootResult, gitDirResult] = await Promise.all([
		_internals.runGitCapture(directory, [
			'status',
			'--porcelain=v2',
			'--branch',
			'-z',
			'--untracked-files=all',
		]),
		_internals.runGitCapture(directory, ['rev-parse', '--show-toplevel']),
		_internals.runGitCapture(directory, ['rev-parse', '--absolute-git-dir']),
	]);
	if (!statusResult.ok || !rootResult.ok || !gitDirResult.ok) {
		return {
			kind: 'indeterminate',
			code: 'GIT_STATE_INDETERMINATE',
			retryable: false,
			requiredAction:
				'Confirm this is a readable Git worktree and resolve filesystem or Git errors before starting the PR workflow.',
			evidence: evidence(
				null,
				null,
				null,
				[],
				'required Git inspection failed',
			),
		};
	}
	const worktreeRoot = rootResult.stdout.trim();
	const gitDir = gitDirResult.stdout.trim();
	const parsedRaw = parsePorcelainV2Snapshot(statusResult.stdout);
	if (!worktreeRoot || !gitDir || !parsedRaw) {
		return {
			kind: 'indeterminate',
			code: 'GIT_STATE_INDETERMINATE',
			retryable: false,
			requiredAction:
				'Resolve the malformed or incomplete Git status before starting the PR workflow.',
			evidence: evidence(
				parsedRaw,
				worktreeRoot || null,
				gitDir || null,
				[],
				'Git returned an incomplete status snapshot',
			),
		};
	}
	const ignoredPaths = new Set(
		(options.ignoredPaths ?? []).map((value) => value.replace(/\\/g, '/')),
	);
	const keepPath = (value: string): boolean =>
		!ignoredPaths.has(value.replace(/\\/g, '/'));
	const parsed: PorcelainV2Snapshot = {
		...parsedRaw,
		dirtyTrackedPaths: parsedRaw.dirtyTrackedPaths.filter(keepPath),
		untrackedPaths: parsedRaw.untrackedPaths.filter(keepPath),
		unmergedPaths: parsedRaw.unmergedPaths.filter(keepPath),
		dirtySubmodulePaths: parsedRaw.dirtySubmodulePaths.filter(keepPath),
	};

	let operations: string[];
	try {
		operations = await _internals.activeOperations(path.resolve(gitDir));
	} catch {
		return {
			kind: 'indeterminate',
			code: 'GIT_STATE_INDETERMINATE',
			retryable: false,
			requiredAction:
				'Resolve the unreadable Git operation state before starting the PR workflow.',
			evidence: evidence(
				parsed,
				worktreeRoot,
				gitDir,
				[],
				'Git operation markers could not be inspected',
			),
		};
	}
	const stateEvidence = evidence(parsed, worktreeRoot, gitDir, operations);
	if (parsed.unmergedCodes.length > 0) {
		return {
			kind: 'recovery-required',
			code: 'UNMERGED_INDEX',
			retryable: false,
			requiredAction:
				'Resolve or abort the current merge/rebase/cherry-pick/revert operation manually; conflicted index entries must never be stashed by PR workflow startup.',
			evidence: stateEvidence,
		};
	}
	if (operations.length > 0) {
		return {
			kind: 'recovery-required',
			code: 'GIT_OPERATION_IN_PROGRESS',
			retryable: false,
			requiredAction:
				'Complete or abort the active Git operation manually before starting the PR workflow.',
			evidence: stateEvidence,
		};
	}
	if (parsed.dirtySubmodulePaths.length > 0) {
		return {
			kind: 'recovery-required',
			code: 'DIRTY_SUBMODULE',
			retryable: false,
			requiredAction:
				'Resolve or preserve dirty submodule worktrees manually; the checkout-preparation stash cannot safely preserve them.',
			evidence: stateEvidence,
		};
	}
	const swarmStatePath = [
		...parsed.dirtyTrackedPaths,
		...parsed.untrackedPaths,
	].find(
		(candidate) =>
			candidate === '.swarm' ||
			candidate.startsWith('.swarm/') ||
			candidate.startsWith('.swarm\\'),
	);
	if (swarmStatePath) {
		return {
			kind: 'recovery-required',
			code: 'SWARM_STATE_TRACKING_ERROR',
			retryable: false,
			requiredAction:
				'Restore .swarm/ so it is git-excluded before starting the PR workflow; runtime state must not be treated as checkout dirt.',
			evidence: stateEvidence,
		};
	}
	if (
		parsed.dirtyTrackedPaths.length === 0 &&
		parsed.untrackedPaths.length === 0
	) {
		return {
			kind: 'clean',
			code: 'CLEAN',
			retryable: true,
			requiredAction: 'No checkout recovery is required.',
			evidence: stateEvidence,
		};
	}
	return {
		kind: 'stashable',
		code: 'STASHABLE_CHANGES',
		retryable: true,
		requiredAction:
			'Run prepare_pr_workflow_checkout once to preserve the ordinary working-tree changes before checkout.',
		evidence: stateEvidence,
	};
}

export const _internals: {
	runGitCapture: typeof runGitCapture;
	activeOperations: typeof activeOperations;
	parsePorcelainV2: typeof parsePorcelainV2Snapshot;
} = {
	runGitCapture,
	activeOperations,
	parsePorcelainV2: parsePorcelainV2Snapshot,
};
