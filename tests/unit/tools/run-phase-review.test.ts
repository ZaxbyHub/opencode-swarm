import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReviewModelDispatcher } from '../../../src/review/contracts.js';
import {
	_internals,
	createRunPhaseReviewTool,
	executeRunPhaseReview,
} from '../../../src/tools/run-phase-review.js';
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

function setupPhaseReviewFixture(directory: string): void {
	git(directory, ['init', '-b', 'main']);
	git(directory, ['config', 'user.email', 'phase-review@example.invalid']);
	git(directory, ['config', 'user.name', 'Phase Review']);
	fs.appendFileSync(
		path.join(directory, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
		'utf8',
	);
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'src', 'state.ts'),
		'export const state = "base";\n',
	);
	git(directory, ['add', '--', 'src/state.ts']);
	git(directory, ['commit', '-m', 'base']);
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			auto_review: {
				enabled: true,
				trigger: 'phase_boundary',
				final_review: {
					mode: 'gate',
					on_phase_complete: true,
					on_plan_complete: true,
				},
			},
		}),
		'utf8',
	);
	fs.writeFileSync(
		path.join(directory, 'src', 'state.ts'),
		'export const state = "review me";\n',
		'utf8',
	);
}

function approvalDispatcher(): ReviewModelDispatcher {
	return {
		async dispatch(request) {
			const text = [
				'VERDICT: APPROVED',
				'RISK: LOW',
				'ISSUES: none',
				'```json',
				'{"findings":[],"verdict":"APPROVED","overall_confidence":0.99}',
				'```',
			].join('\n');
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
}

describe('run_phase_review tool', () => {
	const originalLoadPluginConfigWithMeta = _internals.loadPluginConfigWithMeta;

	beforeEach(() => {
		_internals.loadPluginConfigWithMeta = originalLoadPluginConfigWithMeta;
	});

	afterEach(() => {
		_internals.loadPluginConfigWithMeta = originalLoadPluginConfigWithMeta;
	});

	test('executeRunPhaseReview persists evidence and returns the final manifest identity', async () => {
		const fixture = createSafeTestDir('run-phase-review-');
		try {
			setupPhaseReviewFixture(fixture.dir);
			const result = await executeRunPhaseReview(
				fixture.dir,
				{ phase: 1, sessionID: 'phase-review-session' },
				{
					dispatcher: approvalDispatcher(),
					generatedAgentNames: ['reviewer', 'critic_finding_validator'],
				},
			);

			expect(result.success).toBe(true);
			expect(result.trigger).toBe('phase_completion');
			expect(result.status).toBe('completed');
			expect(result.blocked).toBe(false);
			expect(result.scopeHash).toMatch(/^[a-f0-9]{64}$/);
			expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
			expect(result.evidencePath).toBeDefined();
			expect(fs.existsSync(result.evidencePath ?? '')).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});

	test('tool wrapper uses the injected workspace directory and returns JSON', async () => {
		const fixture = createSafeTestDir('run-phase-review-tool-');
		try {
			setupPhaseReviewFixture(fixture.dir);
			const tool = createRunPhaseReviewTool(approvalDispatcher(), [
				'reviewer',
				'critic_finding_validator',
			]);
			const raw = await tool.execute?.(
				{ phase: 1, sessionID: 'tool-session' },
				{ directory: fixture.dir, sessionID: 'tool-session' } as never,
			);
			const parsed = JSON.parse(String(raw)) as {
				success: boolean;
				manifestHash?: string;
				evidencePath?: string;
			};
			expect(parsed.success).toBe(true);
			expect(parsed.manifestHash).toMatch(/^[a-f0-9]{64}$/);
			expect(fs.existsSync(parsed.evidencePath ?? '')).toBe(true);
		} finally {
			fixture.cleanup();
		}
	});
});
