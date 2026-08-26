import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { type Plan, PlanSchema } from '../config/plan-schema';
import { appendCoreEventSync } from '../events/core-events.js';
import { validateSwarmPath } from '../hooks/utils';
import { appendLedgerEvent, computePlanHash, initLedger } from '../plan/ledger';
import { derivePlanId } from '../plan/utils.js';
import { checkpoint as checkpointTool } from '../tools/checkpoint.js';
import type { ToolResult } from '../tools/create-tool';
import { log } from '../utils/logger';
import { resetSwarmArtifactCache } from '../utils/swarm-artifact-cache';

type LegacyCheckpoint = { phase: number; label?: string; timestamp: string };
type GitCheckpoint = { label: string; sha: string; timestamp: string };

function safeParseToolJson(result: ToolResult): unknown {
	try {
		const jsonStr = typeof result === 'string' ? result : result.output;
		return JSON.parse(jsonStr);
	} catch {
		return null;
	}
}

async function listGitCheckpoints(
	directory: string,
): Promise<GitCheckpoint[] | null> {
	try {
		const result = await checkpointTool.execute({ action: 'list' }, {
			directory,
		} as ToolContext);
		const parsed = safeParseToolJson(result) as {
			success?: boolean;
			checkpoints?: GitCheckpoint[];
		};
		if (!parsed) return null;
		if (parsed.success !== true || !Array.isArray(parsed.checkpoints)) {
			return null;
		}
		return parsed.checkpoints;
	} catch {
		return null;
	}
}

function formatGitCheckpointList(checkpoints: GitCheckpoint[]): string {
	if (checkpoints.length === 0) {
		return 'No checkpoints found. Create one with `/swarm checkpoint save <label>`';
	}

	return [
		'## Available Checkpoints',
		'',
		...checkpoints.map(
			(c, index) =>
				`- ${index + 1}. "${c.label}" - ${new Date(c.timestamp).toLocaleString()} (${c.sha.slice(0, 12)})`,
		),
		'',
		'Run `/swarm rollback <label-or-number>` to restore to a checkpoint.',
	].join('\n');
}

function resolveGitCheckpoint(
	checkpoints: GitCheckpoint[],
	selector: string,
): GitCheckpoint | null {
	const index = Number.parseInt(selector, 10);
	if (/^\d+$/.test(selector) && index >= 1 && index <= checkpoints.length) {
		return checkpoints[index - 1] ?? null;
	}
	return checkpoints.find((c) => c.label === selector) ?? null;
}

