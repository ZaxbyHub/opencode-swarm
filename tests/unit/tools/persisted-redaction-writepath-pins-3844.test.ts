/**
 * #3844 final-critic round-2 R2-1/R2-2/R2-3: regression pins through the
 * REAL write paths (not just the exported helpers) — persistReviewReceipt
 * and persistAutoReviewEvidence file read-backs, the wake-message builder
 * (including a legacy raw stored event), the subscriber advisory fan-out,
 * the F2 sibling fields, and the consent command's version line. The
 * pr-feedback-loop terminal reason has its own tracked suite
 * (tests/unit/background/pr-feedback-loop-terminal-reason-3844.test.ts,
 * final-critic R3-2). Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	FindingValidationSchema,
	ReviewFindingSchema,
} from '../../../src/agents/agent-output-schema';
import { buildWakeMessage } from '../../../src/background/pr-event-delivery';
import { handleDatasetConsentCommand } from '../../../src/commands/dataset';
import {
	persistReviewReceipt,
	readReceiptById,
} from '../../../src/hooks/review-receipt';
import { persistAutoReviewEvidence } from '../../../src/review/evidence';
import { write_drift_evidence } from '../../../src/tools/write-drift-evidence';
import { write_hallucination_evidence } from '../../../src/tools/write-hallucination-evidence';
import { TRAINING_REDACTION_VERSION } from '../../../src/training/redact';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GH = `ghp_${'w'.repeat(30)}`;
const ANT = `sk-ant-${'b'.repeat(24)}`;

function ctx(directory: string) {
	return { directory, sessionID: 'r2-pins' } as never;
}

/** Walk every file under dir; assert neither token is present anywhere. */
function assertNoTokensUnder(dir: string) {
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const entry of Array.from(
			require('node:fs').readdirSync(current, {
				withFileTypes: true,
			}) as Array<{
				name: string;
				isDirectory(): boolean;
			}>,
		)) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else {
				const text = readFileSync(full, 'utf8');
				if (text.includes(GH) || text.includes(ANT)) {
					throw new Error(
						`raw token persisted in ${full}: ${text.slice(0, 400)}`,
					);
				}
			}
		}
	}
}

