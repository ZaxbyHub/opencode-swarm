/**
 * Config-doctor coverage for the `git` section (issue #2236).
 *
 * `GitConfigSchema` (`src/config/schema.ts`) adds a `git.binary` override that
 * decides which git executable the plugin spawns. The schema deliberately does
 * NOT `.refine()` the value: a refine failure fails the whole config parse, and
 * an unloadable config is exactly the "config value makes git unreachable"
 * outcome the field exists to avoid. That decision moves the validation duty to
 * the doctor, where a finding is advisory instead of fatal — so the section
 * needs real checks here, not just a switch case that satisfies the
 * "every top-level key has a validation case" introspection test.
 *
 * New file: `src/services/config-doctor.test.ts` is over the FR-006 500-line
 * cap and must not grow.
 */
import { describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config/schema';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Minimal valid base so unrelated keys never contribute findings. */
function configWith(git: unknown): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		git,
	} as unknown as PluginConfig;
}

function findingsFor(git: unknown, pathPrefix: string) {
	const dir = canonicalMkdtemp('doctor-git-binary-');
	return runConfigDoctor(configWith(git), dir).findings.filter(
		(f) => f.path === pathPrefix,
	);
}

describe('config doctor — git section', () => {
	it('flags a non-object git section', () => {
		const findings = findingsFor('not-an-object', 'git');
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0]?.id).toBe('invalid-git-type');
		expect(findings[0]?.severity).toBe('error');
	});

	it('flags an array git section (arrays are not config objects)', () => {
		const findings = findingsFor([], 'git');
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0]?.id).toBe('invalid-git-type');
	});

	it('flags a non-string git.binary', () => {
		const findings = findingsFor({ binary: 12345 }, 'git.binary');
		expect(findings.length).toBe(1);
		expect(findings[0]?.id).toBe('invalid-git-binary-type');
		expect(findings[0]?.severity).toBe('error');
		expect(findings[0]?.description).toContain('must be a string');
	});

	it('flags a blank git.binary — a blank override names no executable', () => {
		// Whitespace-only is the dangerous shape: it is a valid string to the
		// schema, so nothing upstream rejects it, yet it resolves to no binary.
		const findings = findingsFor({ binary: '   ' }, 'git.binary');
		expect(findings.length).toBe(1);
		expect(findings[0]?.id).toBe('empty-git-binary');
		expect(findings[0]?.severity).toBe('error');
	});

	it('flags an empty-string git.binary', () => {
		const findings = findingsFor({ binary: '' }, 'git.binary');
		expect(findings.length).toBe(1);
		expect(findings[0]?.id).toBe('empty-git-binary');
	});

	it('accepts a populated git.binary and an omitted one', () => {
		expect(findingsFor({ binary: '/usr/bin/git' }, 'git.binary').length).toBe(
			0,
		);
		expect(findingsFor({ binary: 'git' }, 'git.binary').length).toBe(0);
		// Section present but empty, and section absent, are both valid.
		expect(findingsFor({}, 'git').length).toBe(0);
		expect(findingsFor({}, 'git.binary').length).toBe(0);
	});

	it('does not flag a valid git section at the section path', () => {
		expect(findingsFor({ binary: 'git' }, 'git').length).toBe(0);
	});
});
