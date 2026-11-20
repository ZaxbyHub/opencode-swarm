import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GeneralCouncilConfigSchema } from '../../../src/config/schema';

describe('council.general.searchProvider keenable', () => {
	it('accepts keenable as an optional provider; default remains tavily', () => {
		const keenable = GeneralCouncilConfigSchema.safeParse({
			searchProvider: 'keenable',
		});
		expect(keenable.success).toBe(true);
		const defaults = GeneralCouncilConfigSchema.safeParse({});
		expect(defaults.success).toBe(true);
		if (defaults.success) {
			expect(defaults.data.searchProvider).toBe('tavily');
		}
	});

	it('still rejects an unknown provider', () => {
		expect(
			GeneralCouncilConfigSchema.safeParse({ searchProvider: 'duckduckgo' })
				.success,
		).toBe(false);
	});

	it('generated opencode-swarm.schema.json enum equals the provider list', () => {
		const schemaPath = path.resolve(
			import.meta.dir,
			'../../../opencode-swarm.schema.json',
		);
		const json = JSON.parse(readFileSync(schemaPath, 'utf-8')) as {
			properties: {
				council: {
					properties: {
						general: {
							properties: { searchProvider: { enum: string[] } };
						};
					};
				};
			};
		};
		expect(
			json.properties.council.properties.general.properties.searchProvider.enum,
		).toEqual(['tavily', 'brave', 'keenable']);
	});
});
