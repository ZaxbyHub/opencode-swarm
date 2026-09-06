import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginConfig } from '../../config/schema';
import { observeCloseArchive } from '../../health/learning-health';
import { isLinked } from '../../hooks/knowledge-link';
import { telemetry as telemetryEmit } from '../../telemetry';
import { REPO_MEMORY_FILENAME } from '../../tools/repo-graph/indexed-storage';
import { log } from '../../utils/logger';
import { archiveSqliteSnapshot } from '../archive-sqlite';
import {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	ACTIVE_STATE_TO_CLEAN,
	ARCHIVE_ARTIFACTS,
	KNOWLEDGE_FAMILY_ARTIFACTS,
	REQUIRED_ARTIFACTS,
} from './constants.js';
import type {
	ArchiveRequiredness,
	ArchiveSourceDisposition,
	ArchiveStageContext,
	ArtifactArchiveResult,
	CleanStageResult,
	CloseStageContext,
} from './context.js';
import { copyDirRecursiveWithFailures } from './fs-helpers.js';
import { _internals } from './internals.js';

/**
 * Emit the single `close_archive_result` telemetry event whose payload is the
 * SAME `ctx.archiveResults` array the user-facing prose derives from, so the
 * two cannot disagree (issue #2030 item 6). Called AFTER `runCleanStage` so
 * `source_disposition` can be finalized truthfully: artifacts that were
 * successfully archived AND then unlinked by the clean stage report `'removed'`;
 * artifacts preserved (absent, or failed/retained) keep their archive-time
 * disposition. Counts only — no row content (issue items 4/9).
 */
export function emitCloseArchiveResult(
	ctx: CloseStageContext,
	cleanResult: CleanStageResult,
): void {
	// Finalize dispositions: any artifact the clean stage actually removed is
	// 'removed' — regardless of whether its archive attempt succeeded or failed
	// (terminal-state files like plan.json are unlinked unconditionally even on
	// archive failure; reporting those as 'retained' would be factually false
	// about on-disk state). The attempt/reason_code fields still carry the
	// archive-outcome truth, so the tuple (failed, removed, copy_failed) reads
	// truthfully as "archive failed, source file removed, no archive copy".
	const cleaned = new Set(cleanResult.cleanedFiles);
	const failedCount = ctx.archiveResults.filter(
		(r) => r.attempt === 'failed',
	).length;
	const sqliteSnapshots = ctx.archiveResults.filter(
		(r) => r.method === 'vacuum_into' && r.attempt === 'succeeded',
	);
	const archiveEmpty =
		sqliteSnapshots.length > 0 &&
		sqliteSnapshots.every(
			(r) =>
				(r.row_counts?.project_constraints ?? 0) === 0 &&
				(r.row_counts?.qa_gate_profile ?? 0) === 0,
		);
	// archive_valid must be false when the stage threw wholesale (empty
	// archiveResults would otherwise make failedCount === 0 and invert the
	// alarm signal PR 16 depends on).
	const archiveValid = !ctx.archiveStageFailed && failedCount === 0;

	try {
		telemetryEmit.closeArchiveResult({
			archive_valid: archiveValid,
			archive_empty: archiveEmpty,
			file_count: ctx.archivedFileCount,
			bundle: `swarm-${ctx.timestamp}-${ctx.archiveSuffix}`,
			artifacts: ctx.archiveResults.map((r) => {
				const removed = cleaned.has(r.artifact);
				return {
					artifact: r.artifact,
					requiredness: r.requiredness,
					attempt: r.attempt,
					validation: r.validation,
					source_disposition: removed
						? ('removed' as ArchiveSourceDisposition)
						: r.source_disposition,
					method: r.method,
					reason_code: r.reason_code,
					...(r.row_counts ? { row_counts: r.row_counts } : {}),
				};
			}),
		});
	} catch (telemetryErr) {
		// Telemetry must never block close; record and continue.
		log(
			'[close-command] close_archive_result telemetry emit failed:',
			telemetryErr,
		);
	}

	// Learning-health archive-mismatch feed (#2044): raise when the archive is
	// empty/invalid while recorded activity predicted content. The bounded
	// activity probe reads existence + size only (no parsing). Late-arriving
	// activity never retro-raises — the alarm records what was known now.
	observeCloseArchive({
		directory: ctx.directory,
		archiveValid,
		archiveEmpty,
		activityPredictsContent: archiveActivityPredictsContent(ctx.directory),
	});
}
/**
 * Bounded activity probe for the archive-mismatch alarm (#2044): does recorded
 * project activity predict archive content? Existence + size only — no reads
 * of record content, no unbounded scans.
 */
