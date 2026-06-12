/**
 * Real path validation tests for write_mutation_evidence (Item 7).
 *
 * The existing write-mutation-evidence.test.ts mocks validateSwarmPath.
 * These tests verify:
 *  1. That executeWriteMutationEvidence uses the REAL validateSwarmPath
 *     (i.e., evidence lands in .swarm/evidence/N/, not just evidence/N/)
 *  2. That validateSwarmPath itself rejects traversal, absolute paths, and
 *     null bytes — the security properties bypassed by the mock.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executeWriteMutationEvidence } from './write-mutation-evidence.js';
import { validateSwarmPath } from '../hooks/utils.js';

describe('write_mutation_evidence — real path validation (no mocks)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-evidence-real-')),
		);
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	// ─── Integration: evidence is written under .swarm/ ────────────────────

	test('evidence is written under .swarm/ with real validateSwarmPath', async () => {
		const result = JSON.parse(
			await executeWriteMutationEvidence(
				{ phase: 1, verdict: 'PASS', summary: 'All mutants killed', killRate: 0.9 },
				tempDir,
			),
		);
		expect(result.success).toBe(true);

		// Real validateSwarmPath resolves to .swarm/evidence/N/mutation-gate.json
		const expectedPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'1',
			'mutation-gate.json',
		);
		expect(fs.existsSync(expectedPath)).toBe(true);

		const content = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
		expect(content.entries[0].type).toBe('mutation-gate');
		expect(content.entries[0].verdict).toBe('pass');
	});

	test('multiple phases write to distinct .swarm/evidence/N/ directories', async () => {
		for (const phase of [1, 2, 3]) {
			const result = JSON.parse(
				await executeWriteMutationEvidence(
					{ phase, verdict: 'PASS', summary: `Phase ${phase} done`, killRate: 0.9 },
					tempDir,
				),
			);
			expect(result.success).toBe(true);
		}

		for (const phase of [1, 2, 3]) {
			const p = path.join(tempDir, '.swarm', 'evidence', String(phase), 'mutation-gate.json');
			expect(fs.existsSync(p)).toBe(true);
		}
	});

	// ─── validateSwarmPath security: path traversal ─────────────────────────

	test('validateSwarmPath rejects ../ traversal', () => {
		expect(() =>
			validateSwarmPath(tempDir, '../../../etc/passwd'),
		).toThrow('path traversal detected');
	});

	test('validateSwarmPath rejects ..\\ Windows traversal', () => {
		expect(() =>
			validateSwarmPath(tempDir, '..\\..\\secret'),
		).toThrow('path traversal detected');
	});

	test('validateSwarmPath rejects POSIX absolute path', () => {
		expect(() =>
			validateSwarmPath(tempDir, '/etc/passwd'),
		).toThrow('path escapes .swarm directory');
	});

	test('validateSwarmPath rejects Windows absolute path (e.g. C:\\Windows)', () => {
		expect(() =>
			validateSwarmPath(tempDir, 'C:\\Windows\\secret.txt'),
		).toThrow('path escapes .swarm directory');
	});

	test('validateSwarmPath rejects null bytes in filename', () => {
		expect(() =>
			validateSwarmPath(tempDir, 'evidence/1/\0mutation-gate.json'),
		).toThrow('null bytes');
	});

	test('validateSwarmPath accepts a normal relative sub-path', () => {
		const resolved = validateSwarmPath(tempDir, 'evidence/1/mutation-gate.json');
		const expected = path.join(tempDir, '.swarm', 'evidence', '1', 'mutation-gate.json');
		expect(resolved).toBe(expected);
	});

	test('validateSwarmPath confines resolved path inside .swarm/', () => {
		const resolved = validateSwarmPath(tempDir, 'evidence/99/custom.json');
		expect(resolved.startsWith(path.join(tempDir, '.swarm') + path.sep)).toBe(true);
	});
});
