/**
 * r17 (§9.2): a foreign-platform WINDOWS drive path must never be resolved
 * as a RELATIVE project directory on POSIX hosts.
 *
 * Proven causality before this repair (see the r17 session report): the
 * combined tests/unit/services batch run (Bun's shared test-runner process)
 * leaked a `mock.module('node:fs')` whose `existsSync` returned TRUE for
 * every path. When handoff-service-adversarial.test.ts later probed
 * `getHandoffData('C:\\Users\\Administrator\\.aws\\credentials')` — an
 * intended READ-ONLY adversarial probe — the tampered `projectDbExists`
 * reported the DB as existing, so `readSnapshotRows` →
 * `withCoordinationTransaction` → `getProjectDb` exercised its
 * create-on-first-open contract and MATERIALIZED
 * `<cwd>/C:\Users\Administrator\.aws\credentials/.swarm/swarm.db` — a
 * literal directory in the repository root. Run in isolation (clean fs) the
 * same test is green and creates nothing: the leak alone turned a safe
 * probe into a state-creating one. Reproduced by running the services batch
 * with cwd=/tmp: `/tmp/C:\Users\Administrator\.aws\credentials/.swarm/
 * swarm.db` appears.
 *
 * The repair refuses foreign-platform drive paths at the DB storage sink
 * BEFORE any filesystem access (pure string test — a tampered existsSync
 * cannot bypass it) and keeps `projectDbExists` non-throwing.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
	assertProjectDbRoot,
	closeAllProjectDbs,
	getProjectDb,
	projectDbExists,
} from '../../../src/db/project-db';
import { ProjectDbError } from '../../../src/db/db-errors';
import { looksLikeWindowsDrivePath } from '../../../src/utils/path-security';

const HOSTILE = 'C:\\Users\\Administrator\\.aws\\credentials';
const OTHER_DRIVE = 'Q:\\hostile\\probe';

describe('project-db — foreign-platform drive paths (r17 §9.2)', () => {
	test.skipIf(process.platform === 'win32')(
		'looksLikeWindowsDrivePath recognizes drive-absolute strings',
		() => {
			expect(looksLikeWindowsDrivePath(HOSTILE)).toBe(true);
			expect(looksLikeWindowsDrivePath('C:/Users/x')).toBe(true);
			expect(looksLikeWindowsDrivePath('/tmp/normal')).toBe(false);
			expect(looksLikeWindowsDrivePath('relative/dir')).toBe(false);
			expect(looksLikeWindowsDrivePath('C')).toBe(false);
			expect(looksLikeWindowsDrivePath('')).toBe(false);
			expect(looksLikeWindowsDrivePath(undefined)).toBe(false);
		},
	);

	test.skipIf(process.platform === 'win32')(
		'getProjectDb refuses a Windows drive path with the typed invalid_root error',
		() => {
			// Close any cached connections first (other suites may have opened
			// DBs in this process).
			closeAllProjectDbs();
			expect(() => getProjectDb(HOSTILE)).toThrow(ProjectDbError);
			try {
				getProjectDb(HOSTILE);
			} catch (error) {
				expect((error as ProjectDbError).category).toBe('invalid_root');
			}
		},
	);

	test.skipIf(process.platform === 'win32')(
		'assertProjectDbRoot rejects drive paths without touching the filesystem',
		() => {
			expect(() => assertProjectDbRoot(OTHER_DRIVE)).toThrow(ProjectDbError);
			// No directory was materialized relative to the cwd for a path
			// that never existed before. (The historical
			// `C:\Users\Administrator\.aws\credentials` leftover in the repo
			// root itself is the r17 §9.2 evidence and is deliberately NOT
			// asserted against — it predates this repair and only the user
			// should remove it.)
			expect(fs.existsSync(join(process.cwd(), OTHER_DRIVE))).toBe(false);
		},
	);

	test.skipIf(process.platform === 'win32')(
		'projectDbExists answers false for drive paths (never throws, never resolves)',
		() => {
			expect(projectDbExists(HOSTILE)).toBe(false);
			expect(projectDbExists(OTHER_DRIVE)).toBe(false);
		},
	);
});
