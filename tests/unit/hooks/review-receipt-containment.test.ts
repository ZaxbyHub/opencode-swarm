import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildApprovedReceipt,
	persistReviewReceipt,
	removeReviewReceipt,
} from '../../../src/hooks/review-receipt';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function approvedReceipt() {
	return buildApprovedReceipt({
		agent: 'reviewer',
		sessionId: 'receipt-containment',
		scopeContent: 'reviewed scope',
		scopeDescription: 'containment-test',
		checkedAspects: ['correctness'],
		validatedClaims: ['scope reviewed'],
		caveats: [],
	});
}

function linkDirectory(target: string, link: string): void {
	fs.symlinkSync(
		target,
		link,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
}

describe('review receipt persistence containment', () => {
	test('rejects a project root reached through a junction or symlink', async () => {
		const project = createSafeTestDir('review-root-target-');
		const links = createSafeTestDir('review-root-link-');
		const linkedProject = path.join(links.dir, 'linked-project');
		linkDirectory(project.dir, linkedProject);
		try {
			await expect(
				persistReviewReceipt(linkedProject, approvedReceipt()),
			).rejects.toThrow(/real directory|symlink|junction/i);
			expect(fs.readdirSync(project.dir)).toEqual([]);
		} finally {
			links.cleanup();
			project.cleanup();
		}
	});

	test('rejects a .swarm junction or directory symlink', async () => {
		const project = createSafeTestDir('review-swarm-project-');
		const outside = createSafeTestDir('review-swarm-outside-');
		const swarm = path.join(project.dir, '.swarm');
		linkDirectory(outside.dir, swarm);
		try {
			await expect(
				persistReviewReceipt(project.dir, approvedReceipt()),
			).rejects.toThrow(/real directory|symlink|junction/i);
			expect(fs.readdirSync(outside.dir)).toEqual([]);
		} finally {
			project.cleanup();
			outside.cleanup();
		}
	});

	test('rejects a review-receipts junction or directory symlink', async () => {
		const project = createSafeTestDir('review-receipt-project-');
		const outside = createSafeTestDir('review-receipt-outside-');
		const swarm = path.join(project.dir, '.swarm');
		const receipts = path.join(swarm, 'review-receipts');
		fs.mkdirSync(swarm);
		linkDirectory(outside.dir, receipts);
		try {
			await expect(
				persistReviewReceipt(project.dir, approvedReceipt()),
			).rejects.toThrow(/real directory|symlink|junction/i);
			expect(fs.readdirSync(outside.dir)).toEqual([]);
		} finally {
			project.cleanup();
			outside.cleanup();
		}
	});

	test('cleans temporary receipt state when final scope verification is stale', async () => {
		const project = createSafeTestDir('review-receipt-stale-');
		try {
			await expect(
				persistReviewReceipt(project.dir, approvedReceipt(), {
					verifyCurrent: async () => false,
				}),
			).rejects.toMatchObject({ code: 'REVIEW_SCOPE_STALE' });
			const receipts = path.join(project.dir, '.swarm', 'review-receipts');
			expect(fs.readdirSync(receipts)).toEqual([]);
		} finally {
			project.cleanup();
		}
	});

	test('detects an ancestor swap immediately before receipt commit', async () => {
		const project = createSafeTestDir('review-receipt-swap-project-');
		const outside = createSafeTestDir('review-receipt-swap-outside-');
		const receipts = path.join(project.dir, '.swarm', 'review-receipts');
		const movedReceipts = path.join(project.dir, 'moved-review-receipts');
		try {
			await expect(
				persistReviewReceipt(project.dir, approvedReceipt(), {
					verifyCurrent: async () => {
						fs.renameSync(receipts, movedReceipts);
						linkDirectory(outside.dir, receipts);
						return true;
					},
				}),
			).rejects.toThrow(/changed|real directory|symlink|junction/i);
			expect(fs.readdirSync(outside.dir)).toEqual([]);
		} finally {
			project.cleanup();
			outside.cleanup();
		}
	});

	test('detects an ancestor swap immediately before index commit', async () => {
		const project = createSafeTestDir('review-index-swap-project-');
		const outside = createSafeTestDir('review-index-swap-outside-');
		const receipts = path.join(project.dir, '.swarm', 'review-receipts');
		const movedReceipts = path.join(project.dir, 'moved-index-receipts');
		let verifications = 0;
		try {
			await expect(
				persistReviewReceipt(project.dir, approvedReceipt(), {
					verifyCurrent: async () => {
						verifications++;
						if (verifications === 2) {
							fs.renameSync(receipts, movedReceipts);
							linkDirectory(outside.dir, receipts);
						}
						return true;
					},
				}),
			).rejects.toThrow(/changed|real directory|symlink|junction/i);
			expect(verifications).toBe(2);
			expect(fs.readdirSync(outside.dir)).toEqual([]);
		} finally {
			project.cleanup();
			outside.cleanup();
		}
	});

	test('cleanup refuses to follow a swapped review-receipts ancestor', async () => {
		const project = createSafeTestDir('review-cleanup-swap-project-');
		const outside = createSafeTestDir('review-cleanup-swap-outside-');
		const receipt = approvedReceipt();
		const receiptPath = await persistReviewReceipt(project.dir, receipt);
		const receipts = path.dirname(receiptPath);
		const movedReceipts = path.join(project.dir, 'moved-cleanup-receipts');
		fs.renameSync(receipts, movedReceipts);
		linkDirectory(outside.dir, receipts);
		try {
			await expect(
				removeReviewReceipt(project.dir, receiptPath, receipt.id),
			).rejects.toThrow(/real directory|symlink|junction/i);
			expect(fs.readdirSync(outside.dir)).toEqual([]);
			expect(
				fs.existsSync(path.join(movedReceipts, path.basename(receiptPath))),
			).toBe(true);
		} finally {
			project.cleanup();
			outside.cleanup();
		}
	});
});
