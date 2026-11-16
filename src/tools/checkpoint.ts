import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	consumeConfirmToken,
	issueConfirmToken,
} from '../commands/destructive-purge';
import {
	readGitRepositoryStatusDetailedAsync,
	readGitStatusAsync,
} from '../commands/git-status-read';
import { backupTrackedChangesBeforeRollback } from '../commands/reset-backup';
import {
	describeUnreadableCause,
	formatExcludedRecord,
	measureGitDestruction,
	ROLLBACK_GIT_KIND,
	trackedDirtyCandidates,
} from '../commands/rollback-gate';
import { loadPluginConfigWithMeta } from '../config';
import {
	buildTaskCompletionDescriptor,
	ensureTaskCheckpointReceipt,
	updateTaskCheckpointReceipt,
} from '../db/task-checkpoint-receipt.js';
import { appendCoreEventSync } from '../events/core-events.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { readLedgerEvents } from '../plan/ledger.js';
import { loadPlan } from '../plan/manager.js';
import { derivePlanId, derivePlanIdentityHash } from '../plan/utils.js';
import {
	GitBinaryMissingError,
	GitSpawnCwdError,
	isGitBinaryMissing,
	isSpawnCwdMissing,
	isSpawnCwdUnreadable,
} from '../utils/git-binary-missing-error.js';
import { resolveGitExecutable } from '../utils/git-executable.js';
import {
	isTransientSpawnError,
	MAX_TRANSIENT_RETRIES,
	transientBackoff,
} from '../utils/transient-retry.js';
import { createSwarmTool } from './create-tool';

const CHECKPOINT_LOG_PATH = '.swarm/checkpoints.json';
const PLAN_LOCK_PATH = 'plan.json';
const CHECKPOINT_AGENT_NAME = 'checkpoint';
const MAX_LABEL_LENGTH = 100;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const CHECKPOINT_LOCK_MAX_ATTEMPTS = 20;
const CHECKPOINT_LOCK_DELAY_MS = 250;
const CHECKPOINT_LOCK_DEADLINE_MS = 45_000;
const CHECKPOINT_RECEIPT_LOOKUP_LIMIT = 25;
const NON_SWARM_COMMIT_PATHSPEC = [
	'.',
	':(exclude,top).swarm',
	':(exclude,top).swarm/**',
] as const;

const SHELL_METACHARACTERS = /[;|&$`(){}<>!'"]/;
const SAFE_LABEL_PATTERN = /^[a-zA-Z0-9_ -]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security validation pattern
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const NON_ASCII_PATTERN = /[^\x20-\x7E]/;

type MutationAction = 'save' | 'restore' | 'delete' | 'save_task_completion';

interface CheckpointEntry {
	label: string;
	sha: string;
	timestamp: string;
}

interface CheckpointLog {
	version: number;
	checkpoints: CheckpointEntry[];
}

interface RetentionEvent {
	event: 'checkpoint_retention_applied';
	evicted_labels: string[];
	evicted_count: number;
	remaining_count: number;
}

export const _internals: {
	tryAcquireLock: typeof tryAcquireLock;
	loadPlan: typeof loadPlan;
	gitExec: typeof gitExec;
	sleep: (ms: number) => Promise<void>;
	findCommitByExactSubject: typeof findCommitByExactSubject;
	stageAllExcludingSwarm: typeof stageAllExcludingSwarm;
	afterTaskEligibilityRead?: (
		directory: string,
		taskId: string,
	) => Promise<void>;
	/**
	 * Issue #2236 hardening (F1/F4/F5) — resolves the absolute git executable
	 * path instead of spawning the bare `'git'` name. Exposed for test
	 * injection (mirrors `src/git/branch.ts`'s `_internals.resolveGitExecutable`
	 * convention) so a test that mocks `node:child_process` wholesale to drive
	 * `gitExec`'s retry/classification logic can stub a fixed value instead of
	 * having the real candidate-probing loop consume the same mocked
	 * `spawnSync` call slots the test is asserting on.
	 */
	resolveGitExecutable: typeof resolveGitExecutable;
	/**
	 * Feedback-round seam (#3441 review): the restore path's destruction
	 * measurement is reachable through this slot so a test can stub the
	 * measurement without mocking the whole rollback-gate module (whose
	 * process-global mock.module form leaks across co-run files).
	 */
	measureGitDestruction: typeof measureGitDestruction;
	/**
	 * Feedback-round seams (PRR-011): the two async reader probes are
	 * reachable through slots so tests stub them by PROPERTY ASSIGNMENT
	 * (restored in afterEach) instead of mock.module — the module-level
	 * registration is process-global and poisoned co-run files.
	 */
	readGitStatusAsync: typeof readGitStatusAsync;
	readGitRepositoryStatusDetailedAsync: typeof readGitRepositoryStatusDetailedAsync;
} = {
	tryAcquireLock,
	loadPlan,
	gitExec,
	sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
	findCommitByExactSubject,
	stageAllExcludingSwarm,
	resolveGitExecutable,
	measureGitDestruction,
	readGitStatusAsync,
	readGitRepositoryStatusDetailedAsync,
};

function serializeResult(
	action: MutationAction | 'list' | 'unknown',
	payload: Record<string, unknown>,
): string {
	return JSON.stringify(
		{
			action,
			...payload,
		},
		null,
		2,
	);
}

function containsNonAsciiChars(label: string): boolean {
	for (let i = 0; i < label.length; i++) {
		const charCode = label.charCodeAt(i);
		if (charCode < 0x20 || charCode > 0x7e) {
			return true;
		}
	}
	return false;
}

function validateLabel(label: string): string | null {
	if (!label || label.length === 0) {
		return 'label is required';
	}
	if (label.length > MAX_LABEL_LENGTH) {
		return `label exceeds maximum length of ${MAX_LABEL_LENGTH}`;
	}
	if (label.startsWith('--')) {
		return 'label cannot start with "--" (git flag pattern)';
	}
	if (CONTROL_CHAR_PATTERN.test(label)) {
		return 'label contains control characters';
	}
	if (NON_ASCII_PATTERN.test(label)) {
		return 'label contains non-ASCII or invalid characters';
	}
	if (containsNonAsciiChars(label)) {
		return 'label contains non-ASCII characters (must be printable ASCII only)';
	}
	if (SHELL_METACHARACTERS.test(label)) {
		return 'label contains shell metacharacters';
	}
	if (!SAFE_LABEL_PATTERN.test(label)) {
		return 'label contains invalid characters (use alphanumeric, hyphen, underscore, space)';
	}
	if (!/[a-zA-Z0-9_]/.test(label)) {
		return 'label cannot be whitespace-only';
	}
	if (label.includes('..') || label.includes('/') || label.includes('\\')) {
		return 'label contains path traversal sequence';
	}
	return null;
}

function getCheckpointLogPath(directory: string): string {
	return path.join(directory, CHECKPOINT_LOG_PATH);
}

function readCheckpointLog(directory: string): CheckpointLog {
	const logPath = getCheckpointLogPath(directory);
	try {
		if (fs.existsSync(logPath)) {
			const content = fs.readFileSync(logPath, 'utf-8');
			const parsed = JSON.parse(content) as CheckpointLog;
			if (!parsed.checkpoints || !Array.isArray(parsed.checkpoints)) {
				return { version: 1, checkpoints: [] };
			}
			return parsed;
		}
	} catch {
		// Corrupted or unreadable log falls back to empty.
	}
	return { version: 1, checkpoints: [] };
}

function writeCheckpointLog(log: CheckpointLog, directory: string): void {
	const logPath = getCheckpointLogPath(directory);
	const dir = path.dirname(logPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const tempPath = `${logPath}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(log, null, 2), 'utf-8');
	fs.renameSync(tempPath, logPath);
}

