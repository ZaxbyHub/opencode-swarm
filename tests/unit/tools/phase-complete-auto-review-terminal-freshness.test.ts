import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type AutoReviewConfig,
	AutoReviewConfigSchema,
	type PluginConfig,
} from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import type { ReviewEngineResult } from '../../../src/review/engine';
import { runReviewEngine } from '../../../src/review/engine';
import { runFinalReviewGate } from '../../../src/tools/phase-complete/gates/final-review-gate';
import type { GateContext } from '../../../src/tools/phase-complete/gates/types';
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
	return file;
}

function gateConfig(): AutoReviewConfig {
	return AutoReviewConfigSchema.parse({
		enabled: true,
		trigger: 'phase_boundary',
		final_review: { mode: 'gate', on_phase_complete: true },
	});
}

function gateContext(
	directory: string,
	config: AutoReviewConfig,
	result: ReviewEngineResult,
): GateContext {
	return {
		phase: 1,
		dir: directory,
		sessionID: 'terminal-freshness',
		pluginConfig: { auto_review: config } as PluginConfig,
		agentsDispatched: [],
		safeWarn: () => {},
		autoReviewTrigger: 'phase_completion',
		autoReviewScopeHash: result.scopeHash,
		autoReviewScopeComplete: result.scopeComplete,
		autoReviewBlocked: result.blocked,
		autoReviewBlockReason: result.blockReason,
	};
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

function dispatcherWithCounter(counter: {
	calls: number;
}): ReviewModelDispatcher {
	return {
		async dispatch(request) {
			counter.calls++;
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
}

describe('phase final-review gate — regression: terminal scope freshness (F-D3)', () => {
	test('rejects clean evidence that becomes dirty before gate execution', async () => {
		const fixture = createSafeTestDir('terminal-review-clean-');
		const file = initializeRepository(fixture.dir);
		const config = gateConfig();
		const counter = { calls: 0 };
		try {
			const engineResult = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'terminal-freshness',
				trigger: 'phase_completion',
				phase: 1,
				config,
				dispatcher: dispatcherWithCounter(counter),
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});
			expect(engineResult.status).toBe('clean');
			expect(engineResult.blocked).toBe(false);
			expect(counter.calls).toBe(0);
			const freshGate = await runFinalReviewGate(
				gateContext(fixture.dir, config, engineResult),
			);
			expect(freshGate.blocked).toBe(false);

			// Prior behavior trusted the engine-returned clean hash and reached the
			// gate without observing this post-engine repository mutation.
			fs.writeFileSync(
				file,
				'export const state = "dirty-after-clean";\n',
				'utf8',
			);
			const gate = await runFinalReviewGate(
				gateContext(fixture.dir, config, engineResult),
			);

			expect(gate.blocked).toBe(true);
			expect(gate.reason).toBe('FINAL_REVIEW_EVIDENCE_STALE');
			expect(gate.message).toContain('repository scope changed');
			expect(counter.calls).toBe(0);
		} finally {
			fixture.cleanup();
		}
	});

	test('rejects completed evidence mutated after engine return', async () => {
		const fixture = createSafeTestDir('terminal-review-completed-');
		const file = initializeRepository(fixture.dir);
		const config = gateConfig();
		const counter = { calls: 0 };
		fs.writeFileSync(file, 'export const state = "reviewed";\n', 'utf8');
		try {
			const engineResult = await runReviewEngine({
				directory: fixture.dir,
				sessionID: 'terminal-freshness',
				trigger: 'phase_completion',
				phase: 1,
				config,
				dispatcher: dispatcherWithCounter(counter),
				reviewerAgent: 'reviewer',
				validatorAgent: 'critic_finding_validator',
			});
			expect(engineResult.status).toBe('completed');
			expect(engineResult.blocked).toBe(false);
			expect(counter.calls).toBe(1);
			const freshGate = await runFinalReviewGate(
				gateContext(fixture.dir, config, engineResult),
			);
			expect(freshGate.blocked).toBe(false);

			fs.writeFileSync(
				file,
				'export const state = "mutated-after-engine";\n',
				'utf8',
			);
			const gate = await runFinalReviewGate(
				gateContext(fixture.dir, config, engineResult),
			);

			expect(gate.blocked).toBe(true);
			expect(gate.reason).toBe('FINAL_REVIEW_EVIDENCE_STALE');
			expect(counter.calls).toBe(1);
		} finally {
			fixture.cleanup();
		}
	});
});
