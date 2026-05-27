import { describe, expect, test } from 'bun:test';
import {
	ArchitecturalSupervisionConfigSchema,
	PluginConfigSchema,
} from '../../../src/config/schema';

describe('ArchitecturalSupervisionConfigSchema', () => {
	test('defaults are opt-in and advisory', () => {
		const parsed = ArchitecturalSupervisionConfigSchema.parse({});
		expect(parsed.enabled).toBe(false);
		expect(parsed.mode).toBe('advisory');
		expect(parsed.run_on).toBe('phase_complete');
		expect(parsed.max_agent_summary_words).toBe(100);
		expect(parsed.max_phase_summary_words).toBe(250);
		expect(parsed.allow_concerns_to_complete).toBe(true);
		expect(parsed.persist_knowledge_recommendations).toBe(false);
	});

	test('rejects an invalid mode', () => {
		expect(
			ArchitecturalSupervisionConfigSchema.safeParse({ mode: 'block' }).success,
		).toBe(false);
	});

	test('is attached to PluginConfigSchema as optional', () => {
		const ok = PluginConfigSchema.safeParse({
			architectural_supervision: { enabled: true, mode: 'gate' },
		});
		expect(ok.success).toBe(true);
		const absent = PluginConfigSchema.safeParse({});
		expect(absent.success).toBe(true);
	});
});
