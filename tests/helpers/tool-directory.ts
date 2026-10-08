/**
 * Call a createSwarmTool tool's `execute` against an explicit project root.
 *
 * `execute(args, ctx)` takes a ToolContext as its second parameter, not a
 * directory string. A bare string has no `.directory`, so createSwarmTool's
 * direct-CLI fallback silently runs the tool against process.cwd() — the
 * plugin checkout under `bun test` — and any `.swarm/` state the tool writes
 * (test-runner history, impact map, ...) lands there instead of the fixture.
 */
export function executeInDirectory(tool: {
	execute: unknown;
}): (args: Record<string, unknown>, directory: string) => Promise<string> {
	const execute = tool.execute as (
		args: Record<string, unknown>,
		ctx: { directory: string },
	) => Promise<string>;
	return (args, directory) => execute(args, { directory });
}
