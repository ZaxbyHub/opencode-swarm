/**
 * Write retro tool for persisting retrospective evidence bundles.
 * Accepts flat retro fields from the Architect and wraps them correctly
 * in a RetrospectiveEvidence entry before calling saveEvidence().
 * This fixes the bug where Architect was writing flat JSON that failed EvidenceBundleSchema.parse().
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	type RetrospectiveEvidence,
	RetrospectiveEvidenceSchema,
} from '../config/evidence-schema';
import {
	listEvidenceTaskIds,
	loadEvidence,
	saveEvidence,
} from '../evidence/manager';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the write_retro tool
 * User-supplied fields (the Architect provides these)
 */
export interface WriteRetroArgs {
	/** The phase number being completed (maps to phase_number in schema) */
	phase: number;
	/** Human-readable phase summary (maps to summary in BaseEvidenceSchema) */
	summary: string;
	/** Count of tasks completed */
	task_count: number;
	/** Task complexity level */
	task_complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
	/** Total number of tool calls in the phase */
	total_tool_calls: number;
	/** Number of coder revisions made */
	coder_revisions: number;
	/** Number of reviewer rejections received */
	reviewer_rejections: number;
	loop_detections?: number;
	circuit_breaker_trips?: number;
	/** Number of test failures encountered */
	test_failures: number;
	/** Number of security findings */
	security_findings: number;
	/** Number of integration issues */
	integration_issues: number;
	/** Optional lessons learned (max 5) */
	lessons_learned?: string[];
	/** Optional top rejection reasons */
	top_rejection_reasons?: string[];
	/** Optional task ID (defaults to retro-{phase}) */
	task_id?: string;
	/** Optional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Execute the write_retro tool.
 * Validates input, builds a RetrospectiveEvidence entry, and saves to disk.
 * @param args - The write retro arguments
 * @param directory - Working directory
 * @returns JSON string with success status and details
 */
export async function executeWriteRetro(
	args: WriteRetroArgs,
	directory: string,
): Promise<string> {
	// Reject Windows reserved device names (e.g., CON:, NUL:, PRN:, COM1, LPT1)
	if (/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(:|$)/i.test(directory)) {
		return JSON.stringify(
			{
				success: false,
				message: 'Invalid directory: reserved device name',
			},
			null,
			2,
		);
	}

	// Validate phase is a positive integer
	const phase = args.phase;
	if (!Number.isInteger(phase) || phase < 1) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid phase: must be a positive integer',
			},
			null,
			2,
		);
	}

	// Validate task_complexity is one of the allowed values
	const validComplexities = [
		'trivial',
		'simple',
		'moderate',
		'complex',
	] as const;
	if (!validComplexities.includes(args.task_complexity)) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: `Invalid task_complexity: must be one of 'trivial'|'simple'|'moderate'|'complex'`,
			},
			null,
			2,
		);
	}

	// Validate task_count >= 1
	if (!Number.isInteger(args.task_count) || args.task_count < 1) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid task_count: must be a positive integer >= 1',
			},
			null,
			2,
		);
	}

	// Validate non-negative integer guards for required numeric fields
	if (!Number.isInteger(args.total_tool_calls) || args.total_tool_calls < 0) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid total_tool_calls: must be a non-negative integer',
			},
			null,
			2,
		);
	}

	if (!Number.isInteger(args.coder_revisions) || args.coder_revisions < 0) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid coder_revisions: must be a non-negative integer',
			},
			null,
			2,
		);
	}

	if (
		!Number.isInteger(args.reviewer_rejections) ||
		args.reviewer_rejections < 0
	) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid reviewer_rejections: must be a non-negative integer',
			},
			null,
			2,
		);
	}

	if (!Number.isInteger(args.test_failures) || args.test_failures < 0) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid test_failures: must be a non-negative integer',
			},
			null,
			2,
		);
	}

	if (!Number.isInteger(args.security_findings) || args.security_findings < 0) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid security_findings: must be a non-negative integer',
			},
			null,
			2,
		);
	}

	if (
		!Number.isInteger(args.integration_issues) ||
		args.integration_issues < 0
	) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid integration_issues: must be a non-negative integer',
			},
			null,
			2,
		);
	}

	// Validate non-negative integer guards for optional numeric fields when provided
	if (
		args.loop_detections !== undefined &&
		(!Number.isInteger(args.loop_detections) || args.loop_detections < 0)
	) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid loop_detections: must be a non-negative integer',
			},
			null,
			2,
		);
	}

	if (
		args.circuit_breaker_trips !== undefined &&
		(!Number.isInteger(args.circuit_breaker_trips) ||
			args.circuit_breaker_trips < 0)
	) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message:
					'Invalid circuit_breaker_trips: must be a non-negative integer',
			},
			null,
			2,
		);
	}

	// Validate max bounds for all numeric fields (reject over-limit values before saveEvidence)
	if (args.phase > 99) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid phase: must be <= 99',
			},
			null,
			2,
		);
	}

	if (args.task_count > 9999) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid task_count: must be <= 9999',
			},
			null,
			2,
		);
	}

	if (args.total_tool_calls > 9999) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid total_tool_calls: must be <= 9999',
			},
			null,
			2,
		);
	}

	if (args.coder_revisions > 999) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid coder_revisions: must be <= 999',
			},
			null,
			2,
		);
	}

	if (args.reviewer_rejections > 999) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid reviewer_rejections: must be <= 999',
			},
			null,
			2,
		);
	}

	if (args.loop_detections !== undefined && args.loop_detections > 9999) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid loop_detections: must be <= 9999',
			},
			null,
			2,
		);
	}

	if (
		args.circuit_breaker_trips !== undefined &&
		args.circuit_breaker_trips > 9999
	) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid circuit_breaker_trips: must be <= 9999',
			},
			null,
			2,
		);
	}

	if (args.test_failures > 9999) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid test_failures: must be <= 9999',
			},
			null,
			2,
		);
	}

	if (args.security_findings > 999) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid security_findings: must be <= 999',
			},
			null,
			2,
		);
	}

	if (args.integration_issues > 999) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid integration_issues: must be <= 999',
			},
			null,
			2,
		);
	}

	// Validate summary is non-empty string
	const summary = args.summary;
	if (typeof summary !== 'string' || summary.trim().length === 0) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: 'Invalid summary: must be a non-empty string',
			},
			null,
			2,
		);
	}

	// Validate task_id if explicitly provided
	if (args.task_id !== undefined) {
		const tid = args.task_id;
		if (!tid || tid.length === 0 || tid.length > 200) {
			return JSON.stringify(
				{
					success: false,
					phase: phase,
					message: 'Invalid task ID: must match pattern',
				},
				null,
				2,
			);
		}
		if (/\0/.test(tid)) {
			return JSON.stringify(
				{
					success: false,
					phase: phase,
					message: 'Invalid task ID: contains null bytes',
				},
				null,
				2,
			);
		}
		for (let i = 0; i < tid.length; i++) {
			if (tid.charCodeAt(i) < 32) {
				return JSON.stringify(
					{
						success: false,
						phase: phase,
						message: 'Invalid task ID: contains control characters',
					},
					null,
					2,
				);
			}
		}
		if (tid.includes('..') || tid.includes('/') || tid.includes('\\')) {
			return JSON.stringify(
				{
					success: false,
					phase: phase,
					message: 'Invalid task ID: path traversal detected',
				},
				null,
				2,
			);
		}
		// Accept:
		//   - numeric task IDs (N.M, N.M.P)
		//   - per-phase retrospectives (retro-<digits>)
		//   - named session retrospectives (retro-<alnum>, e.g. 'retro-session')
		// The broader retro-<alnum> form is required by /swarm close's plan-free
		// path, which writes a dedicated 'retro-session' bundle when there are
		// no phases to attach a retro to. It must remain compatible with the
		// evidence manager's GENERAL_TASK_ID_REGEX, which already accepts the
		// same shape.
		const VALID_TASK_ID =
			/^(retro-[a-zA-Z0-9][a-zA-Z0-9_-]*|\d+\.\d+(\.\d+)*)$/;
		if (!VALID_TASK_ID.test(tid)) {
			return JSON.stringify(
				{
					success: false,
					phase: phase,
					message: 'Invalid task ID: must match pattern',
				},
				null,
				2,
			);
		}
	}

	// Build the taskId
	const taskId = args.task_id ?? `retro-${phase}`;

	// Build the RetrospectiveEvidence entry with auto-generated fields
	const retroEntry: RetrospectiveEvidence = {
		task_id: taskId,
		type: 'retrospective',
		timestamp: new Date().toISOString(),
		agent: 'architect',
		verdict: 'pass',
		summary: summary,
		metadata: args.metadata,
		phase_number: phase,
		total_tool_calls: args.total_tool_calls,
		coder_revisions: args.coder_revisions,
		reviewer_rejections: args.reviewer_rejections,
		loop_detections: args.loop_detections,
		circuit_breaker_trips: args.circuit_breaker_trips,
		test_failures: args.test_failures,
		security_findings: args.security_findings,
		integration_issues: args.integration_issues,
		task_count: args.task_count,
		task_complexity: args.task_complexity,
		top_rejection_reasons: args.top_rejection_reasons ?? [],
		lessons_learned: (args.lessons_learned ?? []).slice(0, 5),
		// Required by RetrospectiveEvidence schema; not collected via tool args to avoid complex nested object parsing
		user_directives: [],
		// Required by RetrospectiveEvidence schema; not collected via tool args to avoid complex nested object parsing
		approaches_tried: [],
		error_taxonomy: [] as (
			| 'planning_error'
			| 'interface_mismatch'
			| 'logic_error'
			| 'scope_creep'
			| 'gate_evasion'
		)[],
	};

	// --- Error taxonomy classification from evidence ---
	const taxonomy: (
		| 'planning_error'
		| 'interface_mismatch'
		| 'logic_error'
		| 'scope_creep'
		| 'gate_evasion'
	)[] = [];
	try {
		// Dynamically discover task IDs from evidence store instead of hardcoded suffixes
		const allTaskIds = await listEvidenceTaskIds(directory);
		const phaseTaskIds = allTaskIds.filter((id) => id.startsWith(`${phase}.`));
		// Session-scoping: when session_start is provided in metadata, filter out
		// evidence bundles from prior sessions to prevent taxonomy noise (#444 item 9)
		const sessionStart =
			args.metadata && typeof args.metadata.session_start === 'string'
				? args.metadata.session_start
				: undefined;
		for (const phaseTaskId of phaseTaskIds) {
			const result = await loadEvidence(directory, phaseTaskId);
			if (result.status !== 'found') continue;
			const bundle = result.bundle;
			// Skip bundles not updated since the current session started.
			// Uses updated_at (refreshed on every append) rather than created_at
			// (set once at bundle creation) so bundles with new entries are included.
			if (sessionStart && bundle.updated_at < sessionStart) continue;

			// Scan entries for rejection/failure patterns
			for (const entry of bundle.entries) {
				const e = entry as Record<string, unknown>;

				// Check for reviewer rejection
				if (e.type === 'review' && e.verdict === 'fail') {
					const reasonParts: string[] = [];
					if (typeof e.summary === 'string') reasonParts.push(e.summary);
					if (Array.isArray(e.issues)) {
						for (const iss of e.issues as Record<string, unknown>[]) {
							if (typeof iss.message === 'string')
								reasonParts.push(iss.message);
						}
					}
					const reason = reasonParts.join(' ');
					if (/signature|type|contract|interface/i.test(reason)) {
						taxonomy.push('interface_mismatch');
					} else {
						taxonomy.push('logic_error');
					}
				}
				// Check for test failure
				else if (e.type === 'test' && e.verdict === 'fail') {
					taxonomy.push('logic_error');
				}
				// Check for scope violation
				else if (e.agent === 'scope_guard' && e.verdict === 'fail') {
					taxonomy.push('scope_creep');
				}
				// Check for loop detector block
				else if (e.agent === 'loop_detector' && e.verdict === 'fail') {
					taxonomy.push('gate_evasion');
				}
			}
		}
	} catch {
		// Evidence read failures are non-fatal — taxonomy stays empty
	}
	// Deduplicate and assign
	retroEntry.error_taxonomy = [...new Set(taxonomy)];

	// Validate retroEntry against Zod schema before saving
	const validationResult = RetrospectiveEvidenceSchema.safeParse(retroEntry);
	if (!validationResult.success) {
		return JSON.stringify(
			{
				success: false,
				error: `Retrospective entry failed validation: ${validationResult.error.message}`,
			},
			null,
			2,
		);
	}

	// Call saveEvidence to handle wrapping in EvidenceBundle + atomic write
	try {
		await saveEvidence(directory, taskId, retroEntry);
		return JSON.stringify(
			{
				success: true,
				task_id: taskId,
				phase: phase,
				message: `Retrospective evidence written to .swarm/evidence/${taskId}/evidence.json`,
			},
			null,
			2,
		);
	} catch (error) {
		return JSON.stringify(
			{
				success: false,
				phase: phase,
				message: error instanceof Error ? error.message : String(error),
			},
			null,
			2,
		);
	}
}

