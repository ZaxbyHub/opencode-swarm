/**
 * Adversarial tests for check_gate_status plugin registration
 *
 * Tests boundary and misuse cases relevant to plugin registration:
 * - Duplicate registration
 * - Missing import scenarios
 * - Conflicting names
 * - Broken tool structure
 * - Regression risk to existing registered tools
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AGENT_TOOL_MAP } from '../../src/config/constants';
import { check_gate_status } from '../../src/tools/check-gate-status';
import { TOOL_NAME_SET, TOOL_NAMES } from '../../src/tools/tool-names';

// Test workspace setup
let testWorkspace: string;

beforeEach(() => {
	testWorkspace = mkdtempSync(path.join(tmpdir(), 'check-gate-status-test-'));
});

afterEach(() => {
	if (testWorkspace && fs.existsSync(testWorkspace)) {
		rmSync(testWorkspace, { recursive: true, force: true });
	}
});

describe('check_gate_status tool registration integrity', () => {
	describe('TOOL_NAMES and TOOL_NAME_SET registration', () => {
		it('should have check_gate_status in TOOL_NAMES', () => {
			expect(TOOL_NAMES).toContain('check_gate_status');
		});

		it('should have check_gate_status in TOOL_NAME_SET', () => {
			expect(TOOL_NAME_SET.has('check_gate_status')).toBe(true);
		});
	});

	describe('tool structure validation', () => {
		it('should export a valid tool object', () => {
			expect(check_gate_status).toBeDefined();
			expect(typeof check_gate_status).toBe('object');
		});

		it('should have a description property', () => {
			expect(check_gate_status).toHaveProperty('description');
			expect(typeof check_gate_status.description).toBe('string');
			expect(check_gate_status.description.length).toBeGreaterThan(0);
		});

		it('should have an args schema', () => {
			expect(check_gate_status).toHaveProperty('args');
			expect(typeof check_gate_status.args).toBe('object');
		});

		it('should have task_id in args schema', () => {
			expect(check_gate_status.args).toHaveProperty('task_id');
		});

		it('should have an execute function', () => {
			expect(check_gate_status).toHaveProperty('execute');
			expect(typeof check_gate_status.execute).toBe('function');
		});
	});
});

describe('check_gate_status import and registration paths', () => {
	it('should be importable from tools index', () => {
		expect(() => {
			require('../../src/tools').check_gate_status;
		}).not.toThrow();
	});

	it('should have consistent export in both index.ts and tools/index.ts', () => {
		// Verify the tool exists in both locations
		const fromIndex = require('../../src/tools').check_gate_status;
		const fromDirect =
			require('../../src/tools/check-gate-status').check_gate_status;

		expect(fromIndex).toBeDefined();
		expect(fromDirect).toBeDefined();
		expect(fromIndex).toBe(fromDirect);
	});
});

describe('check_gate_status argument validation', () => {
	it('should reject missing task_id', async () => {
		const result = await check_gate_status.execute({}, {} as any);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id');
	});

	it('should reject invalid task_id format - empty string', async () => {
		const result = await check_gate_status.execute({ task_id: '' }, {} as any);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id');
	});

	it('should reject invalid task_id format - letters', async () => {
		const result = await check_gate_status.execute(
			{ task_id: 'abc' },
			{} as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	it('should reject invalid task_id format - special characters', async () => {
		const result = await check_gate_status.execute(
			{ task_id: '1.1<script>' },
			{} as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	it('should reject path traversal in task_id', async () => {
		const result = await check_gate_status.execute(
			{ task_id: '../etc/passwd' },
			{} as any,
		);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	it('should accept valid task_id format N.M', async () => {
		const result = await check_gate_status.execute({ task_id: '1.1' }, {
			directory: testWorkspace,
		} as any);
		const parsed = JSON.parse(result);

		// Should not be a validation error - will be "no_evidence" since file doesn't exist
		expect(parsed.message).not.toContain('Invalid task_id');
	});

	it('should accept valid task_id format N.M.P', async () => {
		const result = await check_gate_status.execute({ task_id: '1.2.3' }, {
			directory: testWorkspace,
		} as any);
		const parsed = JSON.parse(result);

		expect(parsed.message).not.toContain('Invalid task_id');
	});
});

describe('check_gate_status path security', () => {
	it('should restrict evidence path to .swarm/evidence directory', async () => {
		// The tool should never allow escaping the evidence directory
		const result = await check_gate_status.execute({ task_id: '1.1' }, {
			directory: testWorkspace,
		} as any);
		const parsed = JSON.parse(result);

		// Should either validate the path correctly or return no_evidence for missing file
		// Should NOT expose any path traversal in the error message
		expect(parsed.message).not.toContain('..');
	});

	it('should handle missing evidence file gracefully', async () => {
		const result = await check_gate_status.execute({ task_id: '9.99' }, {
			directory: testWorkspace,
		} as any);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.taskId).toBe('9.99');
	});
});

describe('check_gate_status evidence file processing', () => {
	it('should parse valid evidence JSON', async () => {
		// Create valid evidence file
		const evidenceDir = path.join(testWorkspace, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });

		const evidenceData = {
			taskId: '1.1',
			required_gates: ['lint', 'test'],
			gates: {
				lint: { sessionId: 's1', timestamp: '2024-01-01', agent: 'reviewer' },
			},
		};

		writeFileSync(
			path.join(evidenceDir, '1.1.json'),
			JSON.stringify(evidenceData),
		);

		const result = await check_gate_status.execute({ task_id: '1.1' }, {
			directory: testWorkspace,
		} as any);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('incomplete');
		expect(parsed.required_gates).toEqual(['lint', 'test']);
		expect(parsed.passed_gates).toContain('lint');
		expect(parsed.missing_gates).toContain('test');
	});

	it('should return all_passed when all gates are complete', async () => {
		const evidenceDir = path.join(testWorkspace, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });

		const evidenceData = {
			taskId: '2.1',
			required_gates: ['lint', 'test', 'review'],
			gates: {
				lint: { sessionId: 's1', timestamp: '2024-01-01', agent: 'reviewer' },
				test: {
					sessionId: 's2',
					timestamp: '2024-01-01',
					agent: 'test_engineer',
				},
				review: { sessionId: 's3', timestamp: '2024-01-01', agent: 'reviewer' },
			},
		};

		writeFileSync(
			path.join(evidenceDir, '2.1.json'),
			JSON.stringify(evidenceData),
		);

		const result = await check_gate_status.execute({ task_id: '2.1' }, {
			directory: testWorkspace,
		} as any);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('all_passed');
		expect(parsed.passed_gates).toHaveLength(3);
		expect(parsed.missing_gates).toHaveLength(0);
	});

	it('should reject malformed JSON evidence file', async () => {
		const evidenceDir = path.join(testWorkspace, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });

		writeFileSync(path.join(evidenceDir, '3.1.json'), 'not valid json {');

		const result = await check_gate_status.execute({ task_id: '3.1' }, {
			directory: testWorkspace,
		} as any);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('No evidence file found');
	});

	it('should reject evidence file missing required_gates', async () => {
		const evidenceDir = path.join(testWorkspace, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });

		writeFileSync(
			path.join(evidenceDir, '4.1.json'),
			JSON.stringify({ taskId: '4.1', gates: {} }),
		);

		const result = await check_gate_status.execute({ task_id: '4.1' }, {
			directory: testWorkspace,
		} as any);
		const parsed = JSON.parse(result);

		// Should treat as invalid/missing evidence
		expect(parsed.status).toBe('no_evidence');
	});
});

describe('regression: existing tool registrations', () => {
	const existingTools = [
		'checkpoint',
		'complexity_hotspots',
		'detect_domains',
		'evidence_check',
		'extract_code_blocks',
		'gitingest',
		'imports',
		'knowledge_query',
		'lint',
		'diff',
		'pkg_audit',
		'pre_check_batch',
		'retrieve_summary',
		'save_plan',
		'schema_drift',
		'secretscan',
		'symbols',
		'test_runner',
		'todo_extract',
		'update_task_status',
		'write_retro',
		'declare_scope',
	];

	it.each(existingTools)('should have %s in TOOL_NAMES', (toolName) => {
		expect(TOOL_NAMES).toContain(toolName);
	});

	it.each(existingTools)('should have %s in TOOL_NAME_SET', (toolName) => {
		expect(TOOL_NAME_SET.has(toolName as any)).toBe(true);
	});

	// extract_code_blocks is a write tool (issue #1778 C1); the architect is a
	// delegating orchestrator that holds no write tool (capability-drift-guard
	// invariant), so it is excluded from the architect-tools membership check.
	it.each(existingTools.filter((t) => t !== 'extract_code_blocks'))(
		'should have %s in architect tools',
		(toolName) => {
			expect(AGENT_TOOL_MAP.architect).toContain(toolName);
		},
	);

	it('should NOT have extract_code_blocks in architect tools (write tool, #1778 C1)', () => {
		expect(AGENT_TOOL_MAP.architect).not.toContain('extract_code_blocks');
	});
});

describe('duplicate and conflicting registration scenarios', () => {
	it('should not have duplicate entries in TOOL_NAMES', () => {
		const counts = new Map<string, number>();
		for (const name of TOOL_NAMES) {
			counts.set(name, (counts.get(name) || 0) + 1);
		}

		const duplicates = Array.from(counts.entries())
			.filter(([_, count]) => count > 1)
			.map(([name]) => name);

		expect(duplicates).toEqual([]);
	});

	it('should have unique tool names in AGENT_TOOL_MAP.architect', () => {
		const tools = AGENT_TOOL_MAP.architect;
		const uniqueTools = new Set(tools);

		expect(uniqueTools.size).toBe(tools.length);
	});

	it('check_gate_status should not duplicate other tool names', () => {
		const otherTools = existingTools.filter((t) => t !== 'check_gate_status');

		for (const tool of otherTools) {
			expect('check_gate_status').not.toBe(tool);
		}
	});
});

describe('tool name collision detection', () => {
	it('should detect if check_gate_status collides with any existing tool', () => {
		const allTools = new Set([...TOOL_NAMES]);

		// check_gate_status should be in the set
		expect(allTools.has('check_gate_status')).toBe(true);

		// It should not collide with any other tool
		const collisions = [...allTools].filter(
			(t) =>
				t !== 'check_gate_status' &&
				(t.includes('check_gate') || 'check_gate_status'.includes(t)),
		);

		expect(collisions).toEqual([]);
	});
});

// Helper for the regression test
const existingTools = [
	'checkpoint',
	'complexity_hotspots',
	'detect_domains',
	'evidence_check',
	'extract_code_blocks',
	'gitingest',
	'imports',
	'knowledge_query',
	'lint',
	'diff',
	'pkg_audit',
	'pre_check_batch',
	'retrieve_summary',
	'save_plan',
	'schema_drift',
	'secretscan',
	'symbols',
	'test_runner',
	'todo_extract',
	'update_task_status',
	'write_retro',
	'declare_scope',
];
