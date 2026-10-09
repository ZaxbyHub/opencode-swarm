/**
 * A user home in the shape `redactPath` (src/hooks/guardrails/audit-log.ts)
 * recognizes. Deriving it from homedir() broke whenever HOME is not
 * /home/<user> (an isolated test HOME, /root, ...): the redactor strips
 * /home/<name> only, so the last segment of such a HOME survived and the
 * "no username" assertions failed.
 */
export const SYNTHETIC_HOME =
	process.platform === 'win32'
		? 'C:\\Users\\swarm-test-user'
		: process.platform === 'darwin'
			? '/Users/swarm-test-user'
			: '/home/swarm-test-user';
