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
	type KnowledgeEventInput,
	recordHiveKnowledgeEvent,
	recordKnowledgeEvent,
} from '../hooks/knowledge-events.js';
import {
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	transactKnowledge,
	transactKnowledgeWithCas,
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

/**
 * #1848: load the resolved KnowledgeConfig for the curation policy.
 *
 * F-06: load the REAL project config (ownership quorum, protected-owner rules,
 * etc.) instead of bare schema defaults, so authorizeCuration sees the project's
 * actual cohort-safety settings. `loadPluginConfigWithMeta` is synchronous.
 */
async function loadConfigForPolicy(directory: string) {
	const { KnowledgeConfigSchema } = await import('../config/schema.js');
	const { loadPluginConfigWithMeta } = await import('../config/index.js');
	const { config: loaded } = loadPluginConfigWithMeta(directory);
	return KnowledgeConfigSchema.parse(loaded.knowledge ?? {});
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
						config: await loadConfigForPolicy(directory),
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

			// PRR-002: revision + content_hash captured from the pre-authorization
			// read, used to CAS-guard the swarm archive mutation so a concurrent
			// update between authorize and mutate cannot be silently clobbered.
			let casExpectedRevision: number | undefined;
			let casExpectedContentHash: string | undefined;
			// PRR-010: set when authorization was granted via the manual-override
			// bypass so an explicit override-audit event can be appended below.
			let overrideDecisionBasis: string | undefined;
			let overrideActor: string | undefined;
			let overrideReason: string | undefined;

			// #1848 §2: cohort-safe authorization for archive/purge (swarm tier).
			// Hive-tier entries are cross-project and already gated by hive-policy
			// at promotion; the destructive archive here is the operator path and
			// remains available. For swarm tier, route through authorizeCuration.
			if (tier === 'swarm') {
				// #1848 review F-14: honor the tool's {success:false, error}
				// contract on I/O failure during the pre-authorization read
				// (same class of bug as knowledge-remove F-13); an unguarded
				// throw would escape to createSwarmTool's outer wrapper and drop
				// the `.error` field.
				let preEntries: KnowledgeEntryBase[];
				try {
					preEntries = await readKnowledge<KnowledgeEntryBase>(knowledgePath);
				} catch (err) {
					const message = err instanceof Error ? err.message : 'Unknown error';
					return JSON.stringify({ success: false, error: message });
				}
				const preTarget = preEntries.find((e) => e.id === id) ?? null;
				// Skip authorization for a missing entry — let the existing
				// not-found path handle it (avoids a misleading policy error).
				if (preTarget) {
					// F-03: purge no longer auto-synthesizes a `manual-override` from
					// `allow_purge:true`. `allow_purge` remains the LOCAL admin confirmation
					// required to ATTEMPT a purge (checked above), but it must not bypass
					// cohort ownership/quorum. Purge now routes through authorizeCuration
					// with NO override — identical to archive — so the normal ladder applies:
					// unlinked/owner → authorized; cross-owner in a linked cohort → blocked
					// (returns a proposal) and the not-authorized path below reports it.
					// The `override` variable stays declared (always undefined here) so the
					// defensive PRR-010 override-audit branch remains wired for any future
					// explicit operator override, without any current code producing one.
					const override:
						| { actor: 'manual-override'; reason: string }
						| undefined = undefined;
					const curationInput: CurationAuthorizationInput = {
						directory,
						action: mode as CurationAction,
						entryId: id,
						reason,
						evidenceScope: 'cohort-wide' as CurationEvidenceScope,
						actorRole: ctx?.agent,
						override,
					};
					const curationContext: CurationContext = {
						config: await loadConfigForPolicy(directory),
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
					// PRR-002: capture the authorized entry's revision + content_hash so
					// the swarm archive mutation below can CAS against them (rejecting a
					// stale plan if the entry changed between here and the mutation).
					casExpectedRevision = preTarget.revision;
					casExpectedContentHash = preTarget.content_hash;
					// PRR-010: when the override bypass was the actual decision basis, the
					// standard archived tombstone does not record that an ownership/quorum
					// gate was bypassed. Capture it so an explicit override-audit event is
					// appended after the mutation (who/why/basis are all auditable).
					if (decision.basis === 'override' && curationInput.override) {
						overrideDecisionBasis = decision.basis;
						overrideActor = curationInput.override.actor;
						overrideReason = curationInput.override.reason;
					}
				} // end if (preTarget)
			} // end if (tier === 'swarm')

			if (tier === 'swarm' && mode === 'archive') {
				// PRR-002: CAS-guarded swarm archive. transactKnowledgeWithCas is the
				// natural home for the single-entry ARCHIVE mutation — it enforces the
				// revision/content_hash contract INSIDE the directory lock, closing the
				// authorize→mutate TOCTOU. Legacy entries (revision undefined/0) are
				// permitted: expectedRevision===undefined skips the revision check.
				let casResult: { committed: boolean; casFailed: boolean };
				try {
					casResult = await transactKnowledgeWithCas<KnowledgeEntryBase>(
						directory,
						knowledgePath,
						id,
						casExpectedRevision,
						casExpectedContentHash,
						(entry) => {
							found = true;
							previousStatus = entry.status;
							// PRR-015 / G6 (#1716): never re-archive an already-archived
							// entry (would record self-referential archived_from). Return
							// null → no-op commit; the success path reports 'archived'.
							if (entry.status === 'archived') {
								resultStatus = 'archived';
								return null;
							}
							// G6 (#1716): record `archived_from` so `unarchiveEntry` can
							// restore the prior status.
							resultStatus = 'archived';
							return {
								mutated: {
									...entry,
									status: 'archived' as const,
									archived_from: entry.status,
									archived_at: now,
									updated_at: now,
								},
							};
						},
					);
				} catch (err) {
					return JSON.stringify({
						success: false,
						error: err instanceof Error ? err.message : 'Unknown error',
					});
				}
				if (casResult.casFailed) {
					// The entry's revision/content_hash changed between authorization
					// and mutation (a sibling worktree updated it). Reject the stale
					// plan rather than clobbering the newer entry.
					return JSON.stringify({
						success: false,
						error:
							'entry changed since authorization (revision/content-hash mismatch); stale archive plan rejected',
					});
				}
			} else {
				// Purge (swarm or hive) and hive-tier archive keep the plain
				// single-transaction path (CAS is scoped to the swarm archive mutation).
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
			} // end else (purge / hive-tier archive plain transaction)
			if (!found) {
				return JSON.stringify({ success: false, message: 'entry not found' });
			}

			// PRR-010: the standard archived tombstone records who/why/mode but NOT
			// that an ownership/quorum gate was BYPASSED via the manual-override. When
			// the authorization decision basis was the override path, suppress the
			// helper's plain tombstone (`skipTombstone`) and write a single ENRICHED
			// archived tombstone below carrying the override markers. This keeps the
			// tombstone count invariant (exactly one archived event per removal) while
			// making the bypass auditable (actor/reason/basis). Skill invalidation
			// still runs — `skipTombstone` only suppresses the tombstone write.
			const overrideUsed = Boolean(overrideDecisionBasis);

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
				skipTombstone: overrideUsed,
			});

			// PRR-010: enriched override tombstone (replaces the suppressed plain one).
			// Reuses the existing knowledge-event mechanism — no new file. Fail-open.
			if (overrideUsed) {
				const overrideTombstone = {
					type: 'archived' as const,
					entry_id: id,
					tier,
					actor: ctx?.agent ?? 'unknown',
					reason,
					mode,
					evidence,
					previous_status: previousStatus,
					// Explicit bypass markers (extra fields on the archived event; the
					// event log preserves them verbatim for audit tooling).
					override_used: true,
					override_actor: overrideActor,
					override_reason: overrideReason,
					decision_basis: overrideDecisionBasis,
				} as KnowledgeEventInput;
				if (tier === 'hive') {
					await recordHiveKnowledgeEvent(overrideTombstone);
				} else {
					await recordKnowledgeEvent(directory, overrideTombstone);
				}
			}

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
