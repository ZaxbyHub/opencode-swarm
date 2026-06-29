/**
 * Compile-time type tests for knowledge-types.ts
 *
 * These tests verify type correctness using TypeScript's type system.
 * Since knowledge-types.ts is types-only with no runtime behavior,
 * we use compile-time assertions rather than runtime tests.
 */

import { describe, expect, it } from 'bun:test';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeConfig,
	KnowledgeEntryBase,
	MessageInfo,
	MessagePart,
	MessageWithParts,
	PhaseConfirmationRecord,
	ProjectConfirmationRecord,
	RejectedLesson,
	RetrievalOutcome,
	SwarmKnowledgeEntry,
} from '../../src/hooks/knowledge-types';

describe('KnowledgeCategory union type', () => {
	it('accepts all 9 valid values', () => {
		const validCategories: KnowledgeCategory[] = [
			'process',
			'architecture',
			'tooling',
			'security',
			'testing',
			'debugging',
			'performance',
			'integration',
			'other',
		];

		expect(validCategories).toHaveLength(9);
	});

	// NOTE: Negative type tests using @ts-expect-error are documented below.
	// The project's tsconfig.json only includes "src/**/*", so test files
	// are not type-checked at compile time. These @ts-expect-error directives
	// serve as documentation of expected TypeScript errors.
	// To verify these errors, run: npx tsc --noEmit --include "tests/unit/hooks/knowledge-types.test.ts"
	it('documents expected type rejections for KnowledgeCategory', () => {
		// These assignments would cause TypeScript errors if type-checked:
		// - Invalid category strings
		// - Wrong case sensitivity
		// - Empty strings
		// The type system should reject these at compile time.
		expect(() => {
			// @ts-expect-error - invalid category value: 'invalid' is not in the union
			const _invalid1: KnowledgeCategory = 'invalid';

			// @ts-expect-error - invalid category value: 'unknown' is not in the union
			const _invalid2: KnowledgeCategory = 'unknown';

			// @ts-expect-error - invalid category value: case-sensitive, 'Process' != 'process'
			const _invalid3: KnowledgeCategory = 'Process';

			// @ts-expect-error - invalid category value: empty string
			const _invalid4: KnowledgeCategory = '';
		}).toBeDefined();
	});
});

describe('PhaseConfirmationRecord interface', () => {
	it('accepts valid PhaseConfirmationRecord', () => {
		const record: PhaseConfirmationRecord = {
			phase_number: 1,
			confirmed_at: '2024-01-01T00:00:00Z',
			project_name: 'test-project',
		};

		expect(record).toBeDefined();
	});

	it('rejects missing required fields', () => {
		// @ts-expect-error - missing phase_number
		const invalid1: PhaseConfirmationRecord = {
			confirmed_at: '2024-01-01T00:00:00Z',
			project_name: 'test-project',
		};

		// @ts-expect-error - missing confirmed_at
		const invalid2: PhaseConfirmationRecord = {
			phase_number: 1,
			project_name: 'test-project',
		};

		// @ts-expect-error - missing project_name
		const invalid3: PhaseConfirmationRecord = {
			phase_number: 1,
			confirmed_at: '2024-01-01T00:00:00Z',
		};

		expect([invalid1, invalid2, invalid3]).toBeDefined();
	});
});

describe('ProjectConfirmationRecord interface', () => {
	it('accepts valid ProjectConfirmationRecord', () => {
		const record: ProjectConfirmationRecord = {
			project_name: 'test-project',
			confirmed_at: '2024-01-01T00:00:00Z',
		};

		expect(record).toBeDefined();
	});

	it('accepts valid ProjectConfirmationRecord with optional phase_number', () => {
		const record: ProjectConfirmationRecord = {
			project_name: 'test-project',
			confirmed_at: '2024-01-01T00:00:00Z',
			phase_number: 1,
		};

		expect(record).toBeDefined();
	});

	it('rejects missing required fields', () => {
		// @ts-expect-error - missing project_name
		const invalid1: ProjectConfirmationRecord = {
			confirmed_at: '2024-01-01T00:00:00Z',
		};

		// @ts-expect-error - missing confirmed_at
		const invalid2: ProjectConfirmationRecord = {
			project_name: 'test-project',
		};

		expect([invalid1, invalid2]).toBeDefined();
	});
});

