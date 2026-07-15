/**
 * knowledge_archive — archival-by-default removal with audit tombstones.
 *
 * Unlike knowledge_remove (which hard-deletes a swarm entry), this tool defaults
 * to a reversible status transition and always appends an immutable `archived`
 * event to `.swarm/knowledge-events.jsonl` recording the actor, reason, evidence,
 * and previous status.
 *
 * Modes:
 *  - 'archive'    (default): set status='archived' — hidden from recall, records
 *                            `archived_from` so it can be unarchived (G6 #1716).
 *  - 'quarantine':           route through `quarantineEntry` (G5 #1716) — moves
 *                            the entry to `knowledge-quarantined.jsonl`, records
 *                            `original_status`, restorable via `/swarm knowledge restore`.
 *                            Swarm-only; hive+quarantine returns a clear error.
 *  - 'purge':                hard-delete the JSONL line. Requires allow_purge:true.
 *
 * Tiers:
 *  - 'swarm' (default): archives a project-local swarm entry.
 *  - 'hive':            archives a shared hive entry (cross-project knowledge).
 */

import { z } from 'zod';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type {
	CurationAction,
	CurationEvidenceScope,
	KnowledgeEntryBase,
} from '../hooks/knowledge-types.js';
import { quarantineEntry } from '../hooks/knowledge-validator.js';
import { writeArchiveTombstoneAndInvalidateSkills } from '../hooks/skill-invalidator.js';
import {
	authorizeCuration,
	type CurationAuthorizationInput,
	type CurationContext,
} from '../knowledge/curation-policy.js';
import { warn } from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

const MODES = ['archive', 'quarantine', 'purge'] as const;
type ArchiveMode = (typeof MODES)[number];

const TIERS = ['swarm', 'hive'] as const;
type ArchiveTier = (typeof TIERS)[number];

/** #1848: load the resolved KnowledgeConfig for the curation policy. */
async function loadConfigForPolicy() {
	const { KnowledgeConfigSchema } = await import('../config/schema.js');
	return KnowledgeConfigSchema.parse({});
}

