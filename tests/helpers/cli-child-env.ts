/**
 * Environment for a spawned `src/cli/index.ts` child process.
 *
 * A child inherits the parent's environment, so without this a CLI test's
 * child resolves every path it was not explicitly handed from the developer's
 * real HOME / XDG roots. This pins HOME, USERPROFILE, the XDG roots, and the
 * Windows APPDATA roots to one short throwaway directory per test process;
 * the caller's overrides (usually XDG_CONFIG_HOME / XDG_CACHE_HOME pointing
 * at the test's own fixture dir) still win.
 *
 * The directory comes from canonicalMkdtemp (short, under os.tmpdir()), so the
 * child's home is never longer than the fixture paths it is asked to manage,
 * and it is removed when the test process exits.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalMkdtemp } from './tmpdir';

let childHome: string | undefined;

function getChildHome(): string {
	if (childHome === undefined) {
		const dir = canonicalMkdtemp('cli-home-');
		childHome = dir;
		process.on('exit', () => {
			// Best effort: a cleanup failure (Windows EBUSY/EPERM) must never throw
			// out of an exit handler and mask the test run's exit code.
			try {
				rmSync(dir, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 100,
				});
			} catch {
				/* leave the throwaway home for the OS temp reaper */
			}
		});
	}
	return childHome;
}

export function cliChildEnv(
	overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
	const home = getChildHome();
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, '.config'),
		XDG_CACHE_HOME: join(home, '.cache'),
		XDG_DATA_HOME: join(home, '.local', 'share'),
		APPDATA: join(home, 'AppData', 'Roaming'),
		LOCALAPPDATA: join(home, 'AppData', 'Local'),
		...overrides,
	};
}