/**
 * Tool definition for write_retro
 */
export const write_retro: ToolDefinition = createSwarmTool({
	description:
		'Write a retrospective evidence bundle for a completed phase. ' +
		'Accepts flat retro fields and writes a correctly-wrapped EvidenceBundle to ' +
		'.swarm/evidence/retro-{phase}/evidence.json. ' +
		'Use this instead of manually writing retro JSON to avoid schema validation failures in phase_complete.',
	args: {
		phase: z
			.number()
			.int()
			.min(1)
			.max(99)
			.describe('The phase number being completed (e.g., 1, 2, 3)'),
		summary: z.string().describe('Human-readable summary of the phase'),
		task_count: z
			.number()
			.int()
			.min(1)
			.max(9999)
			.describe('Count of tasks completed in this phase'),
		task_complexity: z
			.enum(['trivial', 'simple', 'moderate', 'complex'])
			.describe('Complexity level of the completed tasks'),
		total_tool_calls: z
			.number()
			.int()
			.min(0)
			.max(9999)
			.describe('Total number of tool calls in this phase'),
		coder_revisions: z
			.number()
			.int()
			.min(0)
			.max(999)
			.describe('Number of coder revisions made'),
		reviewer_rejections: z
			.number()
			.int()
			.min(0)
			.max(999)
			.describe('Number of reviewer rejections received'),
		loop_detections: z
			.number()
			.int()
			.min(0)
			.max(9999)
			.optional()
			.describe('Number of loop detection events in this phase'),
		circuit_breaker_trips: z
			.number()
			.int()
			.min(0)
			.max(9999)
			.optional()
			.describe('Number of circuit breaker trips in this phase'),
		test_failures: z
			.number()
			.int()
			.min(0)
			.max(9999)
			.describe('Number of test failures encountered'),
		security_findings: z
			.number()
			.int()
			.min(0)
			.max(999)
			.describe('Number of security findings'),
		integration_issues: z
			.number()
			.int()
			.min(0)
			.max(999)
			.describe('Number of integration issues'),
		lessons_learned: z
			.array(z.string())
			.max(5)
			.optional()
			.describe('Key lessons learned from this phase (max 5)'),
		top_rejection_reasons: z
			.array(z.string())
			.optional()
			.describe('Top reasons for reviewer rejections'),
		task_id: z
			.string()
			.optional()
			.describe('Optional custom task ID (defaults to retro-{phase})'),
		metadata: z
			.record(z.string(), z.unknown())
			.optional()
			.describe('Optional additional metadata'),
	},
	execute: async (args, directory) => {
		const rawPhase = args.phase !== undefined ? Number(args.phase) : 0;
		try {
			const writeRetroArgs: WriteRetroArgs = {
				phase: Number(args.phase),
				summary: String(args.summary ?? ''),
				task_count: Number(args.task_count),
				task_complexity: args.task_complexity as unknown as
					| 'trivial'
					| 'simple'
					| 'moderate'
					| 'complex',
				total_tool_calls: Number(args.total_tool_calls),
				coder_revisions: Number(args.coder_revisions),
				reviewer_rejections: Number(args.reviewer_rejections),
				loop_detections:
					args.loop_detections != null
						? Number(args.loop_detections)
						: undefined,
				circuit_breaker_trips:
					args.circuit_breaker_trips != null
						? Number(args.circuit_breaker_trips)
						: undefined,
				test_failures: Number(args.test_failures),
				security_findings: Number(args.security_findings),
				integration_issues: Number(args.integration_issues),
				lessons_learned: Array.isArray(args.lessons_learned)
					? args.lessons_learned.map(String)
					: undefined,
				top_rejection_reasons: Array.isArray(args.top_rejection_reasons)
					? args.top_rejection_reasons.map(String)
					: undefined,
				task_id: args.task_id !== undefined ? String(args.task_id) : undefined,
				metadata: args.metadata as unknown as
					| Record<string, unknown>
					| undefined,
			};
			return await _internals.executeWriteRetro(writeRetroArgs, directory);
		} catch {
			return JSON.stringify(
				{ success: false, phase: rawPhase, message: 'Invalid arguments' },
				null,
				2,
			);
		}
	},
});

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 * Uses getter for write_retro to avoid circular reference at module load time.
 */
export const _internals: {
	executeWriteRetro: typeof executeWriteRetro;
	write_retro: typeof write_retro;
} = {
	executeWriteRetro: executeWriteRetro,
	write_retro: write_retro,
} as const;