export function archiveActivityPredictsContent(directory: string): boolean {
	try {
		for (const name of [
			'knowledge-events.jsonl',
			'telemetry.jsonl',
			'evidence',
		]) {
			const target = path.join(directory, '.swarm', name);
			const stat = fsSync.statSync(target);
			if (target.endsWith('evidence')) {
				const entries = fsSync.readdirSync(target);
				if (entries.length > 0) return true;
			} else if (stat.size > 0) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}
/**
 * STAGE 2: ARCHIVE
 *
 * Creates a timestamped archive bundle under .swarm/archive/, copies flat-file
 * artifacts and active-state directories, then runs the evidence retention
 * policy. All state mutations (archive path, counts, success sets) are written
 * back to ctx so the caller can build the close summary.
 */
export async function runArchiveStage(ctx: CloseStageContext): Promise<void> {
	ctx.timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	ctx.archiveSuffix = Math.random().toString(36).slice(2, 8);
	ctx.archiveDir = path.join(
		ctx.swarmDir,
		'archive',
		`swarm-${ctx.timestamp}-${ctx.archiveSuffix}`,
	);

	try {
		await fs.mkdir(ctx.archiveDir, { recursive: true });

		// Flush the telemetry write stream BEFORE archiving its files. The
		// writer holds an open buffered WriteStream whose in-memory buffer is
		// not on disk until drained; without this, archiving telemetry.jsonl
		// via fs.copyFile would silently lose the session's tail records
		// (issue #2030 item 8). Fail-open: a flush failure never blocks close.
		try {
			await _internals.flushAndDrainTelemetry();
		} catch (flushErr) {
			const msg =
				flushErr instanceof Error ? flushErr.message : String(flushErr);
			ctx.warnings.push(`Telemetry flush before archive failed: ${msg}`);
		}

		// Finalize the context-map telemetry store (issue #2037) BEFORE archiving
		// so the archived `context-telemetry.jsonl` is a defined, validated cut
		// (tail folded into the durable aggregate, atomic single-file rewrite).
		// Unlike the core telemetry stream this store is synchronous (no buffered
		// writer), so no flush is needed — finalization is a fold + atomic rewrite.
		// Fail-open: a finalize failure only warns; the close pipeline continues.
		try {
			_internals.finalizeContextTelemetry(ctx.directory);
		} catch (finalizeErr) {
			const msg =
				finalizeErr instanceof Error
					? finalizeErr.message
					: String(finalizeErr);
			ctx.warnings.push(
				`Context-map telemetry finalize before archive failed: ${msg}`,
			);
		}

		// Finalize the core event store (issue #2039) BEFORE archiving so the
		// archived `events.jsonl` is a defined, VALIDATED cut (legacy header-less
		// tail drained to convergence, window compacted, pre-rename validation).
		// Fail-open: a finalize failure only warns; the close pipeline continues.
		try {
			_internals.finalizeCoreEvents(ctx.directory);
		} catch (finalizeErr) {
			const msg =
				finalizeErr instanceof Error
					? finalizeErr.message
					: String(finalizeErr);
			ctx.warnings.push(`Core events finalize before archive failed: ${msg}`);
		}

		// Finalize the shell-audit security store (issue #2040) BEFORE the
		// session/ directory archive copy so the archived `shell-audit.jsonl`
		// is a defined, VALIDATED cut (legacy header-less tail drained to
		// convergence, window compacted under the decision-class priority
		// policy, pre-rename validation). Releasing the store lock also
		// unlinks it, so a stale lock file is never archived. Fail-open: a
		// finalize failure only warns; the close pipeline continues.
		try {
			_internals.finalizeShellAudit(ctx.directory);
		} catch (finalizeErr) {
			const msg =
				finalizeErr instanceof Error
					? finalizeErr.message
					: String(finalizeErr);
			ctx.warnings.push(`Shell audit finalize before archive failed: ${msg}`);
		}

		// Copy swarm artifacts to archive.
		// Each artifact produces a structured ArtifactArchiveResult pushed into
		// ctx.archiveResults — the single source of truth from which the
		// user-facing prose, the clean-stage gate (archivedActiveStateFiles),
		// the failure map, and the close_archive_result telemetry event are all
		// derived (so none can disagree — issue #2030 item 6).
		//
		// WAL sidecar files (swarm.db-shm/-wal) are transient SQLite internals
		// that SQLite recreates on next open; they are deliberately absent from
		// ARCHIVE_ARTIFACTS/ACTIVE_STATE_TO_CLEAN, so they are never archived —
		// the clean stage removes them right after the swarm.db unlink via
		// removeSqliteSidecarsAfterClose (#2483, reversing #1692). swarm.db
		// itself is snapshotted via the in-process VACUUM INTO engine
		// (archiveSqliteSnapshot), which produces a single self-contained,
		// transactionally-consistent file.

		// When linked, the knowledge family lives in the shared link store, which
		// is cohort-owned. Do not archive or clean it from a single worktree's
		// close — surface one note and leave the shared lifecycle untouched.
		const linkedKnowledgeShared = isLinked(ctx.directory);
		if (linkedKnowledgeShared) {
			ctx.warnings.push(
				'Worktree is linked: shared knowledge (knowledge.jsonl, knowledge-rejected.jsonl) lives in the link store and is not archived or cleaned by /swarm close. Manage it via the link.',
			);
		}

		for (const artifact of ARCHIVE_ARTIFACTS) {
			// Skip cohort-shared knowledge artifacts when linked (see note above).
			if (linkedKnowledgeShared && KNOWLEDGE_FAMILY_ARTIFACTS.has(artifact)) {
				continue;
			}

			const srcPath = path.join(ctx.swarmDir, artifact);
			const destPath = path.join(ctx.archiveDir, artifact);
			const requiredness: ArchiveRequiredness = REQUIRED_ARTIFACTS.has(artifact)
				? 'required'
				: 'optional';

			if (artifact === 'swarm.db' || artifact === REPO_MEMORY_FILENAME) {
				// In-process VACUUM INTO snapshot via the shared, runtime-portable
				// loader (src/db/sqlite-loader.ts). Produces a single self-contained
				// file (journal_mode=delete, no WAL sidecars) containing ALL committed
				// rows and EXCLUDING uncommitted writers (spike-proven under Bun + Node).
				// Sidecar files (-shm/-wal) are transient and intentionally never
				// archived; swarm.db's sidecars are removed after its unlink by
				// removeSqliteSidecarsAfterClose (#2483), with no warning.
				// repo-memory.sqlite (issue #1534) is a WAL-mode DB exactly like
				// swarm.db, so a raw copy would not be a consistent snapshot; it is
				// routed through the same archiveSqliteSnapshot path.
				const r = await archiveSqliteSnapshot({
					sourcePath: srcPath,
					destDir: ctx.archiveDir,
					destName: artifact,
				});
				const result: ArtifactArchiveResult = {
					artifact,
					requiredness,
					attempt: r.attempt,
					validation: r.validation,
					source_disposition:
						r.attempt === 'succeeded' ? 'retained' : r.source_disposition,
					method: r.method,
					reason_code: r.reason_code,
					detail: r.detail,
					row_counts: r.rowCounts,
				};
				ctx.archiveResults.push(result);
				if (r.attempt === 'succeeded' && r.validation === 'passed') {
					ctx.archivedFileCount++;
					if (ACTIVE_STATE_TO_CLEAN.includes(artifact)) {
						ctx.archivedActiveStateFiles.add(artifact);
					}
				} else if (
					!(r.attempt === 'not_attempted' && r.source_disposition === 'absent')
				) {
					// Real failure (not a clean absence). Truthful warning; source
					// is preserved (archiveSqliteSnapshot never deletes the source).
					ctx.archiveFailureReasons.set(
						artifact,
						`${r.reason_code}: ${r.detail ?? ''}`,
					);
					ctx.warnings.push(
						`Failed to archive ${artifact} [${r.reason_code}]: ${r.detail ?? ''}. Source preserved.`,
					);
				}
				// absent optional → silent (no warning, no failure map entry)
			} else {
				try {
					await fs.copyFile(srcPath, destPath);
					ctx.archivedFileCount++;
					if (ACTIVE_STATE_TO_CLEAN.includes(artifact)) {
						ctx.archivedActiveStateFiles.add(artifact);
					}
					ctx.archiveResults.push({
						artifact,
						requiredness,
						attempt: 'succeeded',
						validation: 'not_applicable',
						// 'retained' at archive time; finalized to 'removed'
						// post-clean for artifacts actually unlinked (see
						// emitCloseArchiveResult in handleCloseCommand).
						source_disposition: 'retained',
						method: 'copy',
						reason_code: 'ok',
					});
				} catch (err: unknown) {
					const errno = (err as NodeJS.ErrnoException)?.code;
					if (errno === 'ENOENT') {
						// File absent — expected for optional artifacts; silent skip,
						// recorded as absent so the structured result is truthful.
						ctx.archiveResults.push({
							artifact,
							requiredness,
							attempt: 'not_attempted',
							validation: 'not_applicable',
							source_disposition: 'absent',
							method: 'none',
							reason_code: 'source_absent',
						});
					} else {
						const reason = err instanceof Error ? err.message : String(err);
						ctx.archiveFailureReasons.set(
							artifact,
							`${errno ?? 'unknown'}: ${reason}`,
						);
						ctx.warnings.push(
							`Failed to archive ${artifact} [${errno ?? 'unknown'}]: ${reason}. File preserved (not cleaned up).`,
						);
						ctx.archiveResults.push({
							artifact,
							requiredness,
							attempt: 'failed',
							validation: 'not_applicable',
							source_disposition: 'retained',
							method: 'copy',
							reason_code: 'copy_failed',
							detail: `${errno ?? 'unknown'}: ${reason}`,
						});
					}
				}
			}
		}

		const dynamicArchiveArtifacts = (
			await fs.readdir(ctx.swarmDir).catch(() => [] as string[])
		).filter(
			(name) =>
				/^post-mortem-[^/\\]+\.md$/.test(name) ||
				/^drift-report-phase-\d+\.json$/.test(name),
		);
		for (const artifact of dynamicArchiveArtifacts) {
			const srcPath = path.join(ctx.swarmDir, artifact);
			const destPath = path.join(ctx.archiveDir, artifact);
			try {
				await fs.copyFile(srcPath, destPath);
				ctx.archivedFileCount++;
				ctx.archivedActiveStateFiles.add(artifact);
				// Record in the structured result so the close_archive_result
				// event's artifacts[] array is complete (issue #2030: prose and
				// event must derive from the same result object).
				ctx.archiveResults.push({
					artifact,
					requiredness: 'optional',
					attempt: 'succeeded',
					validation: 'not_applicable',
					source_disposition: 'retained',
					method: 'copy',
					reason_code: 'ok',
				});
			} catch (err: unknown) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno !== 'ENOENT') {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.archiveFailureReasons.set(
						artifact,
						`${errno ?? 'unknown'}: ${reason}`,
					);
					ctx.warnings.push(
						`Failed to archive ${artifact} [${errno ?? 'unknown'}]: ${reason}. File preserved (not cleaned up).`,
					);
					ctx.archiveResults.push({
						artifact,
						requiredness: 'optional',
						attempt: 'failed',
						validation: 'not_applicable',
						source_disposition: 'retained',
						method: 'copy',
						reason_code: 'copy_failed',
						detail: `${errno ?? 'unknown'}: ${reason}`,
					});
				} else {
					ctx.archiveResults.push({
						artifact,
						requiredness: 'optional',
						attempt: 'not_attempted',
						validation: 'not_applicable',
						source_disposition: 'absent',
						method: 'none',
						reason_code: 'source_absent',
					});
				}
			}
		}

		// Archive directories (evidence/, session/, scopes/, spec-archive/).
		// locks/ is intentionally excluded — per-run locks are managed via
		// proper-lockfile, not archived or cleaned by close.
		for (const dirName of ACTIVE_STATE_DIRS_TO_CLEAN) {
			const srcDir = path.join(ctx.swarmDir, dirName);
			const destDir = path.join(ctx.archiveDir, dirName);
			try {
				const result = await copyDirRecursiveWithFailures(srcDir, destDir);
				ctx.archivedFileCount += result.copied;
				if (result.failures.length === 0) {
					// All files copied (or skipped via ENOENT) — safe to clean source.
					ctx.archivedActiveStateDirs.add(dirName);
				} else {
					// Non-ENOENT failures occurred — preserve source to prevent data loss.
					ctx.warnings.push(
						`Directory ${dirName} not fully archived (${result.failures.length} failure(s)). Source preserved.`,
					);
					for (const failure of result.failures) {
						ctx.warnings.push(`  - ${failure}`);
					}
				}
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT') {
					ctx.warnings.push(
						`Failed to archive directory ${dirName} [${code ?? 'unknown'}]: ${(err as Error).message}. Source preserved.`,
					);
				}
				// ENOENT = directory doesn't exist = silent skip
			}
		}

		// Derive the user-facing prose AND the telemetry event from the SAME
		// ctx.archiveResults array so they cannot disagree (issue #2030 item 6).
		// (archive_valid / archive_empty are computed in emitCloseArchiveResult,
		// which runs after the clean stage so source_disposition is truthful.)
		const succeededCount = ctx.archiveResults.filter(
			(r) => r.attempt === 'succeeded',
		).length;
		const failedCount = ctx.archiveResults.filter(
			(r) => r.attempt === 'failed',
		).length;
		const absentCount = ctx.archiveResults.filter(
			(r) => r.source_disposition === 'absent',
		).length;
		const bundleName = `swarm-${ctx.timestamp}-${ctx.archiveSuffix}`;
		ctx.archiveResult =
			failedCount > 0
				? `Archive partial: ${succeededCount} succeeded, ${failedCount} failed, ${absentCount} absent (see warnings). Bundle: .swarm/archive/${bundleName}/`
				: `Archived ${ctx.archivedFileCount} artifact(s) to .swarm/archive/${bundleName}/`;
	} catch (archiveError) {
		ctx.warnings.push(
			`Archive creation failed: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`,
		);
		ctx.archiveResult = 'Archive creation failed (see warnings)';
		// Mark the stage failed so the close_archive_result event does NOT
		// report archive_valid=true on an empty archiveResults array (which
		// would otherwise make failedCount === 0 and invert the alarm signal).
		ctx.archiveStageFailed = true;
	}

	// Archive evidence bundles (retention policy)
	// FR-016: read retention from config.evidence when available.
	await runArchiveEvidenceRetention({
		directory: ctx.directory,
		swarmDir: ctx.swarmDir,
		config: ctx.config as unknown as PluginConfig,
		warnings: ctx.warnings,
	});
}
/**
 * Runs the evidence-retention sub-logic of STAGE 2 (ARCHIVE).
 * Reads max_age_days / max_bundles / cache_max_bytes / cache_max_records from
 * config.evidence (FR-016, issue #1184) and calls archiveEvidence. The report
 * overload is used so the documents-cache prune runs when cache caps are set.
 * Fail-open: pushes a warning on error but never throws.
 */
