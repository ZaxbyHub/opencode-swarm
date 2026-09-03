import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * CI-004 for the merge-group critical path. `integration` and `smoke` check
 * out, install and run from source; neither consumes an artifact or output
 * from `unit`, so serialising them behind the unit matrix only lengthened the
 * merge-group wall time (a measured ~25 min tail after `unit` on a 59 min
 * run). These assertions keep the two jobs anchored on `quality` so the
 * serialisation cannot silently return. `unit-passed` is the one legitimate
 * consumer of `needs.unit.result` and is deliberately not asserted here.
 */
const CI_YML = fileURLToPath(
	new URL('../../../../.github/workflows/ci.yml', import.meta.url),
);

function extractJob(yml: string, jobId: string): string {
	const start = yml.indexOf(`\n  ${jobId}:\n`);
	if (start < 0) throw new Error(`job '${jobId}' not found in ci.yml`);
	const rest = yml.slice(start + 1);
	const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
	return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('ci.yml merge-group critical path — CI-004 for integration and smoke', () => {
	const yml = readFileSync(CI_YML, 'utf8');
	const integration = extractJob(yml, 'integration');
	const smoke = extractJob(yml, 'smoke');

	test('integration starts after quality instead of waiting for the unit matrix', () => {
		expect(integration).toContain('needs: [detect-release, quality]');
		expect(integration).not.toMatch(/needs: \[[^\]]*\bunit\b/);
	});

	test('smoke does not wait for unit or integration', () => {
		expect(smoke).toContain(
			'needs: [detect-release, package-check, php-validation, rust-sandbox-runner]',
		);
		expect(smoke).not.toMatch(/needs: \[[^\]]*\b(unit|integration)\b/);
	});

	test('neither job reads a needs.unit.* value it no longer declares', () => {
		expect(integration).not.toMatch(/needs\.unit\./);
		expect(smoke).not.toMatch(/needs\.(unit|integration)\./);
	});

	test('neither job gained a job-level if: always() (skipped prerequisites must still skip)', () => {
		expect(integration).not.toMatch(/^ {4}if: always\(\)/m);
		expect(smoke).not.toMatch(/^ {4}if: always\(\)/m);
	});
});
