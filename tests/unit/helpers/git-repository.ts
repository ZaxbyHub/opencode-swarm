import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bunSpawn } from '../../../src/utils/bun-compat.js';

export async function initializeGitRepository(
	directory: string,
	options: { excludeSwarm?: boolean } = {},
): Promise<void> {
	const proc = bunSpawn(['git', 'init', '--quiet'], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'pipe',
		timeout: 30_000,
	});
	try {
		const [exitCode, stderr] = await Promise.all([
			proc.exited,
			proc.stderr.text(),
		]);
		if (exitCode !== 0) throw new Error(`git init failed: ${stderr}`);
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort cleanup.
		}
	}
	if (options.excludeSwarm !== false) {
		await fs.writeFile(
			path.join(directory, '.git', 'info', 'exclude'),
			'.swarm/\n',
		);
	}
}
