/**
 * Discovery availability seam for the pkg-audit composer suites (issue
 * #2477 review F-002/F-003/F-006).
 *
 * Installs a fake PATH-probe on `discovery._internals.spawnSyncImpl` that
 * answers ONLY the `composer` probe from the caller's flag; every other
 * command's probe delegates to the real spawn captured at module load, so
 * auto-ecosystem availability guards keep their fidelity. Replaces the
 * historical file-scope `mock.module` of `src/build/discovery`, whose
 * namespace replacement masked other suites' seam control when files
 * shared one process (the #2260 hang class) and whose delegation branch
 * was infinite tail recursion.
 *
 * `restoreDiscoverySeam()` restores the original captured at module load
 * (before any test can mutate it, per the AGENTS.md §7 captured-original
 * restore convention) and clears the toolchain cache so no availability
 * entry survives a test.
 */
import {
	clearToolchainCache,
	_internals as discoveryInternals,
} from '../../src/build/discovery';

const originalSpawnSync = discoveryInternals.spawnSyncImpl;

export function installComposerProbeSeam(
	composerAvailable: () => boolean,
): void {
	clearToolchainCache();
	discoveryInternals.spawnSyncImpl = (cmd, opts) => {
		if (Array.isArray(cmd) && cmd[1] === 'composer') {
			const available = composerAvailable();
			return {
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
				exitCode: available ? 0 : 127,
				success: available,
			};
		}
		return originalSpawnSync(cmd, opts);
	};
}

export function restoreDiscoverySeam(): void {
	discoveryInternals.spawnSyncImpl = originalSpawnSync;
	clearToolchainCache();
}
