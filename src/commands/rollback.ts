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
import { consumeConfirmToken, issueConfirmToken } from './destructive-purge';
import { backupSwarmStateBeforeReset } from './reset-backup';
import {
	describeUnreadableCause,
	formatExcludedRecord,
	measureGitDestruction,
	ROLLBACK_GIT_KIND,
	ROLLBACK_PHASE_KIND,
	swarmOverwriteCandidates,
	trackedDirtyCandidates,
} from './rollback-gate';

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
	confirmToken?: string,
): Promise<string> {
	const result = await checkpointTool.execute(
		confirmToken
			? {
					action: 'restore',
					label: selected.label,
					confirm_token: confirmToken,
				}
			: { action: 'restore', label: selected.label },
		{ directory } as ToolContext,
	);
	const parsed = safeParseToolJson(result) as {
		success?: boolean;
		error?: string;
		requires_confirm?: boolean;
		preview?: string[];
		confirm_token?: string;
		backup_dir?: string;
		backup_warnings?: string[];
		message?: string;
	};
	if (!parsed) {
		return `Error: Failed to parse checkpoint response for "${selected.label}"`;
	}
	if (parsed.requires_confirm && parsed.confirm_token) {
		// The tool sink minted the token (same candidate derivation as the
		// command layer); surface the preview instead of a bare error (#2946).
		return [
			...(parsed.preview ?? []),
			'',
			`🔐 Nothing was restored. Re-run /swarm rollback ${selected.label} --confirm=${parsed.confirm_token} (valid 15 minutes), or add --yes to confirm in one step.`,
		].join('\n');
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

	// Surface the backup safety net and any backup warnings to the CLI caller
	// instead of discarding them inside the tool payload (#2976 review F-3).
	const lines = [
		`Rolled back to checkpoint "${selected.label}" (${selected.sha.slice(0, 12)})`,
	];
	if (parsed.backup_dir) {
		lines.push(
			`📦 Destroyed bytes backed up to ${path.relative(directory, parsed.backup_dir)} — copy files back to recover.`,
		);
	}
	for (const warning of parsed.backup_warnings ?? []) {
		lines.push(`⚠️ ${warning}`);
	}
	return lines.join('\n');
}

/**
 * Parse /swarm rollback flags (#2946). Flags may appear anywhere in the arg
 * list; the selector is the first non-flag element, so `--yes <label>`,
 * `<label> --yes`, and `--confirm=<token> <label>` all parse.
 */
function parseRollbackArgs(args: string[]): {
	selector: string | undefined;
	confirmToken: string | undefined;
	yes: boolean;
} {
	let selector: string | undefined;
	let confirmToken: string | undefined;
	let yes = false;
	for (const arg of args) {
		if (arg === '--yes') {
			yes = true;
			continue;
		}
		const confirmMatch = /^--confirm=(.+)$/.exec(arg);
		if (confirmMatch) {
			confirmToken = confirmMatch[1];
			continue;
		}
		if (selector === undefined) selector = arg;
	}
	return { selector, confirmToken, yes };
}

/**
 * Gate the git-checkpoint restore on the #2946 two-step contract. The
 * candidate derivation lives in src/commands/rollback-gate.ts and is shared
 * with the tool sink, so a token minted here is consumable at the sink.
 */
async function restoreGitCheckpointGated(
	directory: string,
	selected: GitCheckpoint,
	flags: { confirmToken?: string; yes?: boolean },
): Promise<string> {
	const measurement = await measureGitDestruction(directory, selected.sha);
	if (measurement.kind === 'unreadable') {
		// #3317: name WHY the read failed when the async reader could tell
		// (single shared source with the checkpoint tool sink). #3434: this
		// also covers an unreadable ls-tree/ls-files enumeration, and the
		// feedback-round `source` field names WHICH read failed instead of
		// always blaming git status.
		const cause = describeUnreadableCause(measurement, measurement.source);
		const unreadableNote =
			measurement.excludedOutOfRoot && measurement.excludedOutOfRoot.length > 0
				? ` — ${measurement.excludedOutOfRoot.length} out-of-root porcelain record(s) had been excluded from the scope before the read failed (first: ${formatExcludedRecord(measurement.excludedOutOfRoot[0])})`
				: '';
		return `Error: cannot verify the working tree (${
			measurement.source === 'enumeration'
				? 'the target-tree listing could not be read'
				: 'git status unreadable'
		}; ${cause})${unreadableNote} — refusing to restore without a preview.`;
	}
	// #3434: bounded diagnostic for out-of-root porcelain records excluded
	// from the scope — surfaced on EVERY branch below, including the
	// all-excluded clean-tree case, so an exclusion is never silent. The
	// record bytes are sanitized+bounded by formatExcludedRecord before
	// they reach operator/agent-visible text.
	const exclusionNote =
		measurement.excludedOutOfRoot.length > 0
			? `⚠ ${measurement.excludedOutOfRoot.length} out-of-root porcelain record(s) were excluded from this scope (first: ${formatExcludedRecord(measurement.excludedOutOfRoot[0])})`
			: null;
	if (flags.yes && flags.confirmToken) {
		return 'Error: pass either --yes or --confirm=<token>, not both.';
	}
	if (measurement.dirtyRelPaths.length === 0) {
		// Clean tree — nothing tracked to destroy; single-call restore. When
		// every dirty record was out-of-root-excluded (#3434), the operator
		// still sees what was dropped (appended once the restore returns).
		const restored = await restoreGitCheckpoint(
			directory,
			selected,
			flags.confirmToken,
		);
		return exclusionNote ? `${restored}\n${exclusionNote}` : restored;
	}
	const candidates = trackedDirtyCandidates(
		directory,
		measurement.dirtyRelPaths,
	);
	const scopeAnchor = candidates[0].path;
	if (flags.yes) {
		// Explicit operator consent: mint + consume in one invocation through
		// the same primitive (still digest-bound, single-use). The tool sink
		// consumes the fresh token.
		const token = issueConfirmToken(scopeAnchor, directory, {
			kind: ROLLBACK_GIT_KIND,
			candidates,
		});
		const restored = await restoreGitCheckpoint(directory, selected, token);
		return exclusionNote ? `${restored}\n${exclusionNote}` : restored;
	}
	if (flags.confirmToken) {
		const restored = await restoreGitCheckpoint(
			directory,
			selected,
			flags.confirmToken,
		);
		return exclusionNote ? `${restored}\n${exclusionNote}` : restored;
	}
	// Bare invocation on a destructive scope: preview only, nothing restored.
	const token = issueConfirmToken(scopeAnchor, directory, {
		kind: ROLLBACK_GIT_KIND,
		candidates,
	});
	const shown = measurement.dirtyRelPaths.slice(0, 10);
	const overflow = measurement.dirtyRelPaths.length - shown.length;
	return [
		`⚠️ Restoring to checkpoint "${selected.label}" (${selected.sha.slice(0, 12)}) runs git reset --hard and would DESTROY ${candidates.length} uncommitted tracked file(s):`,
		...shown.map((p) => `  - ${p}`),
		...(overflow > 0 ? [`  (+${overflow} more)`] : []),
		...(exclusionNote ? ['', exclusionNote] : []),
		'',
		'🔐 Nothing was restored. Destroyed bytes are backed up to .swarm/rollback-backups/ once confirmed.',
		`Re-run /swarm rollback ${selected.label} --confirm=${token} (valid 15 minutes), or add --yes to confirm in one step.`,
	].join('\n');
}

/**
 * Handle /swarm rollback command
 * Restores .swarm/ state from a checkpoint using direct overwrite
 */
export async function handleRollbackCommand(
	directory: string,
	args: string[],
): Promise<string> {
	// Parse phase selector + confirmation flags from args (#2946)
	const { selector: phaseArg, confirmToken, yes } = parseRollbackArgs(args);

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
		return restoreGitCheckpointGated(directory, selected, {
			confirmToken,
			yes,
		});
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
		return restoreGitCheckpointGated(directory, selected, {
			confirmToken,
			yes,
		});
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

	// #2946 two-step gate: the copy below replaces live .swarm/ files
	// wholesale; a destructive scope (existing live entries in the copy set)
	// requires the preview + confirm-token contract before anything is
	// touched. Plan projections are excluded here — they are published
	// through the gated ledger lifecycle below — but their prior live bytes
	// are still included in the execute-path backup.
	const overwriteSet: string[] = [];
	for (const file of checkpointFiles) {
		if (EXCLUDE_FILES.has(file) || file.startsWith('plan-ledger.archived-')) {
			continue;
		}
		if (checkpointPlan && PLAN_PROJECTION_FILES.has(file)) continue;
		if (fs.existsSync(path.join(swarmDir, file))) overwriteSet.push(file);
	}
	let backupNote = '';
	if (overwriteSet.length > 0) {
		if (yes && confirmToken) {
			return 'Error: pass either --yes or --confirm=<token>, not both.';
		}
		const candidates = swarmOverwriteCandidates(directory, overwriteSet);
		const scopeAnchor = candidates[0].path;
		if (!confirmToken && !yes) {
			const token = issueConfirmToken(scopeAnchor, directory, {
				kind: ROLLBACK_PHASE_KIND,
				candidates,
			});
			return [
				`⚠️ Rolling back to phase ${targetPhase} replaces ${overwriteSet.length} live .swarm/ entry/entries with checkpoint copies:`,
				...overwriteSet.slice(0, 10).map((f) => `  - ${f}`),
				...(overwriteSet.length > 10
					? [`  (+${overwriteSet.length - 10} more)`]
					: []),
				'',
				'🔐 Nothing was restored. The replaced bytes are backed up to .swarm/rollback-backups/ once confirmed.',
				`Re-run /swarm rollback ${targetPhase} --confirm=${token} (valid 15 minutes), or add --yes to confirm in one step.`,
			].join('\n');
		}
		// --yes mints and immediately consumes through the same primitive
		// (single use, digest-bound); --confirm consumes the operator's token
		// against the re-derived scope (digest mismatch = scope changed).
		const token = yes
			? issueConfirmToken(scopeAnchor, directory, {
					kind: ROLLBACK_PHASE_KIND,
					candidates,
				})
			: (confirmToken as string);
		const verdict = consumeConfirmToken(scopeAnchor, directory, token, {
			kind: ROLLBACK_PHASE_KIND,
			candidates,
		});
		if (!verdict.ok) {
			return `Error: ${verdict.reason} 🔐 Nothing was restored.`;
		}
		const backupEntries = [...overwriteSet];
		for (const file of PLAN_PROJECTION_FILES) {
			if (
				!backupEntries.includes(file) &&
				fs.existsSync(path.join(swarmDir, file))
			) {
				backupEntries.push(file);
			}
		}
		const backup = backupSwarmStateBeforeReset(
			directory,
			'rollback',
			backupEntries,
			{ backupsRoot: 'rollback-backups' },
		);
		// Fail closed when the safety net is incomplete: the wholesale copy
		// never proceeds over entries whose prior bytes were not actually
		// saved (#2976 review F-3).
		if (!backup.backupDir || backup.copied.length < backupEntries.length) {
			return `Error: backup incomplete (${backup.copied.length}/${backupEntries.length} at-risk entr(ies) copied) — rollback refused so nothing was replaced.${
				backup.warnings.length > 0
					? ` Warnings: ${backup.warnings.join('; ')}`
					: ''
			} 🔐 Nothing was restored.`;
		}
		backupNote = `; replaced bytes backed up to ${path.relative(directory, backup.backupDir)}`;
		if (backup.warnings.length > 0) {
			backupNote += `; warnings: ${backup.warnings.join('; ')}`;
		}
	}

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
			`Rolled back to phase ${targetPhase}: ${checkpoint.label || 'no label'}${backupNote}`,
		].join('\n');
	}
	return `Rolled back to phase ${targetPhase}: ${checkpoint.label || 'no label'}${backupNote}`;
}
