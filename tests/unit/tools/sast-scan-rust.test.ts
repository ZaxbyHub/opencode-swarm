/**
 * SAST Scan Tool Tests — Rust Language
 *
 * Focused tests for Rust security patterns:
 * - rust-command-injection
 * - rust-hardcoded-secret (F-005)
 * - rust-unsafe-block (F-005)
 *
 * Extracted from tests/unit/tools/sast-scan.test.ts to satisfy
 * the per-file 500-line limit (FR-006 / SC-006.1).
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	vi,
} from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { resetSemgrepCache } from '../../../src/sast/semgrep';
import type { LoadBaselineResult } from '../../../src/tools/sast-baseline';
import { type SastScanInput, sastScan } from '../../../src/tools/sast-scan';

// Mock the saveEvidence function
vi.mock('../../../src/evidence/manager', () => ({
	saveEvidence: vi.fn().mockResolvedValue(undefined),
}));

// Mock isSemgrepAvailable to control Semgrep availability in tests
let mockSemgrepAvailable = false;

vi.mock('../../../src/sast/semgrep', () => ({
	isSemgrepAvailable: () => mockSemgrepAvailable,
	checkSemgrepAvailable: async () => mockSemgrepAvailable,
	runSemgrep: vi.fn().mockResolvedValue({
		available: mockSemgrepAvailable,
		findings: [],
		engine: 'tier_a+tier_b',
	}),
	resetSemgrepCache: vi.fn(),
}));

// Mock sast-baseline I/O functions so tests don't write real files.
const mockCaptureOrMergeBaseline = mock(async () => ({
	status: 'written' as const,
	path: '/fake/sast-baseline.json',
	fingerprint_count: 1,
}));
const mockLoadBaseline = mock(
	(): LoadBaselineResult => ({ status: 'not_found' }),
);

mock.module('../../../src/tools/sast-baseline', () => {
	// Spread the real module so non-I/O exports (assignOccurrenceIndices,
	// MAX_BASELINE_FINDINGS, etc.) remain functional.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const actual =
		require('../../../src/tools/sast-baseline') as typeof import('../../../src/tools/sast-baseline');
	return {
		...actual,
		captureOrMergeBaseline: mockCaptureOrMergeBaseline,
		loadBaseline: mockLoadBaseline,
	};
});

describe('sastScan — Rust language', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(tmpdir(), 'sast-rust-test-'));
		mockSemgrepAvailable = false;
		mockCaptureOrMergeBaseline.mockClear();
		mockLoadBaseline.mockClear();
		vi.clearAllMocks();
	});

	afterEach(() => {
		mock.restore();
	});

	it('should detect command injection in Rust files', async () => {
		const testFile = path.join(tempDir, 'test.rs');
		fs.writeFileSync(
			testFile,
			`use std::process::Command;
fn main() {
	let _child = Command::new("sh").arg("-c").arg(user_input).spawn();
}`,
		);

		const input: SastScanInput = {
			changed_files: [testFile],
			severity_threshold: 'medium',
		};

		const result = await sastScan(input, tempDir);

		expect(result.summary.files_scanned).toBe(1);
		expect(
			result.findings.some((f) => f.rule_id === 'sast/rust-command-injection'),
		).toBe(true);
	});

	it('should detect hardcoded secrets in Rust files (F-005)', async () => {
		// Seed both idiomatic forms the rule is designed to catch:
		// - typed &str form: const API_KEY: &str = "..."
		// - untyped let form: let api_token = "..."
		const testFile = path.join(tempDir, 'test.rs');
		fs.writeFileSync(
			testFile,
			`fn main() {
	const API_KEY: &str = "ak_live_1234567890abcdef";
	let api_token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
}`,
		);

		const input: SastScanInput = {
			changed_files: [testFile],
			severity_threshold: 'medium',
		};

		const result = await sastScan(input, tempDir);

		expect(result.summary.files_scanned).toBe(1);
		// Both typed &str and untyped let forms should trigger the rule
		expect(
			result.findings.filter((f) => f.rule_id === 'sast/rust-hardcoded-secret')
				.length,
		).toBeGreaterThanOrEqual(2);
		// Verify severity is critical
		const secretFindings = result.findings.filter(
			(f) => f.rule_id === 'sast/rust-hardcoded-secret',
		);
		expect(secretFindings.length).toBeGreaterThan(0);
		expect(secretFindings[0]?.severity).toBe('critical');
	});

	it('should detect unsafe blocks in Rust files (F-005)', async () => {
		const testFile = path.join(tempDir, 'test.rs');
		fs.writeFileSync(
			testFile,
			`fn main() {
	unsafe { std::ptr::null::<u8>(); }
}`,
		);

		const input: SastScanInput = {
			changed_files: [testFile],
			severity_threshold: 'medium',
		};

		const result = await sastScan(input, tempDir);

		expect(result.summary.files_scanned).toBe(1);
		expect(
			result.findings.some((f) => f.rule_id === 'sast/rust-unsafe-block'),
		).toBe(true);
		// Verify severity is medium
		const unsafeFinding = result.findings.find(
			(f) => f.rule_id === 'sast/rust-unsafe-block',
		);
		expect(unsafeFinding?.severity).toBe('medium');
	});
});