export async function runArchiveEvidenceRetention(
	ctx: ArchiveStageContext,
): Promise<void> {
	let maxAgeDays = 30;
	let maxBundles = 10;
	let cacheMaxBytes: number | undefined;
	let cacheMaxRecords: number | undefined;
	try {
		const { config: evidenceLoadedConfig } =
			_internals.loadPluginConfigWithMeta(ctx.directory);
		const evidenceCfg = (evidenceLoadedConfig.evidence ?? {}) as Record<
			string,
			unknown
		>;
		if (typeof evidenceCfg.max_age_days === 'number') {
			maxAgeDays = evidenceCfg.max_age_days;
		}
		if (typeof evidenceCfg.max_bundles === 'number') {
			maxBundles = evidenceCfg.max_bundles;
		}
		// Issue #1184: documents-cache retention caps. Only forwarded when set
		// so the cache remains append-only by default.
		if (typeof evidenceCfg.cache_max_bytes === 'number') {
			cacheMaxBytes = evidenceCfg.cache_max_bytes;
		}
		if (typeof evidenceCfg.cache_max_records === 'number') {
			cacheMaxRecords = evidenceCfg.cache_max_records;
		}
	} catch {
		// Fallback to defaults on config read failure
	}

	try {
		// Use the report overload so the documents-cache sweep (issue #1184)
		// runs when cache caps are configured. The report itself is not surfaced
		// to the finalize summary; only warnings on failure.
		await _internals.archiveEvidence(ctx.directory, maxAgeDays, maxBundles, {
			report: true,
			cacheMaxBytes,
			cacheMaxRecords,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.warnings.push(`Evidence retention archive failed: ${msg}`);
		log('[close-command] archiveEvidence error:', error);
	}
}
