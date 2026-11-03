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
 * execute — verify never requires dummy emission arguments, and NO emission
 * field may accompany `verify`, FB-007):
 *   { unit: 'task'|'phase', id, export? }  — emit (and optionally bundle)
 *   { verify: <bundle path> }              — verify a bundle (relative paths
 *                                            resolve against the tool's
 *                                            project directory, never
 *                                            process.cwd() — invariant 4)
 *
 * Output is bounded JSON metadata only (paths, hashes, counts); the receipt
 * itself is a file artifact, never inlined into tool output.
 */
export const receipt: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'emit a portable verification receipt (JSON + Markdown) recording the durably recorded gate outcomes for a task or phase, with content hashes and snapshot hashes; export writes a self-contained bundle under .swarm/plan-export/ and --verify re-checks every recorded hash of a bundle on any machine (internal consistency, not external anchoring), exiting nonzero on any mismatch',
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
		const verifyTarget = typed.verify;
		const hasAnyEmissionField =
			typed.unit !== undefined ||
			typed.id !== undefined ||
			typed.export !== undefined;
		if (verifyTarget !== undefined) {
			// FB-007: ANY emission field (not only the complete pair) is
			// mutually exclusive with verify — partial shapes must fail
			// closed instead of silently dropping the caller's other intent.
			if (hasAnyEmissionField) {
				throw new Error(
					'Invalid arguments: verify is mutually exclusive with unit/id/export emission arguments',
				);
			}
			if (verifyTarget.trim() === '') {
				throw new Error('Invalid arguments: verify must not be empty');
			}
			// PRR-021: relative verify targets resolve against the tool's
			// injected project directory (ctx.directory), never process.cwd().
			const outcome = await executeReceiptVerify(verifyTarget, directory);
			return JSON.stringify({ ...outcome, summary: undefined });
		}
		if (typed.unit === undefined || typed.id === undefined) {
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
