import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import { collectReviewDiff } from '../../../src/review/diff-source';
import {
	_internals as engineInternals,
	runReviewEngine,
} from '../../../src/review/engine';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`,
		);
	}
	return result.stdout.trim();
}

function initializeRepository(directory: string): string {
	git(directory, ['init']);
	git(directory, ['config', 'user.email', 'test@example.com']);
	git(directory, ['config', 'user.name', 'Review Test']);
	fs.appendFileSync(
		path.join(directory, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
		'utf8',
	);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	const file = path.join(directory, 'src', 'state.ts');
	fs.writeFileSync(file, 'export const state = "base";\n', 'utf8');
	git(directory, ['add', '--', 'src/state.ts']);
	git(directory, ['commit', '-m', 'base']);
	fs.writeFileSync(file, 'export const state = "reviewed";\n', 'utf8');
	return file;
}

function structuredApproval(): string {
	return [
		'VERDICT: APPROVED',
		'RISK: LOW',
		'ISSUES: none',
		'```json',
		'{"findings":[],"verdict":"APPROVED","overall_confidence":0.99}',
		'```',
	].join('\n');
}

const realPersistReceipt = engineInternals.persistReceipt;
const realPersistEvidence = engineInternals.persistEvidence;

afterEach(() => {
	engineInternals.persistReceipt = realPersistReceipt;
	engineInternals.persistEvidence = realPersistEvidence;
});

function approvalDispatcher(): ReviewModelDispatcher {
	return {
		async dispatch(request) {
			const text = structuredApproval();
			return {
				status: 'completed',
				agentName: request.agentName,
				text,
				durationMs: 1,
				promptBytes: 1,
				responseBytes: Buffer.byteLength(text, 'utf8'),
			};
		},
	};
}

function receiptArtifacts(directory: string): {
	receipts: string[];
	indexEntries: unknown[];
} {
	const receiptsDir = path.join(directory, '.swarm', 'review-receipts');
	if (!fs.existsSync(receiptsDir)) return { receipts: [], indexEntries: [] };
	const receipts = fs
		.readdirSync(receiptsDir)
		.filter((name) => name.endsWith('.json') && name !== 'index.json');
	const indexPath = path.join(receiptsDir, 'index.json');
	const indexEntries = fs.existsSync(indexPath)
		? (JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { entries: unknown[] })
				.entries
		: [];
	return { receipts, indexEntries };
}

async function runWithDispatchMutation(mode: 'advisory' | 'gate') {
	const fixture = createSafeTestDir(`review-freshness-${mode}-`);
	const file = initializeRepository(fixture.dir);
	const advisories: string[] = [];
	let reviewerCalls = 0;
	const dispatcher: ReviewModelDispatcher = {
		async dispatch(request) {
			reviewerCalls++;
			// Prior behavior accepted the pre-dispatch scope after this external
			// mutation and persisted a reusable approval receipt for stale content.
			fs.writeFileSync(file, 'export const state = "mutated";\n', 'utf8');
			const text = structuredApproval();
			return {
				status: 'completed',
				agentName: request.agentName,
				text,
				durationMs: 1,
				promptBytes:
					Buffer.byteLength(request.system, 'utf8') +
					Buffer.byteLength(request.prompt, 'utf8'),
				responseBytes: Buffer.byteLength(text, 'utf8'),
			};
		},
	};
	try {
		const result = await runReviewEngine({
			directory: fixture.dir,
			sessionID: `freshness-${mode}`,
			trigger: 'phase_completion',
			phase: 1,
			selector: { kind: 'working-tree' },
			config: AutoReviewConfigSchema.parse({
				enabled: true,
				final_review: { mode },
			}),
			dispatcher,
			reviewerAgent: 'reviewer',
			validatorAgent: 'critic_finding_validator',
			injectAdvisory: (_sessionID, message) => advisories.push(message),
		});
		const current = await collectReviewDiff({
			directory: fixture.dir,
			selector: { kind: 'working-tree' },
		});
		if (current.status === 'error') throw new Error(current.reason);
		return {
			result,
			current,
			advisories,
			reviewerCalls,
			cleanup: fixture.cleanup,
		};
	} catch (error) {
		fixture.cleanup();
		throw error;
	}
}

