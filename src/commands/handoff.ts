/**
 * Handle /swarm handoff command
 * Generates a handoff brief, writes to .swarm/handoff.md, triggers snapshot, and returns markdown.
 */
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
import { atomicWriteSwarmFile } from '../utils/atomic-write';

const HANDOFF_SOURCE_SESSION_PREFIX =
	'<!-- opencode-swarm-handoff-source-session:';

export function formatSessionScopedHandoffMarkdown(
	markdown: string,
	sessionID?: string,
): string {
	if (!sessionID) {
		return markdown;
	}
	return `${HANDOFF_SOURCE_SESSION_PREFIX} ${encodeURIComponent(sessionID)} -->\n${markdown}`;
}

export async function handleHandoffCommand(
	directory: string,
	_args: string[],
	sessionID?: string,
): Promise<string> {
	// Get handoff data from service
	const handoffData = await getHandoffData(directory);

	// Format as markdown
	const markdown = formatHandoffMarkdown(handoffData);

	// Write to .swarm/handoff.md via the canonical atomic helper (issue
	// #2035): `.swarm` containment, registered temp grammar, fsync, bounded
	// rename retry, exact own-temp cleanup, and cache invalidation. handoff.md
	// is read through the cached reader (`readSwarmFileAsync(directory,
	// 'handoff.md')` at src/hooks/system-enhancer.ts and
	// src/services/context-budget-service.ts), and the cache's stat stamp
	// (mtime+ctime+size) cannot distinguish a same-size rewrite landing inside
	// one filesystem timestamp tick (issue #1729) — the helper invalidates
	// after the successful rename.
	try {
		const resolvedPath = validateSwarmPath(directory, 'handoff.md');
		await atomicWriteSwarmFile(
			resolvedPath,
			formatSessionScopedHandoffMarkdown(markdown, sessionID),
		);

		// Build continuation prompt from structured data
		const continuationPrompt = formatContinuationPrompt(handoffData);

		// Write continuation prompt as a dedicated artifact (same helper).
		const promptPath = validateSwarmPath(directory, 'handoff-prompt.md');
		await atomicWriteSwarmFile(promptPath, continuationPrompt);

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
