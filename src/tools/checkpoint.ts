import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { createSwarmTool } from './create-tool';

// ============ Constants ============
const CHECKPOINT_LOG_PATH = '.swarm/checkpoints.json';
const MAX_LABEL_LENGTH = 100;
const GIT_TIMEOUT_MS = 30_000;

// Shell metacharacters that could enable injection
const SHELL_METACHARACTERS = /[;|&$`(){}<>!'"]/;

// Safe characters for labels: ASCII alphanumeric, hyphens, underscores, literal spaces only
// Excludes tabs, newlines, control chars, BOM, non-ASCII unicode, emoji, etc.
const SAFE_LABEL_PATTERN = /^[a-zA-Z0-9_ -]+$/;

// ============ Types ============
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

// ============ Validation ============

// Control characters to reject: tab, newline, carriage return, vertical tab, form feed, null, etc.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security validation pattern
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// BOM and non-ASCII unicode pattern (emoji, accented chars, etc.)
const NON_ASCII_PATTERN = /[^\x20-\x7E]/;

/**
 * Explicit character-code based ASCII validation.
 * Rejects any character outside printable ASCII range 0x20..0x7E.
 * This provides deterministic rejection of non-ASCII labels (emoji, accented chars like café).
 */
function containsNonAsciiChars(label: string): boolean {
	for (let i = 0; i < label.length; i++) {
		const charCode = label.charCodeAt(i);
		if (charCode < 0x20 || charCode > 0x7e) {
			return true;
		}
	}
	return false;
}

/**
 * Validate checkpoint label - no shell metacharacters or path traversal
 */
function validateLabel(label: string): string | null {
	if (!label || label.length === 0) {
		return 'label is required';
	}
	if (label.length > MAX_LABEL_LENGTH) {
		return `label exceeds maximum length of ${MAX_LABEL_LENGTH}`;
	}
	// Reject git flag patterns (--prefix)
	if (label.startsWith('--')) {
		return 'label cannot start with "--" (git flag pattern)';
	}
	// Reject control characters
	if (CONTROL_CHAR_PATTERN.test(label)) {
		return 'label contains control characters';
	}
	// Reject BOM and non-ASCII characters (emoji, accented chars, etc.)
	if (NON_ASCII_PATTERN.test(label)) {
		return 'label contains non-ASCII or invalid characters';
	}
	// Explicit character-code check: reject any char outside printable ASCII 0x20..0x7E
	if (containsNonAsciiChars(label)) {
		return 'label contains non-ASCII characters (must be printable ASCII only)';
	}
	if (SHELL_METACHARACTERS.test(label)) {
		return 'label contains shell metacharacters';
	}
	if (!SAFE_LABEL_PATTERN.test(label)) {
		return 'label contains invalid characters (use alphanumeric, hyphen, underscore, space)';
	}
	// Reject whitespace-only labels (label must contain at least one non-space char)
	if (!/[a-zA-Z0-9_]/.test(label)) {
		return 'label cannot be whitespace-only';
	}
	// Check for path traversal
	if (label.includes('..') || label.includes('/') || label.includes('\\')) {
		return 'label contains path traversal sequence';
	}
	return null;
}

// ============ File Operations ============

/**
 * Get the checkpoint log file path (absolute)
 */
function getCheckpointLogPath(directory: string): string {
	return path.join(directory, CHECKPOINT_LOG_PATH);
}

/**
 * Read existing checkpoint log or create empty one
 */
function readCheckpointLog(directory: string): CheckpointLog {
	const logPath = getCheckpointLogPath(directory);
	try {
		if (fs.existsSync(logPath)) {
			const content = fs.readFileSync(logPath, 'utf-8');
			const parsed = JSON.parse(content) as CheckpointLog;
			// Validate structure
			if (!parsed.checkpoints || !Array.isArray(parsed.checkpoints)) {
				return { version: 1, checkpoints: [] };
			}
			return parsed;
		}
	} catch {
		// If file is corrupted, return empty log
	}
	return { version: 1, checkpoints: [] };
}

/**
 * Write checkpoint log atomically
 */
function writeCheckpointLog(log: CheckpointLog, directory: string): void {
	const logPath = getCheckpointLogPath(directory);
	const dir = path.dirname(logPath);
	// Ensure .swarm directory exists
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	// Write atomically using temp file
	const tempPath = `${logPath}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(log, null, 2), 'utf-8');
	fs.renameSync(tempPath, logPath);
}

// ============ Git Operations ============

/**
 * Execute git command safely using spawnSync with argument array (no shell interpolation)
 */