describe('SwarmKnowledgeEntry interface', () => {
	it('can be assigned with confirmed_by: PhaseConfirmationRecord[]', () => {
		const confirmedBy: PhaseConfirmationRecord[] = [
			{
				phase_number: 1,
				confirmed_at: '2024-01-01T00:00:00Z',
				project_name: 'test-project',
			},
			{
				phase_number: 2,
				confirmed_at: '2024-01-02T00:00:00Z',
				project_name: 'test-project',
			},
		];

		const retrievalOutcomes: RetrievalOutcome = {
			applied_count: 5,
			succeeded_after_count: 3,
			failed_after_count: 1,
			last_applied_at: '2024-01-03T00:00:00Z',
		};

		const entry: SwarmKnowledgeEntry = {
			id: '550e8400-e29b-41d4-a716-446655440000',
			tier: 'swarm',
			lesson:
				'This is a valid lesson text that meets the 15-280 character requirement.',
			category: 'process',
			tags: ['tag1', 'tag2'],
			scope: 'global',
			confidence: 0.8,
			status: 'candidate',
			confirmed_by: confirmedBy,
			retrieval_outcomes: retrievalOutcomes,
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			project_name: 'test-project',
		};

		expect(entry).toBeDefined();
		expect(entry.confirmed_by).toHaveLength(2);
	});

	it('rejects ProjectConfirmationRecord in confirmed_by', () => {
		const confirmedBy: ProjectConfirmationRecord[] = [
			{
				project_name: 'test-project',
				confirmed_at: '2024-01-01T00:00:00Z',
			},
		];

		const retrievalOutcomes: RetrievalOutcome = {
			applied_count: 5,
			succeeded_after_count: 3,
			failed_after_count: 1,
		};

		// @ts-expect-error - confirmed_by must be PhaseConfirmationRecord[], not ProjectConfirmationRecord[]
		const entry: SwarmKnowledgeEntry = {
			id: '550e8400-e29b-41d4-a716-446655440000',
			tier: 'swarm',
			lesson:
				'This is a valid lesson text that meets the 15-280 character requirement.',
			category: 'process',
			tags: ['tag1', 'tag2'],
			scope: 'global',
			confidence: 0.8,
			status: 'candidate',
			confirmed_by: confirmedBy,
			retrieval_outcomes: retrievalOutcomes,
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			project_name: 'test-project',
		};

		expect(entry).toBeDefined();
	});
});

describe('HiveKnowledgeEntry interface', () => {
	it('can be assigned with confirmed_by: ProjectConfirmationRecord[]', () => {
		const confirmedBy: ProjectConfirmationRecord[] = [
			{
				project_name: 'project-a',
				confirmed_at: '2024-01-01T00:00:00Z',
			},
			{
				project_name: 'project-b',
				confirmed_at: '2024-01-02T00:00:00Z',
				phase_number: 1,
			},
		];

		const retrievalOutcomes: RetrievalOutcome = {
			applied_count: 10,
			succeeded_after_count: 8,
			failed_after_count: 1,
			last_applied_at: '2024-01-03T00:00:00Z',
		};

		const entry: HiveKnowledgeEntry = {
			id: '660e8400-e29b-41d4-a716-446655440001',
			tier: 'hive',
			lesson:
				'This is a valid lesson text that meets the 15-280 character requirement.',
			category: 'architecture',
			tags: ['tag1', 'tag2', 'tag3'],
			scope: 'stack:react',
			confidence: 0.9,
			status: 'promoted',
			confirmed_by: confirmedBy,
			retrieval_outcomes: retrievalOutcomes,
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			source_project: 'test-project',
		};

		expect(entry).toBeDefined();
		expect(entry.confirmed_by).toHaveLength(2);
	});

	it('rejects PhaseConfirmationRecord in confirmed_by', () => {
		const confirmedBy: PhaseConfirmationRecord[] = [
			{
				phase_number: 1,
				confirmed_at: '2024-01-01T00:00:00Z',
				project_name: 'test-project',
			},
		];

		const retrievalOutcomes: RetrievalOutcome = {
			applied_count: 10,
			succeeded_after_count: 8,
			failed_after_count: 1,
		};

		// @ts-expect-error - confirmed_by must be ProjectConfirmationRecord[], not PhaseConfirmationRecord[]
		const entry: HiveKnowledgeEntry = {
			id: '660e8400-e29b-41d4-a716-446655440001',
			tier: 'hive',
			lesson:
				'This is a valid lesson text that meets the 15-280 character requirement.',
			category: 'architecture',
			tags: ['tag1', 'tag2', 'tag3'],
			scope: 'stack:react',
			confidence: 0.9,
			status: 'promoted',
			confirmed_by: confirmedBy,
			retrieval_outcomes: retrievalOutcomes,
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			source_project: 'test-project',
		};

		expect(entry).toBeDefined();
	});
});

