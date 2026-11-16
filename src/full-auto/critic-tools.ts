/**
 * Tools denied to the Full-Auto critic agent (#3446).
 *
 * The critic's task is "verify using read-only tools only", but `shell`/`bash`
 * are not read-only and — worse for latency — let the critic wander: on
 * OpenCode 2 every observed critic session ran `grep -rl` / `find ~` over the
 * user's home directory until the oversight deadline killed it, so no verdict
 * was ever produced and Full-Auto paused. Shell is denied alongside the
 * mutating tools; the critic keeps read/grep/glob and the swarm's own
 * read-only verification tools (diff, evidence, test_impact, symbols).
 *
 * Limit, stated plainly: `execute` (OpenCode 2 Code Mode, which reaches plugin
 * tools such as diff/evidence/test_impact) stays available to the critic by
 * design, and its sandbox also exposes `fetch`/`Function`, which no hook sees.
 * This denial list therefore bounds shell and mutating tools only; it is not a
 * sandbox. A restricted critic Code Mode surface is a follow-up.
 */
export const FULL_AUTO_CRITIC_DENIED_TOOLS: Readonly<Record<string, false>> =
	Object.freeze({
		write: false,
		edit: false,
		patch: false,
		bash: false,
		shell: false,
	});
