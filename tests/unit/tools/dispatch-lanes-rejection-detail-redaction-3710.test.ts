/**
 * #3710 regression — `composeLaneRejectionError`'s inlineDetail
 * sanitization must redact the thrown-cause text before it reaches BOTH the
 * returned terminal error AND the persisted lane-rejection artifact.
 *
 * Sink (src/tools/dispatch-lanes.ts, composeLaneRejectionError): the
 * inlineDetail arm (no `failure` object — the PR_WORKFLOW_CONTRACT_INVALID
 * thrown-cause catch in collect settlement, and the failure-less verdict
 * settlement site) passes the raw `formatError(cause)` string through
 * `sanitizeFailureEvidenceDisplay` at entry. The sanitized detail then
 * flows into (a) the returned 1_024-char sliced error (persisted on the
 * delegation terminal by the settlement caller) and (b) the COMPLETE detail
 * artifact persisted by `persistLaneRejectionDetail` → `storeLaneOutput`
 * under `.swarm/lane-results/**` (source `collect_lane_results`).
 *
 * Seam note: the settle paths that reach this composer with an inlineDetail
 * sit deep inside `settleCollectedLane` (driven only by a full collect
 * orchestration), so the composer is driven directly through the disclosed
 * `_test_exports.composeLaneRejectionError` addition — the persistence leg
 * (persistLaneRejectionDetail / storeLaneOutput) still runs REAL inside it.
 *
 * Mutation contract: removing the `sanitizeFailureEvidenceDisplay`
 * inlineDetail wrap makes this suite RED (cleartext token in both the
 * returned error and the persisted artifact). All tokens are synthetic.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLaneOutput } from '../../../src/background/lane-output-store';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { _test_exports } from '../../../src/tools/dispatch-lanes';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const SYNTH_TOKEN = 'sk-SynthAbCdEf12345678901234567890';
const SYNTH_OPENAI_PLACEHOLDER = '[REDACTED:openai]';

/** The thrown transport-validation cause, as formatError would render it. */
const THROWN_CAUSE = `transport validation crashed: Invalid API key provided: ${SYNTH_TOKEN}. You can find your API key at https://platform.openai.example/account/api-keys.`;

/** Minimal lane record literal for persistLaneRejectionDetail's identity fields. */
function makeRecord(): BackgroundDelegationRecord {
	return {
		schemaVersion: 4,
		correlationId: 'corr-reject-3710',
		jobId: null,
		subagentSessionId: 'sess-reject-3710',
		parentSessionId: 'parent-reject-3710',
		callID: 'call-reject-3710',
		normalizedAgent: 'critic',
		swarmPrefixedAgent: 'critic',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'running',
		createdAt: 0,
		updatedAt: 0,
		batchId: 'batch-reject-3710',
		laneId: 'lane-reject-3710',
		mode: 'swarm-pr-review:critic',
		workflowLane: 'verdict',
	} as unknown as BackgroundDelegationRecord;
}

describe('composeLaneRejectionError inlineDetail redaction (#3710)', () => {
	test('returned terminal error and persisted lane-rejection artifact are redacted', () => {
		const directory = canonicalMkdtemp('lane-reject-redact-3710-');
		try {
			fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });

			const summary = _test_exports.composeLaneRejectionError({
				directory,
				record: makeRecord(),
				errorCode: 'PR_WORKFLOW_CONTRACT_INVALID',
				inlineDetail: THROWN_CAUSE,
			});

			// The returned (terminal-persisted) summary leads with the code and
			// carries the family placeholder, not the token body.
			expect(summary).toContain('PR_WORKFLOW_CONTRACT_INVALID');
			expect(summary).toContain(SYNTH_OPENAI_PLACEHOLDER);
			expect(
				summary.includes(SYNTH_TOKEN),
				`rejection summary carries token cleartext: ${summary}`,
			).toBe(false);

			// The complete detail was persisted by the REAL
			// persistLaneRejectionDetail → storeLaneOutput; read it back
			// through the production read path via the cited ref.
			const refMatch = summary.match(
				/artifact (L1:[0-9a-f]+(?::[0-9a-f]+){2})/,
			);
			expect(refMatch).not.toBeNull();
			const ref = refMatch?.[1] as string;

			const read = readLaneOutput(directory, ref);
			expect(read).not.toBeNull();
			const artifactText = read?.artifact.text ?? '';
			expect(artifactText).toContain(SYNTH_OPENAI_PLACEHOLDER);
			expect(
				artifactText.includes(SYNTH_TOKEN),
				`lane-rejection artifact carries token cleartext: ${artifactText}`,
			).toBe(false);

			// The artifact physically lands under .swarm/lane-results/** —
			// assert it on disk too, independent of the read helper.
			const refParts = ref.split(':');
			const absPath = path.join(
				directory,
				'.swarm',
				'lane-results',
				refParts[1] as string,
				refParts[2] as string,
				`${refParts[3] as string}.json`,
			);
			expect(fs.existsSync(absPath)).toBe(true);
			const rawArtifact = fs.readFileSync(absPath, 'utf-8');
			expect(
				rawArtifact.includes(SYNTH_TOKEN),
				'on-disk lane-rejection artifact carries token cleartext',
			).toBe(false);
			expect(rawArtifact).toContain(SYNTH_OPENAI_PLACEHOLDER);
		} finally {
			removeTreeWithRetry(directory);
		}
	}, 30_000);
});
