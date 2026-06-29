/**
 * Tests for src/hooks/review-receipt.ts
 *
 * Covers:
 * 1. computeScopeFingerprint — deterministic SHA-256, length tracking
 * 2. isScopeStale — hash comparison, conservative undefined handling
 * 3. buildRejectedReceipt / buildApprovedReceipt — factory helpers
 * 4. persistReviewReceipt — atomic write, index update
 * 5. readReceiptById — index lookup, file read, missing ID
 * 6. readReceiptsByScopeHash — filter by hash, newest-first ordering
 * 7. readAllReceipts — full manifest, newest-first ordering
 * 8. buildReceiptContextForDrift — context string formatting, stale tagging
 * 9. Path helpers — resolveReceiptsDir, resolveReceiptIndexPath
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	ApprovedReviewReceipt,
	RejectedReviewReceipt,
	ReviewReceipt,
} from '../../../src/hooks/review-receipt.js';
import {
	buildApprovedReceipt,
	buildReceiptContextForDrift,
	buildRejectedReceipt,
	computeScopeFingerprint,
	isScopeStale,
	persistReviewReceipt,
	readAllReceipts,
	readReceiptById,
	readReceiptsByScopeHash,
	resolveReceiptIndexPath,
	resolveReceiptsDir,
} from '../../../src/hooks/review-receipt.js';

// ============================================================================
// Test helpers
// ============================================================================

let tmpDir: string;

function makeTestDir(): string {
	const dir = path.join(
		os.tmpdir(),
		`review-receipt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

beforeEach(() => {
	tmpDir = makeTestDir();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// 1. computeScopeFingerprint
// ============================================================================

describe('computeScopeFingerprint', () => {
	it('produces a 64-char hex SHA-256 hash', () => {
		const fp = computeScopeFingerprint('hello world', 'test-scope');
		expect(fp.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic — same input yields same hash', () => {
		const content = 'const x = 1;';
		const fp1 = computeScopeFingerprint(content, 'git-diff');
		const fp2 = computeScopeFingerprint(content, 'git-diff');
		expect(fp1.hash).toBe(fp2.hash);
	});

	it('hash matches independent SHA-256 computation', () => {
		const content = 'some code content here';
		const fp = computeScopeFingerprint(content, 'file-content');
		expect(fp.hash).toBe(sha256(content));
	});

	it('stores scope_description and content_length', () => {
		const content = 'abc';
		const fp = computeScopeFingerprint(content, 'spec-md');
		expect(fp.scope_description).toBe('spec-md');
		expect(fp.content_length).toBe(3);
	});

	it('different content produces different hash', () => {
		const fp1 = computeScopeFingerprint('version A', 'diff');
		const fp2 = computeScopeFingerprint('version B', 'diff');
		expect(fp1.hash).not.toBe(fp2.hash);
	});

	it('empty string has consistent hash', () => {
		const fp = computeScopeFingerprint('', 'empty');
		expect(fp.hash).toBe(sha256(''));
		expect(fp.content_length).toBe(0);
	});
});

// ============================================================================
// 2. isScopeStale
// ============================================================================

describe('isScopeStale', () => {
	it('returns false when hash matches current content', () => {
		const content = 'current diff content';
		const receipt = buildApprovedReceipt({
			agent: 'reviewer',
			scopeContent: content,
			scopeDescription: 'git-diff',
			checkedAspects: ['security'],
			validatedClaims: ['no injection'],
		});
		expect(isScopeStale(receipt, content)).toBe(false);
	});

	it('returns true when current content differs from fingerprint', () => {
		const original = 'original diff';
		const modified = 'modified diff with extra line';
		const receipt = buildApprovedReceipt({
			agent: 'reviewer',
			scopeContent: original,
			scopeDescription: 'git-diff',
			checkedAspects: ['security'],
			validatedClaims: [],
		});
		expect(isScopeStale(receipt, modified)).toBe(true);
	});

	it('returns true conservatively when currentContent is undefined', () => {
		const receipt = buildApprovedReceipt({
			agent: 'critic',
			scopeContent: 'some content',
			scopeDescription: 'file-content',
			checkedAspects: [],
			validatedClaims: [],
		});
		expect(isScopeStale(receipt, undefined)).toBe(true);
	});

	it('works for rejected receipts too (same fingerprint logic)', () => {
		const content = 'diff with bug';
		const receipt = buildRejectedReceipt({
			agent: 'reviewer',
			scopeContent: content,
			scopeDescription: 'git-diff',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});
		expect(isScopeStale(receipt, content)).toBe(false);
		expect(isScopeStale(receipt, content + ' (patched)')).toBe(true);
	});

	it('single-character change makes receipt stale', () => {
		const original = 'const x = 1;';
		const tweaked = 'const x = 2;';
		const receipt = buildApprovedReceipt({
			agent: 'curator',
			scopeContent: original,
			scopeDescription: 'file-content',
			checkedAspects: ['correctness'],
			validatedClaims: [],
		});
		expect(isScopeStale(receipt, tweaked)).toBe(true);
	});
});

// ============================================================================
// 3. Factory helpers
// ============================================================================

describe('buildRejectedReceipt', () => {
	it('creates receipt with correct shape', () => {
		const receipt = buildRejectedReceipt({
			agent: 'reviewer',
			sessionId: 'sess-abc',
			scopeContent: 'buggy code diff',
			scopeDescription: 'git-diff',
			blockingFindings: [
				{
					location: 'src/foo.ts',
					summary: 'SQL injection',
					severity: 'critical',
				},
			],
			evidenceReferences: ['src/foo.ts:42'],
			passConditions: ['sanitize all DB inputs'],
			summary: 'Critical security issue found',
		});

		expect(receipt.schema_version).toBe(1);
		expect(receipt.receipt_type).toBe('rejected');
		expect(receipt.verdict).toBe('rejected');
		expect(receipt.reviewer.agent).toBe('reviewer');
		expect(receipt.reviewer.session_id).toBe('sess-abc');
		expect(receipt.blocking_findings).toHaveLength(1);
		expect(receipt.blocking_findings[0].severity).toBe('critical');
		expect(receipt.evidence_references).toEqual(['src/foo.ts:42']);
		expect(receipt.pass_conditions).toEqual(['sanitize all DB inputs']);
		expect(receipt.summary).toBe('Critical security issue found');
		expect(receipt.scope_fingerprint.hash).toBe(sha256('buggy code diff'));
		expect(receipt.scope_fingerprint.scope_description).toBe('git-diff');
	});

	it('generates a UUID for id', () => {
		const r1 = buildRejectedReceipt({
			agent: 'r',
			scopeContent: 'a',
			scopeDescription: 'd',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});
		const r2 = buildRejectedReceipt({
			agent: 'r',
			scopeContent: 'a',
			scopeDescription: 'd',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});
		expect(r1.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(r1.id).not.toBe(r2.id); // unique per call
	});

	it('sets reviewed_at to current ISO timestamp', () => {
		const before = new Date().toISOString();
		const receipt = buildRejectedReceipt({
			agent: 'r',
			scopeContent: 'x',
			scopeDescription: 'd',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});
		const after = new Date().toISOString();
		expect(receipt.reviewed_at >= before).toBe(true);
		expect(receipt.reviewed_at <= after).toBe(true);
	});

	it('sessionId is optional and omitted when not provided', () => {
		const receipt = buildRejectedReceipt({
			agent: 'r',
			scopeContent: 'x',
			scopeDescription: 'd',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});
		expect(receipt.reviewer.session_id).toBeUndefined();
	});
});

describe('buildApprovedReceipt', () => {
	it('creates receipt with correct shape', () => {
		const receipt = buildApprovedReceipt({
			agent: 'curator',
			sessionId: 'sess-xyz',
			scopeContent: 'clean code diff',
			scopeDescription: 'git-diff',
			checkedAspects: ['security', 'correctness', 'test coverage'],
			validatedClaims: ['all tests pass', 'no SQL injection'],
			caveats: ['performance not checked'],
		});

		expect(receipt.schema_version).toBe(1);
		expect(receipt.receipt_type).toBe('approved');
		expect(receipt.verdict).toBe('approved');
		expect(receipt.reviewer.agent).toBe('curator');
		expect(receipt.reviewer.session_id).toBe('sess-xyz');
		expect(receipt.checked_aspects).toEqual([
			'security',
			'correctness',
			'test coverage',
		]);
		expect(receipt.validated_claims).toEqual([
			'all tests pass',
			'no SQL injection',
		]);
		expect(receipt.caveats).toEqual(['performance not checked']);
		expect(receipt.scope_fingerprint.hash).toBe(sha256('clean code diff'));
	});

	it('caveats is optional', () => {
		const receipt = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'x',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		expect(receipt.caveats).toBeUndefined();
	});
});

// ============================================================================
// 4. persistReviewReceipt
// ============================================================================

describe('persistReviewReceipt', () => {
	it('writes receipt file under .swarm/review-receipts/', async () => {
		const receipt = buildApprovedReceipt({
			agent: 'reviewer',
			scopeContent: 'diff content',
			scopeDescription: 'git-diff',
			checkedAspects: ['security'],
			validatedClaims: [],
		});

		const receiptPath = await persistReviewReceipt(tmpDir, receipt);

		expect(fs.existsSync(receiptPath)).toBe(true);
		expect(receiptPath).toContain(path.join('.swarm', 'review-receipts'));
	});

	it('receipt file is valid JSON matching the receipt', async () => {
		const receipt = buildRejectedReceipt({
			agent: 'reviewer',
			scopeContent: 'buggy diff',
			scopeDescription: 'git-diff',
			blockingFindings: [
				{ location: 'main.ts', summary: 'race condition', severity: 'high' },
			],
			evidenceReferences: ['main.ts:10'],
			passConditions: ['add mutex'],
		});

		const receiptPath = await persistReviewReceipt(tmpDir, receipt);
		const raw = fs.readFileSync(receiptPath, 'utf-8');
		const parsed = JSON.parse(raw) as RejectedReviewReceipt;

		expect(parsed.id).toBe(receipt.id);
		expect(parsed.verdict).toBe('rejected');
		expect(parsed.blocking_findings[0].summary).toBe('race condition');
		expect(parsed.scope_fingerprint.hash).toBe(receipt.scope_fingerprint.hash);
	});

	it('filename follows YYYY-MM-DD-<id>.json pattern', async () => {
		const receipt = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		const receiptPath = await persistReviewReceipt(tmpDir, receipt);
		const filename = path.basename(receiptPath);
		expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}\.json$/);
	});

	it('updates the index.json with the new entry', async () => {
		const receipt = buildApprovedReceipt({
			agent: 'curator',
			scopeContent: 'code',
			scopeDescription: 'spec',
			checkedAspects: ['security'],
			validatedClaims: [],
		});
		await persistReviewReceipt(tmpDir, receipt);

		const indexPath = resolveReceiptIndexPath(tmpDir);
		const raw = fs.readFileSync(indexPath, 'utf-8');
		const index = JSON.parse(raw);

		expect(index.schema_version).toBe(1);
		expect(Array.isArray(index.entries)).toBe(true);
		expect(index.entries).toHaveLength(1);
		expect(index.entries[0].id).toBe(receipt.id);
		expect(index.entries[0].verdict).toBe('approved');
		expect(index.entries[0].scope_hash).toBe(receipt.scope_fingerprint.hash);
		expect(index.entries[0].agent).toBe('curator');
	});

	it('accumulates multiple receipts in the index', async () => {
		const r1 = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c1',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		const r2 = buildRejectedReceipt({
			agent: 'r',
			scopeContent: 'c2',
			scopeDescription: 'd',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});
		const r3 = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c3',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});

		await persistReviewReceipt(tmpDir, r1);
		await persistReviewReceipt(tmpDir, r2);
		await persistReviewReceipt(tmpDir, r3);

		const indexPath = resolveReceiptIndexPath(tmpDir);
		const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
		expect(index.entries).toHaveLength(3);
	});

	it('creates directory if it does not exist', async () => {
		const deepDir = path.join(tmpDir, 'nested', 'project');
		const receipt = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		await persistReviewReceipt(deepDir, receipt);

		const receiptsDir = resolveReceiptsDir(deepDir);
		expect(fs.existsSync(receiptsDir)).toBe(true);
	});
});

// ============================================================================
// 5. readReceiptById
// ============================================================================

describe('readReceiptById', () => {
	it('returns the receipt for a known ID', async () => {
		const receipt = buildApprovedReceipt({
			agent: 'reviewer',
			scopeContent: 'c',
			scopeDescription: 'd',
			checkedAspects: ['security'],
			validatedClaims: [],
		});
		await persistReviewReceipt(tmpDir, receipt);

		const found = await readReceiptById(tmpDir, receipt.id);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(receipt.id);
		expect(found?.verdict).toBe('approved');
	});

	it('returns null for an unknown ID', async () => {
		const result = await readReceiptById(tmpDir, 'non-existent-id');
		expect(result).toBeNull();
	});

	it('returns null when receipts directory does not exist', async () => {
		const emptyDir = path.join(tmpDir, 'empty-project');
		const result = await readReceiptById(emptyDir, 'any-id');
		expect(result).toBeNull();
	});

	it('returns rejected receipt with all blocking findings', async () => {
		const receipt = buildRejectedReceipt({
			agent: 'critic',
			scopeContent: 'diff',
			scopeDescription: 'git-diff',
			blockingFindings: [
				{ location: 'a.ts', summary: 'issue 1', severity: 'critical' },
				{ location: 'b.ts', summary: 'issue 2', severity: 'medium' },
			],
			evidenceReferences: ['a.ts:1', 'b.ts:2'],
			passConditions: ['fix both issues'],
		});
		await persistReviewReceipt(tmpDir, receipt);

		const found = (await readReceiptById(
			tmpDir,
			receipt.id,
		)) as RejectedReviewReceipt;
		expect(found.blocking_findings).toHaveLength(2);
		expect(found.blocking_findings[0].severity).toBe('critical');
	});
});

// ============================================================================
// 6. readReceiptsByScopeHash
// ============================================================================

describe('readReceiptsByScopeHash', () => {
	it('returns only receipts matching the scope hash', async () => {
		const contentA = 'scope A diff';
		const contentB = 'scope B diff';

		const r1 = buildApprovedReceipt({
			agent: 'r',
			scopeContent: contentA,
			scopeDescription: 'diff',
			checkedAspects: [],
			validatedClaims: [],
		});
		const r2 = buildApprovedReceipt({
			agent: 'r',
			scopeContent: contentB,
			scopeDescription: 'diff',
			checkedAspects: [],
			validatedClaims: [],
		});
		const r3 = buildRejectedReceipt({
			agent: 'r',
			scopeContent: contentA,
			scopeDescription: 'diff',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});

		await persistReviewReceipt(tmpDir, r1);
		await persistReviewReceipt(tmpDir, r2);
		await persistReviewReceipt(tmpDir, r3);

		const hashA = sha256(contentA);
		const results = await readReceiptsByScopeHash(tmpDir, hashA);

		expect(results).toHaveLength(2);
		const ids = results.map((r) => r.id);
		expect(ids).toContain(r1.id);
		expect(ids).toContain(r3.id);
		expect(ids).not.toContain(r2.id);
	});

	it('returns newest first', async () => {
		const content = 'same scope';
		// Persist with slight delays to ensure distinct timestamps would be ordered
		const r1 = buildApprovedReceipt({
			agent: 'r',
			scopeContent: content,
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		// Manually set an older timestamp on r1
		(r1 as ApprovedReviewReceipt & { reviewed_at: string }).reviewed_at =
			'2024-01-01T00:00:00.000Z';
		const r2 = buildApprovedReceipt({
			agent: 'r',
			scopeContent: content,
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		r2.reviewed_at = '2024-06-01T00:00:00.000Z';

		await persistReviewReceipt(tmpDir, r1);
		await persistReviewReceipt(tmpDir, r2);

		const results = await readReceiptsByScopeHash(tmpDir, sha256(content));
		expect(results[0].id).toBe(r2.id); // newer first
		expect(results[1].id).toBe(r1.id);
	});

	it('returns empty array when no receipts match hash', async () => {
		const r = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'x',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		await persistReviewReceipt(tmpDir, r);

		const results = await readReceiptsByScopeHash(tmpDir, 'a'.repeat(64));
		expect(results).toHaveLength(0);
	});
});

// ============================================================================
// 7. readAllReceipts
// ============================================================================

describe('readAllReceipts', () => {
	it('returns all persisted receipts, newest first', async () => {
		const r1 = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c1',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		r1.reviewed_at = '2024-01-01T00:00:00.000Z';
		const r2 = buildRejectedReceipt({
			agent: 'r',
			scopeContent: 'c2',
			scopeDescription: 'd',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});
		r2.reviewed_at = '2024-09-01T00:00:00.000Z';
		const r3 = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c3',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		r3.reviewed_at = '2024-06-01T00:00:00.000Z';

		await persistReviewReceipt(tmpDir, r1);
		await persistReviewReceipt(tmpDir, r2);
		await persistReviewReceipt(tmpDir, r3);

		const all = await readAllReceipts(tmpDir);
		expect(all).toHaveLength(3);
		expect(all[0].id).toBe(r2.id); // 2024-09 newest
		expect(all[1].id).toBe(r3.id); // 2024-06
		expect(all[2].id).toBe(r1.id); // 2024-01 oldest
	});

	it('returns empty array when no receipts exist', async () => {
		const all = await readAllReceipts(tmpDir);
		expect(all).toHaveLength(0);
	});
});

// ============================================================================
// 8. buildReceiptContextForDrift
// ============================================================================

describe('buildReceiptContextForDrift', () => {
	it('returns empty string for empty receipts array', () => {
		const result = buildReceiptContextForDrift([]);
		expect(result).toBe('');
	});

	it('includes REJECTED line for rejected receipt', () => {
		const r = buildRejectedReceipt({
			agent: 'reviewer',
			scopeContent: 'diff',
			scopeDescription: 'git-diff',
			blockingFindings: [
				{ location: 'a.ts', summary: 'XSS', severity: 'critical' },
				{ location: 'b.ts', summary: 'leak', severity: 'high' },
			],
			evidenceReferences: [],
			passConditions: ['fix XSS', 'plug leak'],
		});

		const text = buildReceiptContextForDrift([r]);
		expect(text).toContain('REJECTED');
		expect(text).toContain('reviewer');
		expect(text).toContain('2 blocking finding');
		expect(text).toContain('fix XSS');
	});

	it('includes APPROVED line for approved receipt', () => {
		const r = buildApprovedReceipt({
			agent: 'curator',
			scopeContent: 'diff',
			scopeDescription: 'git-diff',
			checkedAspects: ['security', 'correctness'],
			validatedClaims: [],
		});

		const text = buildReceiptContextForDrift([r]);
		expect(text).toContain('APPROVED');
		expect(text).toContain('curator');
		expect(text).toContain('security');
		expect(text).toContain('correctness');
	});

	it('flags stale approved receipt with SCOPE-STALE tag', () => {
		const original = 'original content';
		const r = buildApprovedReceipt({
			agent: 'reviewer',
			scopeContent: original,
			scopeDescription: 'git-diff',
			checkedAspects: ['security'],
			validatedClaims: [],
		});

		// Pass modified content → should be stale
		const text = buildReceiptContextForDrift(
			[r],
			'modified content different from original',
		);
		expect(text).toContain('SCOPE-STALE');
	});

	it('does NOT flag stale when current content matches fingerprint', () => {
		const content = 'stable content';
		const r = buildApprovedReceipt({
			agent: 'reviewer',
			scopeContent: content,
			scopeDescription: 'git-diff',
			checkedAspects: ['security'],
			validatedClaims: [],
		});

		const text = buildReceiptContextForDrift([r], content);
		expect(text).not.toContain('SCOPE-STALE');
	});

	it('rejected receipts are never flagged as stale regardless of content', () => {
		const r = buildRejectedReceipt({
			agent: 'reviewer',
			scopeContent: 'original',
			scopeDescription: 'diff',
			blockingFindings: [],
			evidenceReferences: [],
			passConditions: [],
		});

		const text = buildReceiptContextForDrift(
			[r],
			'completely different content',
		);
		expect(text).not.toContain('SCOPE-STALE');
	});

	it('respects maxChars limit', () => {
		const receipts: ReviewReceipt[] = [];
		for (let i = 0; i < 20; i++) {
			receipts.push(
				buildApprovedReceipt({
					agent: 'reviewer',
					scopeContent: `content-${i}`,
					scopeDescription: 'diff',
					checkedAspects: ['security', 'correctness', 'performance', 'testing'],
					validatedClaims: ['claim a', 'claim b'],
				}),
			);
		}

		const text = buildReceiptContextForDrift(receipts, undefined, 300);
		expect(text.length).toBeLessThanOrEqual(300);
	});

	it('includes staleness warning footer', () => {
		const r = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c',
			scopeDescription: 'd',
			checkedAspects: [],
			validatedClaims: [],
		});
		const text = buildReceiptContextForDrift([r]);
		expect(text).toContain('Stale receipts must not be blindly trusted');
	});

	it('shows "No caveats recorded" when approved receipt has no caveats', () => {
		const r = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c',
			scopeDescription: 'd',
			checkedAspects: ['security'],
			validatedClaims: [],
		});
		const text = buildReceiptContextForDrift([r]);
		expect(text).toContain('No caveats recorded');
	});

	it('shows first caveat when approved receipt has caveats', () => {
		const r = buildApprovedReceipt({
			agent: 'r',
			scopeContent: 'c',
			scopeDescription: 'd',
			checkedAspects: ['security'],
			validatedClaims: [],
			caveats: ['performance was not checked', 'edge cases remain'],
		});
		const text = buildReceiptContextForDrift([r]);
		expect(text).toContain('performance was not checked');
	});
});

// ============================================================================
// 9. Path helpers
// ============================================================================

describe('resolveReceiptsDir', () => {
	it('returns .swarm/review-receipts under the given directory', () => {
		const dir = resolveReceiptsDir('/projects/myapp');
		expect(dir).toBe(path.join('/projects/myapp', '.swarm', 'review-receipts'));
	});
});

describe('resolveReceiptIndexPath', () => {
	it('returns .swarm/review-receipts/index.json under the given directory', () => {
		const p = resolveReceiptIndexPath('/projects/myapp');
		expect(p).toBe(
			path.join('/projects/myapp', '.swarm', 'review-receipts', 'index.json'),
		);
	});
});

// ============================================================================
// 10. Stale receipt invalidation by scope/hash mismatch (integration)
// ============================================================================

describe('Stale receipt invalidation end-to-end', () => {
	it('persisted approved receipt becomes stale when scope content changes', async () => {
		const originalContent = 'function foo() { return 1; }';
		const modifiedContent = 'function foo() { return 2; } // changed';

		const receipt = buildApprovedReceipt({
			agent: 'reviewer',
			scopeContent: originalContent,
			scopeDescription: 'file-content',
			checkedAspects: ['correctness'],
			validatedClaims: ['no side effects'],
		});
		await persistReviewReceipt(tmpDir, receipt);

		// Load receipt from disk
		const loaded = await readReceiptById(tmpDir, receipt.id);
		expect(loaded).not.toBeNull();

		// Check staleness: original → not stale
		expect(isScopeStale(loaded!, originalContent)).toBe(false);

		// Check staleness: modified → stale
		expect(isScopeStale(loaded!, modifiedContent)).toBe(true);
	});

	it('two rejected receipts for same scope both appear in readReceiptsByScopeHash', async () => {
		const content = 'problematic diff';
		const hash = sha256(content);

		const r1 = buildRejectedReceipt({
			agent: 'reviewer',
			scopeContent: content,
			scopeDescription: 'diff',
			blockingFindings: [
				{ location: 'x.ts', summary: 'bug 1', severity: 'high' },
			],
			evidenceReferences: [],
			passConditions: ['fix bug 1'],
		});
		const r2 = buildRejectedReceipt({
			agent: 'critic',
			scopeContent: content,
			scopeDescription: 'diff',
			blockingFindings: [
				{ location: 'y.ts', summary: 'bug 2', severity: 'medium' },
			],
			evidenceReferences: [],
			passConditions: ['fix bug 2'],
		});

		await persistReviewReceipt(tmpDir, r1);
		await persistReviewReceipt(tmpDir, r2);

		const results = await readReceiptsByScopeHash(tmpDir, hash);
		expect(results).toHaveLength(2);
	});
});
