import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { type Plan, PlanSchema } from '../config/plan-schema';
import { appendCoreEventSync } from '../events/core-events.js';
import { validateSwarmPath } from '../hooks/utils';
import {
	clearPlanLedgerForReset,
	peekPlanFromLedger,
	replacePlanLedgerWithRoot,
} from '../plan/ledger';
import { withPlanLifecycleLock } from '../plan/manager';
import { checkpoint as checkpointTool } from '../tools/checkpoint.js';
import type { ToolResult } from '../tools/create-tool';
import { log } from '../utils/logger';
import { resetSwarmArtifactCache } from '../utils/swarm-artifact-cache';

/** Test-only seam for the atomic ledger re-root lifecycle transition. */
export const _internals = {
	replacePlanLedgerWithRoot,
	clearPlanLedgerForReset,
	peekPlanFromLedger,
	withPlanLifecycleLock,
};

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

	// Validate the checkpoint plan before mutating any active state. The root is
	// published before its projections, so malformed checkpoint JSON must fail
	// before the transition begins.
	let checkpointPlan: Plan | null = null;
	if (checkpointFiles.includes('plan.json')) {
		try {
			checkpointPlan = PlanSchema.parse(
				JSON.parse(
					fs.readFileSync(path.join(checkpointDir, 'plan.json'), 'utf-8'),
				),
			);
		} catch (error) {
			return `Error: Checkpoint plan.json is invalid. Cannot rollback: ${error instanceof Error ? error.message : String(error)}`;
		}
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
	const PLAN_PROJECTION_FILES = new Set(['plan.json', 'plan.md']);

	const successes: string[] = [];
	const failures: { file: string; error: string }[] = [];
	const warnings: string[] = [];

	for (const file of checkpointFiles) {
		// Skip ledger files — we'll reinitialize the ledger fresh
		if (EXCLUDE_FILES.has(file) || file.startsWith('plan-ledger.archived-')) {
			continue;
		}
		// A checkpoint plan is committed through the lifecycle transaction below.
		// Publishing it here used to make rollback failure leave new projections
		// paired with the old authoritative ledger.
		if (checkpointPlan && PLAN_PROJECTION_FILES.has(file)) continue;

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

	// The checkpoint copy intentionally excludes the old ledger. Re-root the
	// active ledger authority and portable JSONL before publishing checkpoint
	// projections. The enclosing plan lock is always acquired before the ledger
	// lock taken by replacePlanLedgerWithRoot, matching savePlan's lock order.
	try {
		if (checkpointPlan) {
			await _internals.withPlanLifecycleLock(
				directory,
				'rollback-plan-lifecycle',
				async () => {
					const prior = await _internals.peekPlanFromLedger(directory);
					const previousProjection = new Map<string, Buffer | null>();
					for (const file of PLAN_PROJECTION_FILES) {
						const destination = path.join(swarmDir, file);
						previousProjection.set(
							file,
							fs.existsSync(destination) ? fs.readFileSync(destination) : null,
						);
					}

					await _internals.replacePlanLedgerWithRoot(
						directory,
						checkpointPlan,
						'rollback',
					);
					try {
						for (const file of checkpointFiles) {
							if (!PLAN_PROJECTION_FILES.has(file)) continue;
							fs.cpSync(
								path.join(checkpointDir, file),
								path.join(swarmDir, file),
								{ recursive: true, force: true },
							);
						}
						// A checkpoint with plan.json but no Markdown projection must not
						// inherit an old plan.md for a different authoritative root.
						if (!checkpointFiles.includes('plan.md')) {
							const markdownPath = path.join(swarmDir, 'plan.md');
							if (fs.existsSync(markdownPath)) fs.unlinkSync(markdownPath);
						}
					} catch (publishError) {
						// The root is already durable. Restore both projections and the
						// prior root before surfacing the error, so a failed publish cannot
						// leave the workspace pointing at two different plans.
						const compensationFailures: string[] = [];
						for (const [file, previous] of previousProjection) {
							const destination = path.join(swarmDir, file);
							if (previous === null) {
								try {
									fs.unlinkSync(destination);
								} catch (error) {
									compensationFailures.push(
										`${file}: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
							} else {
								try {
									fs.writeFileSync(destination, previous);
								} catch (error) {
									compensationFailures.push(
										`${file}: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
							}
						}
						try {
							if (prior.plan)
								await _internals.replacePlanLedgerWithRoot(
									directory,
									prior.plan,
									'rollback_projection_compensation',
								);
							else await _internals.clearPlanLedgerForReset(directory);
						} catch (error) {
							compensationFailures.push(
								`authoritative state: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						throw new Error(
							`checkpoint projection publish failed (${publishError instanceof Error ? publishError.message : String(publishError)}); compensation ${compensationFailures.length ? `failed: ${compensationFailures.join('; ')}` : 'completed'}`,
						);
					}
				},
			);
		}
	} catch (replaceError) {
		return [
			`Rollback restored files but failed to replace the authoritative ledger: ${replaceError instanceof Error ? replaceError.message : String(replaceError)}`,
			'Checkpoint plan projections were not published unless authority changed successfully; any publish failure attempted compensation to the prior state.',
			'Inspect the reported error and retry the rollback after resolving filesystem or ledger access.',
		].join('\n');
	}

	// Write the separate operational rollback audit event.
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
