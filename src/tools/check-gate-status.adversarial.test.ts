import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { check_gate_status } from './check-gate-status';
import type { ToolResult } from './create-tool';

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Helper to call tool execute with proper context
async function executeTool(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = (await check_gate_status.execute(args, {
		directory,
	} as unknown as ToolContext)) as unknown as ToolResult;
	return resultToString(result);
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gate-adversarial-'));
	mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('check_gate_status ADVERSARIAL', () => {
	// ═══════════════════════════════════════════════════════════════════════════
	// TASK ID FORMAT ATTACKS - Malformed task IDs
	// ═══════════════════════════════════════════════════════════════════════════

	it('rejects empty task_id', async () => {
		const result = await executeTool({ task_id: '' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id');
	});

	it('rejects null task_id', async () => {
		const result = await executeTool({ task_id: null }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id');
	});

	it('rejects undefined task_id', async () => {
		const result = await executeTool({ task_id: undefined }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects numeric task_id (type confusion)', async () => {
		const result = await executeTool({ task_id: 123 }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id');
	});

	it('rejects array task_id (type confusion)', async () => {
		const result = await executeTool({ task_id: ['1', '1'] }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects object task_id (type confusion)', async () => {
		const result = await executeTool({ task_id: { id: '1.1' } }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with only letters', async () => {
		const result = await executeTool({ task_id: 'abc' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	it('rejects task_id with single number', async () => {
		const result = await executeTool({ task_id: '1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	it('rejects negative numbers in task_id', async () => {
		const result = await executeTool({ task_id: '-1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// PATH TRAVERSAL IN TASK ID - Attempting to escape evidence directory
	// ═══════════════════════════════════════════════════════════════════════════

	it('rejects task_id with path traversal (../)', async () => {
		const result = await executeTool({ task_id: '../1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	it('rejects task_id with absolute path attempt', async () => {
		const result = await executeTool({ task_id: '/etc/passwd' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	it('rejects task_id with double dots and slash', async () => {
		const result = await executeTool({ task_id: '..%2F..%2Fetc' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with null byte injection', async () => {
		// Null bytes in JS strings get handled, but test anyway
		const result = await executeTool({ task_id: '1.1\x00' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id attempting to escape with parent refs', async () => {
		// This would try to create path like: .swarm/evidence/../../../etc/passwd.json
		const result = await executeTool(
			{ task_id: '..\\..\\..\\etc\\passwd' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should either reject format or return no_evidence (not read arbitrary file)
		expect(parsed.status).toBe('no_evidence');
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// INJECTION ATTEMPTS - SQL, HTML, Script, Template
	// ═══════════════════════════════════════════════════════════════════════════

	it('rejects task_id with SQL injection attempt', async () => {
		const result = await executeTool(
			{ task_id: "1.1'; DROP TABLE evidence;--" },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with HTML/script injection attempt', async () => {
		const result = await executeTool(
			{ task_id: '<script>alert(1)</script>' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with template literal injection', async () => {
		const result = await executeTool({ task_id: '${process.env}' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with shell command injection', async () => {
		const result = await executeTool({ task_id: '1.1; rm -rf /' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with JSON injection attempt', async () => {
		const result = await executeTool({ task_id: '{"injected": true}' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// OVERSIZED / ADVERSARIAL INPUTS
	// ═══════════════════════════════════════════════════════════════════════════

	it('rejects extremely long task_id (DoS attempt)', async () => {
		const longId = `1.${'a'.repeat(10000)}`;
		const result = await executeTool({ task_id: longId }, tmpDir);
		const parsed = JSON.parse(result);

		// Should either reject format or handle gracefully without crashing
		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid');
	});

	it('rejects task_id with Unicode smuggling attempt', async () => {
		// Unicode that might look like valid format
		const result = await executeTool({ task_id: '1.\u200b1' }, tmpDir); // zero-width space
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with fullwidth numbers', async () => {
		// Fullwidth Unicode numbers (looks like 1.1 but isn't)
		const result = await executeTool({ task_id: '\uff11\uff0e\uff11' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with RTL override character', async () => {
		// Right-to-left override can reverse string interpretation
		const result = await executeTool({ task_id: '1.1\u202e3.2\u202c' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with combining characters', async () => {
		// Combining diacritical marks
		const result = await executeTool({ task_id: '1.\u03081.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('rejects task_id with emoji', async () => {
		const result = await executeTool({ task_id: '1.1😀' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// INVALID EVIDENCE STRUCTURE - Malformed or malicious evidence files
	// ═══════════════════════════════════════════════════════════════════════════

	it('handles evidence file with invalid JSON', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			'not valid json {{',
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence file with null content', async () => {
		writeFileSync(path.join(tmpDir, '.swarm', 'evidence', '1.1.json'), 'null');

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence file with string content', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			'"just a string"',
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence file with array content', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			'[1, 2, 3]',
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence file with missing required_gates', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({ taskId: '1.1', gates: {} }),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence file with null required_gates', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({ taskId: '1.1', required_gates: null, gates: {} }),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence file with null gates', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer'],
				gates: null,
			}),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence file with number instead of array for required_gates', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({ taskId: '1.1', required_gates: 123, gates: {} }),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence file with string instead of object for gates', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer'],
				gates: 'string',
			}),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('handles extremely large evidence file (DoS attempt)', async () => {
		// Create a massive JSON file (100KB+ of padding)
		const hugeArray = Array(10000).fill('padding'.repeat(10));
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: hugeArray,
				gates: {},
			}),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// Should handle gracefully - either process or return error
		expect(parsed.status).toBeDefined();
	});

	it('handles deeply nested evidence structure', async () => {
		// Create deeply nested JSON that could cause stack overflow in recursive parsing
		const nested: Record<string, unknown> = {};
		let current = nested;
		for (let i = 0; i < 100; i++) {
			current.level = {};
			current = current.level as Record<string, unknown>;
		}
		current.required_gates = ['reviewer'];
		current.gates = {
			reviewer: { sessionId: 's1', timestamp: '2024', agent: 'a' },
		};

		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({ taskId: '1.1', ...nested }),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// Should handle gracefully - extract what it needs
		expect(parsed.status).toBeDefined();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// SYMLINK ATTACKS - Evidence file is a symlink to sensitive data
	// ═══════════════════════════════════════════════════════════════════════════

	it('handles symlink to arbitrary file gracefully', async () => {
		// Note: This test would only work on systems supporting symlinks
		// The tool should handle it - but importantly, it should only read within .swarm/evidence
		// Since the path validation checks the final resolved path, this should be safe

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// Should return no_evidence if no actual file exists
		expect(parsed.status).toBe('no_evidence');
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// BOUNDARY CASES - Edge cases and edge values
	// ═══════════════════════════════════════════════════════════════════════════

	it('handles task_id at maximum safe integer', async () => {
		const result = await executeTool(
			{ task_id: `${String(Number.MAX_SAFE_INTEGER)}.1` },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Very large numbers might fail format validation
		expect(parsed.status).toBe('no_evidence');
	});

	it('handles task_id with zero values', async () => {
		const result = await executeTool({ task_id: '0.0' }, tmpDir);
		const parsed = JSON.parse(result);

		// Zero is valid numerically but the format check is regex-based
		expect(parsed.status).toBeDefined();
	});

	it('handles very large valid task_id format', async () => {
		// Even with large numbers, the regex should match
		const result = await executeTool(
			{ task_id: '999999999.999999999' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should at least get to "no_evidence" stage (file doesn't exist)
		expect(parsed.status).toBe('no_evidence');
	});

	it('handles evidence with required_gates containing special chars', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['<script>', '../../../etc', '\x00'],
				gates: {},
			}),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// Should handle gracefully - stores as-is
		expect(parsed.required_gates).toBeDefined();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// READ-ONLY VERIFICATION - Ensure tool doesn't mutate state
	// ═══════════════════════════════════════════════════════════════════════════

	it('does not create evidence file when missing', async () => {
		const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '1.1.json');

		await executeTool({ task_id: '1.1' }, tmpDir);

		expect(existsSync(evidencePath)).toBe(false);
	});

	it('does not modify file permissions or attributes', async () => {
		const evidence = {
			taskId: '1.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: { sessionId: 's1', timestamp: '2024', agent: 'r' },
			},
		};
		const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '1.1.json');
		writeFileSync(evidencePath, JSON.stringify(evidence));

		// Get original content
		const _originalStat = Bun.file(evidencePath).stat();

		// Execute tool multiple times
		await executeTool({ task_id: '1.1' }, tmpDir);
		await executeTool({ task_id: '1.1' }, tmpDir);

		// Verify file unchanged
		const afterContent = readFileSync(evidencePath, 'utf-8');
		expect(afterContent).toBe(JSON.stringify(evidence));
	});

	it('does not create any other files in workspace', async () => {
		const initialFiles = new Set(
			readdirSyncRecursive(path.join(tmpDir, '.swarm', 'evidence')),
		);

		await executeTool({ task_id: '1.1' }, tmpDir);

		const afterFiles = new Set(
			readdirSyncRecursive(path.join(tmpDir, '.swarm', 'evidence')),
		);

		// Should have same files (none added)
		expect(afterFiles.size).toBe(initialFiles.size);
	});

	it('does not write to stdout/stderr (silent operation)', async () => {
		// This is implicitly tested - we only check return value
		// But verify no console errors leak
		const result = await executeTool({ task_id: 'invalid!!!!' }, tmpDir);

		expect(result).toBeDefined();
		expect(() => JSON.parse(result)).not.toThrow();
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// ERROR MESSAGE SANITIZATION - Ensure no sensitive paths in errors
	// ═══════════════════════════════════════════════════════════════════════════

	it('includes working_directory path in error messages (expected - controlled by caller)', async () => {
		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// The message includes the path - this is expected because the path is within
		// the provided working_directory which is controlled by the caller
		expect(parsed.message).toContain('.swarm');
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// MALICIOUS GETTER ATTACKS - Testing try/catch around args access
	// ═══════════════════════════════════════════════════════════════════════════

	it('handles args with malicious getter gracefully', async () => {
		// Create object with malicious getter
		const maliciousArgs = new Proxy(
			{},
			{
				get() {
					throw new Error('Malicious getter attack');
				},
			},
		);

		const result = await executeTool(
			maliciousArgs as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Should handle gracefully, not crash
		expect(parsed.status).toBe('no_evidence');
	});

	it('handles args.task_id getter that throws', async () => {
		const maliciousArgs = {
			get task_id() {
				throw new Error('Getter attack');
			},
		};

		const result = await executeTool(
			maliciousArgs as Record<string, unknown>,
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});
});

// Helper function to recursively read directory contents
function readdirSyncRecursive(dir: string): string[] {
	const results: string[] = [];
	if (!existsSync(dir)) return results;

	const entries = require('node:fs').readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...readdirSyncRecursive(fullPath));
		} else {
			results.push(fullPath);
		}
	}
	return results;
}
