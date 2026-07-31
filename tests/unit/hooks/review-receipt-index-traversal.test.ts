import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildApprovedReceipt,
	persistReviewReceipt,
	readAllReceipts,
	readReceiptById,
	readReceiptsByScopeHash,
} from '../../../src/hooks/review-receipt';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/**
 * Regression coverage for the receipt-index read path (PRR-006).
 *
 * `index.json` is an editable manifest whose `filename` field was previously
 * trusted by readReceiptById / readReceiptsByScopeHash / readAllReceipts: a
 * poisoned entry like `../../outside/secret` would escape the receipts
 * directory when joined. These readers now route through the hardened
 * readReviewReceiptText, which asserts the resolved path stays directly inside
 * the receipts directory. A traversal entry must yield null / be skipped, never
 * read out-of-root content.
 */
function approvedReceipt(id: string, scopeContent: string) {
	return buildApprovedReceipt({
		agent: 'reviewer',
		sessionId: 'receipt-index-traversal',
		scopeContent,
		scopeDescription: 'index-traversal-test',
		checkedAspects: ['correctness'],
		validatedClaims: ['scope reviewed'],
		caveats: [],
	});
}

const OUTSIDE_SECRET = 'OUTSIDE_RECEIPT_TRAVERSAL_SENTINEL';

function poisonIndexFilename(
	directory: string,
	receiptId: string,
	traversalFilename: string,
): void {
	const indexPath = path.join(
		directory,
		'.swarm',
		'review-receipts',
		'index.json',
	);
	const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
		schema_version: number;
		entries: Array<{ id: string; filename: string }>;
	};
	for (const entry of index.entries) {
		if (entry.id === receiptId) entry.filename = traversalFilename;
	}
	fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}

describe('review receipt index traversal containment (PRR-006)', () => {
	test('readReceiptById returns null for a traversal filename and never reads outside .swarm', async () => {
		const project = createSafeTestDir('prr006-byid-project-');
		const outside = createSafeTestDir('prr006-byid-outside-');
		const secretPath = path.join(outside.dir, 'secret.json');
		fs.writeFileSync(
			secretPath,
			JSON.stringify({ exfil: OUTSIDE_SECRET }),
			'utf-8',
		);
		try {
			const receipt = approvedReceipt('traversal-by-id', 'scope-by-id');
			await persistReviewReceipt(project.dir, receipt);
			// Build a traversal filename relative to the receipts directory that
			// resolves to the out-of-root secret. Path segments differ by platform.
			const receiptsDir = path.join(project.dir, '.swarm', 'review-receipts');
			const relative = path.relative(receiptsDir, secretPath);
			poisonIndexFilename(project.dir, receipt.id, relative);

			const result = await readReceiptById(project.dir, receipt.id);
			expect(result).toBeNull();
		} finally {
			outside.cleanup();
			project.cleanup();
		}
	});

	test('readReceiptsByScopeHash skips a traversal entry without leaking content', async () => {
		const project = createSafeTestDir('prr006-scope-project-');
		const outside = createSafeTestDir('prr006-scope-outside-');
		const secretPath = path.join(outside.dir, 'leak.json');
		fs.writeFileSync(
			secretPath,
			JSON.stringify({ exfil: OUTSIDE_SECRET }),
			'utf-8',
		);
		try {
			const receipt = approvedReceipt('traversal-scope', 'scope-hash-content');
			await persistReviewReceipt(project.dir, receipt);
			const receiptsDir = path.join(project.dir, '.swarm', 'review-receipts');
			const relative = path.relative(receiptsDir, secretPath);
			poisonIndexFilename(project.dir, receipt.id, relative);

			const results = await readReceiptsByScopeHash(
				project.dir,
				receipt.scope_fingerprint.hash,
			);
			expect(results).toEqual([]);
		} finally {
			outside.cleanup();
			project.cleanup();
		}
	});

	test('readAllReceipts skips a traversal entry without leaking content', async () => {
		const project = createSafeTestDir('prr006-all-project-');
		const outside = createSafeTestDir('prr006-all-outside-');
		const secretPath = path.join(outside.dir, 'all-leak.json');
		fs.writeFileSync(
			secretPath,
			JSON.stringify({ exfil: OUTSIDE_SECRET }),
			'utf-8',
		);
		try {
			const receipt = approvedReceipt('traversal-all', 'scope-all');
			await persistReviewReceipt(project.dir, receipt);
			const receiptsDir = path.join(project.dir, '.swarm', 'review-receipts');
			const relative = path.relative(receiptsDir, secretPath);
			poisonIndexFilename(project.dir, receipt.id, relative);

			const results = await readAllReceipts(project.dir);
			expect(results.some((r) => r === null)).toBe(false);
			expect(results).toEqual([]);
		} finally {
			outside.cleanup();
			project.cleanup();
		}
	});

	test('a well-formed index entry still reads back after the hardening change', async () => {
		const project = createSafeTestDir('prr006-legit-project-');
		try {
			const receipt = approvedReceipt('legit-id', 'legit-scope');
			await persistReviewReceipt(project.dir, receipt);
			const byId = await readReceiptById(project.dir, receipt.id);
			expect(byId).not.toBeNull();
			expect(byId?.id).toBe(receipt.id);
			const byScope = await readReceiptsByScopeHash(
				project.dir,
				receipt.scope_fingerprint.hash,
			);
			expect(byScope).toHaveLength(1);
			expect(byScope[0]?.id).toBe(receipt.id);
			const all = await readAllReceipts(project.dir);
			expect(all).toHaveLength(1);
			expect(all[0]?.id).toBe(receipt.id);
		} finally {
			project.cleanup();
		}
	});
});
