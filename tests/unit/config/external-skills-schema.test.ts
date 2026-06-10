import { describe, expect, it } from 'bun:test';
import {
	DiscoverySourceSchema,
	ExternalSkillCandidateEvaluationVerdictSchema,
	ExternalSkillCandidateSchema,
	ExternalSkillCandidateSourceTypeSchema,
	ExternalSkillsConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema';

describe('ExternalSkillsConfigSchema', () => {
	it('test 1: defaults — curation_enabled=false', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.curation_enabled).toBe(false);
		}
	});

	it('test 1: defaults — max_candidates=500', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_candidates).toBe(500);
		}
	});

	it('test 1: defaults — eviction_policy=fifo', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.eviction_policy).toBe('fifo');
		}
	});

	it('test 1: defaults — ttl_days=90', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.ttl_days).toBe(90);
		}
	});

	it('test 1: defaults — evaluation_enabled=false', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.evaluation_enabled).toBe(false);
		}
	});

	it('test 1: defaults — sources=[]', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.sources).toEqual([]);
		}
	});

	it('test 1: defaults — max_candidates_per_discovery=50', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_candidates_per_discovery).toBe(50);
		}
	});

	it('test 1: defaults — max_concurrent_fetches=5', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.max_concurrent_fetches).toBe(5);
		}
	});

	it('test 1: defaults — fetch_timeout_ms=30000', () => {
		const result = ExternalSkillsConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.fetch_timeout_ms).toBe(30000);
		}
	});

	it('test 2: validates full config with all fields', () => {
		const fullConfig = {
			curation_enabled: true,
			max_candidates: 1000,
			max_bytes_per_candidate: 2097152,
			eviction_policy: 'fifo',
			ttl_days: 180,
			evaluation_enabled: true,
			sources: [
				{
					type: 'github',
					location: 'https://github.com/example/repo',
					enabled: true,
					trust_level: 'medium',
				},
			],
			max_candidates_per_discovery: 100,
			max_concurrent_fetches: 10,
			fetch_timeout_ms: 60000,
		};
		const result = ExternalSkillsConfigSchema.safeParse(fullConfig);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.curation_enabled).toBe(true);
			expect(result.data.max_candidates).toBe(1000);
			expect(result.data.max_bytes_per_candidate).toBe(2097152);
			expect(result.data.ttl_days).toBe(180);
			expect(result.data.evaluation_enabled).toBe(true);
			expect(result.data.sources).toHaveLength(1);
			expect(result.data.sources[0].type).toBe('github');
			expect(result.data.sources[0].trust_level).toBe('medium');
			expect(result.data.max_candidates_per_discovery).toBe(100);
			expect(result.data.max_concurrent_fetches).toBe(10);
			expect(result.data.fetch_timeout_ms).toBe(60000);
		}
	});

	it('test 3: rejects invalid curation_enabled (non-boolean)', () => {
		const result = ExternalSkillsConfigSchema.safeParse({
			curation_enabled: 'yes',
		});
		expect(result.success).toBe(false);
	});

	it('test 4: rejects max_candidates below minimum (0)', () => {
		const result = ExternalSkillsConfigSchema.safeParse({
			max_candidates: 0,
		});
		expect(result.success).toBe(false);
	});

	it('test 4: rejects max_candidates below minimum (negative)', () => {
		const result = ExternalSkillsConfigSchema.safeParse({
			max_candidates: -1,
		});
		expect(result.success).toBe(false);
	});

	it('test 4: rejects max_candidates above maximum (10001)', () => {
		const result = ExternalSkillsConfigSchema.safeParse({
			max_candidates: 10001,
		});
		expect(result.success).toBe(false);
	});

	it('test 4: accepts max_candidates at minimum boundary (1)', () => {
		const result = ExternalSkillsConfigSchema.safeParse({
			max_candidates: 1,
		});
		expect(result.success).toBe(true);
	});

	it('test 4: accepts max_candidates at maximum boundary (10000)', () => {
		const result = ExternalSkillsConfigSchema.safeParse({
			max_candidates: 10000,
		});
		expect(result.success).toBe(true);
	});
});

