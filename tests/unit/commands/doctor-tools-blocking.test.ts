import { describe, expect, test } from 'bun:test';
import { formatToolDoctorMarkdown } from '../../../src/commands/doctor';
import type { ConfigDoctorResult } from '../../../src/services/config-doctor';

/**
 * Enforcement regression: when tool-doctor reports any error-severity
 * findings (e.g. AGENT_TOOL_MAP alignment gaps — the exact bug class
 * that shipped broken in 6.66.0), the rendered tool doctor report must
 * include a machine-readable BLOCKING marker so release tooling can
 * gate on it. Severity promotion alone (warn -> error) is cosmetic
 * unless there is a visible blocker that downstream consumers can
 * grep for. This guards against silently shipping the same regression
 * again.
 */
describe('formatToolDoctorMarkdown BLOCKING footer', () => {
	test('emits BLOCKING marker when there is at least one error finding', () => {
		const result: ConfigDoctorResult = {
			findings: [
				{
					id: 'agent-tool-map-mismatch-architect-submit_council_verdicts',
					title: 'AGENT_TOOL_MAP alignment gap',
					description:
						'Tool "submit_council_verdicts" is assigned to agent "architect" in AGENT_TOOL_MAP but is not registered in the plugin\'s tool: {} block.',
					severity: 'error',
					path: 'AGENT_TOOL_MAP.architect',
					currentValue: 'submit_council_verdicts',
					autoFixable: false,
				},
			],
			summary: { info: 0, warn: 0, error: 1 },
			hasAutoFixableIssues: false,
			timestamp: Date.now(),
			configSource: 'test',
		};

		const output = formatToolDoctorMarkdown(result);
		expect(output).toContain('**BLOCKING**');
		expect(output).toContain('AGENT_TOOL_MAP alignment errors');
		expect(output).toContain('submit_council_verdicts');
	});

	test('does NOT emit BLOCKING marker when only warnings or infos exist', () => {
		const result: ConfigDoctorResult = {
			findings: [
				{
					id: 'missing-binary-dotnet',
					title: 'Missing binary',
					description: 'dotnet not on PATH',
					severity: 'warn',
					path: 'binaries.dotnet',
					currentValue: 'missing',
					autoFixable: false,
				},
			],
			summary: { info: 0, warn: 1, error: 0 },
			hasAutoFixableIssues: false,
			timestamp: Date.now(),
			configSource: 'test',
		};

		const output = formatToolDoctorMarkdown(result);
		expect(output).not.toContain('**BLOCKING**');
	});

	test('does NOT emit BLOCKING marker on a clean run', () => {
		const result: ConfigDoctorResult = {
			findings: [],
			summary: { info: 0, warn: 0, error: 0 },
			hasAutoFixableIssues: false,
			timestamp: Date.now(),
			configSource: 'test',
		};

		const output = formatToolDoctorMarkdown(result);
		expect(output).not.toContain('**BLOCKING**');
		expect(output).toContain('All tools are properly registered');
	});
});
