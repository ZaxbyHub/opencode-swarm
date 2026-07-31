import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import { collectReviewDiff } from '../../../src/review/diff-source';
import { runReviewEngine } from '../../../src/review/engine';

const fixtures: string[] = [];

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

function writeFile(
	directory: string,
	relativePath: string,
	content: string,
): void {
	const target = path.join(directory, ...relativePath.split('/'));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, 'utf8');
}

function finding(file: string, title: string, line = 1) {
	return {
		title,
		body: `${title} has a concrete target-tree impact.`,
		severity: 'high',
		confidence: 0.95,
		file,
		line_start: line,
		line_end: line,
	};
}

function reviewerOutput(): string {
	return [
		'VERDICT: REJECTED',
		'RISK: HIGH',
		'ISSUES: none',
		'```json',
		JSON.stringify({
			findings: [
				finding('src/target-only.ts', 'Target-only addition'),
				finding('src/new-name.ts', 'Target-side rename', 2),
				finding('src/deleted.ts', 'Deleted path'),
				finding('src/old-name.ts', 'Old rename path', 2),
			],
			verdict: 'REJECTED',
			overall_confidence: 0.95,
		}),
		'```',
	].join('\n');
}

function dispatcher(
	output: string,
	onDispatch?: (prompt: string) => void,
): ReviewModelDispatcher {
	return {
		async dispatch(request) {
			onDispatch?.(request.prompt);
			return {
				status: 'completed',
				agentName: request.agentName,
				text: output,
				durationMs: 1,
				promptBytes: Buffer.byteLength(request.prompt, 'utf8'),
				responseBytes: Buffer.byteLength(output, 'utf8'),
			};
		},
	};
}

function createRangeFixture(): {
	directory: string;
	baseSha: string;
	targetSha: string;
} {
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'review-range-anchor-')),
	);
	fixtures.push(directory);
	git(directory, ['init']);
	git(directory, ['config', 'user.email', 'test@example.com']);
	git(directory, ['config', 'user.name', 'Review Test']);

	writeFile(directory, 'src/existing.ts', 'export const state = "base";\n');
	writeFile(
		directory,
		'src/old-name.ts',
		[
			'export const stableBefore = true;',
			'export const renamed = "base";',
			'export const stableAfter = true;',
			'',
		].join('\n'),
	);
	writeFile(directory, 'src/deleted.ts', 'export const deleted = "base";\n');
	git(directory, ['add', '--', 'src']);
	git(directory, ['commit', '-m', 'base']);
	const baseSha = git(directory, ['rev-parse', 'HEAD']);

	writeFile(directory, 'src/existing.ts', 'export const state = "target";\n');
	writeFile(
		directory,
		'src/target-only.ts',
		'export const added = "target";\n',
	);
	git(directory, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
	writeFile(
		directory,
		'src/new-name.ts',
		[
			'export const stableBefore = true;',
			'export const renamed = "target";',
			'export const stableAfter = true;',
			'',
		].join('\n'),
	);
	fs.unlinkSync(path.join(directory, 'src', 'deleted.ts'));
	git(directory, ['add', '--', 'src']);
	git(directory, ['commit', '-m', 'target']);
	const targetSha = git(directory, ['rev-parse', 'HEAD']);

	// The review target is no longer checked out: target-only and renamed paths
	// are absent while deleted and old rename paths exist in the working tree.
	git(directory, ['checkout', '--detach', baseSha]);
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	return { directory, baseSha, targetSha };
}

afterEach(() => {
	for (const directory of fixtures.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('exact committed-range finding anchoring', () => {
	test('anchors target-tree additions and identifies the detached review target in the prompt', async () => {
		const fixture = createRangeFixture();
		expect(
			fs.existsSync(path.join(fixture.directory, 'src', 'target-only.ts')),
		).toBe(false);
		expect(
			fs.existsSync(path.join(fixture.directory, 'src', 'new-name.ts')),
		).toBe(false);
		const selector = {
			kind: 'range' as const,
			from: fixture.baseSha,
			to: fixture.targetSha,
			operator: '..' as const,
		};
		const collected = await collectReviewDiff({
			directory: fixture.directory,
			selector,
		});
		expect(collected.status).toBe('ok');
		if (collected.status !== 'ok') throw new Error(collected.reason);
		expect(collected.files.get('src/new-name.ts')).toMatchObject({
			kind: 'renamed',
			oldPath: 'src/old-name.ts',
			newPath: 'src/new-name.ts',
		});
		expect(collected.changedLines.get('src/new-name.ts')).toEqual([
			{ start: 2, end: 2 },
		]);

		let reviewerPrompt = '';
		const result = await runReviewEngine({
			directory: fixture.directory,
			sessionID: 'range-session',
			trigger: 'manual',
			selector,
			config: AutoReviewConfigSchema.parse({ enabled: true }),
			dispatcher: dispatcher(reviewerOutput(), (prompt) => {
				reviewerPrompt = prompt;
			}),
			reviewerAgent: 'reviewer',
			validatorAgent: 'critic_finding_validator',
		});
		const byFile = new Map(result.findings.map((item) => [item.file, item]));

		// Regression: the prior reviewer prompt omitted the selector and target SHA,
		// exposing only checkout HEAD (A) while the exact reviewed target was B.
		expect(reviewerPrompt).toContain(
			`REVIEW_SELECTOR: ${JSON.stringify(selector)}`,
		);
		expect(reviewerPrompt).toContain(`SCOPE_HASH: ${collected.scopeHash}`);
		expect(reviewerPrompt).toContain(`CHECKOUT_HEAD_SHA: ${fixture.baseSha}`);
		expect(reviewerPrompt).toContain(`RESOLVED_FROM_SHA: ${fixture.baseSha}`);
		expect(reviewerPrompt).toContain(`RESOLVED_TO_SHA: ${fixture.targetSha}`);
		expect(reviewerPrompt).toContain(`REVIEW_TARGET_SHA: ${fixture.targetSha}`);
		expect(reviewerPrompt).toContain('CHECKOUT_MATCHES_REVIEW_TARGET: false');
		expect(reviewerPrompt).toContain(
			'REVIEW_SCOPE_INCLUDES_WORKING_TREE: false',
		);
		expect(reviewerPrompt).toContain(
			'diff --git a/src/target-only.ts b/src/target-only.ts',
		);
		expect(reviewerPrompt).toContain('export const added = "target";');
		expect(reviewerPrompt).not.toContain('\nHEAD_SHA:');
		expect(git(fixture.directory, ['rev-parse', 'HEAD'])).toBe(fixture.baseSha);

		expect(result.status).toBe('completed');
		expect(byFile.get('src/target-only.ts')).toMatchObject({
			anchored: true,
			anchor_rejection: undefined,
		});
		expect(byFile.get('src/new-name.ts')).toMatchObject({
			anchored: true,
			anchor_rejection: undefined,
		});
		expect(byFile.get('src/deleted.ts')).toMatchObject({
			anchored: false,
			anchor_rejection: 'line_range_does_not_overlap_diff',
		});
		expect(byFile.get('src/old-name.ts')).toMatchObject({
			anchored: false,
			anchor_rejection: 'line_range_does_not_overlap_diff',
		});
	});
});
