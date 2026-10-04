/**
 * Redirect the hive (cross-project) knowledge store into a temp home.
 *
 * `resolveHiveDataDir()` (src/knowledge/hive-paths.ts) reads HOME, and also
 * XDG_DATA_HOME on Linux and LOCALAPPDATA on Windows, which win over HOME when
 * set. Redirecting HOME alone therefore leaves the store on the developer's
 * real data dir whenever XDG_DATA_HOME is set (common on Linux desktops), and
 * the production-store tripwire then fails the test. This sets all three and
 * returns a restore that puts back the exact previous values.
 */
import * as path from 'node:path';

const HIVE_ENV_KEYS = ['HOME', 'XDG_DATA_HOME', 'LOCALAPPDATA'] as const;

export function redirectHiveHome(tempHome: string): () => void {
	const previous = new Map(HIVE_ENV_KEYS.map((key) => [key, process.env[key]]));
	process.env.HOME = tempHome;
	process.env.XDG_DATA_HOME = path.join(tempHome, '.local', 'share');
	process.env.LOCALAPPDATA = path.join(tempHome, 'AppData', 'Local');
	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}
