import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * CI-004 for the merge-group critical path. `integration` and `smoke` check
 * out, install and run from source; neither consumes an artifact or output
 * from `unit`, so serialising them behind the unit matrix only lengthened the
 * merge-group wall time (a measured ~25 min tail after `unit` on a 59 min
 * run). These assertions keep the two jobs anchored on `quality`, pin the
 * full `needs` lists (plus `unit-passed`'s `[unit]` gate, the one legitimate
 * `needs.unit.result` consumer) so the serialisation cannot silently return.
 * Skipped prerequisites must still skip these jobs, so a job-level
 * `if: always()` is forbidden here too.
 */
const CI_YML = fileURLToPath(
	new URL('../../../../.github/workflows/ci.yml', import.meta.url),
);

// CRLF-normalize: Windows checkouts can hold CRLF working copies while the
// committed file is LF (.gitattributes eol=lf); assertions must hold on both.
function readText(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function extractJob(yml: string, jobId: string): string {
	const start = yml.indexOf(`\n  ${jobId}:\n`);
	if (start < 0) throw new Error(`job '${jobId}' not found in ci.yml`);
	const rest = yml.slice(start + 1);
	const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
	return next < 0 ? rest : rest.slice(0, next + 1);
}

function extractNeedsLine(job: string): string {
	const match = job.match(/needs: \[[^\]]*\]/);
	if (!match) throw new Error('needs: [...] list not found in job slice');
	return match[0];
}

describe('ci.yml merge-group critical path — CI-004 for integration and smoke', () => {
	const yml = readText(CI_YML);

	test('integration starts after quality instead of waiting for the unit matrix', () => {
		const integration = extractJob(yml, 'integration');
		expect(extractNeedsLine(integration)).toBe(
			'needs: [detect-release, quality]',
		);
		expect(integration).not.toMatch(/needs: \[[^\]]*\bunit\b/);
	});

	test('smoke does not wait for unit or integration', () => {
		const smoke = extractJob(yml, 'smoke');
		// detect-paths (issue #2475) feeds the windows packed-artifact probe's
		// pull_request activation; it is a fast ubuntu job that always runs, so
		// it adds no serialisation behind the slower package-check leg.
		expect(extractNeedsLine(smoke)).toBe(
			'needs: [detect-release, detect-paths, package-check, php-validation, rust-sandbox-runner]',
		);
		expect(smoke).not.toMatch(/needs: \[[^\]]*\b(unit|integration)\b/);
	});

	test('neither job reads a needs.unit.* value it no longer declares', () => {
		const integration = extractJob(yml, 'integration');
		const smoke = extractJob(yml, 'smoke');
		expect(integration).not.toMatch(/needs\.unit\./);
		expect(smoke).not.toMatch(/needs\.(unit|integration)\./);
	});

	test('unit-passed keeps gating on the unit matrix', () => {
		const unitPassed = extractJob(yml, 'unit-passed');
		expect(extractNeedsLine(unitPassed)).toBe('needs: [unit]');
	});

	test('neither job gained a job-level if: always() (skipped prerequisites must still skip)', () => {
		const integration = extractJob(yml, 'integration');
		const smoke = extractJob(yml, 'smoke');
		expect(integration).not.toMatch(/^ {4}if:[^\n]*\balways\s*\(\)/m);
		expect(smoke).not.toMatch(/^ {4}if:[^\n]*\balways\s*\(\)/m);
	});
});