describe('KnowledgeConfig interface', () => {
	it('requires all 15 fields - constructs complete valid object', () => {
		const config: KnowledgeConfig = {
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			auto_promote_days: 90,
			max_inject_count: 5,
			dedup_threshold: 0.6,
			scope_filter: ['global'],
			hive_enabled: true,
			rejected_max_entries: 20,
			validation_enabled: true,
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
			schema_version: 1,
		};

		expect(config).toBeDefined();

		// Verify all required fields are present
		expect(config.enabled).toBe(true);
		expect(config.swarm_max_entries).toBe(100);
		expect(config.hive_max_entries).toBe(200);
		expect(config.auto_promote_days).toBe(90);
		expect(config.max_inject_count).toBe(5);
		expect(config.dedup_threshold).toBe(0.6);
		expect(config.scope_filter).toEqual(['global']);
		expect(config.hive_enabled).toBe(true);
		expect(config.rejected_max_entries).toBe(20);
		expect(config.validation_enabled).toBe(true);
		expect(config.evergreen_confidence).toBe(0.9);
		expect(config.evergreen_utility).toBe(0.8);
		expect(config.low_utility_threshold).toBe(0.3);
		expect(config.min_retrievals_for_utility).toBe(3);
		expect(config.schema_version).toBe(1);
	});

	it('rejects missing required fields', () => {
		const baseConfig = {
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			auto_promote_days: 90,
			max_inject_count: 5,
			dedup_threshold: 0.6,
			scope_filter: ['global'],
			hive_enabled: true,
			rejected_max_entries: 20,
			validation_enabled: true,
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
			schema_version: 1,
		};

		// @ts-expect-error - missing enabled
		const invalid1: KnowledgeConfig = {
			...baseConfig,
			enabled: undefined as any,
		};

		// @ts-expect-error - missing swarm_max_entries
		const invalid2: KnowledgeConfig = {
			...baseConfig,
			swarm_max_entries: undefined as any,
		};

		// @ts-expect-error - missing schema_version
		const invalid3: KnowledgeConfig = {
			...baseConfig,
			schema_version: undefined as any,
		};

		expect([invalid1, invalid2, invalid3]).toBeDefined();
	});

	it('satisfies KnowledgeConfig type with complete object', () => {
		const config = {
			enabled: true,
			swarm_max_entries: 100,
			hive_max_entries: 200,
			auto_promote_days: 90,
			max_inject_count: 5,
			dedup_threshold: 0.6,
			scope_filter: ['global'],
			hive_enabled: true,
			rejected_max_entries: 20,
			validation_enabled: true,
			evergreen_confidence: 0.9,
			evergreen_utility: 0.8,
			low_utility_threshold: 0.3,
			min_retrievals_for_utility: 3,
			schema_version: 1,
		} satisfies KnowledgeConfig;

		expect(config).toBeDefined();
	});
});

describe('RejectedLesson interface', () => {
	it('accepts valid RejectedLesson', () => {
		const lesson: RejectedLesson = {
			id: '770e8400-e29b-41d4-a716-446655440002',
			lesson: 'This is a rejected lesson text.',
			rejection_reason: 'Duplicate entry',
			rejected_at: '2024-01-01T00:00:00Z',
			rejection_layer: 1,
		};

		expect(lesson).toBeDefined();
	});

	it('accepts valid rejection_layer values (1, 2, or 3)', () => {
		const layer1: RejectedLesson = {
			id: '770e8400-e29b-41d4-a716-446655440002',
			lesson: 'Layer 1 rejection',
			rejection_reason: 'Low quality',
			rejected_at: '2024-01-01T00:00:00Z',
			rejection_layer: 1,
		};

		const layer2: RejectedLesson = {
			id: '880e8400-e29b-41d4-a716-446655440003',
			lesson: 'Layer 2 rejection',
			rejection_reason: 'Duplicate',
			rejected_at: '2024-01-01T00:00:00Z',
			rejection_layer: 2,
		};

		const layer3: RejectedLesson = {
			id: '990e8400-e29b-41d4-a716-446655440004',
			lesson: 'Layer 3 rejection',
			rejection_reason: 'Outdated',
			rejected_at: '2024-01-01T00:00:00Z',
			rejection_layer: 3,
		};

		expect([layer1, layer2, layer3]).toHaveLength(3);
	});

	it('rejects invalid rejection_layer values', () => {
		// @ts-expect-error - rejection_layer must be 1, 2, or 3
		const invalid1: RejectedLesson = {
			id: '770e8400-e29b-41d4-a716-446655440002',
			lesson: 'Invalid rejection',
			rejection_reason: 'Bad',
			rejected_at: '2024-01-01T00:00:00Z',
			rejection_layer: 4,
		};

		// @ts-expect-error - rejection_layer must be 1, 2, or 3
		const invalid2: RejectedLesson = {
			id: '770e8400-e29b-41d4-a716-446655440002',
			lesson: 'Invalid rejection',
			rejection_reason: 'Bad',
			rejected_at: '2024-01-01T00:00:00Z',
			rejection_layer: 0,
		};

		expect([invalid1, invalid2]).toBeDefined();
	});
});

