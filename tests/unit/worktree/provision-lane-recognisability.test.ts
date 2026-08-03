/**
 * Structural guard: a lane whose branch the recogniser cannot match must never
 * be provisioned.
 *
 * Lane permission scoping identifies a lane by its BRANCH
 * (`src/config/lane-context.ts` -> `matchSwarmLaneBranch`). If a worktree is
 * created whose branch falls outside that grammar, detection returns "not a
 * lane", no permissions are pre-resolved, and the first `external_directory`
 * request in that lane parks forever on a deferred that no TUI can answer — the
 * original hang, reintroduced silently.
 *
 * The realistic source is an unvalidated session id: tool arguments are
 * LLM-supplied (`sessionID: z.string()`), and the host's own `SessionID` brand
 * is only `isStartsWith("ses")`, so a value such as `ses-run-1` passes the host
 * and reaches `buildSwarmBranchName` intact. Asserting at the provisioning
 * boundary makes the defect unreachable regardless of where the id came from —
 * which is what the guardrail is supposed to guarantee.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	buildSwarmBranchName,
	matchSwarmLaneBranch,
} from '../../../src/config/swarm-branch';
import { _internals, provisionWorktree } from '../../../src/worktree/core';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let dir: string;
let cleanup: () => void;
let spawnCalls: number;
const realSpawn = _internals.bunSpawn;

beforeEach(() => {
	({ dir, cleanup } = createSafeTestDir('provision-guard-'));
	spawnCalls = 0;
	// Count subprocess attempts so we can prove the guard fires BEFORE any git
	// work — a late rejection would already have created a branch/worktree.
	_internals.bunSpawn = ((...args: unknown[]) => {
		spawnCalls += 1;
		return (realSpawn as (...a: unknown[]) => unknown)(...args);
	}) as typeof _internals.bunSpawn;
});

afterEach(() => {
	_internals.bunSpawn = realSpawn;
	cleanup();
});

describe('provisionWorktree refuses unrecognisable lanes', () => {
	test.each([
		// The exact reproduced case: passes the host `ses` brand, fails the grammar.
		['ses-run-1'],
		['phase-3'],
		['session123'],
		['SES_abc'],
		['ses_'],
		['ses_ab/cd'],
		[''],
	])('rejects sessionId %p with an actionable error', async (sessionId) => {
		const result = await provisionWorktree(dir, 'lane-1', sessionId, {
			purpose: 'lane',
		});
		expect(result).toHaveProperty('error');
		const message = (result as { error: string }).error;
		expect(message).toContain('does not match the swarm lane grammar');
		// Actionable: names the offending value and the required shape.
		expect(message).toContain(sessionId);
		expect(message).toContain('ses_');
		// Fired before any git subprocess ran.
		expect(spawnCalls).toBe(0);
		// And nothing was created on disk.
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test('rejects an execution-unit id that is not a single path segment', async () => {
		const result = await provisionWorktree(dir, 'a/b', 'ses_abc', {
			purpose: 'lane',
		});
		expect(result).toHaveProperty('error');
		expect(spawnCalls).toBe(0);
	});

	test('the guard is exactly the recogniser (no second, drifting rule)', () => {
		// Anything the guard would reject is precisely what detection cannot match.
		for (const sessionId of ['ses-run-1', 'phase-3', 'ses_ok']) {
			const branch = buildSwarmBranchName(sessionId, 'lane-1', 'lane', false);
			const recognised = matchSwarmLaneBranch(branch) !== undefined;
			expect(recognised).toBe(sessionId === 'ses_ok');
		}
	});
});
