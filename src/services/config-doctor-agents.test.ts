import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import {
	canonicalMkdtemp,
	removeTreeWithRetry,
} from '../../tests/helpers/tmpdir';
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
	let origXdgConfig: string | undefined;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('config-doctor-agents-');
		// runConfigDoctor also reads the user-level config (getUserConfigDir), so
		// pin it to an empty dir or a host opencode-swarm.json leaks in findings.
		origXdgConfig = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
	});

	afterEach(() => {
		if (origXdgConfig === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = origXdgConfig;
		}
		removeTreeWithRetry(tempDir);
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
		expect(result.findings.every((f) => f.proposedFix === undefined)).toBe(
			true,
		);
		expect(result.findings.map((f) => f.id)).not.toContain(
			'deprecated-agents-config',
		);
	});

	it('still rejects a non-object agents value', () => {
		const cases: Array<[unknown, string]> = [
			['oops', 'string'],
			[42, 'number'],
			[true, 'boolean'],
			[['coder'], 'array'],
		];
		for (const [bad, kind] of cases) {
			const result = runConfigDoctor(config({ agents: bad }), tempDir);

			const finding = result.findings.find(
				(f) => f.id === 'invalid-agents-type',
			);
			expect(finding?.severity).toBe('error');
			expect(finding?.path).toBe('agents');
			expect(finding?.autoFixable).toBe(false);
			expect(finding?.proposedFix).toBeUndefined();
			expect(finding?.currentValue).toEqual(bad);
			expect(finding?.description).toBe(
				`"agents" must be an object keyed by agent name, got ${kind}`,
			);
			expect(result.hasAutoFixableIssues).toBe(false);
			expect(result.findings.map((f) => f.id)).not.toContain(
				'deprecated-agents-config',
			);
		}
	});
});
