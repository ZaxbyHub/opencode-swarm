import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { zodToMcpSchema } from './schema';

describe('zodToMcpSchema', () => {
	it('converts a simple zod object to JSON schema', () => {
		const schema = z.object({
			pattern: z.string().describe('The pattern to search for'),
			include_pattern: z.string().optional().describe('Glob pattern to filter files'),
		});

		const result = zodToMcpSchema(schema);

		expect(result).toEqual({
			type: 'object',
			properties: {
				pattern: {
					type: 'string',
					description: 'The pattern to search for',
				},
				include_pattern: {
					type: 'string',
					description: 'Glob pattern to filter files',
				},
			},
			required: ['pattern'],
			additionalProperties: false,
		});
	});
});
