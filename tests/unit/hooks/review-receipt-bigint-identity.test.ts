import { afterEach, describe, expect, test } from 'bun:test';
import type * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	buildApprovedReceipt,
	persistReviewReceipt,
	readReviewReceiptText,
} from '../../../src/hooks/review-receipt';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const originalLstatBigIntSync = _internals.lstatBigIntSync;
const originalFstatBigIntSync = _internals.fstatBigIntSync;

function withIdentity(
	base: fs.BigIntStats,
	dev: bigint,
	ino: bigint,
): fs.BigIntStats {
	return {
		...base,
		dev,
		ino,
		isDirectory: () => base.isDirectory(),
		isFile: () => base.isFile(),
		isSymbolicLink: () => base.isSymbolicLink(),
	} as fs.BigIntStats;
}

function approvedReceipt() {
	return buildApprovedReceipt({
		agent: 'reviewer',
		sessionId: 'receipt-bigint-identity',
		scopeContent: 'reviewed scope',
		scopeDescription: 'bigint-identity-test',
		checkedAspects: ['correctness'],
		validatedClaims: ['scope reviewed'],
		caveats: [],
	});
}

afterEach(() => {
	_internals.lstatBigIntSync = originalLstatBigIntSync;
	_internals.fstatBigIntSync = originalFstatBigIntSync;
});

describe('review receipt exact filesystem identities', () => {
	test('rejects directory replacement whose adjacent BigInt inode collides as Number', async () => {
		const project = createSafeTestDir('review-receipt-dir-bigint-');
		const leftInode = 9_007_199_254_740_992n;
		const rightInode = leftInode + 1n;
		expect(leftInode).not.toBe(rightInode);
		expect(Number(leftInode)).toBe(Number(rightInode));

		const projectPath = path.resolve(project.dir);
		const projectStats = originalLstatBigIntSync(projectPath);
		let projectIdentityReads = 0;
		_internals.lstatBigIntSync = ((candidate) => {
			const resolved = path.resolve(String(candidate));
			const actual = originalLstatBigIntSync(candidate);
			if (resolved !== projectPath) return actual;
			projectIdentityReads++;
			return withIdentity(
				projectStats,
				1n,
				projectIdentityReads === 1 ? leftInode : rightInode,
			);
		}) as typeof originalLstatBigIntSync;

		try {
			await expect(
				persistReviewReceipt(project.dir, approvedReceipt()),
			).rejects.toThrow(/changed during review receipt persistence/i);
			expect(projectIdentityReads).toBeGreaterThanOrEqual(2);
		} finally {
			project.cleanup();
		}
	});

	test('rejects receipt path-to-descriptor replacement whose adjacent BigInt inode collides as Number', async () => {
		const project = createSafeTestDir('review-receipt-file-bigint-');
		const leftInode = 9_007_199_254_740_992n;
		const rightInode = leftInode + 1n;
		expect(leftInode).not.toBe(rightInode);
		expect(Number(leftInode)).toBe(Number(rightInode));

		try {
			const receiptPath = await persistReviewReceipt(
				project.dir,
				approvedReceipt(),
			);
			const resolvedReceipt = path.resolve(receiptPath);
			const receiptStats = originalLstatBigIntSync(resolvedReceipt);
			let descriptorReads = 0;

			_internals.lstatBigIntSync = ((candidate) => {
				const actual = originalLstatBigIntSync(candidate);
				return path.resolve(String(candidate)) === resolvedReceipt
					? withIdentity(actual, 1n, leftInode)
					: actual;
			}) as typeof originalLstatBigIntSync;
			_internals.fstatBigIntSync = ((descriptor) => {
				descriptorReads++;
				return withIdentity(
					originalFstatBigIntSync(descriptor),
					1n,
					rightInode,
				);
			}) as typeof originalFstatBigIntSync;

			expect(readReviewReceiptText(project.dir, receiptPath)).toBeNull();
			expect(descriptorReads).toBe(1);
			expect(receiptStats.size).toBeGreaterThan(0n);
		} finally {
			project.cleanup();
		}
	});
});
