import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadPluginConfigWithMeta } from '../../config';
import { finalizeContextTelemetry } from '../../context-map/telemetry.js';
import { finalizeCoreEventsForClose } from '../../events/core-events.js';
import { archiveEvidence } from '../../evidence/manager';
import {
	GITIGNORED_BUILD_ARTIFACTS,
	getGitRepositoryStatus,
	_internals as gitInternals,
	resetToMainAfterMerge,
	resetToRemoteBranch,
} from '../../git/branch';
import type { ConfirmedGitAlignment } from '../../git/branch.js';
import { runCuratorPostMortem } from '../../hooks/curator-postmortem';
import {
	removeWorktreeRecoveryAuthority,
	scanWorktreeRecoveryAuthoritiesForRecovery,
} from '../../hooks/delegation-gate/worktree-recovery-authority.js';
import { checkHivePromotions } from '../../hooks/hive-promoter';
import { curateAndStoreSwarm } from '../../hooks/knowledge-curator';
import {
	reconcilePhaseClose,
	recordPhaseCloseIntent,
} from '../../hooks/knowledge-receipt-ledger.js';
import { runFinalizeRewardSweep } from '../../memory/finalize-reward-sweep';
import { closeSnapshotCoordinationInitialization } from '../../session/snapshot-coordination-init.js';
import {
	endAgentSession,
	resetSwarmStatePreservingSingletons,
} from '../../state';
import { closeRepoMemory } from '../../tools/repo-graph/indexed-storage';
import { collectGarbageBestEffort, sleep } from '../../utils/bun-compat.js';
import { _internals, closeReceiptLifecycleInternals } from './internals.js';

