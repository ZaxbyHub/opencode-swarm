import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type PluginConfig,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';
import {
	buildApprovedReceipt,
	_internals as receiptInternals,
} from '../../../src/hooks/review-receipt';
import type { ReviewDiffResult } from '../../../src/review/diff-source';
import {
	type AutoReviewEvidence,
	persistAutoReviewEvidence,
	validateAutoReviewEvidenceIntegrity,
} from '../../../src/review/evidence';
import {
	_internals as gateInternals,
	runFinalReviewGate,
} from '../../../src/tools/phase-complete/gates/final-review-gate';
import type { GateContext } from '../../../src/tools/phase-complete/gates/types';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const SCOPE_TEXT = 'test scope';
const SCOPE_HASH = 'a'.repeat(64);
const HEAD_SHA = 'b'.repeat(40);
const originalCollectReviewDiff = gateInternals.collectReviewDiff;
const originalOpenSync = receiptInternals.openSync;

let projectDir: string;
let cleanupProject: () => void;

function currentScope(): Extract<ReviewDiffResult, { status: 'ok' }> {
	return {
		status: 'ok',
		selector: { kind: 'default' },
		canonicalText: SCOPE_TEXT,
		reviewTextBytes: Buffer.byteLength(SCOPE_TEXT, 'utf8'),
		scopeHash: SCOPE_HASH,
		headSha: HEAD_SHA,
		changedLines: new Map(),
		deletedLines: new Map(),
		files: new Map(),
		completeness: {
			complete: true,
			truncated: false,
			skipReasons: [],
		},
		staleness: {
			collectedAt: new Date().toISOString(),
			headSha: HEAD_SHA,
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: SCOPE_HASH,
		},
	};
}

function gateConfig(): PluginConfig {
	return {
		auto_review: resolveAutoReviewConfig({
			enabled: true,
			final_review: { mode: 'gate' },
		}),
	} as PluginConfig;
}

function gateContext(): GateContext {
	return {
		phase: 2,
		dir: projectDir,
		sessionID: 'receipt-integrity-session',
		pluginConfig: gateConfig(),
		agentsDispatched: [],
		safeWarn: () => {},
		autoReviewTrigger: 'phase_completion',
		autoReviewScopeHash: SCOPE_HASH,
		autoReviewScopeComplete: true,
		autoReviewBlocked: false,
	};
}

function createEvidence(
	directory = projectDir,
	receiptScopeContent = SCOPE_TEXT,
): AutoReviewEvidence {
	const receiptPath = path.join(
		directory,
		'.swarm',
		'review-receipts',
		'receipt.json',
	);
	const evidence: AutoReviewEvidence = {
		schema_version: 1,
		timestamp: new Date().toISOString(),
		trigger: 'phase_completion',
		session_id: 'receipt-integrity-session',
		phase: 2,
		scope: {
			hash: SCOPE_HASH,
			selector: { kind: 'default' },
			head_sha: HEAD_SHA,
			review_text_bytes: Buffer.byteLength(SCOPE_TEXT, 'utf8'),
			completeness: {
				complete: true,
				truncated: false,
				skipReasons: [],
			},
		},
		policy: {
			mode: 'gate',
			min_confidence: 0.7,
			structured_findings: true,
			validate_findings: false,
		},
		review: {
			status: 'completed',
			output_mode: 'structured',
		},
		findings: [],
		validation_complete: true,
		blocking_finding_ids: [],
		receipt_path: receiptPath,
		cost: {
			model_calls: 1,
			diff_bytes: Buffer.byteLength(SCOPE_TEXT, 'utf8'),
			prompt_bytes: 100,
			tokens_input: 10,
			tokens_output: 5,
			tokens_reasoning: 0,
			tokens_cache: 0,
			cost_usd: null,
			cost_source: 'unavailable',
		},
	};
	const receipt = buildApprovedReceipt({
		agent: 'reviewer',
		sessionId: evidence.session_id,
		scopeContent: receiptScopeContent,
		scopeDescription: 'phase_completion-review',
		checkedAspects: ['correctness'],
		validatedClaims: ['structured review completed'],
		caveats: [],
		structuredFindings: [],
		findingValidations: [],
	});
	fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
	fs.writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');
	return evidence;
}

function integrityExpectation(evidence: AutoReviewEvidence) {
	return {
		scopeHash: SCOPE_HASH,
		phase: 2,
		trigger: 'phase_completion' as const,
		policy: evidence.policy,
		scopeContent: SCOPE_TEXT,
	};
}

