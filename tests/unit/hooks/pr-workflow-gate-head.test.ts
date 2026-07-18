import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	bindPrWorkflowHead,
} from '../../../src/hooks/pr-workflow-gate.js';

const HEAD_SHA = 'abcdef1234567890';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-head-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveIsWorkingTreeClean = () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('PR workflow exact checkout head', () => {
	test('fails closed when HEAD is unavailable or differs from the claimed PR head', async () => {
		await activatePrWorkflow(directory, 'review-head', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => null;
		await expect(
			bindPrWorkflowHead(directory, 'review-head', HEAD_SHA),
		).rejects.toThrow('cannot verify the current Git HEAD');

		_test_exports.resolveCurrentGitHead = () => 'different-head';
		await expect(
			bindPrWorkflowHead(directory, 'review-head', HEAD_SHA),
		).rejects.toThrow('does not match PR head');
	});

	test('revalidates live HEAD throughout PR review after binding', async () => {
		await activatePrWorkflow(directory, 'review-drift', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA.toUpperCase();
		await bindPrWorkflowHead(directory, 'review-drift', HEAD_SHA);

		_test_exports.resolveCurrentGitHead = () => 'later-checkout';
		await expect(
			assertPrReviewBaseCoverageSettled(directory, 'review-drift'),
		).rejects.toThrow('does not match PR head');
	});

	test('fails closed when the exact PR checkout is dirty or cleanliness is unknown', async () => {
		await activatePrWorkflow(directory, 'review-dirty', 'PR_REVIEW');
		_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
		for (const cleanliness of [false, null]) {
			_test_exports.resolveIsWorkingTreeClean = () => cleanliness;
			await expect(
				bindPrWorkflowHead(directory, 'review-dirty', HEAD_SHA),
			).rejects.toThrow('clean index and working tree');
		}
	});
});