function appendRetentionEvent(directory: string, event: RetentionEvent): void {
	try {
		appendCoreEventSync(directory, {
			...event,
			timestamp: new Date().toISOString(),
		});
	} catch {
		// Best-effort event logging only.
	}
}

function loadCheckpointConfig(directory: string): {
	maxCheckpoints: number;
	allowEmptyCommits: boolean;
} {
	let maxCheckpoints = 20;
	let allowEmptyCommits = false;
	try {
		const { config } = loadPluginConfigWithMeta(directory);
		maxCheckpoints = config.checkpoint?.max_retention ?? maxCheckpoints;
		allowEmptyCommits = config.checkpoint?.allow_empty_commits === true;
	} catch {
		// Defaults are fine when config loading fails.
	}
	return { maxCheckpoints, allowEmptyCommits };
}

function appendCheckpointEntry(
	directory: string,
	log: CheckpointLog,
	entry: CheckpointEntry,
	maxCheckpoints: number,
): void {
	const existing = log.checkpoints.find(
		(checkpoint) => checkpoint.label === entry.label,
	);
	if (existing) {
		if (existing.sha !== entry.sha) {
			throw new Error(
				`checkpoint log conflict: label "${entry.label}" already exists with a different SHA`,
			);
		}
		return;
	}

	log.checkpoints.push(entry);
	if (log.checkpoints.length > maxCheckpoints) {
		const evicted = log.checkpoints.splice(
			0,
			log.checkpoints.length - maxCheckpoints,
		);
		appendRetentionEvent(directory, {
			event: 'checkpoint_retention_applied',
			evicted_labels: evicted.map((checkpoint) => checkpoint.label),
			evicted_count: evicted.length,
			remaining_count: log.checkpoints.length,
		});
	}
}

function upsertTaskCompletionCheckpointEntry(
	directory: string,
	log: CheckpointLog,
	entry: CheckpointEntry,
	maxCheckpoints: number,
): void {
	const existingIndex = log.checkpoints.findIndex(
		(checkpoint) => checkpoint.label === entry.label,
	);
	if (existingIndex >= 0) {
		const existing = log.checkpoints[existingIndex];
		if (existing.sha === entry.sha) {
			return;
		}
		log.checkpoints[existingIndex] = entry;
		return;
	}

	log.checkpoints.push(entry);
	if (log.checkpoints.length > maxCheckpoints) {
		const evicted = log.checkpoints.splice(
			0,
			log.checkpoints.length - maxCheckpoints,
		);
		appendRetentionEvent(directory, {
			event: 'checkpoint_retention_applied',
			evicted_labels: evicted.map((checkpoint) => checkpoint.label),
			evicted_count: evicted.length,
			remaining_count: log.checkpoints.length,
		});
	}
}

