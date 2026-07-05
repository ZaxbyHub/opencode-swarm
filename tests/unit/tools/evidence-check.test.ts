import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { evidence_check } from '../../../src/tools/evidence-check';

// Store original cwd
let originalCwd: string;
let testDir: string;

function setupTestDir() {
	// Create a unique temp directory
	const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'evidence-check-test-')));
	// Create .swarm directory structure
	mkdirSync(join(tmp, '.swarm', 'evidence'), { recursive: true });
	return tmp;
}

function createPlanFile(content: string) {
	writeFileSync(join(testDir, '.swarm', 'plan.md'), content, 'utf-8');
}

function createEvidenceFile(filename: string, content: object) {
	const filePath = join(testDir, '.swarm', 'evidence', filename);
	// Ensure the directory exists
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(content), 'utf-8');
}

function clearEvidenceDir() {
	const evidenceDir = join(testDir, '.swarm', 'evidence');
	try {
		rmSync(evidenceDir, { recursive: true, force: true });
		mkdirSync(evidenceDir, { recursive: true });
	} catch {
		// Directory might not exist
	}
}

function runEvidenceCheck(requiredTypes?: string) {
	const args = requiredTypes ? { required_types: requiredTypes } : {};
	const mockContext: ToolContext = {
		sessionID: 'test-session',
		messageID: 'test-message',
		agent: 'test-agent',
		directory: testDir,
		worktree: testDir,
		abort: new AbortController().signal,
		metadata: () => {},
		ask: async () => {},
	};
	return evidence_check.execute(args, mockContext);
}

async function parseResult(result: ReturnType<typeof evidence_check.execute>) {
	return JSON.parse(await result);
}

