import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	HooksConfigSchema,
	type PluginConfig,
} from '../../../src/config/schema';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function configWithHooks(hooks: Record<string, unknown>): PluginConfig {
	return {
		max_iterations: 5,
		config_format_version: 3,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks,
	} as PluginConfig;
}

describe('config doctor hooks allowlist parity with HooksConfigSchema', () => {
	let directory = '';

	beforeEach(() => {
		directory = canonicalMkdtemp('config-doctor-hooks-parity-');
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	function unknownHookFindings(hooks: Record<string, unknown>) {
		return runConfigDoctor(configWithHooks(hooks), directory).findings.filter(
			(finding) => finding.id === 'unknown-hook-field',
		);
	}

	test('every key HooksConfigSchema accepts is accepted by the doctor', () => {
		const schemaKeys = Object.keys(HooksConfigSchema.shape);
		expect(schemaKeys).toContain('auto_inject_acceptance');
		for (const key of schemaKeys) {
			expect(unknownHookFindings({ [key]: true }).map((f) => f.path)).toEqual(
				[],
			);
		}
	});

	test('the opt-in auto_inject_acceptance key is not proposed for removal', () => {
		const result = runConfigDoctor(
			configWithHooks({ auto_inject_acceptance: true }),
			directory,
		);
		expect(
			result.findings.some((finding) =>
				finding.proposedFix?.path?.includes('auto_inject_acceptance'),
			),
		).toBe(false);
	});

	test('a key the schema does not define is still flagged', () => {
		const findings = unknownHookFindings({ not_a_real_hook: true });
		expect(findings).toHaveLength(1);
		expect(findings[0]!.path).toBe('hooks.not_a_real_hook');
	});
});