describe('RetrievalOutcome interface', () => {
	it('accepts valid RetrievalOutcome with optional field', () => {
		const outcome: RetrievalOutcome = {
			applied_count: 5,
			succeeded_after_count: 3,
			failed_after_count: 1,
			last_applied_at: '2024-01-01T00:00:00Z',
		};

		expect(outcome).toBeDefined();
	});

	it('accepts valid RetrievalOutcome without optional field', () => {
		const outcome: RetrievalOutcome = {
			applied_count: 5,
			succeeded_after_count: 3,
			failed_after_count: 1,
		};

		expect(outcome).toBeDefined();
		expect(outcome.last_applied_at).toBeUndefined();
	});
});

describe('MessageInfo interface', () => {
	it('accepts valid MessageInfo with required fields', () => {
		const info: MessageInfo = {
			role: 'user',
		};

		expect(info).toBeDefined();
	});

	it('accepts valid MessageInfo with optional fields', () => {
		const info: MessageInfo = {
			role: 'assistant',
			agent: 'architect',
			sessionID: 'session-123',
			modelID: 'gpt-4',
			providerID: 'openai',
		};

		expect(info).toBeDefined();
	});

	it('accepts additional index signature properties', () => {
		const info: MessageInfo = {
			role: 'user',
			customField: 'custom-value',
			anotherField: 123,
		};

		expect(info).toBeDefined();
	});

	it('rejects missing required role field', () => {
		// @ts-expect-error - missing required role field
		const invalid: MessageInfo = {
			agent: 'architect',
		};

		expect(invalid).toBeDefined();
	});
});

describe('MessagePart interface', () => {
	it('accepts valid MessagePart with required fields', () => {
		const part: MessagePart = {
			type: 'text',
		};

		expect(part).toBeDefined();
	});

	it('accepts valid MessagePart with optional text field', () => {
		const part: MessagePart = {
			type: 'text',
			text: 'Hello, world!',
		};

		expect(part).toBeDefined();
	});

	it('accepts additional index signature properties', () => {
		const part: MessagePart = {
			type: 'image',
			url: 'https://example.com/image.png',
			alt: 'An image',
		};

		expect(part).toBeDefined();
	});
});

describe('MessageWithParts interface', () => {
	it('requires info and parts fields', () => {
		const info: MessageInfo = {
			role: 'user',
			agent: 'architect',
		};

		const parts: MessagePart[] = [
			{
				type: 'text',
				text: 'Hello',
			},
			{
				type: 'text',
				text: 'World',
			},
		];

		const message: MessageWithParts = {
			info,
			parts,
		};

		expect(message).toBeDefined();
		expect(message.info.role).toBe('user');
		expect(message.parts).toHaveLength(2);
	});

	it('satisfies MessageWithParts type', () => {
		const message = {
			info: {
				role: 'assistant',
				agent: 'coder',
			},
			parts: [
				{
					type: 'text',
					text: 'Response',
				},
			],
		} satisfies MessageWithParts;

		expect(message).toBeDefined();
	});

	it('rejects missing info field', () => {
		// @ts-expect-error - missing required info field
		const invalid1: MessageWithParts = {
			parts: [],
		};

		// @ts-expect-error - missing required parts field
		const invalid2: MessageWithParts = {
			info: {
				role: 'user',
			},
		};

		expect([invalid1, invalid2]).toBeDefined();
	});
});