export const knowledge_archive: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			"Archive (default), quarantine, or purge a swarm or hive knowledge entry by ID, appending an immutable audit tombstone. 'archive'/'quarantine' set the entry status reversibly and hide it from recall; 'purge' hard-deletes and requires allow_purge:true.",
		args: {
			id: z.string().min(1).describe('UUID of the knowledge entry'),
			tier: z
				.enum(TIERS)
				.optional()
				.describe("Knowledge tier to modify; default 'swarm'"),
			reason: z
				.string()
				.min(1)
				.max(500)
				.describe('Why the entry is being archived/quarantined/purged'),
			evidence: z
				.string()
				.max(1000)
				.optional()
				.describe(
					'Supporting evidence (e.g. "ignored 8 times, contradicted by tests")',
				),
			mode: z.enum(MODES).optional().describe("Default 'archive'"),
			allow_purge: z
				.boolean()
				.optional()
				.describe("Admin flag required when mode='purge'"),
		},
		execute: async (args: unknown, directory, ctx): Promise<string> => {
			const a = (args ?? {}) as {
				id?: unknown;
				reason?: unknown;
				tier?: unknown;
				evidence?: unknown;
				mode?: unknown;
				allow_purge?: unknown;
			};

			const id = typeof a.id === 'string' ? a.id : '';
			if (!id) {
				return JSON.stringify({
					success: false,
					error: 'id must be a non-empty string',
				});
			}
			const reason = typeof a.reason === 'string' ? a.reason : '';
			if (!reason) {
				return JSON.stringify({
					success: false,
					error: 'reason is required',
				});
			}
			const evidence = typeof a.evidence === 'string' ? a.evidence : undefined;
			const tier: ArchiveTier = a.tier === 'hive' ? 'hive' : 'swarm';
			const mode: ArchiveMode =
				a.mode === 'quarantine' || a.mode === 'purge' ? a.mode : 'archive';

			if (mode === 'purge' && a.allow_purge !== true) {
				return JSON.stringify({
					success: false,
					error: 'purge requires allow_purge:true (admin flag)',
				});
			}

			// G5 (#1716): route `mode:'quarantine'` through the canonical
			// `quarantineEntry`, which (unlike the legacy in-place flip) moves the
			// entry to `knowledge-quarantined.jsonl`, records `original_status` +
			// `quarantine_reason` + `quarantined_at`, and is restorable via
			// `restoreEntry`. The legacy in-place flip produced an unrestorable
			// orphan that was invisible to `restoreEntry`.
			//
			// `quarantineEntry` is swarm-only (it reads `resolveSwarmKnowledgePath`).
			// Hive-tier quarantine via this tool is rejected with a clear error — the
			// old behavior silently flipped status in place and was already broken
			// (unrestorable). Users who need hive-tier quarantine should use the
			// `/swarm knowledge quarantine` command (also swarm-only today) or wait
			// for hive-quarantine to be added as a separate feature.
			if (mode === 'quarantine') {
				if (tier === 'hive') {
					return JSON.stringify({
						success: false,
						error:
							"quarantine via the archive tool is swarm-only; use tier:'swarm' or the /swarm knowledge quarantine command",
					});
				}
				try {
					// PRR-003: verify the entry exists before calling quarantineEntry.
					// quarantineEntry silently returns void on not-found (it only
					// warns), so without this check the tool would report
					// `success:true` for a missing id — diverging from the archive
					// mode which returns `{success:false, message:'entry not found'}`.
					const swarmEntries = await readKnowledge<KnowledgeEntryBase>(
						resolveSwarmKnowledgePath(directory),
					);
					const target = swarmEntries.find((e) => e.id === id);
					if (!target) {
						return JSON.stringify({
							success: false,
							message: 'entry not found',
						});
					}
					const reportedBy: 'architect' | 'user' | 'auto' =
						ctx?.agent === 'architect' ? 'architect' : 'user';
					// #1848 §2: route quarantine through the cohort-safe policy.
					const curationInput: CurationAuthorizationInput = {
						directory,
						action: 'quarantine' as CurationAction,
						entryId: id,
						reason,
						evidenceScope: 'cohort-wide' as CurationEvidenceScope,
						actorRole: ctx?.agent,
					};
					const curationContext: CurationContext = {
						config: await loadConfigForPolicy(),
						entry: target,
					};
					await quarantineEntry(directory, id, reason, reportedBy, {
						input: curationInput,
						context: curationContext,
					});
				} catch (err) {
					return JSON.stringify({
						success: false,
						error:
							err instanceof Error
								? err.message
								: 'Unknown error during quarantine',
					});
				}
				// Short-circuit BEFORE the events tombstone + queueMicrotask below:
				// those side-effects are archive/purge-only. `quarantineEntry`
				// already wrote its own audit trail (rejected-file tombstone), and
				// skill-retirement is irreversible (wrong for a reversible quarantine).
				return JSON.stringify({
					success: true,
					id,
					tier,
					mode,
					status: 'quarantined',
				});
			}

			const knowledgePath =
				tier === 'hive'
					? resolveHiveKnowledgePath()
					: resolveSwarmKnowledgePath(directory);
			let found = false;
			let previousStatus: string | undefined;
			const now = new Date().toISOString();
			let resultStatus: string | undefined;

			// #1848 §2: cohort-safe authorization for archive/purge (swarm tier).
			// Hive-tier entries are cross-project and already gated by hive-policy
			// at promotion; the destructive archive here is the operator path and
			// remains available. For swarm tier, route through authorizeCuration.
			if (tier === 'swarm') {
				const preEntries =
					await readKnowledge<KnowledgeEntryBase>(knowledgePath);
				const preTarget = preEntries.find((e) => e.id === id) ?? null;
				// Skip authorization for a missing entry — let the existing
				// not-found path handle it (avoids a misleading policy error).
				if (preTarget) {
					const curationInput: CurationAuthorizationInput = {
						directory,
						action: mode as CurationAction,
						entryId: id,
						reason,
						evidenceScope: 'cohort-wide' as CurationEvidenceScope,
						actorRole: ctx?.agent,
						override:
							mode === 'purge'
								? {
										actor: 'manual-override',
										reason: 'operator purge (allow_purge)',
									}
								: undefined,
					};
					const curationContext: CurationContext = {
						config: await loadConfigForPolicy(),
						entry: preTarget,
					};
					const decision = await authorizeCuration(
						curationInput,
						curationContext,
					);
					if (!decision.authorized) {
						return JSON.stringify({
							success: false,
							error: `Cohort-safety policy blocked this ${mode}: ${decision.detail}`,
							basis: decision.basis,
						});
					}
				} // end if (preTarget)
			} // end if (tier === 'swarm')

			try {
				await transactKnowledge<KnowledgeEntryBase>(
					knowledgePath,
					(entries) => {
						const target = entries.find((e) => e.id === id);
						if (!target) return null;
						found = true;
						previousStatus = target.status;

						if (mode === 'purge') {
							// Defense-in-depth: hard-delete is irreversible. Emit a prominent
							// warning even though allow_purge:true was already required. The
							// archived event below is the audit trail.
							warn(
								`[knowledge_archive] PURGE: hard-deleting ${tier} entry id=${id} actor=${
									ctx?.agent ?? 'unknown'
								} reason=${reason}`,
							);
							resultStatus = 'purged';
							return entries.filter((e) => e.id !== id);
						}

						// PRR-015 / G6 (#1716): guard against re-archiving an already-
						// archived entry. A duplicate/late archive call would otherwise
						// record `archived_from: 'archived'` (self-referential), breaking
						// unarchive's status recovery. Preserve the existing archived_from
						// and skip the rewrite. Matches curator path (curator.ts:1692-1699).
						if (target.status === 'archived') {
							resultStatus = 'archived';
							return entries;
						}
						// G6 (#1716): record `archived_from` so `unarchiveEntry` can
						// restore the prior status. Only the `archive` mode reaches here
						// (quarantine was short-circuited above; purge returns early).
						resultStatus = 'archived';
						return entries.map((e) =>
							e.id === id
								? {
										...e,
										status: 'archived' as const,
										archived_from: target.status,
										archived_at: now,
										updated_at: now,
									}
								: e,
						);
					},
				);
			} catch (err) {
				return JSON.stringify({
					success: false,
					error: err instanceof Error ? err.message : 'Unknown error',
				});
			}
			if (!found) {
				return JSON.stringify({ success: false, message: 'entry not found' });
			}

			// G11 (issue #1717): route through the shared tombstone + retire/stale
			// invalidator so this path cannot diverge from the curator archive
			// path and knowledge-remove. Fire-and-forget (fail-open).
			await writeArchiveTombstoneAndInvalidateSkills({
				directory,
				entryId: id,
				tier,
				actor: ctx?.agent ?? 'unknown',
				reason,
				mode,
				evidence,
				previousStatus,
				sourceLabel: 'knowledge-archive',
			});

			return JSON.stringify({
				success: true,
				id,
				tier,
				mode,
				previous_status: previousStatus,
				status: resultStatus,
			});
		},
	});

export const _internals: { knowledge_archive: typeof knowledge_archive } = {
	knowledge_archive,
};
