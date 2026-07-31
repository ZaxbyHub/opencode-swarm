import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_REGISTRY } from '../../../src/commands/registry';
import { ALL_AGENT_NAMES } from '../../../src/config/constants';
import {
	AUTO_REVIEW_V8_BURN_IN_DECISION,
	type PluginConfig,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import { runFinalReviewGate } from '../../../src/tools/phase-complete/gates';
import { buildPluginToolObject } from '../../../src/tools/plugin-registration';

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

function read(relativePath: string): string {
	return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('auto-review cross-surface contract', () => {
	test('keeps config, agent, command, runtime factories, docs, and release wired', () => {
		const config = resolveAutoReviewConfig({ enabled: true });
		expect(config).toMatchObject({
			enabled: true,
			trigger: 'phase_boundary',
			min_confidence: 0.7,
			structured_findings: true,
			validate_findings: false,
			final_review: { mode: 'advisory' },
		});
		expect(ALL_AGENT_NAMES).toContain('critic_finding_validator');
		expect(COMMAND_REGISTRY.review.toolPolicy).toBe('human-only');
		expect(COMMAND_REGISTRY.review.args).toContain('--working-tree');
		expect(typeof runFinalReviewGate).toBe('function');

		const dispatcher: ReviewModelDispatcher = {
			async dispatch() {
				throw new Error('contract test does not execute the runtime');
			},
		};
		const tools = buildPluginToolObject(
			{},
			{ auto_review: config } as PluginConfig,
			undefined,
			dispatcher,
		);
		expect(tools.swarm_command).toBeDefined();
		expect(tools.phase_complete).toBeDefined();
		expect(tools.lean_turbo_review).toBeDefined();

		expect(read('README.md')).toContain('/swarm review');
		expect(read('docs/commands.md')).toContain('### `/swarm review');
		expect(read('docs/configuration.md')).toContain(
			AUTO_REVIEW_V8_BURN_IN_DECISION.artifact_sha256,
		);
		expect(read('docs/architecture.md')).toContain(
			'Independent Auto-Review Engine',
		);
		expect(read('docs/proposals/auto-review-by-review-model.md')).toContain(
			'Status: implemented by issue #1675',
		);
		expect(
			read('docs/releases/pending/1675-default-auto-review-engine.md'),
		).toContain('/swarm review');
	});
});