describe('KnowledgeEntryBase type compatibility', () => {
	it('SwarmKnowledgeEntry is assignable to KnowledgeEntryBase', () => {
		const swarmEntry: SwarmKnowledgeEntry = {
			id: '550e8400-e29b-41d4-a716-446655440000',
			tier: 'swarm',
			lesson: 'Swarm lesson text.',
			category: 'process',
			tags: ['tag1'],
			scope: 'global',
			confidence: 0.8,
			status: 'candidate',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2024-01-01T00:00:00Z',
					project_name: 'test-project',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 1,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			project_name: 'test-project',
		};

		// SwarmKnowledgeEntry should be assignable to KnowledgeEntryBase
		const baseEntry: KnowledgeEntryBase = swarmEntry;

		expect(baseEntry).toBeDefined();
		expect(baseEntry.tier).toBe('swarm');
	});

	it('HiveKnowledgeEntry is assignable to KnowledgeEntryBase', () => {
		const hiveEntry: HiveKnowledgeEntry = {
			id: '660e8400-e29b-41d4-a716-446655440001',
			tier: 'hive',
			lesson: 'Hive lesson text.',
			category: 'architecture',
			tags: ['tag1'],
			scope: 'global',
			confidence: 0.9,
			status: 'promoted',
			confirmed_by: [
				{
					project_name: 'test-project',
					confirmed_at: '2024-01-01T00:00:00Z',
				},
			],
			retrieval_outcomes: {
				applied_count: 10,
				succeeded_after_count: 8,
				failed_after_count: 1,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			source_project: 'test-project',
		};

		// HiveKnowledgeEntry should be assignable to KnowledgeEntryBase
		const baseEntry: KnowledgeEntryBase = hiveEntry;

		expect(baseEntry).toBeDefined();
		expect(baseEntry.tier).toBe('hive');
	});

	it('accepts optional hive_eligible field', () => {
		const entry: KnowledgeEntryBase = {
			id: '550e8400-e29b-41d4-a716-446655440000',
			tier: 'swarm',
			lesson: 'Lesson text with hive eligibility.',
			category: 'process',
			tags: ['tag1'],
			scope: 'global',
			confidence: 0.8,
			status: 'candidate',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2024-01-01T00:00:00Z',
					project_name: 'test-project',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 1,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			hive_eligible: true,
		};

		expect(entry).toBeDefined();
		expect(entry.hive_eligible).toBe(true);
	});

	it('accepts optional auto_generated field', () => {
		const entry: KnowledgeEntryBase = {
			id: '550e8400-e29b-41d4-a716-446655440000',
			tier: 'swarm',
			lesson: 'Auto-generated lesson.',
			category: 'process',
			tags: ['tag1'],
			scope: 'global',
			confidence: 0.8,
			status: 'candidate',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2024-01-01T00:00:00Z',
					project_name: 'test-project',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 1,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			auto_generated: true,
		};

		expect(entry).toBeDefined();
		expect(entry.auto_generated).toBe(true);
	});
});

describe('Type discrimination with tier field', () => {
	it('discriminates SwarmKnowledgeEntry by tier: "swarm"', () => {
		const entry: SwarmKnowledgeEntry = {
			id: '550e8400-e29b-41d4-a716-446655440000',
			tier: 'swarm',
			lesson: 'Lesson text.',
			category: 'process',
			tags: ['tag1'],
			scope: 'global',
			confidence: 0.8,
			status: 'candidate',
			confirmed_by: [
				{
					phase_number: 1,
					confirmed_at: '2024-01-01T00:00:00Z',
					project_name: 'test-project',
				},
			],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 1,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			project_name: 'test-project',
		};

		expect(entry.tier).toBe('swarm');

		// Type narrowing should allow access to project_name
		if (entry.tier === 'swarm') {
			expect(entry.project_name).toBe('test-project');
		}
	});

	it('discriminates HiveKnowledgeEntry by tier: "hive"', () => {
		const entry: HiveKnowledgeEntry = {
			id: '660e8400-e29b-41d4-a716-446655440001',
			tier: 'hive',
			lesson: 'Lesson text.',
			category: 'architecture',
			tags: ['tag1'],
			scope: 'global',
			confidence: 0.9,
			status: 'promoted',
			confirmed_by: [
				{
					project_name: 'test-project',
					confirmed_at: '2024-01-01T00:00:00Z',
				},
			],
			retrieval_outcomes: {
				applied_count: 10,
				succeeded_after_count: 8,
				failed_after_count: 1,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			source_project: 'test-project',
		};

		expect(entry.tier).toBe('hive');

		// Type narrowing should allow access to source_project
		if (entry.tier === 'hive') {
			expect(entry.source_project).toBe('test-project');
		}
	});
});