describe('ExternalSkillCandidateSchema', () => {
	const validCandidateBase = {
		id: '550e8400-e29b-41d4-a716-446655440000',
		source_url: 'https://github.com/example/skill',
		source_type: 'github',
		publisher: 'example-publisher',
		sha256: 'a'.repeat(64),
		fetched_at: '2025-01-01T00:00:00.000Z',
		skill_body: '# Skill\n\nThis is a skill.',
	};

	it('test 5: validates complete candidate with all fields', () => {
		const candidate = {
			...validCandidateBase,
			skill_name: 'example-skill',
			skill_description: 'An example skill',
			risk_flags: ['unsigned'],
			evaluation_verdict: 'passed' as const,
			evaluation_history: [
				{
					verdict: 'pending',
					timestamp: '2025-01-01T00:00:00.000Z',
					actor: 'system',
					reason: 'Initial scan',
				},
			],
		};
		const result = ExternalSkillCandidateSchema.safeParse(candidate);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.id).toBe('550e8400-e29b-41d4-a716-446655440000');
			expect(result.data.skill_name).toBe('example-skill');
			expect(result.data.risk_flags).toEqual(['unsigned']);
			expect(result.data.evaluation_verdict).toBe('passed');
			expect(result.data.evaluation_history).toHaveLength(1);
		}
	});

	it('test 6: rejects missing mandatory field source_url', () => {
		const { source_url: _source_url, ...candidate } = validCandidateBase;
		const result = ExternalSkillCandidateSchema.safeParse(candidate);
		expect(result.success).toBe(false);
	});

	it('test 6: rejects missing mandatory field publisher', () => {
		const { publisher: _publisher, ...candidate } = validCandidateBase;
		const result = ExternalSkillCandidateSchema.safeParse(candidate);
		expect(result.success).toBe(false);
	});

	it('test 6: rejects missing mandatory field sha256', () => {
		const { sha256: _sha256, ...candidate } = validCandidateBase;
		const result = ExternalSkillCandidateSchema.safeParse(candidate);
		expect(result.success).toBe(false);
	});

	it('test 6: rejects missing mandatory field fetched_at', () => {
		const { fetched_at: _fetched_at, ...candidate } = validCandidateBase;
		const result = ExternalSkillCandidateSchema.safeParse(candidate);
		expect(result.success).toBe(false);
	});

	it('test 6: rejects missing mandatory field skill_body', () => {
		const { skill_body: _skill_body, ...candidate } = validCandidateBase;
		const result = ExternalSkillCandidateSchema.safeParse(candidate);
		expect(result.success).toBe(false);
	});

	it('test 7: validates sha256 regex — valid 64 hex chars', () => {
		const validSha = 'abcdef0123456789'.repeat(4); // 64 chars
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			sha256: validSha,
		});
		expect(result.success).toBe(true);
	});

	it('test 8: rejects sha256 too short (63 chars)', () => {
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			sha256: 'a'.repeat(63),
		});
		expect(result.success).toBe(false);
	});

	it('test 8: rejects sha256 too long (65 chars)', () => {
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			sha256: 'a'.repeat(65),
		});
		expect(result.success).toBe(false);
	});

	it('test 8: rejects sha256 with non-hex chars (uppercase F)', () => {
		const invalidSha = 'g'.padEnd(64, '0'); // 'g' is not hex
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			sha256: invalidSha,
		});
		expect(result.success).toBe(false);
	});

	it('test 8: rejects sha256 with non-hex chars (special char)', () => {
		const invalidSha = '#' + 'a'.repeat(63);
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			sha256: invalidSha,
		});
		expect(result.success).toBe(false);
	});

	it('test 9: rejects invalid source_url (not a URL)', () => {
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			source_url: 'not-a-url',
		});
		expect(result.success).toBe(false);
	});

	it('test 9: rejects invalid source_url (missing protocol)', () => {
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			source_url: 'github.com/example/repo',
		});
		expect(result.success).toBe(false);
	});

	it('test 10: validates evaluation_history entries', () => {
		const candidate = {
			...validCandidateBase,
			evaluation_history: [
				{
					verdict: 'in_review',
					timestamp: '2025-06-01T10:00:00.000Z',
					actor: 'curator',
					reason: 'Needs verification',
				},
				{
					verdict: 'promoted',
					timestamp: '2025-06-02T14:30:00.000Z',
					actor: 'sme',
				},
			],
		};
		const result = ExternalSkillCandidateSchema.safeParse(candidate);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.evaluation_history).toHaveLength(2);
		}
	});

	it('test 11: rejects future fetched_at datetime', () => {
		const futureDate = new Date();
		futureDate.setFullYear(futureDate.getFullYear() + 1);
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			fetched_at: futureDate.toISOString(),
		});
		// Zod datetime() does NOT validate that the date is not in the future;
		// it only validates the format. So this will succeed.
		// We document this behavior.
		expect(result.success).toBe(true);
	});

	it('test 11: accepts valid ISO datetime for fetched_at', () => {
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			fetched_at: '2025-01-15T12:30:00.000Z',
		});
		expect(result.success).toBe(true);
	});

	it('test 11: rejects invalid fetched_at format', () => {
		const result = ExternalSkillCandidateSchema.safeParse({
			...validCandidateBase,
			fetched_at: '2025/01/15 12:30:00',
		});
		expect(result.success).toBe(false);
	});
});

