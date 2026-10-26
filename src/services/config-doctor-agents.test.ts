import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import type { PluginConfig } from '../config/schema';
import { runConfigDoctor } from './config-doctor';

/**
 * Top-level `agents` is a documented, runtime-consumed key (merged into every
 * swarm in src/agents/index.ts; docs/configuration.md lists it as the
 * default-swarm override), so config-doctor must not call it deprecated or
 * suggest removing it. A non-object value is still rejected (#3463).
 */
function config(overrides: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		config_format_version: 3,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		...overrides,
	} as PluginConfig;
}

describe('config-doctor: top-level agents (#3463)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('config-doctor-agents-');
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('does not flag top-level agents (documented default-swarm override)', () => {
		const result = runConfigDoctor(
			config({ agents: { coder: { model: 'gpt-4' } } }),
			tempDir,
		);

		expect(result.findings).toHaveLength(0);
		expect(result.hasAutoFixableIssues).toBe(false);
	});

	it('does not propose removing agents when swarms is also configured', () => {
		const result = runConfigDoctor(
			config({
				agents: { coder: { model: 'gpt-4' } },
				swarms: { local: { agents: { coder: { model: 'gpt-4' } } } },
			}),
			tempDir,
		);

		expect(
			result.findings.filter((f) => f.proposedFix?.path === 'agents'),
		).toHaveLength(0);
		expect(result.findings.map((f) => f.id)).not.toContain(
			'deprecated-agents-config',
		);
	});

	it('still rejects a non-object agents value', () => {
		for (const bad of ['oops', 42, ['coder']]) {
			const result = runConfigDoctor(config({ agents: bad }), tempDir);

			const finding = result.findings.find(
				(f) => f.id === 'invalid-agents-type',
			);
			expect(finding?.severity).toBe('error');
			expect(result.findings.map((f) => f.id)).not.toContain(
				'deprecated-agents-config',
			);
		}
	});
});
