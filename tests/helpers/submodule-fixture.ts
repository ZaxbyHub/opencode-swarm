// Shared git-submodule fixture builders for the #3763 rollback-capture
// suites. IMPORTANT: `git clone` / `git submodule add` do NOT copy the
// source repository's local identity config, and CI runners have no global
// git identity — every repository a commit runs in must carry identity
// inline (-c flags via gitIn) or configured on that repository itself.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const IDENTITY = [
	'-c',
	'user.email=test@example.invalid',
	'-c',
	'user.name=Fixture',
];

export function gitIn(cwd: string, args: string[], timeout = 15000): string {
	return execFileSync('git', [...IDENTITY, ...args], {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout,
	});
}

/**
 * Creates `subsrc` (source repo with one committed file) and registers it
 * as the `mod` submodule of the repo at rootDir, with the superproject
 * commit recorded. Does not touch `mod` afterwards — callers advance or
 * replace it per test.
 */
export function buildSubmoduleFixture(rootDir: string): void {
	const sub = path.join(rootDir, 'subsrc');
	fs.mkdirSync(sub, { recursive: true });
	gitIn(sub, ['init', '-q']);
	fs.writeFileSync(path.join(sub, 'f.txt'), 's1');
	gitIn(sub, ['add', '-A']);
	gitIn(sub, ['commit', '-qm', 'sub base']);
	gitIn(
		rootDir,
		[
			'-c',
			'protocol.file.allow=always',
			'submodule',
			'add',
			'-q',
			sub.split('\\').join('/'),
			'mod',
		],
		30000,
	);
	gitIn(rootDir, ['add', '-A']);
	gitIn(rootDir, ['commit', '-qm', 'super base']);
}