function stageAllExcludingSwarm(directory: string): void {
	_internals.gitExec(
		['add', '--all', '--', ...NON_SWARM_COMMIT_PATHSPEC],
		directory,
	);
}

function gitExec(args: string[], cwd: string): string {
	for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
		const result = child_process.spawnSync(
			_internals.resolveGitExecutable(),
			args,
			{
				cwd,
				encoding: 'utf-8',
				timeout: GIT_TIMEOUT_MS,
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				maxBuffer: GIT_MAX_BUFFER_BYTES,
			},
		);

		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			const message = result.error.message ?? '';
			const isTransient =
				isTransientSpawnError(result.error) ||
				/ETIMEDOUT|timed out/i.test(message);

			if (!isTransient || attempt >= MAX_TRANSIENT_RETRIES - 1) {
				// #2236 F0d: this is the other site that formatted a raw spawn
				// message into user-visible text. An ENOENT here does NOT mean git
				// is missing — it means that just as often when `cwd` has been torn
				// down. Classify with the cwd we already hold rather than leaking
				// the raw errno. Classification lives inside the throw branch so
				// the transient-retry set above is untouched.
				if (isSpawnCwdMissing(result.error, cwd)) {
					throw new GitSpawnCwdError(cwd, 'missing');
				}
				if (isSpawnCwdUnreadable(result.error, cwd)) {
					throw new GitSpawnCwdError(cwd, 'unreadable');
				}
				if (isGitBinaryMissing(result.error, cwd)) {
					throw new GitBinaryMissingError(
						`git executable is not available on PATH (working directory ${cwd} exists)`,
						{ cause: result.error },
					);
				}
				throw new Error(
					`git failed to start: ${code ?? 'unknown'} - ${message}`,
				);
			}

			transientBackoff(attempt);
			continue;
		}

		if (result.status === 0) {
			return result.stdout ?? '';
		}

		throw new Error(
			result.stderr?.trim() || `git exited with code ${result.status}`,
		);
	}

	throw new Error('git command failed after transient retries');
}

function getCurrentSha(directory: string): string {
	return gitExec(['rev-parse', 'HEAD'], directory).trim();
}

function findCommitByExactSubject(
	directory: string,
	subject: string,
): string | null {
	const output = _internals.gitExec(
		[
			'log',
			'HEAD',
			'--format=%H%x00%s',
			'--fixed-strings',
			`--grep=${subject}`,
			'-n',
			String(CHECKPOINT_RECEIPT_LOOKUP_LIMIT),
		],
		directory,
	);
	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		const nulIndex = line.indexOf('\0');
		if (nulIndex <= 0) continue;
		const sha = line.slice(0, nulIndex).trim();
		const candidateSubject = line.slice(nulIndex + 1);
		if (
			sha.length === 40 &&
			/^[a-f0-9]{40}$/i.test(sha) &&
			candidateSubject === subject
		) {
			return sha;
		}
	}
	return null;
}

