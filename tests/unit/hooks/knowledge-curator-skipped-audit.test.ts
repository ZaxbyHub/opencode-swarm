import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../../../src/memory/redaction.js';
import { curateAndStoreSwarm } from '../../../src/hooks/knowledge-curator.js';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';

describe('curator skipped audit records', () => {
	test('redacts lesson excerpts and uses a real candidate id for near duplicates', async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'curator-skipped-'));
		try {
			mkdirSync(path.join(directory, '.swarm'), { recursive: true });
			const duplicateId = 'existing-entry-id';
			const lesson = 'Use gh status before deploy with ghp_12345678901234567890';
			const existing = {
				id: duplicateId,
				tier: 'swarm',
				lesson,
				category: 'process',
				tags: ['process'],
				scope: 'global',
				confidence: 0.8,
				status: 'candidate',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: 2,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				project_name: 'proj',
				auto_generated: true,
			};
			writeFileSync(
				path.join(directory, '.swarm', 'knowledge.jsonl'),
				`${JSON.stringify(existing)}\n`,
			);

			const result = await curateAndStoreSwarm(
				[lesson],
				'proj',
				{ phase_number: 1 },
				directory,
				KnowledgeConfigSchema.parse({ validation_enabled: false }),
				{ skipAutoPromotion: true },
			);

			expect(result.skipped).toBe(1);
			const event = readFileSync(
				path.join(directory, '.swarm', 'events.jsonl'),
				'utf-8',
			)
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.find((entry) => entry.event === 'curator_skipped');
			expect(event).toBeDefined();
			expect(event?.entry_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(event?.entry_id).not.toBe(duplicateId);
			expect(event?.duplicate_target_id).toBe(duplicateId);
			const redactedLesson = redactSecrets(lesson);
			expect(event?.lesson).toBe(redactedLesson);
			expect(event?.lesson).not.toContain('ghp_12345678901234567890');
			expect(event?.content_hash).toBe(
				createHash('sha1').update(redactedLesson).digest('hex'),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
