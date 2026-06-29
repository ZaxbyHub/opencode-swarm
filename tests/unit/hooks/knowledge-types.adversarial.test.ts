/**
 * ADVERSARIAL SECURITY TESTS for knowledge-types.ts
 *
 * These tests explore type safety boundaries and potential attack vectors.
 * Since TypeScript is erased at runtime, many type constraints are compile-time only.
 * These tests document vulnerabilities where runtime enforcement is expected but not guaranteed.
 */

import { describe, expect, it } from 'bun:test';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeEntryBase,
	MessageInfo,
	MessagePart,
	PhaseConfirmationRecord,
	ProjectConfirmationRecord,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types';

describe('ADVERSARIAL: knowledge-types.ts Security Tests', () => {
	describe('ATTACK VECTOR 1: Type narrowing bypass for confirmed_by', () => {
		/**
		 * RISK: TypeScript's union type PhaseConfirmationRecord[] | ProjectConfirmationRecord[]
		 * allows either type at compile time, but runtime checks are needed to prevent
		 * assigning the wrong type to the wrong tier.
		 */
		it('ALLOWS: SwarmKnowledgeEntry with ProjectConfirmationRecord[] (bypasses tier enforcement)', () => {
			const swarmEntry: SwarmKnowledgeEntry = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson about deployment pipelines',
				category: 'tooling',
				tags: ['devops', 'ci-cd'],
				scope: 'global',
				confidence: 0.9,
				status: 'established',
				// ATTACK: ProjectConfirmationRecord in swarm tier
				confirmed_by: [
					{
						project_name: 'evil-project',
						confirmed_at: '2024-01-01T00:00:00Z',
						// No phase_number - valid for ProjectConfirmationRecord but invalid for Swarm
					},
				] as PhaseConfirmationRecord[], // Cast bypasses runtime check
				project_name: 'legitimate-project',
				retrieval_outcomes: {
					applied_count: 5,
					succeeded_after_count: 4,
					failed_after_count: 1,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			// This compiles and would pass at runtime if no validation exists
			expect(swarmEntry.confirmed_by).toBeDefined();
			expect(swarmEntry.confirmed_by.length).toBe(1);
			// Runtime vulnerability: phase_number is missing but SwarmKnowledgeEntry expects it
			const firstRecord = swarmEntry.confirmed_by[0] as any;
			expect(firstRecord.project_name).toBe('evil-project');
			expect(firstRecord.phase_number).toBeUndefined();
		});

		it('ALLOWS: HiveKnowledgeEntry with PhaseConfirmationRecord[] (bypasses tier enforcement)', () => {
			const hiveEntry: HiveKnowledgeEntry = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'hive',
				lesson: 'Test lesson about deployment pipelines',
				category: 'tooling',
				tags: ['devops', 'ci-cd'],
				scope: 'global',
				confidence: 0.9,
				status: 'established',
				// ATTACK: PhaseConfirmationRecord in hive tier
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2024-01-01T00:00:00Z',
						project_name: 'evil-project',
					},
				] as ProjectConfirmationRecord[], // Cast bypasses runtime check
				source_project: 'legitimate-project',
				retrieval_outcomes: {
					applied_count: 5,
					succeeded_after_count: 4,
					failed_after_count: 1,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			// This compiles and would pass at runtime if no validation exists
			expect(hiveEntry.confirmed_by).toBeDefined();
			expect(hiveEntry.confirmed_by.length).toBe(1);
		});

		it('ALLOWS: Same field can hold either type at runtime (type confusion)', () => {
			let entry: KnowledgeEntryBase;

			// First, assign with PhaseConfirmationRecord[]
			entry = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [
					{
						phase_number: 1,
						confirmed_at: '2024-01-01T00:00:00Z',
						project_name: 'project-a',
					},
				],
				retrieval_outcomes: {
					applied_count: 1,
					succeeded_after_count: 1,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			// Then reassign with ProjectConfirmationRecord[] - TypeScript allows this!
			entry = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'hive',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [
					{
						project_name: 'project-b',
						confirmed_at: '2024-01-01T00:00:00Z',
						// phase_number omitted - valid for ProjectConfirmationRecord
					},
				],
				retrieval_outcomes: {
					applied_count: 1,
					succeeded_after_count: 1,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			// Both assignments succeed - type narrowing cannot prevent runtime confusion
			expect(entry.tier).toBe('hive');
			const record = entry.confirmed_by[0] as any;
			expect(record.phase_number).toBeUndefined();
		});
	});

	describe('ATTACK VECTOR 2: Index signature allows unsafe property injection', () => {
		/**
		 * RISK: [key: string]: unknown allows arbitrary properties to be added at runtime.
		 * This can be exploited to inject malicious data or bypass validation.
		 *
		 * NOTE: JavaScript engines protect against __proto__ in object literals (security feature).
		 */
		it('ALLOWS: Injecting arbitrary properties into MessageInfo', () => {
			const messageInfo: MessageInfo = {
				role: 'user',
				agent: 'architect',
				sessionID: 'test-session',
				modelID: 'test-model',
				providerID: 'test-provider',
				// ATTACK: Injecting malicious or unexpected properties
				constructor: 'attempted',
				eval: 'malicious',
				toString: 'hijacked',
				arbitraryPayload: { sensitive: 'data' },
				maliciousFunction: () => 'execution',
			};

			// All these properties are accepted by the type system
			expect((messageInfo as any).constructor).toBe('attempted');
			expect((messageInfo as any).eval).toBe('malicious');
			expect((messageInfo as any).toString).toBe('hijacked');
			expect((messageInfo as any).arbitraryPayload).toBeDefined();
			expect((messageInfo as any).maliciousFunction).toBeDefined();
		});

		it('ALLOWS: Injecting properties that shadow built-in methods', () => {
			const messageInfo: MessageInfo = {
				role: 'user',
				// ATTACK: Shadowing built-in Object methods
				hasOwnProperty: 'overridden',
				constructor: { evil: 'payload' },
				toString: () => 'malicious output',
			};

			expect((messageInfo as any).hasOwnProperty).toBe('overridden');
		});

		it('ALLOWS: MessagePart also vulnerable to property injection', () => {
			const part: MessagePart = {
				type: 'text',
				text: 'Hello',
				// ATTACK: Injecting arbitrary properties
				metadata: { user: 'attacker' },
				eval: 'malicious',
				arbitraryCode: 'console.log("xss")',
			};

			expect((part as any).metadata).toBeDefined();
			expect((part as any).eval).toBe('malicious');
			expect((part as any).arbitraryCode).toBe('console.log("xss")');
		});

		it('DOCUMENTS: __proto__ in object literal is protected by JavaScript engine', () => {
			// JavaScript engines prevent __proto__ in object literals from creating
			// a regular property (security feature against prototype pollution)
			const messageInfo: MessageInfo = {
				role: 'user',
				__proto__: 'polluted', // This is silently ignored by the engine
			};

			// The __proto__ key exists (as a prototype property descriptor)
			// but the value 'polluted' is NOT set
			expect((messageInfo as any).__proto__).not.toBe('polluted');
			// The actual prototype is still Object.prototype
			expect(Object.getPrototypeOf(messageInfo)).toBe(Object.prototype);
		});

		it('VULNERABLE: Prototype pollution via Object.defineProperty (bypasses literal protection)', () => {
			const messageInfo: MessageInfo = {
				role: 'user',
			};

			// ATTACK: Use Object.defineProperty to pollute prototype
			// This bypasses the object literal protection
			Object.defineProperty(messageInfo, '__proto__', {
				value: { polluted: true },
				writable: true,
				configurable: true,
			});

			// Now the prototype IS polluted
			expect((messageInfo as any).__proto__).toBeDefined();
			expect((messageInfo as any).__proto__.polluted).toBe(true);
		});
	});

	describe('ATTACK VECTOR 3: Type widening allows unexpected strings', () => {
		/**
		 * RISK: KnowledgeCategory is a union of literal strings, but if type checking
		 * is bypassed (e.g., via 'as any' cast), runtime code may receive invalid categories.
		 */
		it('ALLOWS: Assigning admin (privilege escalation attempt)', () => {
			// Attack: Bypass type check with 'as any'
			const entry: KnowledgeCategory = 'admin' as KnowledgeCategory;

			expect(entry).toBe('admin'); // Invalid category accepted
		});

		it('ALLOWS: Assigning other dangerous or invalid strings', () => {
			const dangerousCategories = [
				'root',
				'system',
				'__proto__',
				'constructor',
				'eval',
				'<script>alert(1)</script>',
				'../../../etc/passwd',
				'${process.env.SECRET}',
				'null',
				'undefined',
			];

			dangerousCategories.forEach((cat) => {
				// Attack: All these strings can be forced into KnowledgeCategory type
				const category = cat as KnowledgeCategory;
				expect(category).toBe(cat);
			});
		});

		it('ALLOWS: Empty string and whitespace in category', () => {
			const emptyCategory: KnowledgeCategory = '' as KnowledgeCategory;
			const whitespaceCategory: KnowledgeCategory = '   ' as KnowledgeCategory;

			expect(emptyCategory).toBe('');
			expect(whitespaceCategory).toBe('   ');
		});

		it('REJECTS: Type system correctly rejects invalid strings at compile time', () => {
			// This shows that type checking DOES work when not bypassed
			// @ts-expect-error - intentionally testing type error
			const invalidCategory: KnowledgeCategory = 'admin';

			// If this line runs, TypeScript didn't catch it (configuration issue)
			// but ideally this should fail compilation
			expect(invalidCategory).toBeDefined();
		});
	});

	describe('ATTACK VECTOR 4: Empty array bypasses FIFO semantics', () => {
		/**
		 * RISK: confirmed_by is typed as PhaseConfirmationRecord[] | ProjectConfirmationRecord[]
		 * which technically allows []. This bypasses the intended FIFO confirmation order.
		 */
		it('ALLOWS: confirmed_by can be empty array', () => {
			const swarmEntry: SwarmKnowledgeEntry = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 1.0,
				status: 'established',
				// ATTACK: Empty confirmed_by bypasses confirmation tracking
				confirmed_by: [],
				project_name: 'test-project',
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(swarmEntry.confirmed_by).toEqual([]);
			// Implication: Entry has status 'established' but NO confirmation records
			expect(swarmEntry.status).toBe('established');
		});

		it('ALLOWS: HiveKnowledgeEntry with empty confirmed_by', () => {
			const hiveEntry: HiveKnowledgeEntry = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'hive',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 1.0,
				status: 'established',
				confirmed_by: [], // Empty - bypasses confirmation tracking
				source_project: 'test-project',
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(hiveEntry.confirmed_by).toEqual([]);
		});

		it('ALLOWS: KnowledgeEntryBase with empty confirmed_by union', () => {
			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 1.0,
				status: 'established',
				confirmed_by: [], // Valid per type definition
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(entry.confirmed_by).toEqual([]);
		});
	});

	describe('ATTACK VECTOR 5: Confidence accepts Infinity and NaN', () => {
		/**
		 * RISK: confidence is typed as number (0.0-1.0 in comment) but the type system
		 * allows any number, including Infinity, -Infinity, and NaN.
		 */
		it('ALLOWS: confidence can be Infinity', () => {
			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: Infinity, // ATTACK: Breaks 0.0-1.0 constraint
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(entry.confidence).toBe(Infinity);
			expect(entry.confidence).not.toBeLessThanOrEqual(1.0);
			expect(Number.isFinite(entry.confidence)).toBe(false);
		});

		it('ALLOWS: confidence can be -Infinity', () => {
			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: -Infinity, // ATTACK: Breaks 0.0-1.0 constraint
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(entry.confidence).toBe(-Infinity);
			expect(entry.confidence).not.toBeGreaterThanOrEqual(0.0);
			expect(Number.isFinite(entry.confidence)).toBe(false);
		});

		it('ALLOWS: confidence can be NaN', () => {
			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: NaN, // ATTACK: Breaks 0.0-1.0 constraint
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(entry.confidence).toBeNaN();
			// NaN comparisons always return false
			expect(entry.confidence < 0.0).toBe(false);
			expect(entry.confidence > 1.0).toBe(false);
		});

		it('ALLOWS: confidence can exceed upper bound (1.0)', () => {
			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 1.5, // ATTACK: Exceeds 1.0
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(entry.confidence).toBe(1.5);
			expect(entry.confidence).toBeGreaterThan(1.0);
		});

		it('ALLOWS: confidence can be negative', () => {
			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: -0.5, // ATTACK: Below 0.0
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(entry.confidence).toBe(-0.5);
			expect(entry.confidence).toBeLessThan(0.0);
		});
	});

	describe('ADDITIONAL ATTACK VECTORS: Other type safety concerns', () => {
		it('ALLOWS: tags array can contain malicious content', () => {
			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: [
					'<script>alert(1)</script>',
					'${process.env.SECRET}',
					'__proto__',
					'constructor',
					'eval',
				],
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(entry.tags).toHaveLength(5);
			expect(entry.tags[0]).toContain('<script>');
		});

		it('ALLOWS: lesson can exceed 280 character limit', () => {
			const longLesson = 'A'.repeat(1000); // Exceeds 280 char comment constraint

			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: longLesson, // ATTACK: Bypasses documented 280 char limit
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(entry.lesson.length).toBe(1000);
			expect(entry.lesson.length).toBeGreaterThan(280);
		});

		it('ALLOWS: Invalid ISO 8601 dates', () => {
			const entry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm',
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: 'not-a-date', // ATTACK: Invalid ISO 8601
				updated_at: '${new Date()}', // ATTACK: Template string injection
			};

			expect(entry.created_at).toBe('not-a-date');
			expect(entry.updated_at).toBe('${new Date()}');
		});

		it('ALLOWS: tier can be mismatched with confirmed_by type via cast', () => {
			// ATTACK: tier='swarm' but confirmed_by has ProjectConfirmationRecord shape
			const maliciousEntry: KnowledgeEntryBase = {
				id: '550e8400-e29b-41d4-a716-446655440000',
				tier: 'swarm', // Says swarm
				lesson: 'Test lesson',
				category: 'tooling',
				tags: ['test'],
				scope: 'global',
				confidence: 0.8,
				status: 'established',
				confirmed_by: [
					{
						project_name: 'evil',
						confirmed_at: '2024-01-01T00:00:00Z',
						// No phase_number - ProjectConfirmationRecord shape
					} as PhaseConfirmationRecord, // Cast forces it in
				],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 1,
				created_at: '2024-01-01T00:00:00Z',
				updated_at: '2024-01-01T00:00:00Z',
			};

			expect(maliciousEntry.tier).toBe('swarm');
			const record = maliciousEntry.confirmed_by[0] as any;
			expect(record.phase_number).toBeUndefined();
		});
	});
});
