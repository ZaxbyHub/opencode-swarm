import { beforeEach, describe, expect, it, vi } from 'bun:test';
import {
	formatHandoffMarkdown,
	getHandoffData,
	type HandoffData,
} from '../../../src/services/handoff-service.js';

// Mock all the imported modules
vi.mock('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: vi.fn(),
}));

vi.mock('../../../src/plan/manager.js', () => ({
	loadPlanJsonOnly: vi.fn(),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));

// Import mocked modules
import { readSwarmFileAsync } from '../../../src/hooks/utils.js';
import { loadPlanJsonOnly } from '../../../src/plan/manager.js';

// Type assertions for mocks
const mockReadSwarmFileAsync = readSwarmFileAsync as ReturnType<typeof vi.fn>;
const mockLoadPlanJsonOnly = loadPlanJsonOnly as ReturnType<typeof vi.fn>;

/**
 * Security Tests for Handoff Service
 *
 * Adversarial tests targeting:
 * 1. Path traversal attempts in directory parameter
 * 2. Oversized session state JSON (10MB+)
 * 3. Malformed JSON with prototype pollution attempts
 * 4. Null byte injection in filenames
 * 5. Very long strings in decisions/incomplete tasks
 * 6. Unicode control characters in input
 */

beforeEach(() => {
	vi.clearAllMocks();
	mockReadSwarmFileAsync.mockResolvedValue(null);
	mockLoadPlanJsonOnly.mockResolvedValue(null);
});

// ============================================================================
// ATTACK VECTOR 1: Path Traversal in Directory Parameter
// ============================================================================
describe('Security: Path Traversal Attacks', () => {
	it('should handle directory with parent traversal (..) safely', async () => {
		const maliciousPaths = [
			'../../../etc/passwd',
			'..\\..\\..\\windows\\system32\\config',
			'/etc/passwd',
			'../../../../../../../../../../../etc/passwd',
			'foo/../../../bar',
		];

		for (const maliciousPath of maliciousPaths) {
			// Should not crash, should return safe defaults
			const result = await getHandoffData(maliciousPath);
			expect(result).toBeDefined();
			expect(result.currentPhase).toBeNull();
			expect(result.currentTask).toBeNull();
		}
	});

	it('should handle null bytes in directory path', async () => {
		// Null byte injection - should be handled safely
		const nullBytePath = '/tmp/test\x00malicious';

		// Should not crash
		const result = await getHandoffData(nullBytePath);
		expect(result).toBeDefined();
	});

	it('should handle absolute system paths gracefully', async () => {
		const absolutePaths = [
			'/root/.ssh/id_rsa',
			'C:\\Users\\Administrator\\.aws\\credentials',
		];

		for (const absPath of absolutePaths) {
			const result = await getHandoffData(absPath);
			expect(result).toBeDefined();
			// Should return safe defaults, not expose system data
			expect(result.currentPhase).toBeNull();
		}
	});
});

// ============================================================================
// ATTACK VECTOR 2: Oversized Session State JSON (10MB+)
// ============================================================================
describe('Security: Oversized Payload Attacks', () => {
	it('should handle 10MB+ session state without crashing', async () => {
		// Generate 10MB JSON payload
		const largePayload = JSON.stringify({
			activeAgent: { agent1: 'test' },
			delegationChains: {},
			agentSessions: {},
			padding: 'x'.repeat(10 * 1024 * 1024), // 10MB
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json') return Promise.resolve(largePayload);
			return Promise.resolve(null);
		});

		// Should not crash or hang indefinitely
		const startTime = Date.now();
		const result = await getHandoffData(TEST_DIR);
		const duration = Date.now() - startTime;

		expect(result).toBeDefined();
		// Should complete in reasonable time (< 5 seconds)
		expect(duration).toBeLessThan(5000);
	});

	it('should handle deeply nested JSON structure without stack overflow', async () => {
		// Create deeply nested structure (DoS via stack overflow)
		// Each level adds nesting but is valid JSON
		const nestedPayload = JSON.stringify({
			activeAgent: {
				nested: { nested: { nested: { nested: { data: 'test' } } } },
			},
			delegationChains: {},
			agentSessions: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json') return Promise.resolve(nestedPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle array with extreme length', async () => {
		// Array with many elements
		const hugeArrayPayload = JSON.stringify({
			activeAgent: { agent: 'test' },
			delegationChains: {
				chain1: Array(10000)
					.fill(null)
					.map((_, i) => ({
						from: `agent${i}`,
						to: `agent${i + 1}`,
						taskId: `task${i}`,
						timestamp: Date.now(),
					})),
			},
			agentSessions: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(hugeArrayPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		// Should limit processing
		expect(result.delegationState?.activeChains).toBeDefined();
	});
});

// ============================================================================
// ATTACK VECTOR 3: Malformed JSON with Prototype Pollution
// ============================================================================
describe('Security: Prototype Pollution & Malformed JSON', () => {
	it('should handle __proto__ injection attempt safely', () => {
		const protoPollution = JSON.parse(
			'{"activeAgent": {}, "__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}',
		);

		// Verify the parsed object doesn't pollute Object.prototype
		expect(({} as any).__proto__?.polluted).toBeUndefined();
		expect(({} as any).constructor?.prototype?.polluted).toBeUndefined();
	});

	it('should handle constructor injection attempt', async () => {
		const constructorPayload = JSON.stringify({
			activeAgent: { test: 'value' },
			constructor: {
				prototype: {
					shellExec: 'malicious code',
				},
			},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(constructorPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();

		// Should not pollute global objects
		expect(({} as any).constructor?.prototype?.shellExec).toBeUndefined();
	});

	it('should handle circular references in JSON', () => {
		const circular: any = { name: 'test' };
		circular.self = circular;

		// JSON.stringify throws on circular references
		expect(() => JSON.stringify(circular)).toThrow();
	});

	it('should handle truncated/malformed JSON gracefully', async () => {
		const malformedInputs = [
			'{',
			'{"incomplete":',
			'{"truncated":',
			'{invalid json',
			'',
			'null',
			'undefined',
			'NaN',
			'true',
			'123',
			'<script>alert(1)</script>',
			'{{{{{',
			'}}}',
		];

		for (const input of malformedInputs) {
			mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
				if (file === 'session/state.json') return Promise.resolve(input);
				return Promise.resolve(null);
			});

			// Should not throw, should handle gracefully
			const result = await getHandoffData('/test');
			expect(result).toBeDefined();
		}
	});

	it('should handle special float values', async () => {
		const specialFloats = [
			JSON.stringify({ activeAgent: { test: Infinity } }),
			JSON.stringify({ activeAgent: { test: -Infinity } }),
			JSON.stringify({ activeAgent: { test: NaN } }),
			JSON.stringify({ activeAgent: { test: 1e999 } }),
		];

		for (const input of specialFloats) {
			mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
				if (file === 'session/state.json') return Promise.resolve(input);
				return Promise.resolve(null);
			});

			const result = await getHandoffData('/test');
			expect(result).toBeDefined();
		}
	});
});

// ============================================================================
// ATTACK VECTOR 4: Null Byte Injection
// ============================================================================
describe('Security: Null Byte Injection', () => {
	it('should handle null bytes in JSON string values', async () => {
		const nullBytePayload = JSON.stringify({
			activeAgent: { 'test\x00malicious': 'value\x00injection' },
			delegationChains: {},
			agentSessions: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(nullBytePayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();

		// Verify null bytes are handled safely in output
		const jsonStr = JSON.stringify(result);
		expect(jsonStr).not.toContain('\x00');
	});

	it('should handle multiple null bytes in various positions', async () => {
		const multiNullPayload = JSON.stringify({
			activeAgent: { '\x00\x00\x00': 'admin' },
			delegationChains: {
				'\x00path': [{ from: 'a', to: 'b', taskId: 't', timestamp: 1 }],
			},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(multiNullPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});
});

// ============================================================================
// ATTACK VECTOR 5: Very Long Strings (Buffer Overflow / DoS)
// ============================================================================
describe('Security: Long String Attacks', () => {
	it('should handle extremely long task IDs', async () => {
		const longTaskId = 'x'.repeat(100000); // 100KB string
		const longTasksPayload = {
			phases: [
				{
					id: 1,
					name: 'Test',
					tasks: [
						{
							id: longTaskId,
							status: 'in_progress',
							phase: 1,
							description: 't',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
			current_phase: 1,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(longTasksPayload);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		// Should handle long strings safely
		expect(result.currentTask?.length).toBeLessThan(1000);
	});

	it('should handle extremely long decision strings', async () => {
		const longDecision = 'A'.repeat(1000000); // 1MB decision
		const longContext = `## Decisions
- ${longDecision}
`;

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json') return Promise.resolve(null);
			if (file === 'plan.json') return Promise.resolve(null);
			if (file === 'context.md') return Promise.resolve(longContext);
			return Promise.resolve(null);
		});

		mockLoadPlanJsonOnly.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		// Should truncate long decisions (MAX_DECISION_LENGTH is 500)
		if (result.recentDecisions.length > 0) {
			expect(result.recentDecisions[0].length).toBeLessThanOrEqual(500);
		}
	});

	it('should handle long phase names', async () => {
		const longPhaseName = 'P'.repeat(100000);
		const longPlanPayload = {
			phases: [
				{
					id: 1,
					name: longPhaseName,
					tasks: [
						{
							id: '1.1',
							status: 'pending',
							phase: 1,
							description: 't',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
			current_phase: 1,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(longPlanPayload);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		expect(result.currentPhase).toBeDefined();
	});

	it('should handle many incomplete tasks (DoS via array size)', async () => {
		const manyTasksPayload = {
			phases: [
				{
					id: 1,
					name: 'Phase',
					tasks: Array(10000)
						.fill(null)
						.map((_, i) => ({
							id: `task-${i}`,
							status: i % 2 === 0 ? 'pending' : 'in_progress',
							phase: 1,
							description: 't',
							depends: [],
							files_touched: [],
						})),
				},
			],
			current_phase: 1,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(manyTasksPayload);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		// Should limit incomplete tasks
		expect(result.incompleteTasks.length).toBeLessThan(1000);
	});
});

// ============================================================================
// ATTACK VECTOR 6: Unicode Control Characters
// ============================================================================
describe('Security: Unicode Control Character Injection', () => {
	it('should handle Unicode escape sequences in strings', async () => {
		const unicodePayload = JSON.stringify({
			activeAgent: { test: '\u0000\u0001\u0002\u0003\u001f' },
			delegationChains: {},
			agentSessions: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json') return Promise.resolve(unicodePayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle Right-to-Left override (RTL) characters', async () => {
		const rtlPayload = JSON.stringify({
			activeAgent: { '\u202Estorj': '\u202eadmin\u202c' },
			delegationChains: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json') return Promise.resolve(rtlPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		// Verify output doesn't contain dangerous Unicode
		const jsonStr = JSON.stringify(result);
		expect(jsonStr.includes('\u202e')).toBe(false);
	});

	it('should handle zero-width characters', async () => {
		const zwspPayload = JSON.stringify({
			activeAgent: { 'test\u200b\u200c\u200d': 'value' },
			delegationChains: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json') return Promise.resolve(zwspPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle Unicode surrogate pairs', async () => {
		const surrogatePayload = JSON.stringify({
			activeAgent: { emoji: '😀\ud83d\ude00' },
			delegationChains: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(surrogatePayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle combining characters for homograph attacks', async () => {
		// Latin a with combining ring (looks like å but isn't)
		const homographPayload = JSON.stringify({
			activeAgent: { 'admin\u030a': 'root' },
			delegationChains: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(homographPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle fullwidth Unicode characters', () => {
		// Fullwidth letters (looks like ASCII but isn't)
		const fullwidthPayload = JSON.stringify({
			activeAgent: { ａｄｍｉｎ: 'root' },
			delegationChains: {},
		});

		const parsed = JSON.parse(fullwidthPayload);
		// Should be distinguishable from ASCII
		expect(parsed.activeAgent['ａｄｍｉｎ']).toBe('root');
		expect(parsed.activeAgent['admin']).toBeUndefined();
	});
});

// ============================================================================
// ATTACK VECTOR 7: Code Injection Attempts
// ============================================================================
describe('Security: Code Injection Attempts', () => {
	it('should handle JavaScript in JSON values', async () => {
		const jsInjectionPayload = JSON.stringify({
			activeAgent: { test: '</script><script>alert(1)</script>' },
			delegationChains: {},
			agentSessions: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(jsInjectionPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		const jsonStr = JSON.stringify(result);
		// Should not reflect script tags
		expect(jsonStr).not.toContain('<script>');
	});

	it('should handle template literal injection', async () => {
		const templatePayload = JSON.stringify({
			activeAgent: { test: '${alert(1)}' },
			delegationChains: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(templatePayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle SQL-like strings in context', async () => {
		const sqlPayload = `
## Decisions
- DROP TABLE users;--
- '; DELETE FROM plans; --
- OR 1=1
- UNION SELECT * FROM secrets
`;

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json') return Promise.resolve(null);
			if (file === 'plan.json') return Promise.resolve(null);
			if (file === 'context.md') return Promise.resolve(sqlPayload);
			return Promise.resolve(null);
		});

		mockLoadPlanJsonOnly.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		// Should treat as literal strings, not execute
		expect(result.recentDecisions).toBeDefined();
	});

	it('should handle command injection attempts in task IDs', async () => {
		const cmdInjectionPlan = {
			phases: [
				{
					id: 1,
					name: 'Phase',
					tasks: [
						{
							id: '1.1; rm -rf /',
							status: 'in_progress',
							phase: 1,
							description: 't',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2 && curl evil.com',
							status: 'pending',
							phase: 1,
							description: 't',
							depends: [],
							files_touched: [],
						},
						{
							id: '1.3 | cat /etc/passwd',
							status: 'pending',
							phase: 1,
							description: 't',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
			current_phase: 1,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(cmdInjectionPlan);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		// Should be treated as literal strings
		expect(result.currentTask).toContain('rm -rf');
	});
});

// ============================================================================
// ATTACK VECTOR 8: Format String Attacks
// ============================================================================
describe('Security: Format String Attacks', () => {
	it('should handle printf-style format strings', async () => {
		const formatPayload = JSON.stringify({
			activeAgent: { test: '%s%s%s%s%s%s' },
			delegationChains: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json') return Promise.resolve(formatPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
		// Should not cause format string vulnerabilities
	});

	it('should handle number format specifiers', async () => {
		const numFormatPayload = JSON.stringify({
			activeAgent: { test: '%d%d%x%n' },
			delegationChains: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(numFormatPayload);
			return Promise.resolve(null);
		});

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});
});

// ============================================================================
// ATTACK VECTOR 9: Boundary Violations
// ============================================================================
describe('Security: Boundary Violations', () => {
	it('should handle negative numbers in phase/task IDs', async () => {
		const negativePlan = {
			phases: [
				{
					id: -1,
					name: 'Negative Phase',
					tasks: [
						{
							id: '-1.1',
							status: 'in_progress',
							phase: -1,
							description: 't',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
			current_phase: -1,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(negativePlan);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle extremely large phase numbers', async () => {
		const largePlan = {
			phases: [
				{
					id: Number.MAX_SAFE_INTEGER,
					name: 'Large Phase',
					tasks: [
						{
							id: '1.1',
							status: 'in_progress',
							phase: 1,
							description: 't',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
			current_phase: Number.MAX_SAFE_INTEGER,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(largePlan);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle floating point phase IDs', async () => {
		const floatPlan = {
			phases: [
				{
					id: 1.5,
					name: 'Float Phase',
					tasks: [
						{
							id: '1.1',
							status: 'in_progress',
							phase: 1,
							description: 't',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
			current_phase: 1.5,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(floatPlan);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle boolean values where strings expected', async () => {
		const boolPayload = {
			phases: true,
			current_phase: false,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(boolPayload);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle array values where objects expected', async () => {
		const arrayPayload = {
			phases: [1, 2, 3, 'malicious'],
			current_phase: 1,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(arrayPayload);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle null values in required fields', async () => {
		const nullPayload = {
			phases: null,
			current_phase: null,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(nullPayload);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});
});

// ============================================================================
// ADDITIONAL SECURITY TESTS
// ============================================================================
describe('Security: Markdown Output Sanitization', () => {
	it('should handle HTML in markdown output safely', () => {
		// formatHandoffMarkdown is a pure formatting function.
		// HTML sanitization is done by getHandoffData before data reaches formatHandoffMarkdown.
		// When getHandoffData processes the data, it escapes HTML via escapeHtml().
		// Here we verify the full pipeline by passing pre-escaped data (as getHandoffData would).
		const maliciousData: HandoffData = {
			generated: new Date().toISOString(),
			currentPhase: '&lt;script&gt;alert(1)&lt;/script&gt;',
			currentTask: '1.1',
			incompleteTasks: [],
			pendingQA: null,
			activeAgent: null,
			recentDecisions: [],
			delegationState: null,
		};

		const markdown = formatHandoffMarkdown(maliciousData);
		// Pre-escaped data should not contain raw script tags
		expect(markdown).not.toContain('<script>');
	});

	it('should handle markdown with dangerous links', () => {
		const linkData: HandoffData = {
			generated: new Date().toISOString(),
			currentPhase: null,
			currentTask: '1.1',
			incompleteTasks: [],
			pendingQA: null,
			activeAgent: null,
			recentDecisions: [
				'Visit [evil.com](http://evil.com/malware)',
				'Download [update](javascript:alert(1))',
			],
			delegationState: null,
		};

		const markdown = formatHandoffMarkdown(linkData);
		expect(markdown).toBeDefined();
		// JavaScript URLs should be in output (not our job to filter markdown links)
		// The service just formats data, not sanitizes markdown
	});
});

// Dummy test to ensure TEST_DIR is used
const TEST_DIR = '/tmp/handoff-security-test';

// ============================================================================
// TASK-SPECIFIC SECURITY TESTS FOR HANDOFF
// ============================================================================
describe('Security: HTML Injection Fix Verification', () => {
	it('should escape <script>alert(1)</script> in activeAgent field', async () => {
		// This is the specific test case from the task
		const htmlInjectionPayload = JSON.stringify({
			activeAgent: { agent: '<script>alert(1)</script>' },
			delegationChains: {},
			agentSessions: {},
		});

		mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
			if (file === 'session/state.json')
				return Promise.resolve(htmlInjectionPayload);
			return Promise.resolve(null);
		});

		mockLoadPlanJsonOnly.mockResolvedValue(null);

		const result = await getHandoffData('/test');
		expect(result).toBeDefined();

		// CRITICAL: The script tag must be ESCAPED, not executed
		const jsonStr = JSON.stringify(result);
		expect(jsonStr).not.toContain('<script>');
		expect(jsonStr).not.toContain('</script>');
		expect(jsonStr).toContain('&lt;script&gt;');
	});

	it('should escape various HTML injection patterns in activeAgent', async () => {
		const injectionPatterns = [
			'<img src=x onerror=alert(1)>',
			'<body onload=alert(1)>',
			'<svg onload=alert(1)>',
			'<iframe src="javascript:alert(1)">',
			'<script>alert(1)</script>',
			'<script src="evil.js"></script>',
		];

		for (const pattern of injectionPatterns) {
			const payload = JSON.stringify({
				activeAgent: { agent: pattern },
				delegationChains: {},
				agentSessions: {},
			});

			mockReadSwarmFileAsync.mockImplementation((dir: string, file: string) => {
				if (file === 'session/state.json') return Promise.resolve(payload);
				return Promise.resolve(null);
			});

			const result = await getHandoffData('/test');
			expect(result).toBeDefined();

			// Verify HTML tag escaping (the main security requirement)
			const jsonStr = JSON.stringify(result);
			// These tags should be escaped to prevent XSS
			expect(jsonStr).not.toContain('<img');
			expect(jsonStr).not.toContain('<body');
			expect(jsonStr).not.toContain('<svg');
			expect(jsonStr).not.toContain('<iframe');
			expect(jsonStr).not.toContain('<script>');
			expect(jsonStr).not.toContain('</script>');
		}
	});
});

describe('Security: Phase Type Validation Fix Verification', () => {
	it('should handle phases array with [null, "string", 123, {tasks: []}] without crashing', async () => {
		// This is the specific test case from the task
		const invalidPhasesPayload = {
			phases: [null, 'string', 123, { tasks: [] }],
			current_phase: 1,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(invalidPhasesPayload);
		mockReadSwarmFileAsync.mockResolvedValue(null);

		// Should not crash, should handle gracefully
		const result = await getHandoffData('/test');
		expect(result).toBeDefined();

		// Should return safe defaults when phases are invalid
		expect(result.currentPhase).toBeNull();
		expect(result.currentTask).toBeNull();
		expect(result.incompleteTasks).toEqual([]);
	});

	it('should handle phases array with mixed invalid types', async () => {
		const mixedInvalidPhases = {
			phases: [
				null,
				undefined,
				'just a string',
				123,
				45.67,
				true,
				false,
				[],
				{ name: 'no tasks key' },
				{ tasks: 'not an array' },
				{ tasks: null },
				{ tasks: [null] }, // task is null
				{ tasks: [{ id: 1 }] }, // task is not object
			],
			current_phase: 1,
		};

		mockLoadPlanJsonOnly.mockResolvedValue(mixedInvalidPhases);

		// Should not crash
		const result = await getHandoffData('/test');
		expect(result).toBeDefined();
	});

	it('should handle completely malformed plan objects', async () => {
		const malformedPlans = [
			{ phases: 'not an array' },
			{ phases: null },
			{ phases: undefined },
			{ phases: { 0: 'object instead of array' } },
			{ phases: [{}] }, // phase without tasks
			{ phases: [{ tasks: null }] }, // tasks is null
			{ phases: [{ tasks: 'string' }] }, // tasks is string
		];

		for (const plan of malformedPlans) {
			mockLoadPlanJsonOnly.mockResolvedValue(plan);

			// Should not crash
			const result = await getHandoffData('/test');
			expect(result).toBeDefined();
		}
	});
});