function gitExec(args: string[], cwd: string): string {
	const result = child_process.spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: GIT_TIMEOUT_MS,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.error) {
		throw new Error(
			`git failed to start: ${(result.error as NodeJS.ErrnoException).code ?? 'unknown'} — ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		throw new Error(
			result.stderr?.trim() || `git exited with code ${result.status}`,
		);
	}
	return result.stdout;
}

function appendRetentionEvent(directory: string, event: RetentionEvent): void {
	try {
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		const line = `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`;
		fs.appendFileSync(eventsPath, line);
	} catch {
		// Event logging is best-effort — failures are silently ignored.
	}
}

/**
 * Get current git SHA
 */
function getCurrentSha(directory: string): string {
	const output = gitExec(['rev-parse', 'HEAD'], directory);
	return output.trim();
}

/**
 * Check if we're in a git repository
 */
function isGitRepo(directory: string): boolean {
	try {
		gitExec(['rev-parse', '--git-dir'], directory);
		return true;
	} catch {
		return false;
	}
}

// ============ Action Handlers ============

/**
 * Handle 'save' action - create checkpoint commit and log it
 */
function handleSave(label: string, directory: string): string {
	try {
		// Read checkpoint config
		let maxCheckpoints = 20; // sensible default
		let allowEmptyCommits = false;
		try {
			const { config } = loadPluginConfigWithMeta(directory);
			maxCheckpoints =
				config.checkpoint?.auto_checkpoint_threshold ?? maxCheckpoints;
			allowEmptyCommits = config.checkpoint?.allow_empty_commits === true;
		} catch {
			// Config load failure — use defaults
		}

		// Check for duplicate label before saving
		const log = readCheckpointLog(directory);
		const existingCheckpoint = log.checkpoints.find((c) => c.label === label);
		if (existingCheckpoint) {
			return JSON.stringify(
				{
					action: 'save',
					success: false,
					error: `duplicate label: "${label}" already exists. Use a different label or delete the existing checkpoint first.`,
				},
				null,
				2,
			);
		}

		const timestamp = new Date().toISOString();

		// Stage all changes, excluding .swarm/ to avoid committing checkpoint metadata
		// into project history. On timeout or permission error this throws, which
		// propagates to the outer catch — safer than committing a partially-staged tree.
		gitExec(['add', '--all', '--', ':!.swarm/'], directory);

		// Check whether anything was staged (exit 0 = nothing staged, non-zero = changes)
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
			// Explicit opt-in: preserve legacy behaviour of creating a commit even
			// when the working tree is clean.
			gitExec(
				['commit', '--allow-empty', '-m', `checkpoint: ${label}`],
				directory,
			);
		}
		// Otherwise: nothing to commit — checkpoint records current HEAD SHA without
		// creating a new git commit. Two consecutive clean-tree saves will share the
		// same SHA in the log; both restore correctly to the same HEAD position.

		// Get SHA (equals _sha when no commit was made)
		const newSha = getCurrentSha(directory);

		// Append to log
		log.checkpoints.push({
			label,
			sha: newSha,
			timestamp,
		});

		// Enforce checkpoint retention limit — evict oldest checkpoints
		if (log.checkpoints.length > maxCheckpoints) {
			const evicted = log.checkpoints.splice(
				0,
				log.checkpoints.length - maxCheckpoints,
			);
			try {
				appendRetentionEvent(directory, {
					event: 'checkpoint_retention_applied',
					evicted_labels: evicted.map((e) => e.label),
					evicted_count: evicted.length,
					remaining_count: log.checkpoints.length,
				});
			} catch {
				// Event logging is best-effort, don't fail the save
			}
		}

		writeCheckpointLog(log, directory);

		return JSON.stringify(
			{
				action: 'save',
				success: true,
				label,
				sha: newSha,
				message: `Checkpoint saved: "${label}"`,
			},
			null,
			2,
		);
	} catch (e) {
		const errorMessage =
			e instanceof Error
				? `save failed: ${e.message}`
				: 'save failed: unknown error';
		return JSON.stringify(
			{
				action: 'save',
				success: false,
				error: errorMessage,
			},
			null,
			2,
		);
	}
}

/**
 * Record a checkpoint without staging or committing changes.
 * Writes only to .swarm/checkpoints.json with the current HEAD SHA.
 * Used by spiral detection to avoid silently committing mid-flight user work.
 */
export function saveCheckpointRecord(
	label: string,
	directory: string,
): { success: boolean; sha?: string; error?: string } {
	const labelError = validateLabel(label);
	if (labelError) {
		return { success: false, error: labelError };
	}
	try {
		const log = readCheckpointLog(directory);
		if (log.checkpoints.find((c) => c.label === label)) {
			return { success: false, error: `duplicate label: "${label}"` };
		}
		let sha = '';
		if (isGitRepo(directory)) {
			try {
				sha = getCurrentSha(directory);
			} catch {
				sha = '';
			}
		}
		log.checkpoints.push({
			label,
			sha,
			timestamp: new Date().toISOString(),
		});
		writeCheckpointLog(log, directory);
		return { success: true, sha };
	} catch (e) {
		return {
			success: false,
			error: e instanceof Error ? e.message : 'unknown error',
		};
	}
}

/**
 * Handle 'restore' action - soft reset to saved SHA
 */
function handleRestore(label: string, directory: string): string {
	try {
		// Find the checkpoint
		const log = readCheckpointLog(directory);
		const checkpoint = log.checkpoints.find((c) => c.label === label);

		if (!checkpoint) {
			return JSON.stringify(
				{
					action: 'restore',
					success: false,
					error: `checkpoint not found: "${label}"`,
				},
				null,
				2,
			);
		}

		// Soft reset to the checkpoint SHA (preserves working tree)
		gitExec(['reset', '--soft', checkpoint.sha], directory);

		return JSON.stringify(
			{
				action: 'restore',
				success: true,
				label,
				sha: checkpoint.sha,
				message: `Restored to checkpoint: "${label}" (soft reset)`,
			},
			null,
			2,
		);
	} catch (e) {
		const errorMessage =
			e instanceof Error
				? `restore failed: ${e.message}`
				: 'restore failed: unknown error';
		return JSON.stringify(
			{
				action: 'restore',
				success: false,
				error: errorMessage,
			},
			null,
			2,
		);
	}
}

/**
 * Handle 'list' action - return all checkpoints
 */
function handleList(directory: string): string {
	const log = readCheckpointLog(directory);

	// Sort by timestamp descending (most recent first) for display
	const sorted = [...log.checkpoints].sort((a, b) =>
		b.timestamp.localeCompare(a.timestamp),
	);

	return JSON.stringify(
		{
			action: 'list',
			success: true,
			count: sorted.length,
			checkpoints: sorted,
		},
		null,
		2,
	);
}

/**
 * Handle 'delete' action - remove entry from log (git commit remains)
 */
function handleDelete(label: string, directory: string): string {
	try {
		const log = readCheckpointLog(directory);
		const initialLength = log.checkpoints.length;

		// Filter out the checkpoint with matching label
		log.checkpoints = log.checkpoints.filter((c) => c.label !== label);

		if (log.checkpoints.length === initialLength) {
			return JSON.stringify(
				{
					action: 'delete',
					success: false,
					error: `checkpoint not found: "${label}"`,
				},
				null,
				2,
			);
		}

		// Write updated log (git commit remains)
		writeCheckpointLog(log, directory);

		return JSON.stringify(
			{
				action: 'delete',
				success: true,
				label,
				message: `Checkpoint deleted: "${label}"`,
			},
			null,
			2,
		);
	} catch (e) {
		const errorMessage =
			e instanceof Error
				? `delete failed: ${e.message}`
				: 'delete failed: unknown error';
		return JSON.stringify(
			{
				action: 'delete',
				success: false,
				error: errorMessage,
			},
			null,
			2,
		);
	}
}

// ============ Tool Definition ============

export const checkpoint: ToolDefinition = createSwarmTool({
	description:
		'Save, restore, list, and delete git checkpoints. ' +
		'Use save to create a named snapshot, restore to return to a checkpoint (soft reset), ' +
		'list to see all checkpoints, and delete to remove a checkpoint from the log. ' +
		'Git commits are preserved on delete.',
	args: {
		action: z
			.string()
			.describe('Action to perform: save, restore, list, or delete'),
		label: z
			.string()
			.optional()
			.describe('Checkpoint label (required for save, restore, delete)'),
	},
	execute: async (args, directory) => {
		// Validate we're in a git repository
		if (!isGitRepo(directory)) {
			return JSON.stringify(
				{
					action: 'unknown',
					success: false,
					error: 'not a git repository',
				},
				null,
				2,
			);
		}

		// Safe args extraction
		let action: string;
		let label: string | undefined;
		try {
			action = String(args.action);
			label =
				args.label !== undefined && args.label !== null
					? String(args.label)
					: undefined;
		} catch {
			return JSON.stringify(
				{
					action: 'unknown',
					success: false,
					error: 'invalid arguments',
				},
				null,
				2,
			);
		}

		// Validate action
		const validActions = ['save', 'restore', 'list', 'delete'];
		if (!validActions.includes(action)) {
			return JSON.stringify(
				{
					action,
					success: false,
					error: `invalid action: "${action}". Valid actions: ${validActions.join(', ')}`,
				},
				null,
				2,
			);
		}

		// Validate label for actions that require it
		if (['save', 'restore', 'delete'].includes(action)) {
			if (!label) {
				return JSON.stringify(
					{
						action,
						success: false,
						error: `label is required for ${action} action`,
					},
					null,
					2,
				);
			}
			const labelError = validateLabel(label);
			if (labelError) {
				return JSON.stringify(
					{
						action,
						success: false,
						error: `invalid label: ${labelError}`,
					},
					null,
					2,
				);
			}
		}

		// Execute the action
		switch (action) {
			case 'save':
				return handleSave(label!, directory);
			case 'restore':
				return handleRestore(label!, directory);
			case 'list':
				return handleList(directory);
			case 'delete':
				return handleDelete(label!, directory);
			default:
				// This should never happen due to validation above
				return JSON.stringify(
					{
						action,
						success: false,
						error: 'unreachable',
					},
					null,
					2,
				);
		}
	},
});
