import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Plan, PlanSchema } from '../config/plan-schema';
import { validateSwarmPath } from '../hooks/utils';
import { appendLedgerEvent, computePlanHash, initLedger } from '../plan/ledger';
import { derivePlanId } from '../plan/utils.js';

/**
 * Handle /swarm rollback command
 * Restores .swarm/ state from a checkpoint using direct overwrite
 */
export async function handleRollbackCommand(
	directory: string,
	args: string[],
): Promise<string> {
	// Parse phase number from args[0]
	const phaseArg = args[0];

	if (!phaseArg) {
		// List available checkpoints
		const manifestPath = validateSwarmPath(
			directory,
			'checkpoints/manifest.json',
		);
		if (!fs.existsSync(manifestPath)) {
			return 'No checkpoints found. Use `/swarm checkpoint` to create checkpoints.';
		}

		let manifest: {
			checkpoints?: Array<{ phase: number; label?: string; timestamp: string }>;
		};
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
		} catch {
			return 'Error: Checkpoint manifest is corrupted. Delete .swarm/checkpoints/manifest.json and re-checkpoint.';
		}
		const checkpoints = manifest.checkpoints || [];

		if (checkpoints.length === 0) {
			return 'No checkpoints found in manifest.';
		}

		return [
			'## Available Checkpoints',
			'',
			...checkpoints.map(
				(c) =>
					`- Phase ${c.phase}: ${c.label || 'no label'} (${new Date(c.timestamp).toLocaleString()})`,
			),
			'',
			`Run \`/swarm rollback <phase>\` to restore to a checkpoint.`,
		].join('\n');
	}

	const targetPhase = parseInt(phaseArg, 10);
	if (Number.isNaN(targetPhase) || targetPhase < 1) {
		return 'Error: Phase number must be a positive integer.';
	}

	// Validate checkpoint exists
	const manifestPath = validateSwarmPath(
		directory,
		'checkpoints/manifest.json',
	);
	if (!fs.existsSync(manifestPath)) {
		return `Error: No checkpoints found. Cannot rollback to phase ${targetPhase}.`;
	}

	let manifest: {
		checkpoints?: Array<{ phase: number; label?: string; timestamp: string }>;
	};
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
	} catch {
		return `Error: Checkpoint manifest is corrupted. Delete .swarm/checkpoints/manifest.json and re-checkpoint.`;
	}
	const checkpoint = manifest.checkpoints?.find((c) => c.phase === targetPhase);

	if (!checkpoint) {
		const available =
			manifest.checkpoints?.map((c) => c.phase).join(', ') || 'none';
		return `Error: Checkpoint for phase ${targetPhase} not found. Available phases: ${available}`;
	}

	// Validate checkpoint directory exists and has content
	const checkpointDir = validateSwarmPath(
		directory,
		`checkpoints/phase-${targetPhase}`,
	);
	if (!fs.existsSync(checkpointDir)) {
		return `Error: Checkpoint directory for phase ${targetPhase} does not exist.`;
	}

	// Verify checkpoint has actual files
	const checkpointFiles = fs.readdirSync(checkpointDir);
	if (checkpointFiles.length === 0) {
		return `Error: Checkpoint for phase ${targetPhase} is empty. Cannot rollback.`;
	}

	// Get absolute paths
	const swarmDir = validateSwarmPath(directory, '');

	// Copy files directly from checkpoint to .swarm/
	const EXCLUDE_FILES = new Set([
		'plan-ledger.jsonl',
		'plan-ledger.quarantine',
	]);

	const successes: string[] = [];
	const failures: { file: string; error: string }[] = [];

	for (const file of checkpointFiles) {
		// Skip ledger files — we'll reinitialize the ledger fresh
		if (EXCLUDE_FILES.has(file) || file.startsWith('plan-ledger.archived-')) {
			continue;
		}

		const src = path.join(checkpointDir, file);
		const dest = path.join(swarmDir, file);

		try {
			fs.cpSync(src, dest, { recursive: true, force: true });
			successes.push(file);
		} catch (error) {
			failures.push({ file, error: (error as Error).message });
		}
	}

	if (failures.length > 0) {
		return [
			`Rollback partially completed. Successfully restored ${successes.length} files.`,
			`Failed on ${failures.length} files:`,
			...failures.map((f) => `  - ${f.file}: ${f.error}`),
			'',
			'Some files could not be restored. The .swarm/ directory may be in an inconsistent state.',
			'Check permissions and disk space, then retry the rollback.',
		].join('\n');
	}

	// Delete any existing ledger unconditionally — we're rolling back to a
	// checkpoint state and the old ledger belongs to the pre-rollback state.
	const existingLedgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
	if (fs.existsSync(existingLedgerPath)) {
		fs.unlinkSync(existingLedgerPath);
	}

	// Initialize a fresh ledger with the restored plan (if available)
	// We excluded plan-ledger.jsonl from the checkpoint copy above and
	// create a brand-new ledger here so the ledger matches the restored state.
	try {
		const planJsonPath = path.join(swarmDir, 'plan.json');
		if (fs.existsSync(planJsonPath)) {
			const planRaw = fs.readFileSync(planJsonPath, 'utf-8');
			const plan = PlanSchema.parse(JSON.parse(planRaw) as Plan);
			const planId = derivePlanId(plan);

			const planHash = computePlanHash(plan);
			await initLedger(directory, planId, planHash, plan);

			await appendLedgerEvent(directory, {
				event_type: 'plan_rebuilt',
				source: 'rollback',
				plan_id: planId,
			});
		}
	} catch (initError) {
		return [
			`Rollback restored files but failed to initialize ledger: ${initError instanceof Error ? initError.message : String(initError)}`,
			'The .swarm/plan.json has been restored but the ledger may be out of sync.',
			'Run /swarm reset-session to reinitialize the ledger.',
		].join('\n');
	}

	// Write rollback event to JSONL
	const eventsPath = validateSwarmPath(directory, 'events.jsonl');
	const rollbackEvent = {
		type: 'rollback',
		phase: targetPhase,
		label: checkpoint.label || '',
		timestamp: new Date().toISOString(),
	};

	try {
		fs.appendFileSync(eventsPath, `${JSON.stringify(rollbackEvent)}\n`);
	} catch (error) {
		console.error(
			'Failed to write rollback event:',
			error instanceof Error ? error.message : String(error),
		);
	}

	return `Rolled back to phase ${targetPhase}: ${checkpoint.label || 'no label'}`;
}
