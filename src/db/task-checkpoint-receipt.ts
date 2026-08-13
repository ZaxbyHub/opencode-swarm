import { createHash } from 'node:crypto';
import { getProjectDb, projectDbExists } from './project-db.js';

export type TaskCheckpointReceiptState = 'pending' | 'committed' | 'logged';

export interface TaskCheckpointReceiptRow {
	plan_identity_hash: string;
	task_id: string;
	label: string;
	state: TaskCheckpointReceiptState;
	sha: string | null;
	generation: number;
	completion_active: number;
	completion_ledger_seq: number | null;
	created_at: string;
	updated_at: string;
}

export interface TaskCompletionCheckpointDescriptor {
	planIdentityHash: string;
	taskId: string;
	generation: number;
	label: string;
	subject: string;
}

const TASK_COMPLETION_HASH_LENGTH = 16;

function taskReceiptLabelSuffix(
	planIdentityHash: string,
	taskId: string,
	generation: number,
): string {
	return createHash('sha256')
		.update(
			JSON.stringify(
				generation === 1
					? [planIdentityHash, taskId]
					: [planIdentityHash, taskId, generation],
			),
			'utf8',
		)
		.digest('hex')
		.slice(0, TASK_COMPLETION_HASH_LENGTH);
}

function scrubTaskIdForCheckpointLabel(taskId: string): string {
	const scrubbed = taskId.replace(/[^a-zA-Z0-9._-]/g, '_');
	return scrubbed.length > 32 ? scrubbed.slice(0, 32) : scrubbed;
}

export function buildTaskCompletionDescriptor(
	planIdentityHash: string,
	taskId: string,
	generation: number,
): TaskCompletionCheckpointDescriptor {
	if (!Number.isSafeInteger(generation) || generation < 1) {
		throw new Error(`Invalid task checkpoint generation: ${generation}`);
	}
	const suffix = taskReceiptLabelSuffix(planIdentityHash, taskId, generation);
	const safeTaskId = scrubTaskIdForCheckpointLabel(taskId) || 'task';
	return {
		planIdentityHash,
		taskId,
		generation,
		label: `task-${safeTaskId}-complete-${suffix}`,
		subject:
			generation === 1
				? `checkpoint(task-complete ${suffix} plan ${planIdentityHash}): ${safeTaskId}`
				: `checkpoint(task-complete ${suffix} gen ${generation} plan ${planIdentityHash}): ${safeTaskId}`,
	};
}

export function readTaskCheckpointReceipt(
	directory: string,
	planIdentityHash: string,
	taskId: string,
): TaskCheckpointReceiptRow | null {
	if (!projectDbExists(directory)) return null;
	return (
		getProjectDb(directory)
			.query<TaskCheckpointReceiptRow, [string, string]>(
				'SELECT * FROM task_checkpoint_receipt WHERE plan_identity_hash = ? AND task_id = ?',
			)
			.get(planIdentityHash, taskId) ?? null
	);
}

export function ensureTaskCheckpointReceipt(
	directory: string,
	planIdentityHash: string,
	taskId: string,
	completionLedgerSeq: number,
): TaskCheckpointReceiptRow {
	if (!Number.isSafeInteger(completionLedgerSeq) || completionLedgerSeq < 0) {
		throw new Error(
			`Invalid task checkpoint completion ledger seq: ${completionLedgerSeq}`,
		);
	}
	const db = getProjectDb(directory);
	const initial = buildTaskCompletionDescriptor(planIdentityHash, taskId, 1);
	db.transaction(() => {
		db.run(
			`INSERT OR IGNORE INTO task_checkpoint_receipt
				(plan_identity_hash, task_id, label, state, sha, generation,
				 completion_active, completion_ledger_seq)
			 VALUES (?, ?, ?, 'pending', NULL, 1, 1, ?)`,
			[planIdentityHash, taskId, initial.label, completionLedgerSeq],
		);
		const row = db
			.query<TaskCheckpointReceiptRow, [string, string]>(
				'SELECT * FROM task_checkpoint_receipt WHERE plan_identity_hash = ? AND task_id = ?',
			)
			.get(planIdentityHash, taskId);
		if (!row) return;

		if (row.completion_ledger_seq === null) {
			// v12 receipts and lifecycle-advanced pending receipts have no durable
			// epoch binding. Bind them in place: a migrated logged receipt must stay
			// idempotent, while a pending reopened receipt already owns its generation.
			db.run(
				`UPDATE task_checkpoint_receipt
				 SET completion_ledger_seq = ?, completion_active = 1,
					updated_at = datetime('now')
				 WHERE plan_identity_hash = ? AND task_id = ?
					AND completion_ledger_seq IS NULL`,
				[completionLedgerSeq, planIdentityHash, taskId],
			);
			return;
		}

		if (row.completion_ledger_seq !== completionLedgerSeq) {
			const nextGeneration = row.generation + 1;
			const descriptor = buildTaskCompletionDescriptor(
				planIdentityHash,
				taskId,
				nextGeneration,
			);
			db.run(
				`UPDATE task_checkpoint_receipt
				 SET label = ?, state = 'pending', sha = NULL, generation = ?,
					completion_active = 1, completion_ledger_seq = ?,
					updated_at = datetime('now')
				 WHERE plan_identity_hash = ? AND task_id = ?
					AND completion_ledger_seq = ?`,
				[
					descriptor.label,
					nextGeneration,
					completionLedgerSeq,
					planIdentityHash,
					taskId,
					row.completion_ledger_seq,
				],
			);
			return;
		}

		if (row.completion_active === 0) {
			db.run(
				`UPDATE task_checkpoint_receipt
				 SET completion_active = 1, updated_at = datetime('now')
				 WHERE plan_identity_hash = ? AND task_id = ?
					AND completion_ledger_seq = ? AND completion_active = 0`,
				[planIdentityHash, taskId, completionLedgerSeq],
			);
		}
	})();
	const row = readTaskCheckpointReceipt(directory, planIdentityHash, taskId);
	if (!row) {
		throw new Error(
			`Failed to create or read task checkpoint receipt for ${taskId}`,
		);
	}
	return row;
}