describe('evidence-check verification tests', () => {
	beforeEach(() => {
		originalCwd = process.cwd();
		testDir = setupTestDir();
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('1. Parses plan.md completed tasks correctly (extracts taskId and taskName)', async () => {
		createPlanFile(`
# Plan
- [x] 1.1: Implement feature X
- [x] 1.2: Fix bug Y
`);
		// Use valid filenames (no dots allowed in regex)
		createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
		createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });
		createEvidenceFile('1_2-review.json', { task_id: '1.2', type: 'review' });
		createEvidenceFile('1_2-test.json', { task_id: '1.2', type: 'test' });

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		expect(parsed.completedTasks).toHaveLength(2);
		expect(parsed.completedTasks[0].taskId).toBe('1.1');
		expect(parsed.completedTasks[0].taskName).toBe('Implement feature X');
		expect(parsed.completedTasks[1].taskId).toBe('1.2');
		expect(parsed.completedTasks[1].taskName).toBe('Fix bug Y');
		// Also verify evidence was found
		expect(parsed.tasksWithFullEvidence).toHaveLength(2);
		expect(parsed.completeness).toBe(1.0);
	});

	test('2. Strips [SMALL]/[MEDIUM]/[LARGE] size tags from task names', async () => {
		createPlanFile(`
- [x] 1.1: Task one [SMALL]
- [x] 1.2: Task two [MEDIUM]
- [x] 1.3: Task three [LARGE]
- [x] 1.4: Task without tag
`);
		createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
		createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });
		createEvidenceFile('1_2-review.json', { task_id: '1.2', type: 'review' });
		createEvidenceFile('1_2-test.json', { task_id: '1.2', type: 'test' });
		createEvidenceFile('1_3-review.json', { task_id: '1.3', type: 'review' });
		createEvidenceFile('1_3-test.json', { task_id: '1.3', type: 'test' });
		createEvidenceFile('1_4-review.json', { task_id: '1.4', type: 'review' });
		createEvidenceFile('1_4-test.json', { task_id: '1.4', type: 'test' });

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		expect(parsed.completedTasks[0].taskName).toBe('Task one');
		expect(parsed.completedTasks[1].taskName).toBe('Task two');
		expect(parsed.completedTasks[2].taskName).toBe('Task three');
		expect(parsed.completedTasks[3].taskName).toBe('Task without tag');
	});

	test('3. Identifies missing evidence types correctly (task has review but missing test)', async () => {
		createPlanFile(`
- [x] 1.1: Task with review only
`);
		createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'reviewer' });
		// No test evidence

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		expect(parsed.gaps).toHaveLength(1);
		expect(parsed.gaps[0].taskId).toBe('1.1');
		expect(parsed.gaps[0].missing).toContain('test_engineer');
		expect(parsed.gaps[0].present).toContain('reviewer');
	});

	test('4. Identifies tasks with full evidence (no gaps)', async () => {
		createPlanFile(`
- [x] 1.1: Complete task
- [x] 1.2: Another complete task
`);
		createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
		createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });
		createEvidenceFile('1_2-review.json', { task_id: '1.2', type: 'review' });
		createEvidenceFile('1_2-test.json', { task_id: '1.2', type: 'test' });

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		expect(parsed.tasksWithFullEvidence).toHaveLength(2);
		expect(parsed.gaps).toHaveLength(0);
		expect(parsed.completeness).toBe(1.0);
	});

	test('5. Completeness ratio: 1 gap out of 2 tasks = 0.5', async () => {
		createPlanFile(`
- [x] 1.1: Task one
- [x] 1.2: Task two
`);
		// Only task 1.1 has full evidence
		createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
		createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });
		// Task 1.2 is missing evidence

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		expect(parsed.completeness).toBe(0.5);
		expect(parsed.completedTasks).toHaveLength(2);
		expect(parsed.tasksWithFullEvidence).toHaveLength(1);
		expect(parsed.gaps).toHaveLength(1);
	});

	test('6. Completeness ratio: 0 gaps = 1.0', async () => {
		createPlanFile(`
- [x] 1.1: Task one
- [x] 1.2: Task two
- [x] 1.3: Task three
`);
		// All tasks have full evidence
		for (let i = 1; i <= 3; i++) {
			createEvidenceFile(`1_${i}-review.json`, {
				task_id: `1.${i}`,
				type: 'review',
			});
			createEvidenceFile(`1_${i}-test.json`, {
				task_id: `1.${i}`,
				type: 'test',
			});
		}

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		expect(parsed.completeness).toBe(1.0);
		expect(parsed.tasksWithFullEvidence).toHaveLength(3);
		expect(parsed.gaps).toHaveLength(0);
	});

	test('7. Handles missing evidence directory gracefully (returns completeness: 1.0 with gaps for all tasks)', async () => {
		createPlanFile(`
- [x] 1.1: Task one
- [x] 1.2: Task two
`);
		// Remove evidence directory
		rmSync(join(testDir, '.swarm', 'evidence'), {
			recursive: true,
			force: true,
		});

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		// Should report gaps for all tasks (missing both reviewer and test_engineer)
		expect(parsed.gaps).toHaveLength(2);
		expect(parsed.gaps[0].missing).toContain('reviewer');
		expect(parsed.gaps[0].missing).toContain('test_engineer');
		// Completeness is 0 because no tasks have full evidence
		expect(parsed.completeness).toBe(0);
	});

	test('8. Handles empty plan (no [x] tasks) → returns message + completeness: 1.0', async () => {
		createPlanFile(`
# Plan
- [ ] 1.1: Incomplete task
- [ ] 1.2: Another incomplete task
`);

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		expect(parsed.message).toBe('No completed tasks found in plan.');
		expect(parsed.completeness).toBe(1.0);
		expect(parsed.gaps).toHaveLength(0);
	});

	test('9. Handles corrupt JSON evidence files gracefully (skips them)', async () => {
		createPlanFile(`
- [x] 1.1: Task one
`);
		// Create a corrupt JSON file
		const corruptPath = join(testDir, '.swarm', 'evidence', 'corrupt.json');
		writeFileSync(corruptPath, '{ invalid json }', 'utf-8');
		// Create a valid evidence file
		createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
		createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		// Should still work - corrupt file is skipped
		expect(parsed.completeness).toBe(1.0);
		expect(parsed.tasksWithFullEvidence).toHaveLength(1);
	});

	test('10. Handles evidence file with wrong structure (no task_id/type fields) → skipped', async () => {
		createPlanFile(`
- [x] 1.1: Task one
`);
		// Create evidence file with wrong structure (valid filename but missing task_id/type)
		createEvidenceFile('1_1-wrong.json', {
			wrong_field: 'value',
			another: 123,
		});
		// Also create a valid one for same task
		createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
		createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		// Valid evidence should still work
		expect(parsed.completeness).toBe(1.0);
	});

	test('11. Custom required_types: "review,test,diff" — checks all three (legacy names normalized)', async () => {
		createPlanFile(`
- [x] 1.1: Task one
`);
		// Only review and test - missing diff (legacy types normalized to current gates)
		createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'reviewer' });
		createEvidenceFile('1_1-test.json', {
			task_id: '1.1',
			type: 'test_engineer',
		});

		const result = runEvidenceCheck('review,test,diff');
		const parsed = await parseResult(result);

		// Legacy types are normalized to current gate names
		expect(parsed.requiredTypes).toEqual(['reviewer', 'test_engineer', 'diff']);
		expect(parsed.gaps).toHaveLength(1);
		expect(parsed.gaps[0].missing).toContain('diff');
		expect(parsed.gaps[0].present).toContain('reviewer');
		expect(parsed.gaps[0].present).toContain('test_engineer');
	});
});

