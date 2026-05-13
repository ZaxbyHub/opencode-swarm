import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';

/**
 * Converts a Zod schema to a JSON Schema compatible with MCP.
 */
export function zodToMcpSchema(schema: z.ZodType<any>) {
	const jsonSchema = zodToJsonSchema(schema, {
		$refStrategy: 'none',
	});

	// Remove $schema as it's often not needed in MCP tool definitions
	if ('$schema' in jsonSchema) {
		delete jsonSchema.$schema;
	}

	return jsonSchema;
}