export function activateTaskCheckpointReceipt(
	directory: string,
	planIdentityHash: string,
	taskId: string,
): TaskCheckpointReceiptRow | null {
	if (!projectDbExists(directory)) return null;
	const db = getProjectDb(directory);
	db.transaction(() => {
		const row = db
			.query<TaskCheckpointReceiptRow, [string, string]>(
				'SELECT * FROM task_checkpoint_receipt WHERE plan_identity_hash = ? AND task_id = ?',
			)
			.get(planIdentityHash, taskId);
		if (!row || row.completion_active === 1) return;
		const descriptor = buildTaskCompletionDescriptor(
			planIdentityHash,
			taskId,
			row.generation,
		);
		db.run(
			`UPDATE task_checkpoint_receipt
			 SET label = ?, state = 'pending', sha = NULL, completion_active = 1,
				updated_at = datetime('now')
			 WHERE plan_identity_hash = ? AND task_id = ? AND completion_active = 0`,
			[descriptor.label, planIdentityHash, taskId],
		);
	})();
	return readTaskCheckpointReceipt(directory, planIdentityHash, taskId);
}

export function advanceTaskCheckpointReceiptGeneration(
	directory: string,
	planIdentityHash: string,
	taskId: string,
): TaskCheckpointReceiptRow | null {
	if (!projectDbExists(directory)) return null;
	const db = getProjectDb(directory);
	db.transaction(() => {
		const row = db
			.query<TaskCheckpointReceiptRow, [string, string]>(
				'SELECT * FROM task_checkpoint_receipt WHERE plan_identity_hash = ? AND task_id = ?',
			)
			.get(planIdentityHash, taskId);
		if (!row || row.completion_active === 0) return;
		const nextGeneration = row.generation + 1;
		const descriptor = buildTaskCompletionDescriptor(
			planIdentityHash,
			taskId,
			nextGeneration,
		);
		db.run(
			`UPDATE task_checkpoint_receipt
			 SET label = ?, state = 'pending', sha = NULL, generation = ?,
				completion_active = 0, completion_ledger_seq = NULL,
				updated_at = datetime('now')
			 WHERE plan_identity_hash = ? AND task_id = ? AND completion_active = 1`,
			[descriptor.label, nextGeneration, planIdentityHash, taskId],
		);
	})();
	return readTaskCheckpointReceipt(directory, planIdentityHash, taskId);
}

export function repairTaskCheckpointReceiptForCompletion(
	directory: string,
	planIdentityHash: string,
	taskId: string,
): TaskCheckpointReceiptRow | null {
	if (!projectDbExists(directory)) return null;
	const current = readTaskCheckpointReceipt(
		directory,
		planIdentityHash,
		taskId,
	);
	if (!current) return null;
	if (current.completion_active === 0) {
		return activateTaskCheckpointReceipt(directory, planIdentityHash, taskId);
	}
	// A non-completed -> completed transition with an already-active receipt means
	// the preceding re-open write reached the plan ledger but missed receipt
	// invalidation. Advance here so that crash recovery cannot suppress this epoch.
	advanceTaskCheckpointReceiptGeneration(directory, planIdentityHash, taskId);
	return activateTaskCheckpointReceipt(directory, planIdentityHash, taskId);
}

export function updateTaskCheckpointReceipt(
	directory: string,
	descriptor: TaskCompletionCheckpointDescriptor,
	state: TaskCheckpointReceiptState,
	sha: string | null,
): TaskCheckpointReceiptRow {
	const db = getProjectDb(directory);
	db.run(
		`UPDATE task_checkpoint_receipt
		 SET state = ?, sha = ?, updated_at = datetime('now')
		 WHERE plan_identity_hash = ? AND task_id = ?
			AND generation = ? AND completion_active = 1`,
		[
			state,
			sha,
			descriptor.planIdentityHash,
			descriptor.taskId,
			descriptor.generation,
		],
	);
	const row = readTaskCheckpointReceipt(
		directory,
		descriptor.planIdentityHash,
		descriptor.taskId,
	);
	if (
		!row ||
		row.generation !== descriptor.generation ||
		row.completion_active !== 1
	) {
		throw new Error(
			`Task checkpoint receipt generation changed for ${descriptor.taskId}`,
		);
	}
	return row;
}
