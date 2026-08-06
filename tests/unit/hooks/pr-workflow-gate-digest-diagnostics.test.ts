import { describe, expect, test } from 'bun:test';
import type { RevisionDigestFailureReason } from '../../../src/background/workspace-snapshot.js';
import { describePrWorkflowRevisionDigestFailure } from '../../../src/hooks/pr-workflow-gate.js';

/**
 * Issue #1968 acceptance criterion 6: when a bounded revision digest fails, the
 * BLOCKED message must name the ONE bound that actually fired instead of
 * listing every bound that might have. That makes each arm of
 * `describePrWorkflowRevisionDigestFailure` a user-facing contract in its own
 * right — three of the eight were previously asserted only for their `reason`,
 * never for the text a maintainer actually reads, so five message bodies could
 * be replaced with any string at all and the suite stayed green.
 *
 * Every arm is pinned here on three axes: the exact bound or cause it names,
 * the remediation it offers, and mutual distinctness — a diagnostic that names
 * a bound is worthless if two bounds produce the same sentence.
 */

/** `seam-unavailable` is gate-local (an injected test seam returned null). */
type DescribedReason = RevisionDigestFailureReason | 'seam-unavailable';

const ARMS: ReadonlyArray<{
	reason: DescribedReason;
	/** The bound or cause the message must name. */
	names: string;
	/** The remediation clause the message must carry. */
	remediation: string;
}> = [
	{
		reason: 'file-cap',
		names: 'the changed-file snapshot exceeded REVISION_MAX_FILES',
		remediation:
			'Reduce the changed-path count (commit or stash generated/vendored output) before retrying',
	},
	{
		reason: 'byte-cap',
		names: 'the changed-file snapshot exceeded REVISION_MAX_TOTAL_BYTES',
		remediation: 'Reduce the changed content size before retrying',
	},
	{
		reason: 'buffer-truncated',
		names: 'a bounded git enumeration exceeded GIT_SNAPSHOT_MAX_BUFFER',
		remediation: 'The changed-path list is too large to enumerate',
	},
	{
		reason: 'timeout',
		names: 'a bounded git enumeration timed out',
		remediation: 'Retry once the working tree is quiescent',
	},
	{
		reason: 'git-failed',
		names: 'a bounded git enumeration failed',
		remediation:
			'Verify the checkout is a healthy Git worktree at the recorded head',
	},
	{
		reason: 'containment',
		names: 'git reported a changed path outside the project root',
		remediation: 'Nothing outside the project root may be hashed',
	},
	{
		reason: 'read-failed',
		names: 'a changed path could not be read',
		remediation: 'Resolve the filesystem error before retrying',
	},
	{
		reason: 'seam-unavailable',
		names: 'an injected revision-digest seam returned no digest',
		remediation:
			'production names one of REVISION_MAX_FILES / REVISION_MAX_TOTAL_BYTES / GIT_SNAPSHOT_MAX_BUFFER, a bounded git enumeration timeout, or a read failure',
	},
];

const describe_ = (reason: DescribedReason, detail?: string): string =>
	describePrWorkflowRevisionDigestFailure({
		ok: false,
		reason,
		...(detail === undefined ? {} : { detail }),
	} as Parameters<typeof describePrWorkflowRevisionDigestFailure>[0]);

describe('describePrWorkflowRevisionDigestFailure', () => {
	for (const { reason, names, remediation } of ARMS) {
		test(`"${reason}" names its own bound and remediation`, () => {
			const message = describe_(reason);
			expect(message).toContain(names);
			expect(message).toContain(remediation);
		});

		test(`"${reason}" interpolates the detail in parentheses`, () => {
			// The detail carries the concrete numbers ("1234 changed paths exceed
			// the cap of 512"), which is what turns "a bound fired" into an
			// actionable message.
			expect(describe_(reason, `detail for ${reason}`)).toContain(
				`(detail for ${reason})`,
			);
			// ...and an absent detail must not leave an empty pair of parens.
			expect(describe_(reason)).not.toContain('()');
		});
	}

	test('no two arms produce the same message', () => {
		const messages = ARMS.map(({ reason }) => describe_(reason));
		expect(new Set(messages).size).toBe(ARMS.length);
	});

	test('every RevisionDigestFailureReason the resolver can emit is covered', () => {
		// This list IS hand-copied; the `RevisionDigestFailureReason[]`
		// annotation is what gives it teeth. Removing or renaming a member of
		// the union breaks the build here, so this cannot silently rot in that
		// direction. It does NOT catch a newly *added* reason — that would
		// fall through to the `seam-unavailable` default, claiming a test seam
		// misbehaved when a real bound actually fired. Add the arm and the row
		// together when introducing a reason.
		const producedReasons: RevisionDigestFailureReason[] = [
			'file-cap',
			'byte-cap',
			'buffer-truncated',
			'timeout',
			'git-failed',
			'containment',
			'read-failed',
		];
		const covered = new Set(ARMS.map(({ reason }) => reason));
		for (const reason of producedReasons)
			expect(covered.has(reason)).toBe(true);
		expect(covered.has('seam-unavailable')).toBe(true);
		expect(covered.size).toBe(producedReasons.length + 1);
	});
});
