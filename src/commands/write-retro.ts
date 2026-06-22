/**
 * Handle /swarm write-retro command
 * Accepts a JSON string, parses it as WriteRetroArgs, and delegates to executeWriteRetro().
 * Returns markdown output suitable for display in the swarm UI.
 */
import { executeWriteRetro, type WriteRetroArgs } from '../tools/write-retro';

export async function handleWriteRetroCommand(
	directory: string,
	args: string[],
): Promise<string> {
	// Check if args[0] is provided
	if (args.length === 0 || !args[0] || args[0].trim() === '') {
		return `## Usage: /swarm write-retro <json>

Writes a retrospective evidence bundle for a completed phase.

### Required JSON fields:
\`\`\`json
{
  "phase": 1,
  "summary": "Phase summary here",
  "task_count": 3,
  "task_complexity": "simple",
  "total_tool_calls": 20,
  "coder_revisions": 1,
  "reviewer_rejections": 0,
  "test_failures": 0,
  "security_findings": 0,
  "integration_issues": 0
}
\`\`\`

### Optional fields:
- \`lessons_learned\`: string[] (max 5)
- \`top_rejection_reasons\`: string[]
- \`task_id\`: string (defaults to \`retro-{phase}\`)
- \`metadata\`: Record<string, unknown>

### task_complexity values: trivial | simple | moderate | complex`;
	}

	// Try to parse the JSON argument
	let parsedArgs: WriteRetroArgs;
	try {
		const jsonObj = JSON.parse(args[0]);
		if (
			typeof jsonObj !== 'object' ||
			jsonObj === null ||
			Array.isArray(jsonObj)
		) {
			return 'Error: Invalid JSON — expected a JSON object with retro fields. Run `/swarm write-retro` with no arguments to see usage.';
		}
		parsedArgs = jsonObj as WriteRetroArgs;
	} catch {
		// Justification: user-supplied JSON may be syntactically invalid.
		// We return a helpful error message rather than propagating the
		// parse exception — the command output is the reporting surface.
		return 'Error: Invalid JSON — expected a JSON object with retro fields. Run `/swarm write-retro` with no arguments to see usage.';
	}

	// Delegate to executeWriteRetro
	const resultJson = await executeWriteRetro(parsedArgs, directory);
	let result: {
		success: boolean;
		phase?: number;
		task_id?: string;
		message?: string;
	};
	try {
		result = JSON.parse(resultJson) as {
			success: boolean;
			phase?: number;
			task_id?: string;
			message?: string;
		};
	} catch {
		// Justification: executeWriteRetro returns a JSON string, but an
		// unexpected runtime error (e.g. serialization failure) could
		// produce non-JSON output. We surface a clean error rather than
		// crashing the command handler.
		return 'Error: Failed to parse result from write-retro tool.';
	}

	if (result.success === true) {
		return `## Retrospective Written

Phase **${result.phase ?? 'unknown'}** retrospective saved to \`.swarm/evidence/${result.task_id ?? 'unknown'}/evidence.json\`.

Run \`/swarm evidence ${result.task_id ?? 'unknown'}\` to view it, or \`/swarm status\` to check phase_complete readiness.`;
	}

	return `Error: ${result.message}`;
}
