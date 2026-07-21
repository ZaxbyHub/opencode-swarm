import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Resolve a real Bash runtime for shell-script tests.
 *
 * On Windows, a bare `bash` can resolve to the System32 WSL relay even when no
 * distribution is installed. Git Bash is already a repository prerequisite,
 * so derive its executable from the active Git installation instead.
 */
export function resolveBash(): string {
	if (process.platform !== 'win32') return Bun.which('bash') ?? 'bash';

	const gitExe = Bun.which('git');
	if (!gitExe) {
		throw new Error('Git Bash is required for shell-script tests on Windows');
	}

	let current = path.dirname(gitExe);
	for (let depth = 0; depth < 4; depth += 1) {
		for (const candidate of [
			path.join(current, 'bash.exe'),
			path.join(current, 'bin', 'bash.exe'),
			path.join(current, 'usr', 'bin', 'bash.exe'),
		]) {
			if (fs.existsSync(candidate)) return candidate;
		}

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	throw new Error(
		`Git Bash is required for shell-script tests on Windows (git: ${gitExe})`,
	);
}

/** Build a script command with Git Bash's core utilities on PATH on Windows. */
export function bashCommand(script: string, ...args: string[]): string[] {
	const bash = resolveBash();
	if (process.platform !== 'win32') return [bash, script, ...args];

	// Avoid login startup: Git's profile may try to create HOME before the test
	// starts. Positional forwarding keeps script paths and arguments out of the
	// command string while restoring the coreutils paths omitted by native spawn.
	return [
		bash,
		'-c',
		'export PATH="/usr/bin:/bin:$PATH"; exec /usr/bin/bash "$@"',
		'bash',
		script,
		...args,
	];
}
