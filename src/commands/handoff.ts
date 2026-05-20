/**
 * Handle /swarm handoff command
 * Generates a handoff brief, writes to .swarm/handoff.md, triggers snapshot, and returns markdown.
 */
import crypto from 'node:crypto';
import { renameSync, unlinkSync } from 'node:fs';
import { validateSwarmPath } from '../hooks/utils';
import {
	formatContinuationPrompt,
	formatHandoffMarkdown,
	getHandoffData,
} from '../services/handoff-service';
import {
	flushPendingSnapshot,
	writeSnapshot,
} from '../session/snapshot-writer';
import { swarmState } from '../state';
import { bunWrite } from '../utils/bun-compat';

export async function handleHandoffCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	// Get handoff data from service
	const handoffData = await getHandoffData(directory);

	// Format as markdown
	const markdown = formatHandoffMarkdown(handoffData);

	// Write to .swarm/handoff.md using atomic write (temp file + rename)
	try {
		const resolvedPath = validateSwarmPath(directory, 'handoff.md');
		const tempPath = `${resolvedPath}.tmp.${crypto.randomUUID()}`;
		await bunWrite(tempPath, markdown);
		try {
			renameSync(tempPath, resolvedPath);
		} catch (renameErr) {
			try {
				unlinkSync(tempPath);
			} catch {
				/* best effort cleanup */
			}
			throw renameErr;
		}

		// Build continuation prompt from structured data
		const continuationPrompt = formatContinuationPrompt(handoffData);

		// Write continuation prompt as a dedicated artifact
		const promptPath = validateSwarmPath(directory, 'handoff-prompt.md');
		const promptTempPath = `${promptPath}.tmp.${crypto.randomUUID()}`;
		await bunWrite(promptTempPath, continuationPrompt);
		try {
			renameSync(promptTempPath, promptPath);
		} catch (renameErr) {
			try {
				unlinkSync(promptTempPath);
			} catch {
				/* best effort cleanup */
			}
			throw renameErr;
		}

		// Trigger snapshot write
		await writeSnapshot(directory, swarmState);

		// v6.33.1: Also flush any debounced pending snapshot
		await flushPendingSnapshot(directory);

		// Return markdown response with copyable continuation block
		return `## Handoff Brief Written

Brief written to \`.swarm/handoff.md\`.
Continuation prompt written to \`.swarm/handoff-prompt.md\`.

${markdown}

---

## Continuation Prompt

Copy and paste the block below into your next session to resume cleanly:

${continuationPrompt}`;
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		return `## Handoff Generated (file write failed)

Handoff data was generated but could not be written to disk: ${errMsg}

The handoff content is included below for manual copy:

${markdown}`;
	}
}