function linkDirectory(target: string, link: string): void {
	fs.symlinkSync(
		target,
		link,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
}

beforeEach(() => {
	const fixture = createSafeTestDir('phase-receipt-integrity-');
	projectDir = fixture.dir;
	cleanupProject = fixture.cleanup;
	gateInternals.collectReviewDiff = async () => currentScope();
});

afterEach(() => {
	gateInternals.collectReviewDiff = originalCollectReviewDiff;
	receiptInternals.openSync = originalOpenSync;
	cleanupProject();
});

describe('phase final review receipt integrity', () => {
	test('rejects a receipt fingerprinted over different canonical bytes (F-IG1)', async () => {
		// Previous code omitted scopeContent at the terminal integrity call, so
		// evidence for the current hash could reuse a receipt for different bytes.
		const evidence = createEvidence(projectDir, 'different reviewed bytes');
		await persistAutoReviewEvidence(projectDir, evidence);

		const result = await runFinalReviewGate(gateContext());

		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('FINAL_REVIEW_EVIDENCE_INVALID');
		expect(result.message).toContain('scope or session binding mismatch');
	});

	test('rejects a project root reached through a junction or symlink (F-IG2)', () => {
		const links = createSafeTestDir('phase-receipt-project-link-');
		const linkedProject = path.join(links.dir, 'linked-project');
		const evidence = createEvidence();
		linkDirectory(projectDir, linkedProject);
		evidence.receipt_path = path.join(
			linkedProject,
			'.swarm',
			'review-receipts',
			'receipt.json',
		);
		try {
			const result = validateAutoReviewEvidenceIntegrity(
				linkedProject,
				evidence,
				integrityExpectation(evidence),
			);
			expect(result).toMatchObject({
				ok: false,
				code: 'receipt_missing',
			});
		} finally {
			links.cleanup();
		}
	});

	test('rejects a .swarm junction or directory symlink (F-IG2)', () => {
		const outside = createSafeTestDir('phase-receipt-swarm-link-');
		const evidence = createEvidence();
		const swarmPath = path.join(projectDir, '.swarm');
		const outsideSwarm = path.join(outside.dir, 'swarm');
		fs.renameSync(swarmPath, outsideSwarm);
		linkDirectory(outsideSwarm, swarmPath);
		try {
			const result = validateAutoReviewEvidenceIntegrity(
				projectDir,
				evidence,
				integrityExpectation(evidence),
			);
			expect(result).toMatchObject({
				ok: false,
				code: 'receipt_missing',
			});
		} finally {
			outside.cleanup();
		}
	});

	test('final gate rejects a redirected review-receipts ancestor (F-IG2)', async () => {
		const outside = createSafeTestDir('phase-receipt-root-link-');
		const evidence = createEvidence();
		await persistAutoReviewEvidence(projectDir, evidence);
		const receiptsPath = path.join(projectDir, '.swarm', 'review-receipts');
		const outsideReceipts = path.join(outside.dir, 'receipts');
		fs.renameSync(receiptsPath, outsideReceipts);
		linkDirectory(outsideReceipts, receiptsPath);
		try {
			const result = await runFinalReviewGate(gateContext());
			expect(result.blocked).toBe(true);
			expect(result.reason).toBe('FINAL_REVIEW_RECEIPT_MISSING');
		} finally {
			outside.cleanup();
		}
	});

	test('final gate detects an ancestor swap at descriptor open (F-IG2)', async () => {
		const outside = createSafeTestDir('phase-receipt-open-swap-');
		const evidence = createEvidence();
		await persistAutoReviewEvidence(projectDir, evidence);
		const receiptPath = evidence.receipt_path as string;
		const receiptsPath = path.dirname(receiptPath);
		const movedReceipts = path.join(projectDir, '.swarm', 'moved-receipts');
		const outsideReceipts = path.join(outside.dir, 'receipts');
		fs.mkdirSync(outsideReceipts);
		fs.copyFileSync(
			receiptPath,
			path.join(outsideReceipts, path.basename(receiptPath)),
		);

		let swapped = false;
		// Only the open-time ancestor-swap branch is intercepted here. Normal,
		// already-redirected, and fingerprint paths are covered by the tests above.
		receiptInternals.openSync = ((candidate, flags, mode) => {
			if (!swapped) {
				swapped = true;
				fs.renameSync(receiptsPath, movedReceipts);
				linkDirectory(outsideReceipts, receiptsPath);
			}
			return fs.openSync(candidate, flags, mode);
		}) as typeof fs.openSync;

		try {
			const result = await runFinalReviewGate(gateContext());
			expect(swapped).toBe(true);
			expect(result.blocked).toBe(true);
			expect(result.reason).toBe('FINAL_REVIEW_RECEIPT_MISSING');
		} finally {
			outside.cleanup();
		}
	});
});
