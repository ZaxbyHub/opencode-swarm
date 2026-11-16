/**
 * Issue #3316 AC17 (L3 acceptance, PRESERVING): the armed tracking fetch from
 * AC16 is ONE exact shape. Every other remote- or state-mutating shell form
 * stays refused while armed, at base AND after the fix — including the exact
 * tracking fetch when no upstream target resolves.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { enforcePrWorkflowToolBefore } from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPublicationFixture,
	HEAD_SHA,
	type PublicationFixture,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'l3-armed-floor';

let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

describe('PR_FEEDBACK armed shell floors (AC17)', () => {
	// Observed base messages: remote-mutating verbs reach the armed-window
	// refusal; checkout/switch hit the immutable-head check that precedes it
	// (line-order stable, unrelated to the fetch admission).
	test.each([
		['git fetch origin main', /armed for publication/],
		['git fetch --all', /armed for publication/],
		['git checkout main', /checkout is immutable after exact PR head binding/],
		['git switch main', /checkout is immutable after exact PR head binding/],
		['git merge origin/main', /armed for publication/],
		['git rebase origin/main', /armed for publication/],
		['git pull', /armed for publication/],
		[`git reset --soft ${HEAD_SHA}`, /armed for publication/],
		['git fetch', /armed for publication/],
	])('armed state refuses %s', async (command, pattern) => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command,
			}),
		).rejects.toThrow(pattern);
	});

	test('the tracking fetch shape is refused when no upstream target resolves', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.upstream(null);
		// The armed identity check refuses an unresolvable upstream before any
		// fetch admission is considered; the window stays armed and fails closed.
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: 'git fetch origin pr-head',
			}),
		).rejects.toThrow(/could not verify the armed publication identity/);
	});
});
