/**
 * record_issue_publication — persist an issue-bound publication receipt for the
 * issue-trace workflow (issue #2131 finding 2.4).
 *
 * The issue-trace reducer reaches `publication_handoff` when all implementation
 * phases are complete and the commit-pr directive has been emitted, but that is
 * NOT a terminal "issue resolved" state. The trace reaches `published` (the only
 * terminal state) only after an issue-bound publication receipt is observed.
 * commit-pr invokes this tool after PR creation/update. The reader
 * (`publicationReceiptExists` in issue-trace-state.ts) accepts the receipt only
 * when `published === true` AND `issueNumber` matches the traced issue — so a
 * prior issue's receipt cannot satisfy a new trace.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';
import { createSwarmTool } from './create-tool';

const RecordIssuePublicationArgsSchema = z
	.object({
		issueNumber: z.number().int().min(1),
		prNumber: z.number().int().min(1),
		prUrl: z
			.string()
			.url()
			.regex(
				/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/,
				'prUrl must be a canonical GitHub PR URL (https://github.com/<owner>/<repo>/pull/<number>)',
			),
		headSha: z.string().min(1).optional(),
	})
	.strict();

export async function executeRecordIssuePublication(
	args: unknown,
	directory: string,
): Promise<string> {
	const parsed = RecordIssuePublicationArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid publication receipt: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const { issueNumber, prNumber, prUrl, headSha } = parsed.data;

	const receipt: Record<string, unknown> = {
		published: true,
		issueNumber,
		prNumber,
		prUrl,
		publishedAt: new Date().toISOString(),
	};
	if (headSha) receipt.headSha = headSha;

	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, 'issue-publication.json');
	} catch (error) {
		return JSON.stringify({
			success: false,
			message:
				error instanceof Error ? error.message : 'Failed to validate path',
		});
	}

	try {
		const dir = path.dirname(validatedPath);
		await fs.promises.mkdir(dir, { recursive: true });
		const tmpPath = path.join(dir, '.issue-publication.json.tmp');
		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify(receipt, null, 2),
			'utf-8',
		);
		await fs.promises.rename(tmpPath, validatedPath);
		return JSON.stringify({
			success: true,
			issueNumber,
			prNumber,
			prUrl,
			path: '.swarm/issue-publication.json',
			message: `Publication receipt recorded for issue #${issueNumber} (PR #${prNumber}); the issue-trace workflow will transition to its terminal published state.`,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const record_issue_publication: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record that the traced issue has been published (PR created/updated) so the /swarm issue --trace workflow can reach its terminal published state. The trace stops at publication_handoff (the commit-pr directive) until this receipt is observed — publication_handoff is NOT "issue resolved". commit-pr calls this after the PR is created/updated. Supply the traced issue number, the exact PR number, the canonical GitHub PR URL, and (optionally) the published HEAD sha. The receipt is issue-bound.',
		args: {
			issueNumber: RecordIssuePublicationArgsSchema.shape.issueNumber,
			prNumber: RecordIssuePublicationArgsSchema.shape.prNumber,
			prUrl: RecordIssuePublicationArgsSchema.shape.prUrl,
			headSha: RecordIssuePublicationArgsSchema.shape.headSha,
		},
		execute: executeRecordIssuePublication,
	});
