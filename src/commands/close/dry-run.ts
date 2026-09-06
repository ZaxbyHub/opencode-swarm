import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
	formatResidueInventoryLines,
	inventorySwarmResidue,
} from '../../services/swarm-residue';
import {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	ACTIVE_STATE_TO_CLEAN,
	ARCHIVE_ARTIFACTS,
	TERMINAL_STATE_FILES,
} from './constants.js';
import type { PlanData } from './context.js';
import { _internals } from './internals.js';

/**
 * Builds the `/swarm finalize --dry-run` report. Purely READ-ONLY: inspects the
 * plan and the filesystem and describes what a real finalize WOULD do, without
 * acquiring the finalize lock, creating an archive bundle, deleting any file,
 * running git, or tearing down session state. (#1692)
 *
 * The archive-first guard means the clean stage only removes files it first
 * archived successfully; this report approximates that by listing existing
 * clean-set members as "would remove" and notes the approximation.
 */
export async function runFinalizeDryRun(
	directory: string,
	swarmDir: string,
	planData: PlanData,
	planExists: boolean,
): Promise<string> {
	const existsInSwarm = (name: string): boolean =>
		fsSync.existsSync(path.join(swarmDir, name));

	const phases = planData.phases ?? [];
	const nonTerminalPhases = phases.filter(
		(p) =>
			p.status !== 'complete' &&
			p.status !== 'completed' &&
			p.status !== 'blocked' &&
			p.status !== 'closed',
	);
	const planAlreadyDone =
		planExists && phases.length > 0 && nonTerminalPhases.length === 0;

	const wouldArchive = ARCHIVE_ARTIFACTS.filter(existsInSwarm);
	const dynamicArchive = (
		await fs.readdir(swarmDir).catch(() => [] as string[])
	).filter(
		(name) =>
			/^post-mortem-[^/\\]+\.md$/.test(name) ||
			/^drift-report-phase-\d+\.json$/.test(name),
	);
	const wouldArchiveDirs = ACTIVE_STATE_DIRS_TO_CLEAN.filter(existsInSwarm);
	const wouldRemoveTerminal = (
		TERMINAL_STATE_FILES as readonly string[]
	).filter(existsInSwarm);
	// TERMINAL_STATE_FILES is a subset of ACTIVE_STATE_TO_CLEAN (both cover
	// plan.json/plan-ledger.jsonl/spec-staleness.json/spec-snapshot.md); list
	// those only once, under "Would remove unconditionally", so the report
	// doesn't show the same file under two different removal rationales.
	const wouldCleanFiles = ACTIVE_STATE_TO_CLEAN.filter(
		(f) =>
			existsInSwarm(f) &&
			!(TERMINAL_STATE_FILES as readonly string[]).includes(f),
	);

	const gitStatus = _internals.getGitRepositoryStatus(directory);
	const gitNote = gitStatus.isRepo
		? 'would align the working tree to main/remote (git reset), pruning merged branches only with --prune-branches'
		: 'would skip git alignment (not a git repository / git unavailable)';

	// Read-only residue inventory (issue #2035): the SAME shared inventory the
	// real close run and `/swarm config doctor` render from — a dry-run
	// preview must never mutate, so this uses inventorySwarmResidue directly.
	let residueSection: string[] = [];
	try {
		const residueInventory = await inventorySwarmResidue(directory);
		if (residueInventory.summary.matched > 0) {
			residueSection = [
				'',
				'### Atomic-write residue (read-only inventory)',
				...formatResidueInventoryLines(residueInventory),
				'- A real close run QUARANTINES eligible items into `.swarm/quarantine/` (recoverable, manifest-backed — never deleted); every other candidate is preserved in place.',
			];
		}
	} catch {
		// inventory is best-effort inside dry-run — its failure must not mask
		// the rest of the report
	}

	const lines: string[] = [
		'## /swarm finalize — DRY RUN (no changes made)',
		'',
		'No lock is taken, no files are archived or deleted, no git command runs.',
		'',
		'### Plan',
		planExists
			? planAlreadyDone
				? '- Plan is already terminal — no phases/tasks would be force-closed.'
				: nonTerminalPhases.length > 0
					? `- Would mark ${nonTerminalPhases.length} non-terminal phase(s) as closed: ${nonTerminalPhases.map((p) => `#${p.id} ${p.name}`).join(', ')}`
					: '- No phases present; nothing to close.'
			: '- No plan.json — plan-free session; cleanup-only.',
		'',
		'### Would archive',
		wouldArchive.length > 0 ||
		dynamicArchive.length > 0 ||
		wouldArchiveDirs.length > 0
			? [
					...wouldArchive.map((f) => `- ${f}`),
					...dynamicArchive.map((f) => `- ${f}`),
					...wouldArchiveDirs.map((d) => `- ${d}/`),
				].join('\n')
			: '- (nothing present to archive)',
		'',
		'### Would clean (removed after successful archive)',
		wouldCleanFiles.length > 0 || wouldArchiveDirs.length > 0
			? [
					...wouldCleanFiles.map((f) => `- ${f}`),
					...wouldArchiveDirs.map((d) => `- ${d}/`),
				].join('\n')
			: '- (nothing present to clean)',
		...(wouldRemoveTerminal.length > 0
			? [
					'',
					'### Would remove unconditionally (terminal plan-state)',
					...wouldRemoveTerminal.map((f) => `- ${f}`),
				]
			: []),
		...residueSection,
		'',
		'### Git',
		`- ${gitNote}`,
		'',
		'_Note: swarm.db-shm / swarm.db-wal are transient SQLite sidecars — never archived; a real close removes them right after the swarm.db unlink (#2483, reversing #1692). The clean list is an approximation of the archive-first guard._',
		'',
		'Run `/swarm finalize` (without `--dry-run`) to apply.',
	];

	return lines.join('\n');
}
