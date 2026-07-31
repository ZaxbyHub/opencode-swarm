import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import { MAX_EPHEMERAL_PROMPT_BYTE_LIMIT } from '../../../src/evaluation/ephemeral-agent-dispatcher';
import type {
	ReviewDispatchRequest,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import { runReviewEngine } from '../../../src/review/engine';
import { runFindingValidation } from '../../../src/review/finding-validator';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TARGET_SENTINEL = 'RANGE_ONLY_SENTINEL_1675';

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

function createRangeFixture(directory: string): {
	baseSha: string;
	targetSha: string;
} {
	git(directory, ['init']);
	git(directory, ['config', 'user.email', 'test@example.com']);
	git(directory, ['config', 'user.name', 'Review Test']);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'src', 'base.ts'),
		'export const base = true;\n',
		'utf8',
	);
	git(directory, ['add', '--', 'src/base.ts']);
	git(directory, ['commit', '-m', 'base']);
	const baseSha = git(directory, ['rev-parse', 'HEAD']);
	git(directory, ['branch', 'review-base', baseSha]);

	fs.writeFileSync(
		path.join(directory, 'src', 'range-only.ts'),
		`export const ${TARGET_SENTINEL} = true;\n`,
		'utf8',
	);
	git(directory, ['add', '--', 'src/range-only.ts']);
	git(directory, ['commit', '-m', 'target']);
	const targetSha = git(directory, ['rev-parse', 'HEAD']);
	git(directory, ['branch', 'review-target', targetSha]);
	git(directory, ['checkout', '--detach', baseSha]);
	return { baseSha, targetSha };
}

function reviewerOutput(): string {
	return [
		'VERDICT: REJECTED',
		'RISK: HIGH',
		'ISSUES: none',
		'```json',
		JSON.stringify({
			findings: [
				{
					title: 'Range-only regression',
					body: 'The selected target change introduces a concrete regression.',
					severity: 'high',
					confidence: 0.98,
					file: 'src/range-only.ts',
					line_start: 1,
					line_end: 1,
				},
			],
			verdict: 'REJECTED',
			overall_confidence: 0.98,
		}),
		'```',
	].join('\n');
}

function completedResult(
	request: ReviewDispatchRequest,
	text: string,
): {
	status: 'completed';
	agentName: string;
	text: string;
	durationMs: number;
	promptBytes: number;
	responseBytes: number;
} {
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
}

describe('finding validator — regression: exact arbitrary-range context (F-D2)', () => {
	test('validates a target-only finding against B while checkout remains at A', async () => {
		const fixture = createSafeTestDir('review-validator-range-');
		const range = createRangeFixture(fixture.dir);
		let validatorRequest: ReviewDispatchRequest | undefined;
		const dispatcher: ReviewModelDispatcher = {
			async dispatch(request) {
				if (request.agentName !== 'critic_finding_validator') {
					const text = reviewerOutput();
					return completedResult(request, text);
				}
				validatorRequest = request;
				const findingID = /"finding_id"\s*:\s*"([a-f0-9]{64})"/i.exec(
					request.prompt,
				)?.[1];
				if (!findingID) throw new Error('validator candidate ID missing');
				const text = [
					'```json',
					JSON.stringify({
						validations: [
							{
								finding_id: findingID,
								disposition: 'CONFIRMED',
								confidence: 0.99,
								evidence: 'The exact target diff adds the range-only sentinel.',
							},
						],
					}),
					'```',
				].join('\n');
				return completedResult(request, text);
			},
		};
		try {
			expect(
				fs.existsSync(path.join(fixture.dir, 'src', 'range-only.ts')),
			).toBe(false);
			const result = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'validator-range',
				trigger: 'manual',
				selector: {
					kind: 'range',
					from: 'review-base',
					to: 'review-target',
					operator: '..',
				},
				config: AutoReviewConfigSchema.parse({
					enabled: true,
					validate_findings: true,
				}),
				dispatcher,
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});

			const request = validatorRequest;
			if (!request) throw new Error('validator was not dispatched');
			const requestBytes =
				Buffer.byteLength(request.system, 'utf8') +
				Buffer.byteLength(request.prompt, 'utf8');
			expect(request.promptByteLimit).toBe(requestBytes);
			expect(requestBytes).toBeLessThanOrEqual(MAX_EPHEMERAL_PROMPT_BYTE_LIMIT);
			expect(request.prompt).toContain(
				'REVIEW_SELECTOR: {"kind":"range","from":"review-base","to":"review-target","operator":".."}',
			);
			expect(request.prompt).toContain(`RESOLVED_FROM_SHA: ${range.baseSha}`);
			expect(request.prompt).toContain(`RESOLVED_TO_SHA: ${range.targetSha}`);
			expect(request.prompt).toContain(`SCOPE_HASH: ${result.scopeHash}`);
			expect(request.prompt).toContain(TARGET_SENTINEL);
			expect(git(fixture.dir, ['rev-parse', 'HEAD'])).toBe(range.baseSha);
			expect(result.validationComplete).toBe(true);
			expect(result.findings[0]?.validation?.disposition).toBe('CONFIRMED');

			const evidence = JSON.parse(
				fs.readFileSync(result.evidencePath ?? '', 'utf8'),
			) as { scope: { range_to_sha?: string } };
			expect(evidence.scope.range_to_sha).toBe(range.targetSha);
		} finally {
			fixture.cleanup();
		}
	});

	test('fails closed instead of truncating exact diff evidence above the cap', async () => {
		let dispatches = 0;
		const result = await runFindingValidation({
			dispatcher: {
				async dispatch(request) {
					dispatches++;
					return completedResult(request, '{"validations":[]}');
				},
			},
			directory: path.join(os.tmpdir(), 'validator-context-cap'),
			agentName: 'critic_finding_validator',
			timeoutMs: 30_000,
			findings: [
				{
					title: 'Oversized context',
					body: 'This candidate requires exact reviewed evidence.',
					severity: 'high',
					confidence: 0.95,
					file: 'src/large.ts',
					line_start: 1,
					line_end: 1,
				},
			],
			scopeContext: {
				selector: { kind: 'working-tree' },
				canonicalText: 'x'.repeat(MAX_EPHEMERAL_PROMPT_BYTE_LIMIT),
				scopeHash: 'a'.repeat(64),
				headSha: 'b'.repeat(40),
				completeness: {
					complete: true,
					truncated: false,
					skipReasons: [],
				},
			},
		});

		expect(dispatches).toBe(0);
		expect(result.complete).toBe(false);
		expect(result.attempts).toEqual([]);
		expect(result.error).toContain('exact diff evidence was not truncated');
		expect(result.error).toContain(`${MAX_EPHEMERAL_PROMPT_BYTE_LIMIT}-byte`);
	});
});