async function withTaskCompletionLocksResult<T>(input: {
	directory: string;
	taskId: string;
	run: () => Promise<T>;
	onBusy?: (attempts: number) => T;
	onFailure?: (error: unknown) => T;
}): Promise<T> {
	const deadline = Date.now() + CHECKPOINT_LOCK_DEADLINE_MS;
	let attempts = 0;

	while (attempts < CHECKPOINT_LOCK_MAX_ATTEMPTS && Date.now() <= deadline) {
		attempts++;
		let planLockResult: Awaited<ReturnType<typeof tryAcquireLock>>;
		try {
			planLockResult = await _internals.tryAcquireLock(
				input.directory,
				PLAN_LOCK_PATH,
				CHECKPOINT_AGENT_NAME,
				`save-task-completion-plan-${input.taskId}`,
			);
		} catch (error) {
			if (input.onFailure) {
				return input.onFailure(error);
			}
			return serializeResult('save_task_completion', {
				success: false,
				error: `save_task_completion failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			}) as T;
		}

		if (!planLockResult.acquired) {
			if (
				attempts >= CHECKPOINT_LOCK_MAX_ATTEMPTS ||
				Date.now() + CHECKPOINT_LOCK_DELAY_MS > deadline
			) {
				break;
			}
			await _internals.sleep(CHECKPOINT_LOCK_DELAY_MS);
			continue;
		}

		try {
			let checkpointLockResult: Awaited<ReturnType<typeof tryAcquireLock>>;
			try {
				checkpointLockResult = await _internals.tryAcquireLock(
					input.directory,
					CHECKPOINT_LOG_PATH,
					CHECKPOINT_AGENT_NAME,
					`save-task-completion-checkpoint-${input.taskId}`,
				);
			} catch (error) {
				if (input.onFailure) {
					return input.onFailure(error);
				}
				return serializeResult('save_task_completion', {
					success: false,
					error: `save_task_completion failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				}) as T;
			}

			if (!checkpointLockResult.acquired) {
				if (
					attempts >= CHECKPOINT_LOCK_MAX_ATTEMPTS ||
					Date.now() + CHECKPOINT_LOCK_DELAY_MS > deadline
				) {
					break;
				}
				await _internals.sleep(CHECKPOINT_LOCK_DELAY_MS);
				continue;
			}

			try {
				return await input.run();
			} catch (error) {
				if (input.onFailure) {
					return input.onFailure(error);
				}
				return serializeResult('save_task_completion', {
					success: false,
					error: `save_task_completion failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				}) as T;
			} finally {
				if (checkpointLockResult.lock._release) {
					try {
						await checkpointLockResult.lock._release();
					} catch {
						// Release failure is advisory only.
					}
				}
			}
		} finally {
			if (planLockResult.lock._release) {
				try {
					await planLockResult.lock._release();
				} catch {
					// Release failure is advisory only.
				}
			}
		}
	}

	if (input.onBusy) {
		return input.onBusy(attempts);
	}
	return serializeResult('save_task_completion', {
		success: false,
		status: 'checkpoint_busy',
		error:
			'checkpoint_busy: checkpoint or plan state is locked by another operation; retry after the current mutation completes',
		retryable: true,
		attempts,
	}) as T;
}

async function withCheckpointMutationLock(input: {
	action: MutationAction;
	directory: string;
	operationKey: string;
	run: () => Promise<string>;
	onContendedAttempt?: () => string | null;
}): Promise<string> {
	const result = await withCheckpointMutationLockResult({
		action: input.action,
		directory: input.directory,
		operationKey: input.operationKey,
		run: input.run,
		onContendedAttempt: input.onContendedAttempt,
	});
	return result;
}

async function withCheckpointMutationLockResult<T>(input: {
	action: MutationAction;
	directory: string;
	operationKey: string;
	run: () => Promise<T>;
	onContendedAttempt?: () => T | null;
	onBusy?: (attempts: number) => T;
	onFailure?: (error: unknown) => T;
}): Promise<T> {
	const deadline = Date.now() + CHECKPOINT_LOCK_DEADLINE_MS;
	let attempts = 0;

	while (attempts < CHECKPOINT_LOCK_MAX_ATTEMPTS && Date.now() <= deadline) {
		attempts++;
		let lockResult: Awaited<ReturnType<typeof tryAcquireLock>>;
		try {
			lockResult = await _internals.tryAcquireLock(
				input.directory,
				CHECKPOINT_LOG_PATH,
				CHECKPOINT_AGENT_NAME,
				input.operationKey,
			);
		} catch (error) {
			if (input.onFailure) {
				return input.onFailure(error);
			}
			return serializeResult(input.action, {
				success: false,
				error: `${input.action} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			}) as T;
		}

		if (lockResult.acquired) {
			try {
				try {
					return await input.run();
				} catch (error) {
					if (input.onFailure) {
						return input.onFailure(error);
					}
					return serializeResult(input.action, {
						success: false,
						error: `${input.action} failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					}) as T;
				}
			} finally {
				if (lockResult.lock._release) {
					try {
						await lockResult.lock._release();
					} catch {
						// Release failure is advisory only.
					}
				}
			}
		}

		const contended = input.onContendedAttempt?.();
		if (contended) return contended;
		if (
			attempts >= CHECKPOINT_LOCK_MAX_ATTEMPTS ||
			Date.now() + CHECKPOINT_LOCK_DELAY_MS > deadline
		) {
			break;
		}
		await _internals.sleep(CHECKPOINT_LOCK_DELAY_MS);
	}

	if (input.onBusy) {
		return input.onBusy(attempts);
	}
	return serializeResult(input.action, {
		success: false,
		status: 'checkpoint_busy',
		error:
			'checkpoint_busy: checkpoint state is locked by another operation; retry after the current mutation completes',
		retryable: true,
		attempts,
	}) as T;
}

function handleSave(label: string, directory: string): string {
	try {
		const { maxCheckpoints, allowEmptyCommits } =
			loadCheckpointConfig(directory);
		const log = readCheckpointLog(directory);
		const existingCheckpoint = log.checkpoints.find(
			(checkpoint) => checkpoint.label === label,
		);
		if (existingCheckpoint) {
			return serializeResult('save', {
				success: false,
				error: `duplicate label: "${label}" already exists. Use a different label or delete the existing checkpoint first.`,
			});
		}

		const timestamp = new Date().toISOString();
		_internals.stageAllExcludingSwarm(directory);
		const hasStagedChanges = (() => {
			try {
				gitExec(['diff', '--cached', '--quiet'], directory);
				return false;
			} catch {
				return true;
			}
		})();

		if (hasStagedChanges) {
			gitExec(['commit', '-m', `checkpoint: ${label}`], directory);
		} else if (allowEmptyCommits) {
			gitExec(
				['commit', '--allow-empty', '-m', `checkpoint: ${label}`],
				directory,
			);
		}

		const newSha = getCurrentSha(directory);
		appendCheckpointEntry(
			directory,
			log,
			{
				label,
				sha: newSha,
				timestamp,
			},
			maxCheckpoints,
		);
		writeCheckpointLog(log, directory);

		return serializeResult('save', {
			success: true,
			label,
			sha: newSha,
			message: `Checkpoint saved: "${label}"`,
		});
	} catch (e) {
		return serializeResult('save', {
			success: false,
			error:
				e instanceof Error
					? `save failed: ${e.message}`
					: 'save failed: unknown error',
		});
	}
}

export async function saveCheckpointRecord(
	label: string,
	directory: string,
): Promise<{
	success: boolean;
	sha?: string;
	error?: string;
	warning?: string;
}> {
	const labelError = validateLabel(label);
	if (labelError) {
		return { success: false, error: labelError };
	}
	return withCheckpointMutationLockResult({
		action: 'save',
		directory,
		operationKey: `save-record-${label}`,
		run: async () => {
			const log = readCheckpointLog(directory);
			if (log.checkpoints.find((checkpoint) => checkpoint.label === label)) {
				return { success: false, error: `duplicate label: "${label}"` };
			}
			let sha = '';
			// #3427: the repository probe rides the shared async reader
			// (bounded, killable) instead of the local sync gitExec retry
			// chain — on a host whose sync spawns stall (#3275), this leg no
			// longer blocks the save path. This is a DURABLE write inside the
			// mutation lock, so unlike the entry preflight it keeps bounded
			// transient tolerance: readGitStatusAsync retries a transient
			// spawn failure once (feedback round PRR-003) instead of letting
			// a single EBUSY/EPERM/ETIMEDOUT record a sha-less checkpoint.
			// NOTE: readGitStatusAsync resolves to a full GitStatusReadResult
			// object (always truthy) — branch on `.ok`, never on the object.
			const saveProbe = await _internals.readGitStatusAsync(
				['rev-parse', '--git-dir'],
				directory,
			);
			if (saveProbe.ok) {
				try {
					sha = getCurrentSha(directory);
				} catch {
					sha = '';
				}
			}
			appendCheckpointEntry(
				directory,
				log,
				{
					label,
					sha,
					timestamp: new Date().toISOString(),
				},
				loadCheckpointConfig(directory).maxCheckpoints,
			);
			writeCheckpointLog(log, directory);
			const result: {
				success: boolean;
				sha?: string;
				error?: string;
				warning?: string;
			} = { success: true, sha };
			if (!sha) {
				result.warning =
					'no git restore target - checkpoint recorded without a SHA (directory may not be a git repository or HEAD is unavailable)';
			}
			return result;
		},
		onBusy: () => ({
			success: false,
			error:
				'checkpoint_busy: checkpoint state is locked by another operation; retry after the current mutation completes',
		}),
		onFailure: (error) => ({
			success: false,
			error: error instanceof Error ? error.message : 'unknown error',
		}),
	});
}

async function handleRestore(
	label: string,
	directory: string,
	confirmToken?: string,
): Promise<string> {
	try {
		const log = readCheckpointLog(directory);
		const checkpoint = log.checkpoints.find(
			(candidate) => candidate.label === label,
		);
		if (!checkpoint) {
			return serializeResult('restore', {
				success: false,
				error: `checkpoint not found: "${label}"`,
			});
		}

		// #2946: a destructive scope (uncommitted tracked work, or untracked
		// files at paths the target tree materializes, that a hard reset
		// would discard) requires the two-step preview + confirm-token
		// contract. The candidate set is derived by the shared rollback-gate
		// module so a token minted by /swarm rollback or /swarm checkpoint
		// (command layer) is consumable here at the sink — and vice versa.
		// Routed through the _internals seam (feedback round) so tests can
		// stub the measurement without a process-global module mock.
		const measurement = await _internals.measureGitDestruction(
			directory,
			checkpoint.sha,
		);
		if (measurement.kind === 'unreadable') {
			// #3317: name WHY the read failed when the async reader could tell
			// (single shared source with the /swarm rollback command). #3434:
			// this also covers an unreadable ls-tree/ls-files enumeration,
			// and the `source` field names WHICH read failed.
			const cause = describeUnreadableCause(measurement, measurement.source);
			const unreadableNote =
				measurement.excludedOutOfRoot &&
				measurement.excludedOutOfRoot.length > 0
					? ` — ${measurement.excludedOutOfRoot.length} out-of-root porcelain record(s) had been excluded from the scope before the read failed (first: ${formatExcludedRecord(measurement.excludedOutOfRoot[0])})`
					: '';
			return serializeResult('restore', {
				success: false,
				error: `cannot verify the working tree (${
					measurement.source === 'enumeration'
						? 'the target-tree listing could not be read'
						: 'git status unreadable'
				}; ${cause})${unreadableNote} — refusing to restore without a preview.`,
			});
		}
		// #3434: bounded diagnostic for out-of-root porcelain records
		// excluded from the destroy scope — surfaced on the preview, the
		// confirmed restore, and the clean-tree restore below, so an
		// exclusion is never silent. Record bytes pass through
		// formatExcludedRecord before reaching operator/agent-visible text.
		const exclusionNote =
			measurement.excludedOutOfRoot.length > 0
				? `${measurement.excludedOutOfRoot.length} out-of-root porcelain record(s) were excluded from this scope (first: ${formatExcludedRecord(measurement.excludedOutOfRoot[0])})`
				: null;
		if (measurement.dirtyRelPaths.length > 0) {
			const candidates = trackedDirtyCandidates(
				directory,
				measurement.dirtyRelPaths,
			);
			const scopeAnchor = candidates[0].path;
			if (!confirmToken) {
				const token = issueConfirmToken(scopeAnchor, directory, {
					kind: ROLLBACK_GIT_KIND,
					candidates,
				});
				const shown = measurement.dirtyRelPaths.slice(0, 10);
				const overflow = measurement.dirtyRelPaths.length - shown.length;
				return serializeResult('restore', {
					success: false,
					requires_confirm: true,
					preview: [
						`Restoring to checkpoint "${label}" runs a hard git reset and would DESTROY ${candidates.length} uncommitted tracked file(s):`,
						...shown.map((p) => `  - ${p}`),
						...(overflow > 0 ? [`  (+${overflow} more)`] : []),
						...(exclusionNote ? [`⚠ ${exclusionNote}`] : []),
						'Backups are taken automatically once confirmed.',
					],
					confirm_token: token,
					message:
						'restore preview — re-run with confirm_token to execute (valid 15 minutes)',
				});
			}
			const verdict = consumeConfirmToken(
				scopeAnchor,
				directory,
				confirmToken,
				{ kind: ROLLBACK_GIT_KIND, candidates },
			);
			if (!verdict.ok) {
				return serializeResult('restore', {
					success: false,
					error: verdict.reason,
				});
			}
			const backup = backupTrackedChangesBeforeRollback(
				directory,
				measurement.dirtyRelPaths,
			);
			// Fail closed when the safety net is incomplete: a destructive
			// restore never proceeds over files whose current bytes were not
			// actually copied (#2976 review F-3). Only paths that exist on
			// disk owe a copy — a rename record's ORIG side has no live bytes
			// (the file moved), so requiring it would refuse every rename.
			const atRiskExisting = measurement.dirtyRelPaths.filter((rel) =>
				fs.existsSync(path.join(directory, rel)),
			).length;
			if (!backup.backupDir || backup.copied.length < atRiskExisting) {
				return serializeResult('restore', {
					success: false,
					error: `backup incomplete (${backup.copied.length}/${atRiskExisting} at-risk file(s) copied) — restore refused so nothing is destroyed.${
						backup.warnings.length > 0
							? ` Warnings: ${backup.warnings.join('; ')}`
							: ''
					}`,
				});
			}
			const logBeforeReset = log;
			gitExec(['reset', '--hard', checkpoint.sha], directory);
			writeCheckpointLog(logBeforeReset, directory);
			return serializeResult('restore', {
				success: true,
				label,
				sha: checkpoint.sha,
				backup_dir: backup.backupDir,
				...(backup.warnings.length > 0
					? { backup_warnings: backup.warnings }
					: {}),
				message: `Restored to checkpoint: "${label}" (hard reset)${
					backup.backupDir
						? `; destroyed bytes backed up to ${path.relative(directory, backup.backupDir)}`
						: ''
				}${
					backup.warnings.length > 0
						? `; warnings: ${backup.warnings.join('; ')}`
						: ''
				}${
					// #3442: the confirmed destructive restore carries the
					// exclusion note like its preview and clean-tree siblings —
					// a record excluded between preview and confirm is never
					// silently dropped from the executed scope's report.
					exclusionNote ? `; ⚠ ${exclusionNote}` : ''
				}`,
			});
		}

		// Clean tree: nothing tracked to destroy — single-call restore. When
		// every dirty record was out-of-root-excluded (#3434), the operator
		// still sees what was dropped.
		const logBeforeReset = log;
		gitExec(['reset', '--hard', checkpoint.sha], directory);
		writeCheckpointLog(logBeforeReset, directory);

		return serializeResult('restore', {
			success: true,
			label,
			sha: checkpoint.sha,
			message: `Restored to checkpoint: "${label}" (hard reset)${
				exclusionNote ? `; ⚠ ${exclusionNote}` : ''
			}`,
		});
	} catch (e) {
		return serializeResult('restore', {
			success: false,
			error:
				e instanceof Error
					? `restore failed: ${e.message}`
					: 'restore failed: unknown error',
		});
	}
}

function handleList(directory: string): string {
	const log = readCheckpointLog(directory);
	const sorted = [...log.checkpoints].sort((a, b) =>
		b.timestamp.localeCompare(a.timestamp),
	);
	return serializeResult('list', {
		success: true,
		count: sorted.length,
		checkpoints: sorted,
	});
}

function handleDelete(label: string, directory: string): string {
	try {
		const log = readCheckpointLog(directory);
		const initialLength = log.checkpoints.length;
		log.checkpoints = log.checkpoints.filter(
			(checkpoint) => checkpoint.label !== label,
		);
		if (log.checkpoints.length === initialLength) {
			return serializeResult('delete', {
				success: false,
				error: `checkpoint not found: "${label}"`,
			});
		}
		writeCheckpointLog(log, directory);
		return serializeResult('delete', {
			success: true,
			label,
			message: `Checkpoint deleted: "${label}"`,
		});
	} catch (e) {
		return serializeResult('delete', {
			success: false,
			error:
				e instanceof Error
					? `delete failed: ${e.message}`
					: 'delete failed: unknown error',
		});
	}
}

async function handleSaveTaskCompletion(
	taskId: string,
	directory: string,
): Promise<string> {
	return withTaskCompletionLocksResult({
		directory,
		taskId,
		run: async () => {
			const plan = await _internals.loadPlan(directory);
			if (!plan) {
				return serializeResult('save_task_completion', {
					success: false,
					error:
						'save_task_completion failed: no durable plan is available under .swarm/plan.json',
				});
			}

			const task = plan.phases
				.flatMap((phase) => phase.tasks)
				.find((candidate) => candidate.id === taskId);
			if (!task) {
				return serializeResult('save_task_completion', {
					success: false,
					error: `save_task_completion failed: task "${taskId}" was not found in the current plan`,
				});
			}
			if (task.status !== 'completed') {
				return serializeResult('save_task_completion', {
					success: false,
					error: `save_task_completion failed: task "${taskId}" is ${task.status}, not completed`,
				});
			}
			await _internals.afterTaskEligibilityRead?.(directory, task.id);

			const planIdentityHash = derivePlanIdentityHash(plan);
			const planId = derivePlanId(plan);
			const ledgerEvents = await readLedgerEvents(directory);
			const planEvents = ledgerEvents.filter(
				(event) => event.plan_id === planId,
			);
			const anchor = planEvents.find(
				(event) => event.event_type === 'plan_created',
			);
			const anchorPlan = anchor?.payload?.plan;
			if (anchorPlan && typeof anchorPlan === 'object') {
				const rawIdentity = anchorPlan as { swarm?: unknown; title?: unknown };
				if (
					typeof rawIdentity.swarm !== 'string' ||
					typeof rawIdentity.title !== 'string' ||
					derivePlanIdentityHash({
						swarm: rawIdentity.swarm,
						title: rawIdentity.title,
					}) !== planIdentityHash
				) {
					throw new Error(
						`save_task_completion failed: ledger identity does not match the current plan for task "${task.id}"`,
					);
				}
			}
			const latestTaskStatusEvent = [...planEvents]
				.reverse()
				.find(
					(event) =>
						event.event_type === 'task_status_changed' &&
						event.task_id === task.id,
				);
			if (
				latestTaskStatusEvent &&
				latestTaskStatusEvent.to_status !== 'completed'
			) {
				throw new Error(
					`save_task_completion failed: the authoritative ledger does not record task "${task.id}" as completed`,
				);
			}
			// An initially-completed plan has no task_status_changed event. Its
			// immutable plan_created sequence is the stable completion epoch; zero is
			// reserved for legacy disk-only plans without a readable ledger anchor.
			const completionLedgerSeq =
				latestTaskStatusEvent?.seq ?? anchor?.seq ?? 0;
			const receipt = ensureTaskCheckpointReceipt(
				directory,
				planIdentityHash,
				task.id,
				completionLedgerSeq,
			);
			const descriptor = buildTaskCompletionDescriptor(
				planIdentityHash,
				task.id,
				receipt.generation,
			);
			if (receipt.label !== descriptor.label) {
				throw new Error(
					`Task checkpoint receipt label conflict for ${task.id}: expected ${descriptor.label}, found ${receipt.label}`,
				);
			}
			if (receipt.state === 'logged') {
				return serializeResult('save_task_completion', {
					success: true,
					idempotent: true,
					label: receipt.label,
					sha: receipt.sha,
					receipt_state: receipt.state,
					message: `Checkpoint task completion already logged for "${descriptor.taskId}"`,
				});
			}

			const recoveredSha = _internals.findCommitByExactSubject(
				directory,
				descriptor.subject,
			);
			let committedSha: string | null = null;
			committedSha = recoveredSha ?? receipt.sha;

			if (!committedSha) {
				_internals.stageAllExcludingSwarm(directory);
				// Keep the commit path-limited as well as the preceding add. An
				// exclusion on `git add` does not unstage a force-added .swarm file;
				// the pathspec commit excludes it while leaving its index entry intact.
				_internals.gitExec(
					[
						'commit',
						'--allow-empty',
						'-m',
						descriptor.subject,
						'--',
						...NON_SWARM_COMMIT_PATHSPEC,
					],
					directory,
				);
				committedSha = getCurrentSha(directory);
			}
			if (!committedSha) {
				throw new Error(
					`save_task_completion failed: could not resolve commit SHA for task "${descriptor.taskId}"`,
				);
			}

			updateTaskCheckpointReceipt(
				directory,
				descriptor,
				'committed',
				committedSha,
			);

			const log = readCheckpointLog(directory);
			upsertTaskCompletionCheckpointEntry(
				directory,
				log,
				{
					label: descriptor.label,
					sha: committedSha,
					timestamp: new Date().toISOString(),
				},
				loadCheckpointConfig(directory).maxCheckpoints,
			);
			writeCheckpointLog(log, directory);
			const logged = updateTaskCheckpointReceipt(
				directory,
				descriptor,
				'logged',
				committedSha,
			);

			return serializeResult('save_task_completion', {
				success: true,
				label: logged.label,
				sha: committedSha,
				receipt_state: logged.state,
				message: `Checkpoint task completion saved for "${descriptor.taskId}"`,
			});
		},
	});
}

export const checkpoint: ToolDefinition = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		'Save, restore, list, and delete git checkpoints. ' +
		'Use save to create a named snapshot, restore to return tracked files to a checkpoint (a destructive restore previews first and requires a confirm token issued in the preview; destroyed bytes are backed up under .swarm/rollback-backups/), ' +
		'list to see all checkpoints, delete to remove a checkpoint from the log, and save_task_completion to record a retry-safe task completion checkpoint. ' +
		'Git commits are preserved on delete.',
	args: {
		action: z
			.string()
			.describe(
				'Action to perform: save, restore, list, delete, or save_task_completion',
			),
		label: z
			.string()
			.optional()
			.describe('Checkpoint label (required for save, restore, delete)'),
		confirm_token: z
			.string()
			.optional()
			.describe(
				'Confirm token from a destructive-restore preview (required when restore would destroy uncommitted tracked work; the preview response carries the token)',
			),
		task_id: z
			.string()
			.optional()
			.describe('Plan task ID (required for save_task_completion), e.g. "1.1"'),
	},
	execute: async (args, directory) => {
		// #3427: the entry preflight rides the shared async reader
		// (single-attempt `rev-parse --git-dir`, bounded, killable) instead of
		// the local sync gitExec retry chain — on a host whose sync child
		// spawns stall (#3275), every checkpoint action (list and restore
		// alike) no longer blocks up to the transient-retry horizon before
		// refusing. #3442: the probe is the DETAILED twin so the refusal
		// names the cause (non-repository vs unavailable executable vs a git
		// error) instead of a uniform not-a-repository message — still
		// single-attempt, so the wedge fix is unchanged.
		const repoStatus =
			await _internals.readGitRepositoryStatusDetailedAsync(directory);
		if (!repoStatus.isRepo) {
			const reason =
				repoStatus.reason === 'not_git_repo'
					? 'not a git repository'
					: repoStatus.reason === 'git_unavailable'
						? 'git executable is not available'
						: `git probe failed (${repoStatus.message})`;
			return serializeResult('unknown', {
				success: false,
				error: `${reason} - checkpoint tools require a git repository`,
			});
		}

		let action: string;
		let label: string | undefined;
		let confirmToken: string | undefined;
		let taskId: string | undefined;
		try {
			action = String(args.action);
			label =
				args.label !== undefined && args.label !== null
					? String(args.label)
					: undefined;
			confirmToken =
				args.confirm_token !== undefined && args.confirm_token !== null
					? String(args.confirm_token)
					: undefined;
			taskId =
				args.task_id !== undefined && args.task_id !== null
					? String(args.task_id)
					: undefined;
		} catch {
			return serializeResult('unknown', {
				success: false,
				error: 'invalid arguments',
			});
		}

		const validActions = [
			'save',
			'restore',
			'list',
			'delete',
			'save_task_completion',
		];
		if (!validActions.includes(action)) {
			return serializeResult('unknown', {
				success: false,
				error: `invalid action: "${action}". Valid actions: ${validActions.join(', ')}`,
			});
		}

		if (['save', 'restore', 'delete'].includes(action)) {
			if (!label) {
				return serializeResult(action as MutationAction, {
					success: false,
					error: `label is required for ${action} action`,
				});
			}
			const labelError = validateLabel(label);
			if (labelError) {
				return serializeResult(action as MutationAction, {
					success: false,
					error: `invalid label: ${labelError}`,
				});
			}
		}

		if (action === 'save_task_completion') {
			if (!taskId || taskId.trim().length === 0) {
				return serializeResult('save_task_completion', {
					success: false,
					error: 'task_id is required for save_task_completion action',
				});
			}
		}

		switch (action) {
			case 'save':
				return withCheckpointMutationLock({
					action: 'save',
					directory,
					operationKey: `save-${label!}`,
					run: async () => handleSave(label!, directory),
				});
			case 'restore':
				return withCheckpointMutationLock({
					action: 'restore',
					directory,
					operationKey: `restore-${label!}`,
					run: async () => await handleRestore(label!, directory, confirmToken),
				});
			case 'list':
				return handleList(directory);
			case 'delete':
				return withCheckpointMutationLock({
					action: 'delete',
					directory,
					operationKey: `delete-${label!}`,
					run: async () => handleDelete(label!, directory),
				});
			case 'save_task_completion':
				return handleSaveTaskCompletion(taskId!, directory);
			default:
				return serializeResult('unknown', {
					success: false,
					error: 'unreachable',
				});
		}
	},
});
