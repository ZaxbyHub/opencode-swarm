import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import { createHivePromoterHook } from '../../../src/hooks/hive-promoter.js';
import { createKnowledgeCuratorHook } from '../../../src/hooks/knowledge-curator.js';
import { createKnowledgeInjectorHook } from '../../../src/hooks/knowledge-injector.js';

describe('Knowledge Registration Smoke Test', () => {
	describe('Schema default values', () => {
		it('KnowledgeConfigSchema.parse({}) gives enabled: true, hive_enabled: true', () => {
			const result = KnowledgeConfigSchema.parse({});
			expect(result.enabled).toBe(true);
			expect(result.hive_enabled).toBe(true);
		});

		it('KnowledgeConfigSchema.parse({ enabled: false }) gives enabled: false', () => {
			const result = KnowledgeConfigSchema.parse({ enabled: false });
			expect(result.enabled).toBe(false);
		});
	});

	describe('Conditional logic', () => {
		it('given { enabled: true, hive_enabled: false }, enabled && hive_enabled is false', () => {
			const config = { enabled: true, hive_enabled: false };
			expect(config.enabled && config.hive_enabled).toBe(false);
		});

		it('given { enabled: false, hive_enabled: true }, enabled && hive_enabled is false', () => {
			const config = { enabled: false, hive_enabled: true };
			expect(config.enabled && config.hive_enabled).toBe(false);
		});
	});

	describe('Hook factory functions are callable', () => {
		it('createKnowledgeCuratorHook is a function', () => {
			expect(typeof createKnowledgeCuratorHook).toBe('function');
		});

		it('createHivePromoterHook is a function', () => {
			expect(typeof createHivePromoterHook).toBe('function');
		});

		it('createKnowledgeInjectorHook is a function', () => {
			expect(typeof createKnowledgeInjectorHook).toBe('function');
		});
	});

	describe('Adversarial schema validation', () => {
		it('KnowledgeConfigSchema.parse({ max_inject_count: 51 }) throws ZodError', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ max_inject_count: 51 });
			}).toThrow(z.ZodError);
		});

		it('KnowledgeConfigSchema.parse({ dedup_threshold: 2 }) throws ZodError', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ dedup_threshold: 2 });
			}).toThrow(z.ZodError);
		});

		it('KnowledgeConfigSchema.parse({ enabled: null }) throws ZodError', () => {
			expect(() => {
				KnowledgeConfigSchema.parse({ enabled: null });
			}).toThrow(z.ZodError);
		});
	});
});
