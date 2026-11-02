import { z } from 'zod';
import {
	executeReceiptEmission,
	executeReceiptVerify,
} from '../services/receipt-service';
import { createSwarmTool } from './create-tool';

/**
 * `receipt` tool (#2968 emission + #2970 verify).
 *
 * Two mutually exclusive invocation shapes (strict refinement enforced in
 * execute — verify never requires dummy emission arguments):
 *   { unit: 'task'|'phase', id, export? }  — emit (and optionally bundle)
 *   { verify: <bundle path> }              — verify a bundle
 *
 * Output is bounded JSON metadata only (paths, hashes, counts); the receipt
 * itself is a file artifact, never inlined into tool output.
 */
export const receipt: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'emit a portable verification receipt (JSON + Markdown) recording every gate that ran for a task or phase, with content hashes and snapshot hashes; export writes a self-contained bundle under .swarm/plan-export/ and --verify re-checks every hash in a bundle on any machine, exiting nonzero on any mismatch',
	args: {
		unit: z
			.enum(['task', 'phase'])
			.optional()
			.describe('Receipt unit kind (emission shape)'),
		id: z.string().optional().describe('Task or phase id (emission shape)'),
		export: z
			.boolean()
			.optional()
			.describe('Also write a self-contained export bundle'),
		verify: z
			.string()
			.optional()
			.describe('Bundle directory or receipt.json path to re-verify'),
	},
	execute: async (args: unknown, directory: string): Promise<string> => {
		const typed = args as {
			unit?: 'task' | 'phase';
			id?: string;
			export?: boolean;
			verify?: string;
		};
		const hasVerify = typed.verify !== undefined;
		const hasEmission = typed.unit !== undefined && typed.id !== undefined;
		if (hasVerify && hasEmission) {
			throw new Error(
				'Invalid arguments: verify is mutually exclusive with unit/id emission arguments',
			);
		}
		if (hasVerify) {
			const outcome = await executeReceiptVerify(typed.verify as string);
			return JSON.stringify({ ...outcome, summary: undefined });
		}
		if (!hasEmission) {
			throw new Error(
				'Invalid arguments: provide either { unit, id } to emit a receipt or { verify } to verify a bundle',
			);
		}
		if (typed.unit !== 'task' && typed.unit !== 'phase') {
			throw new Error('Invalid arguments: unit must be task or phase');
		}
		const outcome = await executeReceiptEmission(
			directory,
			typed.unit,
			typed.id as string,
			typed.export === true,
		);
		return JSON.stringify(outcome);
	},
});
