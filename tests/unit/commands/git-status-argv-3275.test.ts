/**
 * Acceptance check C6 for issue #3317 (class: DISCRIMINATING).
 *
 * Every tracked-dirty measurement argv must lead with --no-optional-locks
 * before `status`, so the gate/re-check reads never take the index write lock
 * (the very lock whose contention produces unreadable-status failures this
 * issue fixes). Recording stubs on the three EXISTING seams capture the argv
 * each wrapper actually passes:
 *  - close gate:   _closeGateInternals.runGit      via evaluateClosePurgeGate
 *  - re-check:     destructive-purge _internals.runGitStatus via readTrackedDirtyPaths
 *  - rollback:     _rollbackGateInternals.runGit   via measureGitDestruction
 *
 * Stubs return '' (a legacy sync stdout string — await-tolerant per the seam
 * contract). Directories only need a `.git/HEAD` marker (isRealGitRepository)
 * and a `.swarm/` dir — no real git runs.
 *
 * RED at base (argv[0] is 'status', not '--no-optional-locks'), GREEN after
 * the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_closeGateInternals,
	evaluateClosePurgeGate,
} from '../../../src/commands/close/orchestrator';
import {
	_internals as purgeInternals,
	readTrackedDirtyPaths,
} from '../../../src/commands/destructive-purge';
import {
	_rollbackGateInternals,
	measureGitDestruction,
} from '../../../src/commands/rollback-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

const originalCloseRunGit = _closeGateInternals.runGit;
const originalRunGitStatus = purgeInternals.runGitStatus;
const originalRollbackRunGit = _rollbackGateInternals.runGit;

afterEach(() => {
	_closeGateInternals.runGit = originalCloseRunGit;
	purgeInternals.runGitStatus = originalRunGitStatus;
	_rollbackGateInternals.runGit = originalRollbackRunGit;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('tracked-dirty status argv carries --no-optional-locks (#3317 C6)', () => {
	test('gate, re-check, and rollback argv all start with --no-optional-locks status', async () => {
		const root = canonicalMkdtemp('3317-argv-');
		tempRoots.push(root);
		// Marker root shape only — the stubs mean no real git is needed; the
		// rollback measurement's isRealGitRepository pre-check needs .git/HEAD.
		fs.mkdirSync(path.join(root, '.git'), { recursive: true });
		fs.writeFileSync(path.join(root, '.git', 'HEAD'), '');
		const swarmDir = path.join(root, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const closeArgv: string[][] = [];
		_closeGateInternals.runGit = (args: string[]) => {
			closeArgv.push(args);
			return '';
		};
		const recheckArgv: string[][] = [];
		purgeInternals.runGitStatus = (args: readonly string[]) => {
			recheckArgv.push([...args]);
			return '';
		};
		const rollbackArgv: string[][] = [];
		_rollbackGateInternals.runGit = (args: string[]) => {
			rollbackArgv.push(args);
			return '';
		};

		await evaluateClosePurgeGate(root, swarmDir);
		await readTrackedDirtyPaths(root);
		await measureGitDestruction(root);

		expect(closeArgv.length).toBe(1);
		expect(recheckArgv.length).toBe(1);
		expect(rollbackArgv.length).toBe(1);

		for (const argv of [closeArgv[0], recheckArgv[0], rollbackArgv[0]]) {
			expect(argv?.[0]).toBe('--no-optional-locks');
			expect(argv?.[1]).toBe('status');
		}
		// The close gate and the pre-destruction re-check spread the SAME
		// shared constant (GIT_STATUS_ARGS), so their argv must be identical.
		expect(closeArgv[0]).toEqual(recheckArgv[0]);
		// The rollback gate keeps its NUL-terminated porcelain form.
		expect(rollbackArgv[0]).toEqual([
			'--no-optional-locks',
			'status',
			'--porcelain',
			'-z',
		]);
	}, 30_000);
});