/** Wire concrete dependencies only after the close facade has loaded its stages. */
export function wireCloseInternals(): void {
	Object.assign(closeReceiptLifecycleInternals, {
		recordPhaseCloseIntent,
		reconcilePhaseClose,
	});
	Object.assign(_internals, {
		closeSnapshotCoordinationInitialization,
		closeRepoMemory,
		unlink: fs.unlink,
		unlinkSidecarSync: fsSync.unlinkSync,
		sleep,
		collectGarbageBestEffort,
		getGitRepositoryStatus,
		getGitDestructiveInventory: (directory: string, pruneBranches: boolean) => {
			const paths: string[] = [];
			const branchLabels: string[] = [];
			const branchFingerprints: string[] = [];
			const headLabels: string[] = [];
			const branchCandidates: Array<
				ConfirmedGitAlignment['branchCandidates'][number]
			> = [];
			try {
				const status = gitInternals.gitExec(
					['status', '--porcelain=v1', '-z', '--untracked-files=all'],
					directory,
				);
				const records = status.split('\0');
				const addInventoryPath = (relative: string): void => {
					if (!relative) return;
					// The confirmation primitive's pending/claimed authorization record
					// is created between preview and post-lock inventory. It is internal
					// coordination state, not a close target; including it would make
					// the exact inventory digest change during an otherwise unchanged
					// confirmation.
					const relativeNormalized = relative.replaceAll('\\', '/');
					const isInternalPurgeRecord =
						relativeNormalized.startsWith('.swarm/') &&
						(/^pending-purge-[0-9a-f]{24}\.json$/.test(
							relativeNormalized.slice('.swarm/'.length),
						) ||
							/^pending-purge-[0-9a-f]{24}-[0-9a-f]{64}\.claimed\.json$/.test(
								relativeNormalized.slice('.swarm/'.length),
							));
					if (
						relativeNormalized === '.swarm/locks' ||
						relativeNormalized.startsWith('.swarm/locks/') ||
						isInternalPurgeRecord
					) {
						return;
					}
					paths.push(path.resolve(directory, relative));
				};
				for (let index = 0; index < records.length; index++) {
					const record = records[index];
					if (!record || record.length < 4) continue;
					const relative = record.slice(3);
					addInventoryPath(relative);
					if (
						(record[0] === 'R' ||
							record[0] === 'C' ||
							record[1] === 'R' ||
							record[1] === 'C') &&
						records[index + 1]
					) {
						addInventoryPath(records[++index]);
					}
				}
				for (const artifact of GITIGNORED_BUILD_ARTIFACTS) {
					if (fsSync.existsSync(path.join(directory, artifact))) {
						paths.push(path.resolve(directory, artifact));
					}
				}
				// Both alignment paths can checkout/reset HEAD even when the worktree
				// is clean. Bind the current identity and resolved target as a
				// non-deleting inventory sentinel so clean divergence cannot bypass
				// confirmation merely because there are no dirty paths.
				const defaultBranch = gitInternals.detectDefaultRemoteBranch(directory);
				const currentBranch = gitInternals
					.gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], directory)
					.trim();
				const currentHead = gitInternals
					.gitExec(['rev-parse', 'HEAD'], directory)
					.trim();
				const retainedRecoveryAuthorities: Array<
					NonNullable<
						ConfirmedGitAlignment['retainedRecoveryAuthorities']
					>[number]
				> = [];
				const recoveryScan =
					scanWorktreeRecoveryAuthoritiesForRecovery(directory);
				if (recoveryScan.status !== 'ok') {
					return {
						paths,
						branchLabels,
						branchFingerprints,
						headLabels,
						error:
							'retained recovery authority inventory unavailable: ' +
							recoveryScan.reason,
					};
				}
				for (const authority of recoveryScan.authorities) {
					if (
						authority.status !== 'preserved' ||
						authority.immutable.strategy !== 'squash'
					) {
						continue;
					}
					const branchName = authority.immutable.laneBranch;
					const branchTipSha = gitInternals
						.gitExec(['rev-parse', `refs/heads/${branchName}`], directory)
						.trim();
					if (!branchTipSha) continue;
					retainedRecoveryAuthorities.push(
						Object.freeze({
							authorityDigest: authority.authorityDigest,
							branchName,
							branchTipSha,
							resultTree: authority.immutable.resultTree,
							changedPaths: authority.immutable.changedPaths
								? Object.freeze([...authority.immutable.changedPaths])
								: undefined,
						}),
					);
					if (
						!branchCandidates.some((candidate) => candidate.name === branchName)
					) {
						branchCandidates.push(
							Object.freeze({
								name: branchName,
								tipSha: branchTipSha,
								reason: 'retained squash recovery branch',
							}),
						);
					}
				}
				if (retainedRecoveryAuthorities.length > 0) {
					paths.push(
						path.resolve(
							directory,
							'.swarm',
							'worktree-merge-recovery-v2.json',
						),
					);
				}
				let alignmentPlan: ConfirmedGitAlignment | undefined;
				if (!defaultBranch) {
					const targetRef = 'origin/HEAD';
					headLabels.push(
						currentBranch +
							':' +
							currentHead +
							'->' +
							targetRef +
							':unavailable',
					);
					alignmentPlan = Object.freeze({
						defaultBranch: '',
						targetRef,
						targetSha: '',
						targetAvailable: false,
						currentBranch,
						currentHeadSha: currentHead,
						branchCandidates: Object.freeze([...branchCandidates]),
						retainedRecoveryAuthorities: Object.freeze([
							...retainedRecoveryAuthorities,
						]),
					});
					return {
						paths,
						branchLabels: branchCandidates.map((candidate) => candidate.name),
						branchFingerprints: branchCandidates.map(
							(candidate) =>
								candidate.name +
								'\0' +
								candidate.tipSha +
								'\0' +
								candidate.reason,
						),
						headLabels,
						alignmentPlan,
					};
				}
				if (defaultBranch) {
					const targetRef = `origin/${defaultBranch}`;
					let targetSha = '';
					try {
						targetSha = gitInternals
							.gitExec(['rev-parse', targetRef], directory)
							.trim();
					} catch {
						// A local-only repository has no destructive alignment target.
						// Bind that fact into the confirmation scope so a remote appearing
						// after preview becomes inventory drift instead of silently widening
						// an unconfirmed legacy alignment.
						headLabels.push(
							`${currentBranch}:${currentHead}->${targetRef}:unavailable`,
						);
						const alignmentPlan = Object.freeze({
							defaultBranch,
							targetRef,
							targetSha: '',
							targetAvailable: false,
							currentBranch,
							currentHeadSha: currentHead,
							branchCandidates: Object.freeze([...branchCandidates]),
							retainedRecoveryAuthorities: Object.freeze([
								...retainedRecoveryAuthorities,
							]),
						});
						return {
							paths,
							branchLabels: branchCandidates.map((candidate) => candidate.name),
							branchFingerprints: branchCandidates.map(
								(candidate) =>
									candidate.name +
									'\0' +
									candidate.tipSha +
									'\0' +
									candidate.reason,
							),
							headLabels,
							alignmentPlan,
						};
					}
					if (!targetSha) {
						headLabels.push(
							`${currentBranch}:${currentHead}->${targetRef}:unavailable`,
						);
						const alignmentPlan = Object.freeze({
							defaultBranch,
							targetRef,
							targetSha: '',
							targetAvailable: false,
							currentBranch,
							currentHeadSha: currentHead,
							branchCandidates: Object.freeze([...branchCandidates]),
							retainedRecoveryAuthorities: Object.freeze([
								...retainedRecoveryAuthorities,
							]),
						});
						return {
							paths,
							branchLabels: branchCandidates.map((candidate) => candidate.name),
							branchFingerprints: branchCandidates.map(
								(candidate) =>
									candidate.name +
									'\0' +
									candidate.tipSha +
									'\0' +
									candidate.reason,
							),
							headLabels,
							alignmentPlan,
						};
					}
					if (currentBranch !== defaultBranch || currentHead !== targetSha) {
						headLabels.push(
							`${currentBranch}:${currentHead}->${targetRef}:${targetSha}`,
						);
					}
					const addBranchCandidate = (name: string, reason: string): void => {
						if (
							!name ||
							name === defaultBranch ||
							name === 'HEAD' ||
							branchCandidates.some((candidate) => candidate.name === name)
						) {
							return;
						}
						const tipSha = gitInternals
							.gitExec(['rev-parse', `refs/heads/${name}`], directory)
							.trim();
						if (tipSha) {
							branchCandidates.push(Object.freeze({ name, tipSha, reason }));
						}
					};

					// Resolve the complete candidate set from local refs before fetch.
					// `targetSha` is immutable for the eventual destructive reset.
					const merged = gitInternals.gitExec(
						['branch', '--merged', targetSha],
						directory,
					);
					const mergedBranches = new Set(
						merged
							.split(/\r?\n/)
							.map((raw) => raw.replace(/^[*+]\s*/, '').trim())
							.filter(Boolean),
					);
					if (
						currentBranch !== defaultBranch &&
						mergedBranches.has(currentBranch)
					) {
						addBranchCandidate(currentBranch, 'automatic prior branch');
					}
					if (pruneBranches) {
						for (const name of mergedBranches) {
							addBranchCandidate(name, 'prune merged branch');
						}
					}
					if (pruneBranches) {
						const branchVv = gitInternals.gitExec(['branch', '-vv'], directory);
						for (const raw of branchVv.split(/\r?\n/)) {
							const label = raw.replace(/^[*+]\s*/, '').trim();
							if (label.includes(': gone]')) {
								const branchName = label.split(/\s+/)[0];
								addBranchCandidate(branchName, 'prune gone branch');
							}
						}
					}
					branchLabels.push(
						...branchCandidates.map((candidate) => candidate.name),
					);
					branchFingerprints.push(
						...branchCandidates.map(
							(candidate) =>
								`${candidate.name}\0${candidate.tipSha}\0${candidate.reason}`,
						),
					);
					alignmentPlan = Object.freeze({
						defaultBranch,
						targetRef,
						targetSha,
						targetAvailable: true,
						currentBranch,
						currentHeadSha: currentHead,
						branchCandidates: Object.freeze([...branchCandidates]),
						retainedRecoveryAuthorities: Object.freeze([
							...retainedRecoveryAuthorities,
						]),
					});
				}
				return {
					paths,
					branchLabels,
					branchFingerprints,
					headLabels,
					alignmentPlan,
				};
			} catch (error) {
				return {
					paths,
					branchLabels,
					branchFingerprints,
					headLabels,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		removeConfirmedRecoveryAuthority: (
			directory: string,
			authority: NonNullable<
				ConfirmedGitAlignment['retainedRecoveryAuthorities']
			>[number],
		) => {
			return removeWorktreeRecoveryAuthority(directory, {
				authorityDigest: authority.authorityDigest,
				branchName: authority.branchName,
				branchTipSha: authority.branchTipSha,
				resultTree: authority.resultTree,
				changedPaths: authority.changedPaths
					? [...authority.changedPaths]
					: undefined,
				readBranchTip: () => {
					try {
						return gitInternals
							.gitExec(
								['rev-parse', `refs/heads/${authority.branchName}`],
								directory,
							)
							.trim();
					} catch {
						// The exact branch was deleted by the confirmed alignment stage.
						return undefined;
					}
				},
			});
		},
		resetToMainAfterMerge,
		resetToRemoteBranch,
		loadPluginConfigWithMeta,
		curateAndStoreSwarm,
		checkHivePromotions,
		runCuratorPostMortem,
		resetSwarmStatePreservingSingletons,
		runFinalizeRewardSweep,
		archiveEvidence,
		endAgentSession,
		flushAndDrainTelemetry: async (): Promise<void> => {
			const { flushAndDrainTelemetry } = await import('../../telemetry.js');
			return flushAndDrainTelemetry();
		},
		finalizeContextTelemetry,
		finalizeCoreEvents: finalizeCoreEventsForClose,
	});
}