describe('review engine — regression: dispatch-time scope mutation (F-D1)', () => {
	test('gate mode fails closed and binds error evidence to the current scope', async () => {
		const run = await runWithDispatchMutation('gate');
		try {
			expect(run.reviewerCalls).toBe(1);
			expect(run.result.status).toBe('error');
			expect(run.result.blocked).toBe(true);
			expect(run.result.blockReason).toBe('REVIEW_SCOPE_STALE');
			expect(run.result.receiptPath).toBeUndefined();
			expect(run.result.findings).toEqual([]);
			expect(run.result.scopeHash).toBe(run.current.scopeHash);
			expect(run.advisories.join('\n')).toContain(
				'changed during model dispatch',
			);
			expect(run.advisories.join('\n')).toContain('no current coverage');

			const evidence = JSON.parse(
				fs.readFileSync(run.result.evidencePath ?? '', 'utf8'),
			) as {
				scope: { hash: string };
				review: { status: string; error?: string };
			};
			expect(evidence.scope.hash).toBe(run.current.scopeHash);
			expect(evidence.review.status).toBe('error');
			expect(evidence.review.error).toContain('no current coverage');
		} finally {
			run.cleanup();
		}
	});

	test('advisory mode discards stale findings without claiming coverage', async () => {
		const run = await runWithDispatchMutation('advisory');
		try {
			expect(run.result.status).toBe('error');
			expect(run.result.blocked).toBe(false);
			expect(run.result.blockReason).toBeUndefined();
			expect(run.result.receiptPath).toBeUndefined();
			expect(run.result.scopeHash).toBe(run.current.scopeHash);
			expect(run.result.message).toContain('no current coverage');
			expect(run.advisories).toHaveLength(1);
			expect(run.advisories[0]).not.toContain('No findings reported');
		} finally {
			run.cleanup();
		}
	});
});

describe('review engine - final persistence freshness boundary', () => {
	test('rejects a reviewed-scope mutation at receipt persistence', async () => {
		const fixture = createSafeTestDir('review-receipt-commit-race-');
		const file = initializeRepository(fixture.dir);
		engineInternals.persistReceipt = async (...args) => {
			fs.writeFileSync(file, 'export const state = "receipt-race";\n');
			return realPersistReceipt(...args);
		};
		try {
			const result = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'receipt-commit-race',
				trigger: 'phase_completion',
				phase: 1,
				selector: { kind: 'working-tree' },
				config: AutoReviewConfigSchema.parse({
					enabled: true,
					final_review: { mode: 'gate' },
				}),
				dispatcher: approvalDispatcher(),
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});
			const current = await collectReviewDiff({
				directory: fixture.dir,
				selector: { kind: 'working-tree' },
			});
			if (current.status === 'error') throw new Error(current.reason);
			expect(result.status).toBe('error');
			expect(result.blockReason).toBe('REVIEW_SCOPE_STALE');
			expect(result.scopeHash).toBe(current.scopeHash);
			expect(result.receiptPath).toBeUndefined();
			expect(result.evidencePath).toBeUndefined();
			expect(receiptArtifacts(fixture.dir)).toEqual({
				receipts: [],
				indexEntries: [],
			});
			expect(
				fs.existsSync(
					path.join(fixture.dir, '.swarm', 'evidence', '1', 'auto-review.json'),
				),
			).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	test('removes receipt and index entry when scope changes at evidence commit', async () => {
		const fixture = createSafeTestDir('review-evidence-commit-race-');
		const file = initializeRepository(fixture.dir);
		engineInternals.persistEvidence = async (...args) => {
			fs.writeFileSync(file, 'export const state = "evidence-race";\n');
			return realPersistEvidence(...args);
		};
		try {
			const result = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'evidence-commit-race',
				trigger: 'phase_completion',
				phase: 1,
				selector: { kind: 'working-tree' },
				config: AutoReviewConfigSchema.parse({
					enabled: true,
					final_review: { mode: 'gate' },
				}),
				dispatcher: approvalDispatcher(),
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});
			expect(result.status).toBe('error');
			expect(result.blockReason).toBe('REVIEW_SCOPE_STALE');
			expect(result.receiptPath).toBeUndefined();
			expect(result.evidencePath).toBeUndefined();
			expect(receiptArtifacts(fixture.dir)).toEqual({
				receipts: [],
				indexEntries: [],
			});
			expect(
				fs.existsSync(
					path.join(fixture.dir, '.swarm', 'evidence', '1', 'auto-review.json'),
				),
			).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	test('rejects a clean-scope mutation at evidence persistence', async () => {
		const fixture = createSafeTestDir('review-clean-commit-race-');
		const file = initializeRepository(fixture.dir);
		git(fixture.dir, ['checkout', '--', 'src/state.ts']);
		engineInternals.persistEvidence = async (...args) => {
			fs.writeFileSync(file, 'export const state = "clean-race";\n');
			return realPersistEvidence(...args);
		};
		try {
			const result = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'clean-commit-race',
				trigger: 'phase_completion',
				phase: 1,
				selector: { kind: 'working-tree' },
				config: AutoReviewConfigSchema.parse({
					enabled: true,
					final_review: { mode: 'gate' },
				}),
				dispatcher: approvalDispatcher(),
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});
			const current = await collectReviewDiff({
				directory: fixture.dir,
				selector: { kind: 'working-tree' },
			});
			if (current.status === 'error') throw new Error(current.reason);
			expect(result.status).toBe('error');
			expect(result.blockReason).toBe('REVIEW_SCOPE_STALE');
			expect(result.scopeHash).toBe(current.scopeHash);
			expect(result.evidencePath).toBeUndefined();
			expect(
				fs.existsSync(
					path.join(fixture.dir, '.swarm', 'evidence', '1', 'auto-review.json'),
				),
			).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});
});