async function restoreGitCheckpoint(
	directory: string,
	selected: GitCheckpoint,
): Promise<string> {
	const result = await checkpointTool.execute(
		{ action: 'restore', label: selected.label },
		{ directory } as ToolContext,
	);
	const parsed = safeParseToolJson(result) as {
		success?: boolean;
		error?: string;
	};
	if (!parsed) {
		return `Error: Failed to parse checkpoint response for "${selected.label}"`;
	}
	if (parsed.success !== true) {
		return `Error: ${parsed.error || `Failed to restore checkpoint "${selected.label}"`}`;
	}

	const rollbackEvent = {
		type: 'rollback',
		label: selected.label,
		sha: selected.sha,
		timestamp: new Date().toISOString(),
		source: 'checkpoints.json',
	};

	try {
		appendCoreEventSync(directory, rollbackEvent);
	} catch (error) {
		log(
			'Failed to write rollback event:',
			error instanceof Error ? error.message : String(error),
		);
	}

	return `Rolled back to checkpoint "${selected.label}" (${selected.sha.slice(0, 12)})`;
}

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
			const gitCheckpoints = await listGitCheckpoints(directory);
			if (gitCheckpoints) {
				return formatGitCheckpointList(gitCheckpoints);
			}
			return 'No checkpoints found. Use `/swarm checkpoint save <label>` to create checkpoints.';
		}

		let manifest: { checkpoints?: LegacyCheckpoint[] };
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
		} catch {
			// Justification: fs.existsSync confirmed the manifest file exists
			// before entering this block, so a parse failure means the file is
			// corrupted — not absent. We surface a clear corruption message
			// rather than silently ignoring the error.
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
		const gitCheckpoints = await listGitCheckpoints(directory);
		if (!gitCheckpoints) {
			return 'Error: Phase number must be a positive integer.';
		}
		const selected = resolveGitCheckpoint(gitCheckpoints, phaseArg);
		if (!selected) {
			return `Error: Checkpoint "${phaseArg}" not found. Available checkpoints: ${gitCheckpoints.map((c) => `"${c.label}"`).join(', ') || 'none'}`;
		}
		return restoreGitCheckpoint(directory, selected);
	}

	// Validate checkpoint exists
	const manifestPath = validateSwarmPath(
		directory,
		'checkpoints/manifest.json',
	);
	if (!fs.existsSync(manifestPath)) {
		const gitCheckpoints = await listGitCheckpoints(directory);
		if (!gitCheckpoints) {
			return `Error: No checkpoints found. Cannot rollback to phase ${targetPhase}.`;
		}
		const selected = resolveGitCheckpoint(gitCheckpoints, phaseArg);
		if (!selected) {
			return `Error: Checkpoint ${phaseArg} not found. Available checkpoints: ${gitCheckpoints.map((c, index) => `${index + 1}="${c.label}"`).join(', ') || 'none'}`;
		}
		return restoreGitCheckpoint(directory, selected);
	}

	let manifest: { checkpoints?: LegacyCheckpoint[] };
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
	} catch {
		// Justification: fs.existsSync confirmed the manifest file exists
		// before entering this block, so a parse failure means the file is
		// corrupted. Surface a clear corruption message to guide recovery.
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

	// Get absolute paths.
	//
	// `validateSwarmPath` requires a NON-EMPTY filename: both platform branches
	// test `resolved.startsWith(baseDir + path.sep)`, and with `filename === ''`
	// the resolved path IS `baseDir`, so the test fails. Passing '' here — which
	// this line did until #1619 round 7 — threw
	// "Invalid filename: path escapes .swarm directory" on EVERY platform before a
	// single file was copied, making the whole legacy phase-restore path dead in
	// production. It looked covered because tests/unit/commands/rollback.test.ts
	// and rollback-ledger-lock.test.ts both `mock.module` `validateSwarmPath` to a
	// plain `path.join`, so the restore path was only ever exercised against a
	// stub.
	//
	// Validating a real child and taking its parent is the fix. Scope of what
	// that buys, stated exactly: when `.swarm` EXISTS the helper's symlink
	// rejection and realpath containment both run; when it does not, the helper
	// returns early at its ENOENT branch and those checks are skipped. Here it
	// provably exists — the manifest and the checkpoint directory were both read
	// out of it above — so the checks do run on this path.
	const swarmDir = path.dirname(validateSwarmPath(directory, '.keep'));

	// Copy files directly from checkpoint to .swarm/
	const EXCLUDE_FILES = new Set([
		'plan-ledger.jsonl',
		'plan-ledger.quarantine',
	]);

	const successes: string[] = [];
	const failures: { file: string; error: string }[] = [];
	const warnings: string[] = [];

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

	// The copy above replaces an ARBITRARY set of `.swarm/` files wholesale —
	// plan.json, plan.md, context.md, session/state.json, summaries/, evidence/
	// (recursive), curator-summary.json, spec-staleness.json, anything else the
	// checkpoint happens to hold. Those are read back through the swarm-artifact
	// cache, which decides freshness from a stat stamp (mtimeMs + ctimeMs + size)
	// alone, so a checkpoint file restored at the same size inside one filesystem
	// timestamp tick would keep serving the PRE-rollback value to every later hook
	// read in this session. Per-file invalidation is not viable here: the set is
	// whatever `readdirSync(checkpointDir)` yields, `cpSync` recurses into
	// directories, and enumerating that tree would have to stay in sync with every
	// future artifact layout. Clearing the whole cache is both simpler and
	// obviously correct — the next read of anything repopulates from disk.
	//
	// Placed BEFORE the partial-failure return below on purpose: a rollback that
	// copied some files and failed on others has still mutated `.swarm/`, and that
	// path returns early.
	resetSwarmArtifactCache();

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
	let ledgerDeletionFailed = false;
	if (fs.existsSync(existingLedgerPath)) {
		try {
			fs.unlinkSync(existingLedgerPath);
		} catch (err) {
			ledgerDeletionFailed = true;
			const errMsg = err instanceof Error ? err.message : String(err);
			warnings.push(
				`⚠️ Warning: Could not delete stale ledger (${errMsg}). The ledger may be inconsistent with the restored plan. Run /swarm reset-session to clean up session state.`,
			);
		}
	}

	// Only re-initialize ledger if deletion succeeded (or ledger didn't exist).
	// If deletion failed, the stale ledger remains and initLedger would throw
	// "Ledger already initialized" — skipping preserves the warning path above.
	if (!ledgerDeletionFailed) {
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
	}

	// Write rollback event to JSONL
	const rollbackEvent = {
		type: 'rollback',
		phase: targetPhase,
		label: checkpoint.label || '',
		timestamp: new Date().toISOString(),
	};

	try {
		appendCoreEventSync(directory, rollbackEvent);
	} catch (error) {
		log(
			'Failed to write rollback event:',
			error instanceof Error ? error.message : String(error),
		);
	}

	if (warnings.length > 0) {
		return [
			...warnings,
			'',
			`Rolled back to phase ${targetPhase}: ${checkpoint.label || 'no label'}`,
		].join('\n');
	}
	return `Rolled back to phase ${targetPhase}: ${checkpoint.label || 'no label'}`;
}
