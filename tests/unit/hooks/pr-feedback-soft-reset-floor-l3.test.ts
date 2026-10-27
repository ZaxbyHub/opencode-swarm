/**
 * Issue #3316 AC11 (L3 acceptance, PRESERVING): the sanctioned soft reset from
 * AC10 is ONE exact shape. Every other reset/commit form, and the sanctioned
 * shape under violated preconditions, must keep rejecting at base AND after
 * the fix.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	enforcePrWorkflowToolBefore,
	invalidatePrFeedbackPublication,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	HEAD_SHA,
	POST_COMMIT_SHA,
	type PublicationFixture,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'l3-reset-floor';

let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

async function invalidated(): Promise<void> {
	await fixture.prepareArmedGeneration(SESSION_ID);
	await invalidatePrFeedbackPublication(
		fixture.directory,
		SESSION_ID,
		'rework',
	);
}

const FAIL_CLOSED =
	/BLOCKED: PR_FEEDBACK shell commands fail closed unless they are explicit read-only intake/;

describe('PR_FEEDBACK soft reset floors — command forms (AC11)', () => {
	test.each([
		[
			'hard reset to the intake head',
			`git reset --hard ${HEAD_SHA}`,
			FAIL_CLOSED,
		],
		[
			'mixed reset to the intake head',
			`git reset --mixed ${HEAD_SHA}`,
			FAIL_CLOSED,
		],
		['soft reset by relative ref', 'git reset --soft HEAD~1', FAIL_CLOSED],
		[
			'soft reset to a non-intake target',
			`git reset --soft ${POST_COMMIT_SHA}`,
			FAIL_CLOSED,
		],
		['bare reset with no target', 'git reset', FAIL_CLOSED],
		[
			'reset through a git -C directory override',
			`git -C . reset --soft ${HEAD_SHA}`,
			FAIL_CLOSED,
		],
		['commit --amend', 'git commit --amend -m x', /BLOCKED: PR_FEEDBACK/],
	])('invalidated state refuses %s', async (_name, command, pattern) => {
		await invalidated();
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command,
			}),
		).rejects.toThrow(pattern);
	});
});

describe('PR_FEEDBACK soft reset floors — preconditions (AC11)', () => {
	test('the soft reset shape is refused while still ARMED (no invalidation)', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: `git reset --soft ${HEAD_SHA}`,
			}),
		).rejects.toThrow(/armed for publication/);
	});

	test('the soft reset shape is refused when HEAD is not the exact single child commit', async () => {
		await invalidated();
		_test_exports.resolveIsExactSingleChildCommit = () => false;
		_test_exports.resolveIsExactSingleChildCommitAsync = async () => false;
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: `git reset --soft ${HEAD_SHA}`,
			}),
		).rejects.toThrow(/BLOCKED: PR_FEEDBACK/);
	});

	test('the soft reset shape is refused when HEAD already equals the intake head', async () => {
		await invalidated();
		fixture.mutators.head(HEAD_SHA);
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: `git reset --soft ${HEAD_SHA}`,
			}),
		).rejects.toThrow(/BLOCKED: PR_FEEDBACK/);
	});
});