describe('#3844 write-path pins (final-critic round 2)', () => {
	test('R2-1: persistReviewReceipt writes the DURABLE receipt redacted', async () => {
		const dir = canonicalMkdtemp('r2pins-3844-receipt-');
		const receipt = {
			schema_version: 1,
			id: 'rr-1',
			receipt_type: 'rejected',
			verdict: 'rejected',
			reviewer: { name: 'reviewer', session_id: 's' },
			reviewed_at: '2026-01-01T00:00:00.000Z',
			scope_fingerprint: { algorithm: 'sha256', value: '0'.repeat(64) },
			blocking_findings: [
				{
					summary: `receipt summary ${GH}`,
					title: `title ${ANT}`,
					body: `body ${GH}`,
					finding_id: 'f-1',
					severity: 'high',
					file: 'src/a.ts',
					line: 1,
					validator: 'reviewer',
					validator_evidence: `probe ${ANT}`,
					anchor_reason: `anchor ${GH}`,
				},
			],
			evidence_references: [`ref ${GH}`],
			pass_conditions: ['reviewer approves'],
			summary: `overall ${GH}`,
			structured_findings: [{ title: `st ${ANT}`, body: `sb ${GH}` }],
		} as never;
		await persistReviewReceipt(dir, receipt);
		assertNoTokensUnder(path.join(dir, '.swarm'));
	}, 60_000);

	test('R2-4: a near-cap validation stays inside its schema bound after redaction', async () => {
		// A redaction placeholder can be LONGER than the secret it replaces
		// (`?token=abc` -> `?token=[REDACTED]`), so a value that sat exactly
		// on FindingValidationSchema's 2000-character evidence bound is
		// pushed PAST it by the redaction itself - and the persisted receipt
		// then fails its schema on read (receipt_missing).
		const dir = canonicalMkdtemp('r2pins-3844-cap-');
		const nearCap = `${'x'.repeat(2000 - '?token=abc'.length)}?token=abc`;
		expect(nearCap.length).toBe(2000);
		// The SAME shape for the finding title/body bounds. The value must
		// be SCHEMA-VALID BEFORE the redaction (exactly on its bound) and
		// only the redaction pushes it past — that is the class this clamp
		// exists for. A fixture that was already over its bound would pin
		// nothing: the clamp would simply truncate an invalid input.
		//
		// The secret sits at the HEAD: the redaction puts the marker at the
		// start of the value, and a clamp that mistakes a COMPLETE marker
		// for a fragment empties the field, which then fails
		// ReviewFindingSchema's `.min(1)` and drops the finding.
		//
		// The filler carries a SPACE: the token classes are greedy over
		// [A-Za-z0-9_-], so a letter-only filler would be swallowed INTO the
		// token and the whole field would collapse to the bare marker.
		const nearCapTitle = `?token=abc${'z '.repeat(95)}`;
		const nearCapBody = `?token=abc${'y '.repeat(995)}`;
		expect(nearCapTitle.length).toBe(200);
		expect(nearCapBody.length).toBe(2000);
		const receipt = {
			schema_version: 1,
			id: 'rr-cap',
			receipt_type: 'rejected',
			verdict: 'rejected',
			reviewer: { name: 'reviewer', session_id: 's' },
			reviewed_at: '2026-01-01T00:00:00.000Z',
			scope_fingerprint: { algorithm: 'sha256', value: '0'.repeat(64) },
			blocking_findings: [],
			evidence_references: [],
			pass_conditions: ['reviewer approves'],
			structured_findings: [
				{
					title: nearCapTitle,
					body: nearCapBody,
					severity: 'high',
					confidence: 0.9,
					file: 'src/a.ts',
					line_start: 1,
					line_end: 1,
				},
			],
			finding_validations: [
				{
					finding_id: 'f-cap',
					disposition: 'CONFIRMED',
					confidence: 1,
					evidence: nearCap,
				},
			],
		} as never;
		const receiptPath = await persistReviewReceipt(dir, receipt);
		// Read the persisted receipt back through the PRODUCTION receipt
		// reader (the index + the bounded file read), not by parsing the
		// file this test just wrote: the reader is the surface that decides
		// whether a persisted receipt is usable at all.
		const readBack = await readReceiptById(dir, 'rr-cap');
		expect(readBack).not.toBeNull();
		const persisted = readBack as unknown as {
			finding_validations: Array<{ evidence: string }>;
			structured_findings: Array<{ title: string; body: string }>;
		};
		const evidence = persisted.finding_validations[0].evidence;
		expect(evidence.length).toBeLessThanOrEqual(2000);
		// The redaction still happened, and the cut never persisted a
		// half-written placeholder marker.
		expect(evidence).not.toContain('?token=abc');
		expect(/\[REDACTED?$/.test(evidence)).toBe(false);
		// The title/body bounds hold, and neither field was EMPTIED.
		const title = persisted.structured_findings[0].title;
		const body = persisted.structured_findings[0].body;
		expect(title.length).toBeLessThanOrEqual(200);
		expect(body.length).toBeLessThanOrEqual(2000);
		expect(title.length).toBeGreaterThan(0);
		expect(body.length).toBeGreaterThan(0);
		// The COMPLETE marker at the head SURVIVED the clamp: it is real
		// content, not a half-written fragment. (The pre-fix clamp stripped
		// it, leaving only the `?token=` prefix.)
		expect(title.startsWith('?token=[REDACTED]')).toBe(true);
		expect(body.startsWith('?token=[REDACTED]')).toBe(true);
		// The schema-validating reader must ACCEPT the persisted structures:
		// this is the surface that drops a receipt whose field misses its
		// bound (or was emptied), and a length assertion alone would not
		// notice a field that fails the schema for another reason.
		expect(
			FindingValidationSchema.safeParse(persisted.finding_validations[0])
				.success,
		).toBe(true);
		expect(
			ReviewFindingSchema.safeParse(persisted.structured_findings[0]).success,
		).toBe(true);
	}, 60_000);

	test('R2-1: persistAutoReviewEvidence writes the DURABLE evidence redacted', async () => {
		const dir = canonicalMkdtemp('r2pins-3844-evidence-');
		const evidence = {
			schema_version: 2,
			timestamp: '2026-01-01T00:00:00.000Z',
			trigger: 'manual',
			session_id: 's',
			phase: 'phase-1',
			scope: {
				hash: 'hash-1',
				selector: { mode: 'head_tree' },
				head_sha: '0'.repeat(40),
				review_text_bytes: 1,
				completeness: 'complete',
			},
			policy: {
				mode: 'advisory',
				min_confidence: 0,
				structured_findings: true,
				validate_findings: true,
			},
			review: { status: 'completed', error: `engine error ${ANT}` },
			findings: [
				{
					finding_id: 'f1',
					title: `title ${ANT}`,
					body: `body ${GH}`,
					severity: 'low',
					confidence: 0.9,
					file: 'src/a.ts',
					line_start: 1,
					line_end: 2,
					effective_severity: 'low',
					duplicate_count: 1,
					anchored: true,
				},
			],
			validation_error: `provider ${GH}`,
		} as never;
		await persistAutoReviewEvidence(dir, evidence);
		assertNoTokensUnder(path.join(dir, '.swarm'));
	}, 60_000);

	test('R2-1: wake message redacts the event text — including a LEGACY raw stored event', () => {
		const message = buildWakeMessage([
			{
				type: 'pr.new.comment',
				message: `legacy raw event text quoting ${GH}`,
				prUrl: 'https://github.com/o/r/pull/1',
				dedupToken: 't',
				authorized: true,
				timestamp: '2026-01-01T00:00:00.000Z',
			} as never,
			{
				type: 'pr.ci.failed',
				message: `fresh event ${ANT}`,
				prUrl: 'https://github.com/o/r/pull/1',
				dedupToken: 't2',
				authorized: true,
				timestamp: '2026-01-01T00:00:01.000Z',
			} as never,
		]);
		expect(message.includes(GH)).toBe(false);
		expect(message.includes(ANT)).toBe(false);
	}, 60_000);

	test('R2-1: subscriber advisory construction point redacts before fan-out', async () => {
		const mod = await import('../../../src/background/pr-event-subscribers');
		const internals = mod._internals as Record<string, unknown>;
		const captured: string[] = [];
		const saved = {
			listActive: internals.listActive,
			getAgentSession: internals.getAgentSession,
			readPrWorkflowGateState: internals.readPrWorkflowGateState,
			deliverPrActivity: internals.deliverPrActivity,
			notifyPrFeedbackLoop: internals.notifyPrFeedbackLoop,
			readPrFeedbackLoopCancellation: internals.readPrFeedbackLoopCancellation,
			enqueuePrFeedbackMonitorEvent: internals.enqueuePrFeedbackMonitorEvent,
			isPrEventDeliveryRegistered: internals.isPrEventDeliveryRegistered,
			scheduleClearUnaddressed: internals.scheduleClearUnaddressed,
			updateSnapshot: internals.updateSnapshot,
		};
		internals.listActive = async () => [
			{
				sessionId: 's1',
				prNumber: 7,
				repoFullName: 'team/proj',
				prUrl: 'https://github.com/team/proj/pull/7',
				forge: 'github',
			},
		];
		internals.deliverPrActivity = (_directory: string, message: string) => {
			captured.push(message);
			return Promise.resolve();
		};
		internals.notifyPrFeedbackLoop = async () => undefined;
		internals.readPrFeedbackLoopCancellation = async () => false;
		internals.enqueuePrFeedbackMonitorEvent = (async () => ({})) as never;
		internals.isPrEventDeliveryRegistered = () => false;
		internals.scheduleClearUnaddressed = () => undefined;
		internals.updateSnapshot = () => undefined;
		// No PR-workflow gate state → the direct delivery path is taken
		// (queueForLater=false with auto_pr_feedback off). Provide a live
		// session so the advisory lands on pendingAdvisoryMessages; the
		// captured delivery covers the wake-message arm and the session
		// array covers the advisory arm.
		internals.readPrWorkflowGateState = async () => null;
		const session = {
			id: 's1',
			pendingAdvisoryMessages: [] as string[],
		} as { id: string; pendingAdvisoryMessages: string[] };
		internals.getAgentSession = (() => session) as never;
		try {
			await (
				internals.handlePrEvent as (
					event: { type: string; payload: unknown },
					directory: string,
					config: Record<string, boolean>,
				) => Promise<void>
			)(
				{
					type: 'pr.ci.failed',
					payload: {
						prNumber: 7,
						repoFullName: 'team/proj',
						prUrl: 'https://github.com/team/proj/pull/7',
						failedChecks: [
							{ name: `check log quoting ${GH}`, conclusion: 'failure' },
						],
					},
				},
				'.',
				{},
			);
			const delivered = [...captured, ...session.pendingAdvisoryMessages];
			expect(delivered.length).toBeGreaterThan(0);
			for (const message of delivered) {
				expect(message.includes(GH)).toBe(false);
			}
		} finally {
			Object.assign(internals, saved);
		}
	}, 60_000);

	test('R2-2: hallucination findings field redacted on disk', async () => {
		const dir = canonicalMkdtemp('r2pins-3844-hall-');
		require('node:fs').mkdirSync(path.join(dir, '.swarm'), {
			recursive: true,
		});
		const out = (await write_hallucination_evidence.execute(
			{
				phase: 1,
				verdict: 'NEEDS_REVISION',
				summary: `summary ${GH}`,
				findings: `findings prose quoting ${ANT} at length`,
				working_directory: dir,
			},
			ctx(dir),
		)) as string;
		expect(out).toContain('"success": true');
		const file = readFileSync(
			path.join(dir, '.swarm', 'evidence', '1', 'hallucination-guard.json'),
			'utf8',
		);
		expect(file.includes(ANT)).toBe(false);
		expect(file.includes(GH)).toBe(false);
	}, 60_000);

	test('R2-2: drift requirementCoverage field redacted on disk', async () => {
		const dir = canonicalMkdtemp('r2pins-3844-drift-');
		require('node:fs').mkdirSync(path.join(dir, '.swarm'), {
			recursive: true,
		});
		const out = (await write_drift_evidence.execute(
			{
				phase: 1,
				verdict: 'NEEDS_REVISION',
				summary: `summary ${GH}`,
				requirementCoverage: `coverage notes quoting ${ANT}`,
				working_directory: dir,
			},
			ctx(dir),
		)) as string;
		expect(out).toContain('"success": true');
		const file = readFileSync(
			path.join(dir, '.swarm', 'evidence', '1', 'drift-verifier.json'),
			'utf8',
		);
		expect(file.includes(ANT)).toBe(false);
		expect(file.includes(GH)).toBe(false);
	}, 60_000);

	test('R2-3: consent command prints the RUNNING redaction version, not the constant name', async () => {
		const dir = canonicalMkdtemp('r2pins-3844-consent-');
		const out = await handleDatasetConsentCommand(dir, ['consent']);
		expect(out).toContain(`v${TRAINING_REDACTION_VERSION}`);
		expect(out.includes('vTRAINING_REDACTION_VERSION')).toBe(false);
	}, 60_000);
});
