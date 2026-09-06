import path from 'node:path';
import { log } from '../../utils/logger';
import { _internals } from './internals.js';

/**
 * Remove the SQLite WAL sidecars (swarm.db-wal / swarm.db-shm) immediately
 * after the clean stage unlinks swarm.db (#2483, deliberately reversing the
 * #1692 preserve decision): once the main db is unlinked the sidecar paths
 * are meaningless for future opens — no new opener can attach — and live
 * processes keep their already-open fds, so deleting the PATH cannot corrupt
 * them. Best-effort and per-file fail-open: ENOENT (already gone) and EBUSY
 * (Windows open-handle collision) are skipped silently.
 */
export function removeSqliteSidecarsAfterClose(swarmDir: string): void {
	for (const sidecar of ['swarm.db-wal', 'swarm.db-shm']) {
		try {
			// _internals seam (review FB-7): the EBUSY skip branch is part of the
			// Windows contract and is exercised by injecting a throwing unlink
			// rather than relying on platform-specific open-handle races.
			_internals.unlinkSidecarSync(path.join(swarmDir, sidecar));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT' && code !== 'EBUSY') {
				log('[close-command] failed to remove sqlite sidecar:', error);
			}
		}
	}
}
