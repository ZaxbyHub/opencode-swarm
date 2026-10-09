/**
 * Handle /swarm handoff command
 * Generates a handoff brief, writes to .swarm/handoff.md, triggers snapshot, and returns markdown.
 */
import { renameSync } from 'node:fs';
import { bunWrite } from '@opencode-swarm/core';
import { validateSwarmPath } from '../hooks/utils';
import {
	formatHandoffMarkdown,
	getHandoffData,
} from '../services/handoff-service';
import { writeSnapshot } from '../session/snapshot-writer';
import { swarmState } from '../state';

export async function handleHandoffCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	// Get handoff data from service
	const handoffData = await getHandoffData(directory);

	// Format as markdown
	const markdown = formatHandoffMarkdown(handoffData);

	// Write to .swarm/handoff.md using atomic write (temp file + rename)
	const resolvedPath = validateSwarmPath(directory, 'handoff.md');
	const tempPath = `${resolvedPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
	await bunWrite(tempPath, markdown);
	renameSync(tempPath, resolvedPath);

	// Trigger snapshot write
	await writeSnapshot(directory, swarmState);

	// Return markdown response
	return `## Handoff Brief Written

Brief written to \`.swarm/handoff.md\`.

${markdown}

---

**Next Step:** Start a new OpenCode session, switch to your target model, and send: \`continue the previous work\``;
}