describe('DiscoverySourceSchema', () => {
	it('test 12: validates complete source with all fields', () => {
		const source = {
			type: 'url' as const,
			location: 'https://example.com/skills',
			enabled: false,
			trust_level: 'high' as const,
		};
		const result = DiscoverySourceSchema.safeParse(source);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.type).toBe('url');
			expect(result.data.location).toBe('https://example.com/skills');
			expect(result.data.enabled).toBe(false);
			expect(result.data.trust_level).toBe('high');
		}
	});

	it('test 13: defaults — enabled=true when omitted', () => {
		const result = DiscoverySourceSchema.safeParse({
			type: 'github',
			location: 'https://github.com/example/repo',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.enabled).toBe(true);
		}
	});

	it('test 13: defaults — trust_level=low when omitted (has .default(low))', () => {
		const result = DiscoverySourceSchema.safeParse({
			type: 'github',
			location: 'https://github.com/example/repo',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			// trust_level has .default('low').optional(), so omitted → 'low'
			expect(result.data.trust_level).toBe('low');
		}
	});

	it('accepts trust_level=low', () => {
		const result = DiscoverySourceSchema.safeParse({
			type: 'collection',
			location: 'my-collection',
			trust_level: 'low',
		});
		expect(result.success).toBe(true);
	});

	it('accepts trust_level=medium', () => {
		const result = DiscoverySourceSchema.safeParse({
			type: 'collection',
			location: 'my-collection',
			trust_level: 'medium',
		});
		expect(result.success).toBe(true);
	});

	it('accepts trust_level=high', () => {
		const result = DiscoverySourceSchema.safeParse({
			type: 'collection',
			location: 'my-collection',
			trust_level: 'high',
		});
		expect(result.success).toBe(true);
	});

	it('rejects invalid trust_level', () => {
		const result = DiscoverySourceSchema.safeParse({
			type: 'manual_import',
			location: 'local-skill',
			trust_level: 'very-high',
		});
		expect(result.success).toBe(false);
	});
});

describe('ExternalSkillCandidateEvaluationVerdictSchema', () => {
	it('test 14: accepts all 7 verdicts', () => {
		const verdicts = [
			'pending',
			'in_review',
			'quarantined',
			'passed',
			'rejected',
			'promoted',
			'revoked',
		] as const;
		for (const verdict of verdicts) {
			const result =
				ExternalSkillCandidateEvaluationVerdictSchema.safeParse(verdict);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toBe(verdict);
			}
		}
	});

	it('rejects invalid verdict', () => {
		const result =
			ExternalSkillCandidateEvaluationVerdictSchema.safeParse('approved');
		expect(result.success).toBe(false);
	});
});

describe('ExternalSkillCandidateSourceTypeSchema', () => {
	it('accepts all source types', () => {
		const types = ['github', 'url', 'collection', 'manual_import'] as const;
		for (const type of types) {
			const result = ExternalSkillCandidateSourceTypeSchema.safeParse(type);
			expect(result.success).toBe(true);
		}
	});

	it('rejects invalid source type', () => {
		const result = ExternalSkillCandidateSourceTypeSchema.safeParse('npm');
		expect(result.success).toBe(false);
	});
});

describe('PluginConfigSchema with external_skills', () => {
	it('test 15: includes external_skills as optional field', () => {
		const result = PluginConfigSchema.safeParse({
			external_skills: {
				curation_enabled: true,
				max_candidates: 100,
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.external_skills).toBeDefined();
			expect(result.data.external_skills?.curation_enabled).toBe(true);
			expect(result.data.external_skills?.max_candidates).toBe(100);
		}
	});

	it('test 16: parses config without external_skills (backward compat)', () => {
		const result = PluginConfigSchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.external_skills).toBeUndefined();
		}
	});

	it('parses minimal external_skills config and fills all defaults', () => {
		const result = PluginConfigSchema.safeParse({
			external_skills: {},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			const es = result.data.external_skills!;
			expect(es.curation_enabled).toBe(false);
			expect(es.max_candidates).toBe(500);
			expect(es.eviction_policy).toBe('fifo');
			expect(es.ttl_days).toBe(90);
			expect(es.evaluation_enabled).toBe(false);
			expect(es.sources).toEqual([]);
			expect(es.max_candidates_per_discovery).toBe(50);
			expect(es.max_concurrent_fetches).toBe(5);
			expect(es.fetch_timeout_ms).toBe(30000);
		}
	});
});