describe('evidence-check adversarial tests', () => {
	beforeEach(() => {
		originalCwd = process.cwd();
		testDir = setupTestDir();
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('1. Shell metacharacter in required_types: "review;rm -rf /" → returns error', async () => {
		createPlanFile(`
- [x] 1.1: Task one
`);

		const result = runEvidenceCheck('review;rm -rf /');
		const parsed = await parseResult(result);

		expect(parsed.error).toBeDefined();
		expect(parsed.error).toContain('shell metacharacters');
		expect(parsed.completeness).toBe(0);
	});

	test('2. Shell metacharacter in required_types: "review|cat /etc/passwd" → returns error', async () => {
		createPlanFile(`
- [x] 1.1: Task one
`);

		const result = runEvidenceCheck('review|cat /etc/passwd');
		const parsed = await parseResult(result);

		expect(parsed.error).toBeDefined();
		expect(parsed.error).toContain('shell metacharacters');
	});

	test('3. Evidence filename with path traversal: "../evil.json" → skipped (filename regex blocks it)', () => {
		createPlanFile(`
- [x] 1.1: Task one
`);
		// Test the filename regex - path traversal should be blocked
		const pathTraversalFilename = '../evil.json';
		const regex = /^[a-zA-Z0-9_-]+\.json$/;

		expect(regex.test(pathTraversalFilename)).toBe(false);

		// Also verify normal valid filenames with underscores work
		const validFilename = '1_1-review.json';
		expect(regex.test(validFilename)).toBe(true);

		// And verify filenames with dots are NOT valid (the regex doesn't allow dots)
		const dotFilename = '1.1-review.json';
		expect(regex.test(dotFilename)).toBe(false);
	});

	test('4. Evidence file >1MB → skipped', async () => {
		createPlanFile(`
- [x] 1.1: Task one
`);
		// Create a large evidence file (>1MB)
		const largeContent = 'x'.repeat(1024 * 1024 + 1); // >1MB
		createEvidenceFile('1_1-review.json', {
			task_id: '1.1',
			type: 'review',
			content: largeContent,
		});

		// Verify file is actually large
		const filePath = join(testDir, '.swarm', 'evidence', '1_1-review.json');
		const fileStat = statSync(filePath);
		expect(fileStat.size).toBeGreaterThan(1024 * 1024);

		// Also create a small valid file for the same task
		createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

		const result = runEvidenceCheck();
		const parsed = await parseResult(result);

		// Large file should be skipped, so task should have gap for reviewer
		expect(parsed.gaps).toHaveLength(1);
		expect(parsed.gaps[0].missing).toContain('reviewer');
		expect(parsed.gaps[0].present).toContain('test_engineer');
	});

	// ============ Dotted Filename Tests (Task 1.31) ============
	describe('dotted evidence filename support (task 1.31)', () => {
		test('1. Dotted task ID filenames like "1.21.json" are accepted', async () => {
			createPlanFile(`
- [x] 1.21: Dotted task
`);
			// Create evidence file with dotted filename (1.21.json)
			createEvidenceFile('1.21.json', { task_id: '1.21', type: 'review' });
			createEvidenceFile('1.21-review.json', { task_id: '1.21', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.completedTasks).toHaveLength(1);
			expect(parsed.completedTasks[0].taskId).toBe('1.21');
			expect(parsed.tasksWithFullEvidence).toContain('1.21');
			expect(parsed.completeness).toBe(1.0);
		});

		test('2. Multiple dotted segments in filename "1.21-review.json" work', async () => {
			createPlanFile(`
- [x] 1.21: Dotted task
`);
			// Test that filename with dot in the middle works (1.21-review.json)
			createEvidenceFile('1.21-review.json', {
				task_id: '1.21',
				type: 'review',
			});
			createEvidenceFile('1.21-test.json', { task_id: '1.21', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.tasksWithFullEvidence).toBeInstanceOf(Array);
			expect(parsed.tasksWithFullEvidence).toContain('1.21');
			expect(parsed.completeness).toBe(1.0);
		});

		test('3. Mixed dots and underscores like "1_2.3.json" are accepted', async () => {
			createPlanFile(`
- [x] 1.2: Mixed task
`);
			// Filename like "1_2-review.json" should work (underscore before dot)
			createEvidenceFile('1_2-review.json', { task_id: '1.2', type: 'review' });
			createEvidenceFile('1_2-test.json', { task_id: '1.2', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.tasksWithFullEvidence).toContain('1.2');
			expect(parsed.completeness).toBe(1.0);
		});

		test('4. Path traversal "../evil.json" is rejected by filename regex', async () => {
			createPlanFile(`
- [x] 1.1: Task one
`);
			// Create a file with path traversal attempt
			createEvidenceFile('../evil.json', { task_id: '1.1', type: 'review' });
			createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// ../evil.json should be skipped, so reviewer is missing
			expect(parsed.gaps).toHaveLength(1);
			expect(parsed.gaps[0].missing).toContain('reviewer');
			expect(parsed.gaps[0].present).toContain('test_engineer');
		});

		test('5. Trailing dot "file..json" is rejected', async () => {
			createPlanFile(`
- [x] 1.1: Task one
`);
			createEvidenceFile('file..json', { task_id: '1.1', type: 'review' });
			createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// file..json should be rejected (double dot)
			expect(parsed.gaps).toHaveLength(1);
			expect(parsed.gaps[0].missing).toContain('reviewer');
		});

		test('6. Leading dot ".hidden.json" is rejected', async () => {
			createPlanFile(`
- [x] 1.1: Task one
`);
			createEvidenceFile('.hidden.json', { task_id: '1.1', type: 'review' });
			createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// .hidden.json should be rejected (starts with dot)
			expect(parsed.gaps).toHaveLength(1);
			expect(parsed.gaps[0].missing).toContain('reviewer');
		});

		test('7. No .json extension "file.txt" is rejected', async () => {
			createPlanFile(`
- [x] 1.1: Task one
`);
			createEvidenceFile('file.txt', { task_id: '1.1', type: 'review' });
			createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// file.txt should be rejected (not .json)
			expect(parsed.gaps).toHaveLength(1);
			expect(parsed.gaps[0].missing).toContain('reviewer');
		});

		test('8. Filenames with spaces "my file.json" are rejected', async () => {
			createPlanFile(`
- [x] 1.1: Task one
`);
			createEvidenceFile('my file.json', { task_id: '1.1', type: 'review' });
			createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// "my file.json" should be rejected (spaces not allowed)
			expect(parsed.gaps).toHaveLength(1);
			expect(parsed.gaps[0].missing).toContain('reviewer');
		});
	});

	// ============ Deep Task ID Tests (Task 1.33) ============
	describe('deep completed task ID parsing (task 1.33)', () => {
		test('1. Task ID with two segments "1.2" is parsed correctly', async () => {
			createPlanFile(`
- [x] 1.2: Two segment task
`);
			createEvidenceFile('1_2-review.json', {
				task_id: '1.2',
				type: 'reviewer',
			});
			createEvidenceFile('1_2-test.json', {
				task_id: '1.2',
				type: 'test_engineer',
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.completedTasks).toHaveLength(1);
			expect(parsed.completedTasks[0].taskId).toBe('1.2');
			expect(parsed.completeness).toBe(1.0);
		});

		test('2. Task ID with three segments "1.2.3" is parsed correctly', async () => {
			createPlanFile(`
- [x] 1.2.3: Three segment task
`);
			createEvidenceFile('1_2_3-review.json', {
				task_id: '1.2.3',
				type: 'reviewer',
			});
			createEvidenceFile('1_2_3-test.json', {
				task_id: '1.2.3',
				type: 'test_engineer',
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.completedTasks).toHaveLength(1);
			expect(parsed.completedTasks[0].taskId).toBe('1.2.3');
			expect(parsed.completeness).toBe(1.0);
		});

		test('3. Task ID with four segments "1.2.3.4" is parsed correctly', async () => {
			createPlanFile(`
- [x] 1.2.3.4: Four segment task
`);
			createEvidenceFile('1_2_3_4-review.json', {
				task_id: '1.2.3.4',
				type: 'reviewer',
			});
			createEvidenceFile('1_2_3_4-test.json', {
				task_id: '1.2.3.4',
				type: 'test_engineer',
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.completedTasks).toHaveLength(1);
			expect(parsed.completedTasks[0].taskId).toBe('1.2.3.4');
			expect(parsed.completeness).toBe(1.0);
		});

		test('4. Multiple deep task IDs in same plan are parsed', async () => {
			createPlanFile(`
- [x] 1.1: Regular task
- [x] 1.21: Dotted task
- [x] 1.2.3: Deep task
- [x] 1.2.3.4: Deeper task
`);
			// Create evidence for all tasks
			createEvidenceFile('1_1-review.json', {
				task_id: '1.1',
				type: 'reviewer',
			});
			createEvidenceFile('1_1-test.json', {
				task_id: '1.1',
				type: 'test_engineer',
			});
			createEvidenceFile('1_21-review.json', {
				task_id: '1.21',
				type: 'reviewer',
			});
			createEvidenceFile('1_21-test.json', {
				task_id: '1.21',
				type: 'test_engineer',
			});
			createEvidenceFile('1_2_3-review.json', {
				task_id: '1.2.3',
				type: 'reviewer',
			});
			createEvidenceFile('1_2_3-test.json', {
				task_id: '1.2.3',
				type: 'test_engineer',
			});
			createEvidenceFile('1_2_3_4-review.json', {
				task_id: '1.2.3.4',
				type: 'reviewer',
			});
			createEvidenceFile('1_2_3_4-test.json', {
				task_id: '1.2.3.4',
				type: 'test_engineer',
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.completedTasks).toHaveLength(4);
			expect(parsed.completeness).toBe(1.0);
			expect(parsed.tasksWithFullEvidence).toHaveLength(4);
		});
	});

	// ============ Aggregate Gate-Evidence Tests (Task 1.32) ============
	describe('aggregate gate-evidence parsing (task 1.32)', () => {
		test('1. Aggregate format with gates object is expanded to individual evidence', async () => {
			createPlanFile(`
- [x] 1.1: Aggregate task
`);
			// Create aggregate gate-evidence file (new format)
			createEvidenceFile('1.1.json', {
				taskId: '1.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: { status: 'pass', evidence: 'review content' },
					test_engineer: { status: 'pass', evidence: 'test content' },
				},
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// Should find both reviewer and test_engineer evidence
			expect(parsed.completeness).toBe(1.0);
			expect(parsed.tasksWithFullEvidence).toContain('1.1');
		});

		test('2. Mixed aggregate and legacy flat formats work together', async () => {
			createPlanFile(`
- [x] 1.1: Task one
- [x] 1.2: Task two
`);
			// Task 1.1 uses aggregate format
			createEvidenceFile('1.1.json', {
				taskId: '1.1',
				gates: {
					reviewer: { status: 'pass' },
					test_engineer: { status: 'pass' },
				},
			});
			// Task 1.2 uses legacy flat format
			createEvidenceFile('1_2-review.json', {
				task_id: '1.2',
				type: 'reviewer',
			});
			createEvidenceFile('1_2-test.json', {
				task_id: '1.2',
				type: 'test_engineer',
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.completeness).toBe(1.0);
			expect(parsed.tasksWithFullEvidence).toContain('1.1');
			expect(parsed.tasksWithFullEvidence).toContain('1.2');
		});

		test('3. Aggregate format with only some gates present shows correct gaps', async () => {
			createPlanFile(`
- [x] 1.1: Partial aggregate task
`);
			// Aggregate with only reviewer gate
			createEvidenceFile('1.1.json', {
				taskId: '1.1',
				gates: {
					reviewer: { status: 'pass' },
				},
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// Should have gap for test_engineer
			expect(parsed.gaps).toHaveLength(1);
			expect(parsed.gaps[0].taskId).toBe('1.1');
			expect(parsed.gaps[0].missing).toContain('test_engineer');
			expect(parsed.gaps[0].present).toContain('reviewer');
		});

		test('4. Aggregate format with legacy type names "review" and "test" are normalized', async () => {
			createPlanFile(`
- [x] 1.1: Legacy aggregate task
`);
			// Aggregate with legacy type names (lowercase)
			createEvidenceFile('1.1.json', {
				taskId: '1.1',
				gates: {
					review: { status: 'pass' },
					test: { status: 'pass' },
				},
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// Normalized to reviewer and test_engineer, should pass
			expect(parsed.completeness).toBe(1.0);
			expect(parsed.tasksWithFullEvidence).toContain('1.1');
		});
	});

	// ============ Legacy Type Normalization Tests (Task 1.32) ============
	describe('legacy evidence type normalization (task 1.32)', () => {
		test('1. Legacy "review" type is normalized to "reviewer"', async () => {
			createPlanFile(`
- [x] 1.1: Legacy review task
`);
			// Use legacy "review" type (not "reviewer")
			createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
			createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// Default required types are "reviewer,test_engineer"
			// Legacy "review" should map to "reviewer" and pass
			// Legacy "test" should map to "test_engineer" and pass
			expect(parsed.requiredTypes).toEqual(['reviewer', 'test_engineer']);
			expect(parsed.completeness).toBe(1.0);
			expect(parsed.tasksWithFullEvidence).toContain('1.1');
		});

		test('2. Legacy "test" type is normalized to "test_engineer"', async () => {
			createPlanFile(`
- [x] 1.1: Legacy test task
`);
			createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
			createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.requiredTypes).toEqual(['reviewer', 'test_engineer']);
			expect(parsed.completeness).toBe(1.0);
		});

		test('3. Custom required_types with legacy names are normalized', async () => {
			createPlanFile(`
- [x] 1.1: Custom legacy task
`);
			// Use legacy names in custom required_types
			createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' });
			createEvidenceFile('1_1-test.json', { task_id: '1.1', type: 'test' });

			const result = runEvidenceCheck('review,test,diff');
			const parsed = await parseResult(result);

			// Legacy types should be normalized to current gate names
			expect(parsed.requiredTypes).toEqual([
				'reviewer',
				'test_engineer',
				'diff',
			]);
			// Both reviewer and test_engineer should be present
			expect(parsed.gaps).toHaveLength(1);
			expect(parsed.gaps[0].missing).toContain('diff');
		});

		test('4. Default required_types are "reviewer,test_engineer" (not legacy names)', async () => {
			createPlanFile(`
- [x] 1.1: Default types task
`);
			// Use current gate type names
			createEvidenceFile('1_1-review.json', {
				task_id: '1.1',
				type: 'reviewer',
			});
			createEvidenceFile('1_1-test.json', {
				task_id: '1.1',
				type: 'test_engineer',
			});

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			expect(parsed.requiredTypes).toEqual(['reviewer', 'test_engineer']);
			expect(parsed.completeness).toBe(1.0);
		});

		test('5. Mixed legacy and current type names both work', async () => {
			createPlanFile(`
- [x] 1.1: Mixed types task
`);
			// Mix of legacy and current type names
			createEvidenceFile('1_1-review.json', { task_id: '1.1', type: 'review' }); // legacy
			createEvidenceFile('1_1-test.json', {
				task_id: '1.1',
				type: 'test_engineer',
			}); // current

			const result = runEvidenceCheck();
			const parsed = await parseResult(result);

			// Both should normalize to required types
			expect(parsed.completeness).toBe(1.0);
		});
	});
});
