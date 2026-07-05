import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CI_YML_PATH = join(
	import.meta.dir,
	'../../../../.github/workflows/ci.yml',
);
const COVERAGE_GATE_SCRIPT_PATH = join(
	import.meta.dir,
	'../../../../scripts/ci/run-coverage-gate.sh',
);

function extractRunUnitTestsStep(yml: string): string {
	// Normalize CRLF to LF so regex anchors work consistently
	const normalized = yml.replace(/\r\n/g, '\n');
	// The "Run unit tests" step starts at 6-space indentation under the jobs.*.steps key.
	// Its content ends before the next step (also at 6-space indent) or section comment.
	const match = normalized.match(
		/- name: Run unit tests[\s\S]*?(?=\n {6}- name:|\n {6}# ---|Z)/m,
	);
	return match ? match[0] : '';
}

function extractCollectAndPartitionStep(yml: string): string {
	const normalized = yml.replace(/\r\n/g, '\n');
	const match = normalized.match(
		/- name: Collect and partition test files[\s\S]*?(?=\n {6}- name:|\n {6}# ---|Z)/m,
	);
	return match ? match[0] : '';
}

function extractCoverageMeasurementStep(yml: string): string {
	const normalized = yml.replace(/\r\n/g, '\n');
	const match = normalized.match(
		/- name: Coverage gate enforcement[\s\S]*?(?=\n {6}- name:|\n {6}# ---|Z)/m,
	);
	return match ? match[0] : '';
}

function extractIntegrationTestsStep(yml: string): string {
	const normalized = yml.replace(/\r\n/g, '\n');
	const match = normalized.match(
		/- name: Integration tests[\s\S]*?(?=\n {6}- name:|\n {6}# ---|Z)/m,
	);
	return match ? match[0] : '';
}

describe('ci.yml integration — Task 1.2 wrapper script structural validation', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractRunUnitTestsStep(yml);
	const collectStep = extractCollectAndPartitionStep(yml);

	test('"Run unit tests" step calls the wrapper script', () => {
		expect(step).toContain('bun scripts/ci/run-test-with-timeout.ts');
	});

	test('"Run unit tests" step includes --kill-timeout 180', () => {
		expect(step).toContain('--kill-timeout 180');
	});

	test('"Run unit tests" step preserves error detection with grep -qE', () => {
		expect(step).toContain('grep -qE');
	});

	test('"Run unit tests" step preserves shard file list mechanism', () => {
		expect(step).toContain('shard-tests.txt');
	});

	test('"Run unit tests" step tolerates empty quarantine files', () => {
		expect(collectStep).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-tests.txt > "$tmpdir/quarantined-raw.txt" || true',
		);
		expect(collectStep).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-tests-macos.txt >> "$tmpdir/quarantined-raw.txt" || true',
		);
		expect(collectStep).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-tests-windows.txt >> "$tmpdir/quarantined-raw.txt" || true',
		);
	});

	test('"Run unit tests" step does NOT contain raw bun --smol test "$f" invocation', () => {
		// The old raw pattern was: bun --smol test "$f" --timeout 120000
		expect(step).not.toContain('bun --smol test "$f"');
	});
});

describe('ci.yml integration — integration quarantine extraction', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractIntegrationTestsStep(yml);

	test('"Integration tests" step tolerates empty quarantine files', () => {
		expect(step).toContain(
			'grep -vE \'^\\s*#|^\\s*$\' scripts/ci/quarantined-integration-tests.txt | sort > "$tmpdir/int-quarantined.txt" || true',
		);
	});
});

describe('ci.yml integration — merge-queue coverage isolation', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractCoverageMeasurementStep(yml);
	const coverageGateScript = readFileSync(COVERAGE_GATE_SCRIPT_PATH, 'utf8');

	test('"Coverage gate enforcement" step delegates to the coverage helper', () => {
		expect(step).toContain('bash scripts/ci/run-coverage-gate.sh');
	});

	test('coverage helper runs each file with Bun isolation', () => {
		expect(coverageGateScript).toContain('set -euo pipefail');
		expect(coverageGateScript).toContain(
			'bun test --isolate --coverage --timeout 60000 "$test_file"',
		);
		expect(coverageGateScript).toContain(
			"{ grep -vE '^\\s*#|^\\s*$' scripts/ci/quarantined-tests.txt || true; } | sort > quarantined.txt",
		);
	});

	test('coverage helper merges per-file lcov before enforcing the threshold', () => {
		expect(coverageGateScript).toContain('scripts/ci/merge-lcov.mjs');
		expect(coverageGateScript).toContain('coverage/lcov.info');
		expect(coverageGateScript).toContain('Coverage gate passed');
	});
});
