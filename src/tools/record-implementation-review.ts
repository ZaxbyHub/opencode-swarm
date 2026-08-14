/**
 * record_implementation_review — persist an issue-bound independent
 * implementation-review receipt for the issue-trace workflow (issue #2131
 * residual criterion B).
 *
 * Records that FRESH-context reviewer and critic passes (separate contexts
 * from the implementer) both delivered APPROVE verdicts over the
 * implementation diff. This is an agent self-attestation of the review
 * discipline — it records the verdicts, the reviewed diff range, and the
 * calling session, but does not itself authenticate that the review contexts
 * were genuinely fresh; under PR-review/feedback modes the mechanically
 * authenticated reviewer gates remain the PR-workflow machinery. The trace
 * engine will not hand off to commit-pr until this receipt exists.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';
import { createSwarmTool } from './create-tool';

const RecordImplementationReviewArgsSchema = z
	.object({
		issueNumber: z.number().int().min(1),
		reviewerVerdict: z.enum(['APPROVE', 'NEEDS_REVISION', 'BLOCKED']),
		criticVerdict: z.enum(['APPROVE', 'NEEDS_REVISION', 'BLOCKED']),
		diffBase: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{7,40}$/i),
		diffHead: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{7,40}$/i),
		notes: z.string().trim().min(8).max(4000),
	})
	.strict();

export async function executeRecordImplementationReview(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RecordImplementationReviewArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid implementation review receipt: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	const data = parsed.data;
	if (data.reviewerVerdict !== 'APPROVE' || data.criticVerdict !== 'APPROVE') {
		return JSON.stringify({
			success: false,
			message:
				'A satisfying implementation-review receipt requires BOTH the reviewer and the critic to have delivered APPROVE; record non-approving verdicts in the working notes and fix the findings instead.',
		});
	}

	const receipt: Record<string, unknown> = {
		issueNumber: data.issueNumber,
		reviewerVerdict: data.reviewerVerdict,
		criticVerdict: data.criticVerdict,
		diffBase: data.diffBase,
		diffHead: data.diffHead,
		notes: data.notes,
		timestamp: new Date().toISOString(),
	};
	if (context.sessionID?.trim()) receipt.sessionId = context.sessionID.trim();

	let validatedPath: string;
	try {
		validatedPath = validateSwarmPath(directory, 'implementation-review.json');
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
		const tmpPath = path.join(dir, '.implementation-review.json.tmp');
		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify(receipt, null, 2),
			'utf-8',
		);
		await fs.promises.rename(tmpPath, validatedPath);
		return JSON.stringify({
			success: true,
			issueNumber: data.issueNumber,
			path: '.swarm/implementation-review.json',
			message: `Implementation review recorded for issue #${data.issueNumber} (reviewer APPROVE + critic APPROVE); the trace may now satisfy its review gate.`,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const record_implementation_review: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record the independent implementation review for the current traced issue (issue #2131 residual B): dispatch FRESH-context reviewer and critic passes over the implementation diff (separate contexts from the implementer), and once BOTH approve call this with the issue number, both APPROVE verdicts, the reviewed diff base/head SHAs, and notes. The /swarm issue --trace workflow will not hand off to commit-pr until this receipt exists. Non-approving verdicts cannot be recorded here — fix the findings and re-review.',
		args: {
			issueNumber: RecordImplementationReviewArgsSchema.shape.issueNumber,
			reviewerVerdict:
				RecordImplementationReviewArgsSchema.shape.reviewerVerdict,
			criticVerdict: RecordImplementationReviewArgsSchema.shape.criticVerdict,
			diffBase: RecordImplementationReviewArgsSchema.shape.diffBase,
			diffHead: RecordImplementationReviewArgsSchema.shape.diffHead,
			notes: RecordImplementationReviewArgsSchema.shape.notes,
		},
		execute: executeRecordImplementationReview,
	});
