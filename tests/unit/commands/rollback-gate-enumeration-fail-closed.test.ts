/**
 * #3434 (trace 3427-3434-rollback-gate-hardening, check C4): the
 * destruction measurement fails CLOSED when its ls-tree/ls-files enumeration
 * cannot be read — `measureGitDestruction` reports `kind:"unreadable"` with
 * the structured cause instead of folding an empty in-the-way set into a
 * `kind:"ok"` measurement whose scope silently shrinks below what
 * `git reset --hard` would actually overwrite.
 *
 * Failure matrix (each leg independent): ls-tree only, ls-files only, both —
 * each asserting code + status + stderrTail forwarding. Green legs: a
 * readable enumeration yields the in-the-way paths; a bare `.git` marker
 * root (#2127) returns empty paths with NO failure.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_rollbackGateInternals,
	describeUnreadableCause,
	measureGitDestruction,
	untrackedPathsInTargetTree,
} from '../../../src/commands/rollback-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalRunGit = _rollbackGateInternals.runGit;
const originalRunGitBuffered = _rollbackGateInternals.runGitBuffered;

const tempRoots: string[] = [];

function makeRepo(): string {
	const root = canonicalMkdtemp('c4-repo-');
	tempRoots.push(root);
	// Host-hardened fixture (feedback PRR-012): identity inline, gpgsign off,
	// hooks/templates isolated, bounded spawn — a global commit.gpgsign=true
	// or hook-y init.templateDir/core.hooksPath must not break the suite.
	execSync('git -c init.defaultBranch=main -c init.templateDir= init -q', {
		cwd: root,
		timeout: 30_000,
	});
	execSync(
		'git -c user.name=swarm-test -c user.email=swarm-test@example.com -c commit.gpgsign=false -c core.hooksPath= commit -q --allow-empty --no-verify -m init',
		{ cwd: root, timeout: 30_000 },
	);
	return root;
}

function stubStatusOk(): void {
	_rollbackGateInternals.runGit = (async () => ({
		ok: true as const,
		stdout: '',
	})) as unknown as typeof _rollbackGateInternals.runGit;
}

function stubEnumeration(opts: {
	lsTreeFails?: boolean;
	lsFilesFails?: boolean;
}): void {
	const failure = {
		ok: false as const,
		code: 'ETIMEDOUT' as const,
		status: null,
		stderrTail: 'child timed out',
	};
	_rollbackGateInternals.runGitBuffered = (async (args: string[]) => {
		if (args[0] === 'ls-tree' && opts.lsTreeFails) return failure;
		if (args[0] === 'ls-files' && opts.lsFilesFails) return failure;
		return { ok: true as const, stdout: '' };
	}) as unknown as typeof _rollbackGateInternals.runGitBuffered;
}

afterEach(() => {
	_rollbackGateInternals.runGit = originalRunGit;
	_rollbackGateInternals.runGitBuffered = originalRunGitBuffered;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('measureGitDestruction fails closed on an unreadable enumeration (#3434 C4)', () => {
	test('ls-tree fails, ls-files readable: kind unreadable with the full structured cause', async () => {
		const root = makeRepo();
		stubStatusOk();
		stubEnumeration({ lsTreeFails: true });

		const measurement = await measureGitDestruction(root, 'HEAD');

		expect(measurement.kind).toBe('unreadable');
		if (measurement.kind === 'unreadable') {
			expect(measurement.code).toBe('ETIMEDOUT');
			expect(measurement.status).toBeNull();
			expect(measurement.stderrTail).toBe('child timed out');
			// Feedback PRR-004: the refusal must name the ENUMERATION, not
			// git status — the source field drives the consumer wording.
			expect(measurement.source).toBe('enumeration');
			const cause = describeUnreadableCause(measurement, measurement.source);
			expect(cause).toContain('target-tree listing');
			expect(cause).not.toContain('git status exited');
		}
	});

	test('ls-files fails, ls-tree readable: kind unreadable (single-sided mutant killed)', async () => {
		const root = makeRepo();
		stubStatusOk();
		stubEnumeration({ lsFilesFails: true });

		const measurement = await measureGitDestruction(root, 'HEAD');

		// A mutant handling only the ls-tree failure would fold this leg's
		// empty index read into kind:"ok" — this assertion kills it.
		expect(measurement.kind).toBe('unreadable');
		if (measurement.kind === 'unreadable') {
			expect(measurement.code).toBe('ETIMEDOUT');
			expect(measurement.stderrTail).toBe('child timed out');
			expect(measurement.source).toBe('enumeration');
		}
	});

	test('both reads fail: kind unreadable with the cause (ls-tree short-circuits before ls-files — same code path as the ls-tree-only leg)', async () => {
		const root = makeRepo();
		stubStatusOk();
		stubEnumeration({ lsTreeFails: true, lsFilesFails: true });

		const measurement = await measureGitDestruction(root, 'HEAD');

		expect(measurement.kind).toBe('unreadable');
		if (measurement.kind === 'unreadable') {
			expect(measurement.code).toBe('ETIMEDOUT');
		}
	});

	test('readable enumeration: kind ok (regression floor for the green path)', async () => {
		const root = makeRepo();
		stubStatusOk();
		stubEnumeration({});

		const measurement = await measureGitDestruction(root, 'HEAD');

		expect(measurement.kind).toBe('ok');
		if (measurement.kind === 'ok') {
			expect(measurement.dirtyRelPaths).toEqual([]);
			expect(measurement.excludedOutOfRoot).toEqual([]);
		}
	});

	test('bare .git marker root (#2127): empty paths, NO failure', async () => {
		const root = canonicalMkdtemp('c4-marker-');
		tempRoots.push(root);
		fs.mkdirSync(path.join(root, '.git'), { recursive: true });

		const result = await untrackedPathsInTargetTree(root, 'HEAD');

		expect(result.paths).toEqual([]);
		expect(result.failure).toBeNull();
	});
});
