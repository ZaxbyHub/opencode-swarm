import { findByBatchId } from '../../src/background/pending-delegations.js';

const REQUIRED_PR_REVIEW_TOOLS = [
	'dispatch_lanes_async',
	'submit_pr_review_result',
	'write_pr_review_artifact',
	'write_pr_review_trigger_eval',
	'complete_pr_workflow',
] as const;

export function createIssue2469HostClient(options: {
	nextChildId: () => string;
	onPrompt: (sessionID: string, prompt: string) => void;
}) {
	return {
		session: {
			create: async () => ({
				data: { id: options.nextChildId() },
				error: undefined,
			}),
			promptAsync: async (args: {
				path: { id: string };
				body: { parts: Array<{ text?: string }> };
			}) => {
				options.onPrompt(args.path.id, args.body.parts[0]?.text ?? '');
				return { data: undefined, error: undefined };
			},
		},
	};
}

export function formatIssue2469Evidence(
	resilienceEnabled: boolean,
	completion: Record<string, unknown> & {
		terminal_report: Record<string, unknown>;
	},
	options: {
		tools: Record<string, { execute?: unknown }>;
		directory: string;
		parentSessionId: string;
		baseBatchIds: readonly string[];
	},
): string {
	const registeredTools = REQUIRED_PR_REVIEW_TOOLS.filter(
		(name) => typeof options.tools[name]?.execute === 'function',
	);
	const consolidatedLaneReceipts = options.baseBatchIds
		.flatMap((batchId) =>
			findByBatchId(options.directory, batchId, options.parentSessionId),
		)
		.filter((record) => (record.ownedWorkflowLanes?.length ?? 0) > 1)
		.map((record) => ({
			batch_id: record.batchId,
			lane_id: record.laneId,
			status: record.status,
			credited_lanes:
				record.result?.prReviewResultReceipt?.envelope.creditedLanes ?? [],
			legacy_transcript_compatibility:
				record.prReviewLegacyTranscriptCompatibility ?? null,
		}));
	return `[ISSUE-2469-EVIDENCE] ${JSON.stringify({
		schema_version: 1,
		runner_os: process.platform,
		ci_commit: process.env.GITHUB_SHA ?? null,
		resilience_enabled: resilienceEnabled,
		registered_tools: registeredTools,
		consolidated_lane_receipts: consolidatedLaneReceipts,
		completion,
		coverage_receipt: completion.terminal_report,
	})}`;
}
