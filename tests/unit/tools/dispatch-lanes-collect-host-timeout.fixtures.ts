import { mock } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPendingDelegation } from '../../../src/background/pending-delegations';
import { _internals, type SessionOps } from '../../../src/tools/dispatch-lanes';

export const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

export function createCollectLaneTimeoutFixture() {
	const originalInternals = { ..._internals };
	const directories: string[] = [];

	async function withTestDeadline<T>(promise: Promise<T>): Promise<T> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error('test deadline exceeded')),
						500,
					);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	function makeTempDir(): string {
		const directory = realpathSync(
			mkdtempSync(join(tmpdir(), 'collect-host-timeout-')),
		);
		directories.push(directory);
		return directory;
	}

	async function recordPending(args: {
		directory: string;
		batchId: string;
		laneId?: string;
		correlationId?: string;
		mode?: string;
		workflowLane?: string;
		prReviewLegacyTranscriptCompatibility?: boolean;
		workspace?: {
			directory: string;
			gitHead: string;
			dirtyHash: string | null;
			prHeadSha: string;
			scope: string;
		};
	}): Promise<void> {
		const correlationId = args.correlationId ?? `${args.batchId}-session`;
		await recordPendingDelegation(args.directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: `${args.batchId}-parent`,
			callID: args.batchId,
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: args.batchId,
			laneId: args.laneId ?? `${args.batchId}-lane`,
			mode: args.mode ?? 'advisory',
			...(args.workflowLane ? { workflowLane: args.workflowLane } : {}),
			...(args.prReviewLegacyTranscriptCompatibility !== undefined
				? {
						prReviewLegacyTranscriptCompatibility:
							args.prReviewLegacyTranscriptCompatibility,
					}
				: args.mode === 'swarm-pr-review:base' ||
						args.mode === 'swarm-pr-review:micro'
					? { prReviewLegacyTranscriptCompatibility: true }
					: {}),
			...(args.workspace ? { workspace: args.workspace } : {}),
			promptHash: `${args.batchId}-hash`,
			generation: 1,
		});
	}

	function baseOps(): Pick<SessionOps, 'create' | 'prompt' | 'delete'> {
		return {
			create: mock(async () => ({ data: { id: 'unused' } })),
			prompt: mock(async () => ({ data: null })),
			delete: mock(async () => undefined),
		};
	}

	function assistantMessage(
		text: string,
		overrides: Partial<
			NonNullable<
				Awaited<ReturnType<NonNullable<SessionOps['messages']>>>['data']
			>[number]['info']
		> = {},
	) {
		return {
			info: {
				role: 'assistant',
				time: { completed: 2 },
				finish: 'stop',
				...overrides,
			},
			parts: [{ type: 'text', text }],
		};
	}

	function restoreInternals(): void {
		Object.assign(_internals, originalInternals);
	}

	async function cleanupTempDirs(): Promise<void> {
		await Promise.all(
			directories
				.splice(0)
				.map((directory) => rm(directory, { recursive: true, force: true })),
		);
	}

	return {
		assistantMessage,
		baseOps,
		cleanupTempDirs,
		makeTempDir,
		recordPending,
		restoreInternals,
		withTestDeadline,
	};
}
