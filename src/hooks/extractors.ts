import { type Plan, resolveActivePhaseId } from '../config/plan-schema';
import { extractContextDecisions } from '../utils/context-decisions';
import { sanitizeContextText } from './context-sanitizer';
import { estimateCharsForTokens } from './utils';

/**
 * Swarm File Extractors
 *
 * Pure parsing functions for extracting structured data from .swarm/ files.
 * Used by system-enhancer and compaction-customizer hooks.
 */

/**
 * Extracts the current phase information from plan content.
 *
 * #2841: plan.md is user-writeable content and this one-liner feeds the
 * `[SWARM CONTEXT] Phase:` architect-context injection, so it MUST pass the
 * shared sanitizer (input-side, the same pattern as `extractPlanCursor`).
 */
export function extractCurrentPhase(planContent: string): string | null {
	if (!planContent) {
		return null;
	}

	planContent = sanitizeContextText(planContent);

	const lines = planContent.split('\n');

	// Look for IN PROGRESS phase in the first 20 lines
	for (let i = 0; i < Math.min(20, lines.length); i++) {
		const line = lines[i].trim();
		const progressMatch = line.match(
			/^## Phase (\d+):?\s*(.*?)\s*\[IN PROGRESS\]/i,
		);
		if (progressMatch) {
			const phaseNum = progressMatch[1];
			const description = progressMatch[2]?.trim() || '';
			return `Phase ${phaseNum}: ${description} [IN PROGRESS]`;
		}
	}

	// #2886: report a BLOCKED phase the way the structured path already does
	// (`extractCurrentPhaseFromPlan` maps blocked → 'BLOCKED') instead of
	// silently dropping it. First BLOCKED wins, mirroring the plan cursor's
	// `phases.find` precedent; an IN PROGRESS phase still outranks it.
	for (let i = 0; i < Math.min(20, lines.length); i++) {
		const line = lines[i].trim();
		const blockedMatch = line.match(/^## Phase (\d+):?\s*(.*?)\s*\[BLOCKED\]/i);
		if (blockedMatch) {
			const phaseNum = blockedMatch[1];
			const description = blockedMatch[2]?.trim() || '';
			return `Phase ${phaseNum}: ${description} [BLOCKED]`;
		}
	}

	// Look for Phase: N in the first 3 lines (header)
	for (let i = 0; i < Math.min(3, lines.length); i++) {
		const line = lines[i].trim();
		const phaseMatch = line.match(/Phase:\s*(\d+)/i);
		if (phaseMatch) {
			const phaseNum = phaseMatch[1];
			return `Phase ${phaseNum} [PENDING]`;
		}
	}

	return null;
}

/**
 * Extracts the first incomplete task from the current IN PROGRESS phase.
 *
 * #2841: feeds the `[SWARM CONTEXT] Current task:` injection — sanitized
 * input-side like its siblings.
 */
export function extractCurrentTask(planContent: string): string | null {
	if (!planContent) {
		return null;
	}

	planContent = sanitizeContextText(planContent);

	const lines = planContent.split('\n');
	let inCurrentPhase = false;

	for (const line of lines) {
		// Find the IN PROGRESS phase
		if (line.startsWith('## ') && /\[IN PROGRESS\]/i.test(line)) {
			inCurrentPhase = true;
			continue;
		}

		if (inCurrentPhase) {
			// Stop at the next phase heading or horizontal rule
			if (line.startsWith('## ') || line.trim() === '---') {
				break;
			}
			// Find the first incomplete task
			if (line.trim().startsWith('- [ ]')) {
				return line.trim();
			}
		}
	}

	return null;
}

/**
 * Extracts decisions section from context content.
 *
 * #2493 W9a: derives from the shared section extractor
 * (`src/utils/context-decisions.ts`) instead of a private line-scan.
 * Mapping preserves this consumer's historical output exactly:
 * - Only NON-indented `- ` lines are kept (the old scan matched raw
 *   `line.startsWith('- ')`; the shared extractor is indent-tolerant, so
 *   indented sub-bullets are filtered out here).
 * - Lines are reproduced verbatim from `raw` — bullet prefix, markers
 *   (✅ / [timestamps]) and all — then joined, trimmed and truncated.
 *
 * #2886: context.md is agent-written after consuming untrusted task/issue
 * text and this return feeds the compaction `SWARM DECISIONS` LLM-context
 * fact, so it MUST pass the shared sanitizer input-side (the same pattern as
 * `extractCurrentPhase`); the system-enhancer wraps of this output become
 * idempotent no-ops.
 */
export function extractDecisions(
	contextContent: string,
	maxChars: number = 500,
): string | null {
	if (!contextContent) {
		return null;
	}

	contextContent = sanitizeContextText(contextContent);

	const decisionLines = extractContextDecisions(contextContent)
		.filter((decision) => decision.raw.startsWith('- '))
		.map((decision) => decision.raw);
	const decisionsText = decisionLines.map((line) => `${line}\n`).join('');

	if (!decisionsText.trim()) {
		return null;
	}

	// Truncate to maxChars and clean up
	const trimmed = decisionsText.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	return `${trimmed.slice(0, maxChars)}...`;
}

/**
 * Extracts incomplete tasks from plan content under the current IN PROGRESS phase.
 *
 * #2841: feeds the `SWARM TASKS` compaction fact (LLM-context injection) —
 * sanitized input-side like its siblings.
 */
export function extractIncompleteTasks(
	planContent: string,
	maxChars: number = 500,
): string | null {
	if (!planContent) {
		return null;
	}

	planContent = sanitizeContextText(planContent);

	const lines = planContent.split('\n');
	let tasksText = '';
	let inCurrentPhase = false;

	for (const line of lines) {
		// Find the IN PROGRESS phase
		if (line.startsWith('## ') && /\[IN PROGRESS\]/i.test(line)) {
			inCurrentPhase = true;
			continue;
		}

		if (inCurrentPhase) {
			// Stop at the next phase heading or horizontal rule
			if (line.startsWith('## ') || line.trim() === '---') {
				break;
			}
			// Collect incomplete tasks (- [ ] lines)
			if (line.trim().startsWith('- [ ]')) {
				tasksText += `${line.trim()}\n`;
			}
		}
	}

	if (!tasksText.trim()) {
		return null;
	}

	const trimmed = tasksText.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	return `${trimmed.slice(0, maxChars)}...`;
}

/**
 * Extracts patterns section from context content.
 *
 * #2886: context.md is agent-written after consuming untrusted task/issue
 * text and this return feeds the compaction `SWARM PATTERNS` LLM-context
 * fact, so it MUST pass the shared sanitizer input-side (the same pattern as
 * `extractCurrentPhase`).
 */
export function extractPatterns(
	contextContent: string,
	maxChars: number = 500,
): string | null {
	if (!contextContent) {
		return null;
	}

	contextContent = sanitizeContextText(contextContent);

	const lines = contextContent.split('\n');
	let patternsText = '';
	let inPatternsSection = false;

	for (const line of lines) {
		if (line.trim() === '## Patterns') {
			inPatternsSection = true;
			continue;
		}

		if (inPatternsSection) {
			if (line.startsWith('## ')) {
				break;
			}
			if (line.startsWith('- ')) {
				patternsText += `${line}\n`;
			}
		}
	}

	if (!patternsText.trim()) {
		return null;
	}

	const trimmed = patternsText.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	return `${trimmed.slice(0, maxChars)}...`;
}

/**
 * Extracts current phase info from a Plan object.
 *
 * #2532: resolves the phase through the canonical active-phase resolver so a
 * stale stored cursor (legacy plans whose current_phase never advanced) can
 * never suppress the summary — the honest active phase is reported instead.
 */
export function extractCurrentPhaseFromPlan(plan: Plan): string | null {
	const label = composePhaseLabel(plan, resolveActivePhaseId(plan));
	if (label === null) return null;
	// #2841: phase.name is architect-authored from untrusted input and this
	// one-liner feeds the `[SWARM CONTEXT] Phase:` injection — the composed
	// string must pass the shared sanitizer before it is returned.
	return sanitizeContextText(label);
}

/** The sanitized `Phase N: name [STATUS]` label for one phase of the plan. */
export function extractPhaseLabelFromPlan(
	plan: Plan,
	phaseId: number,
): string | null {
	const label = composePhaseLabel(plan, phaseId);
	if (label === null) return null;
	// #2841: same untrusted phase.name as extractCurrentPhaseFromPlan.
	return sanitizeContextText(label);
}

/** Unsanitized label; every exported caller sanitizes it (#2841). */
function composePhaseLabel(plan: Plan, phaseId: number): string | null {
	const phase = plan.phases.find((p) => p.id === phaseId);
	if (!phase) return null;
	const statusMap: Record<string, string> = {
		pending: 'PENDING',
		in_progress: 'IN PROGRESS',
		complete: 'COMPLETE',
		blocked: 'BLOCKED',
	};
	const statusText = statusMap[phase.status] || 'PENDING';
	return `Phase ${phase.id}: ${phase.name} [${statusText}]`;
}

/**
 * Parse the stable numeric phase id embedded in a stored phase label.
 *
 * Membership labels are immutable once committed, so the embedded id is a
 * stable identity even for legacy records that predate the explicit
 * `phase_id` field (#2947). Accepts BOTH live label shapes — the composed
 * `Phase 2: Name [STATUS]` form and the short architect form `Phase 2` —
 * using the same loose canonical regex as `phaseNumberOf` in
 * knowledge-injector.ts (which delegates here). Returns undefined for labels
 * that carry no `Phase N` prefix AND for `Phase 0`: real plan phases are
 * >= 1 (PhaseSchema), and the architect no-plan fallback label `Phase 0` is a
 * synthetic marker that must never become a membership phase_id. Callers must
 * treat undefined as "no id" and fall back to verbatim-label matching.
 */
export function extractPhaseIdFromLabel(
	label: string | undefined,
): number | undefined {
	if (!label) return undefined;
	const m = /^Phase\s+(\d+)/i.exec(label);
	if (!m) return undefined;
	const id = Number(m[1]);
	return Number.isSafeInteger(id) && id >= 1 ? id : undefined;
}

/**
 * Extracts the first incomplete task from the current phase of a Plan object.
 *
 * #2841: task fields feed the `[SWARM CONTEXT] Current task:` injection —
 * the composed line must pass the shared sanitizer before it is returned.
 */
export function extractCurrentTaskFromPlan(plan: Plan): string | null {
	const phase = plan.phases.find((p) => p.id === resolveActivePhaseId(plan));
	if (!phase) return null;

	// Find first in_progress task, or first pending task
	const inProgress = phase.tasks.find((t) => t.status === 'in_progress');
	if (inProgress) {
		const deps =
			inProgress.depends.length > 0
				? ` (depends: ${inProgress.depends.join(', ')})`
				: '';
		return sanitizeContextText(
			`- [ ] ${inProgress.id}: ${inProgress.description} [${inProgress.size.toUpperCase()}]${deps} ← CURRENT`,
		);
	}

	const pending = phase.tasks.find((t) => t.status === 'pending');
	if (pending) {
		const deps =
			pending.depends.length > 0
				? ` (depends: ${pending.depends.join(', ')})`
				: '';
		return sanitizeContextText(
			`- [ ] ${pending.id}: ${pending.description} [${pending.size.toUpperCase()}]${deps}`,
		);
	}

	return null;
}

/**
 * Extracts incomplete tasks from the current phase of a Plan object.
 */
export function extractIncompleteTasksFromPlan(
	plan: Plan,
	maxChars: number = 500,
): string | null {
	const phase = plan.phases.find((p) => p.id === resolveActivePhaseId(plan));
	if (!phase) return null;

	const incomplete = phase.tasks.filter(
		(t) => t.status === 'pending' || t.status === 'in_progress',
	);
	if (incomplete.length === 0) return null;

	const lines = incomplete.map((t) => {
		const deps =
			t.depends.length > 0 ? ` (depends: ${t.depends.join(', ')})` : '';
		const marker = t.status === 'in_progress' ? ' ← CURRENT' : '';
		return `- [ ] ${t.id}: ${t.description} [${t.size.toUpperCase()}]${deps}${marker}`;
	});

	// #2841: task fields feed the `SWARM TASKS` compaction fact (LLM-context
	// injection). Sanitize BEFORE the maxChars bound so the documented
	// truncation limit holds on the sanitized text (same rationale as the
	// #2838 cursor input-side fix).
	const text = sanitizeContextText(lines.join('\n'));
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}...`;
}

/**
 * Extracts plan cursor - a concise summary of current phase, current task,
 * and lookahead tasks for context-aware agent communication.
 *
 * @param planContent - The raw plan markdown content
 * @param options - Optional configuration
 * @param options.maxTokens - Target max tokens (default 1500, ~6000 chars)
 * @param options.lookaheadTasks - Number of lookahead tasks (default 2)
 * @returns A [SWARM PLAN CURSOR] block with phase summaries and task details
 */
export function extractPlanCursor(
	planContent: string,
	options?: { maxTokens?: number; lookaheadTasks?: number },
): string {
	const maxTokens = options?.maxTokens ?? 1500;
	// Canonical tokens→chars inverse (src/hooks/utils.ts — issue #1616/#2107).
	// Previously an inline *4 constant unconnected to the char→token direction;
	// the two directions could drift independently.
	const maxChars = estimateCharsForTokens(maxTokens);
	const lookaheadCount = options?.lookaheadTasks ?? 2;

	// Issue #2838 review (critic-confirmed): plan.md is user-writeable content
	// and the cursor is injected into the architect system prompt on BOTH
	// context paths, so it must pass the shared sanitizer like every sibling
	// injection. Sanitizing the INPUT (not the injection sites) keeps the
	// budget report's planCursorTokens accounting exact by construction and
	// runs before the max_tokens caps so the documented bound holds on the
	// sanitized text.
	if (planContent && typeof planContent === 'string') {
		planContent = sanitizeContextText(planContent);
	}

	// Handle null/undefined/empty input
	if (!planContent || typeof planContent !== 'string') {
		return `[SWARM PLAN CURSOR]
No plan content available. Start by creating a .swarm/plan.md file.
[/SWARM PLAN CURSOR]`;
	}

	const lines = planContent.split('\n');
	const result: string[] = [];
	result.push('[SWARM PLAN CURSOR]');

	// Track phases
	const phases: Array<{
		number: number;
		title: string;
		status: 'COMPLETE' | 'IN PROGRESS' | 'PENDING' | 'BLOCKED';
		contentLines: string[];
	}> = [];

	let currentPhase: (typeof phases)[0] | null = null;
	let inPhase = false;

	// Parse phases from the content
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Detect phase header
		const phaseMatch = trimmed.match(
			/^## Phase (\d+):?\s*(.*?)\s*\[(COMPLETE|IN PROGRESS|PENDING|BLOCKED)\]/i,
		);
		if (phaseMatch) {
			// Save previous phase
			if (currentPhase) {
				phases.push(currentPhase);
			}

			const phaseNum = parseInt(phaseMatch[1], 10);
			const phaseTitle = phaseMatch[2]?.trim() || '';
			const status = phaseMatch[3].toUpperCase() as
				| 'COMPLETE'
				| 'IN PROGRESS'
				| 'PENDING'
				| 'BLOCKED';

			currentPhase = {
				number: phaseNum,
				title: phaseTitle,
				status: status,
				contentLines: [],
			};
			inPhase = true;
			continue;
		}

		// Stop at next phase or horizontal rule
		if (inPhase && (line.startsWith('## ') || trimmed === '---')) {
			if (currentPhase) {
				phases.push(currentPhase);
			}
			currentPhase = null;
			inPhase = false;
			continue;
		}

		// Collect content for current phase
		if (currentPhase && inPhase && trimmed) {
			currentPhase.contentLines.push(line);
		}
	}

	// Don't forget the last phase
	if (currentPhase) {
		phases.push(currentPhase);
	}

	if (phases.length === 0) {
		result.push('No phases found in plan.');
		result.push('[/SWARM PLAN CURSOR]');
		return result.join('\n');
	}

	// Find IN PROGRESS phase and COMPLETE phases
	const inProgressPhase = phases.find((p) => p.status === 'IN PROGRESS');
	const completePhases = phases.filter((p) => p.status === 'COMPLETE');
	const pendingPhases = phases.filter((p) => p.status === 'PENDING');

	// Output complete phases (earlier ones) - one-liners
	if (completePhases.length > 0) {
		// Get the last few complete phases (max 5 to stay under limit)
		const recentComplete = completePhases.slice(-5);

		// Check if there are even earlier phases
		if (completePhases.length > 5) {
			result.push('');
			result.push(`## Earlier Phases (${completePhases.length - 5} more)`);
			result.push(`- Phase 1-${completePhases.length - 5}: Complete`);
		}

		result.push('');
		result.push('## Completed Phases');
		for (const phase of recentComplete) {
			// Extract task summaries from content
			const taskLines = phase.contentLines
				.filter((l) => l.trim().startsWith('- ['))
				.map((l) =>
					l
						.replace(/^- \[[ xX]\]\s*/, '')
						.replace(/\s*\[.*?\]/g, '')
						.trim(),
				)
				.slice(0, 3); // Max 3 tasks per phase summary

			const taskSummary =
				taskLines.length > 0 ? taskLines.join(', ') : 'All tasks complete';

			result.push(`- Phase ${phase.number}: ${phase.title}`);
			result.push(`  - ${taskSummary}`);
		}
	}

	// Find incomplete tasks in IN PROGRESS phase (cached for reuse)
	const incompleteTasks = inProgressPhase
		? inProgressPhase.contentLines
				.filter((l) => l.trim().startsWith('- [ ]'))
				.map((l) => l.trim())
		: [];

	// Output IN PROGRESS phase with full details
	if (inProgressPhase) {
		result.push('');
		result.push(`## Phase ${inProgressPhase.number} [IN PROGRESS]`);
		result.push(`- ${inProgressPhase.title}`);

		if (incompleteTasks.length > 0) {
			// Current task (first incomplete)
			const currentTask = incompleteTasks[0];
			result.push('');
			result.push(`- Current: ${currentTask.replace('- [ ] ', '')}`);

			// Lookahead tasks
			const lookahead = incompleteTasks.slice(1, 1 + lookaheadCount);
			for (let i = 0; i < lookahead.length; i++) {
				result.push(`- Next: ${lookahead[i].replace('- [ ] ', '')}`);
			}
		} else {
			result.push('- (No pending tasks)');
		}
	}

	// Output next pending phase(s)
	const nextPending = pendingPhases[0];
	// #2841: surface a blocked phase (first one) as a one-liner like PENDING
	// instead of silently dropping it from the cursor.
	const nextBlocked = phases.find((p) => p.status === 'BLOCKED');
	if (nextBlocked) {
		result.push('');
		result.push(`## Phase ${nextBlocked.number} [BLOCKED]`);
		result.push(`- ${nextBlocked.title}`);
	}
	if (nextPending) {
		result.push('');
		result.push(`## Phase ${nextPending.number} [PENDING]`);
		result.push(`- ${nextPending.title}`);
	}

	// Trim to max chars
	let output = result.join('\n');
	output += '\n[/SWARM PLAN CURSOR]';

	// Trim to max chars - truncate task summaries more aggressively while maintaining structure
	if (output.length > maxChars) {
		// Rebuild with truncated task summaries but same structure
		const compactResult: string[] = [];
		compactResult.push('[SWARM PLAN CURSOR]');

		// Compact complete phases - fewer tasks
		if (completePhases.length > 0) {
			compactResult.push('## Completed Phases');
			const recentCompact = completePhases.slice(-3);
			for (const phase of recentCompact) {
				// Get only first task summary
				const taskLines = phase.contentLines
					.filter((l) => l.trim().startsWith('- ['))
					.map((l) =>
						l
							.replace(/^- \[[ xX]\]\s*/, '')
							.replace(/\s*\[.*?\]/g, '')
							.trim(),
					)
					.slice(0, 1);
				const taskSummary = taskLines.length > 0 ? taskLines[0] : 'Complete';
				compactResult.push(`- Phase ${phase.number}: ${taskSummary}`);
			}
			if (completePhases.length > 3) {
				compactResult.push(
					`- Earlier: Phase 1-${completePhases.length - 3} complete`,
				);
			}
		}

		// IN PROGRESS - reuse cached incompleteTasks
		if (inProgressPhase) {
			compactResult.push('');
			compactResult.push(`## Phase ${inProgressPhase.number} [IN PROGRESS]`);
			compactResult.push(`- ${inProgressPhase.title}`);

			if (incompleteTasks.length > 0) {
				// Truncate task text if needed
				const truncateTask = (task: string) => {
					const text = task.replace('- [ ] ', '');
					return text.length > 60 ? `${text.slice(0, 57)}...` : text;
				};

				compactResult.push(`- Current: ${truncateTask(incompleteTasks[0])}`);
				// Fewer lookahead tasks in compact mode
				const lookahead = incompleteTasks.slice(
					1,
					1 + Math.min(lookaheadCount, 1),
				);
				for (const task of lookahead) {
					compactResult.push(`- Next: ${truncateTask(task)}`);
				}
			} else {
				compactResult.push('- (No pending tasks)');
			}
		}

		// Blocked phase one-liner (#2841) — compact rebuild must surface it too.
		if (nextBlocked) {
			compactResult.push('');
			compactResult.push(`## Phase ${nextBlocked.number} [BLOCKED]`);
			compactResult.push(`- ${nextBlocked.title}`);
		}

		// Next pending
		if (nextPending) {
			compactResult.push('');
			compactResult.push(`## Phase ${nextPending.number} [PENDING]`);
			compactResult.push(`- ${nextPending.title}`);
		}

		compactResult.push('[/SWARM PLAN CURSOR]');
		output = compactResult.join('\n');
	}

	// Final cap (#2580): enforce the documented max_tokens UPPER BOUND on every
	// output shape. The compact rebuild bounds IN-PROGRESS task text (60 chars)
	// but not completed-phase task summaries, so one pathological line could
	// still exceed the budget (final-crit finding: 4014 tokens at maxTokens 500).
	// Reserve the closing marker plus a small ceil-boundary margin so the
	// canonical estimator always agrees the result fits.
	if (output.length > maxChars) {
		const closingMarker = '\n[/SWARM PLAN CURSOR]';
		const cap = Math.max(0, maxChars - closingMarker.length - 4);
		let trimmed = output.slice(0, cap);
		// Prefer cutting at a line boundary so the injected block does not end
		// in a truncated fragment (#2838 review F7). Single-line pathological
		// input has no earlier newline and keeps the raw slice.
		const lastNewline = trimmed.lastIndexOf('\n');
		if (lastNewline > 0) {
			trimmed = trimmed.slice(0, lastNewline);
		}
		// #2841 (final-critic): the cap keeps the FRONT and can cut the BLOCKED
		// one-liner off the tail — the exact silent drop this issue closes.
		// Reserve room for the first blocked summary ahead of generic tail
		// truncation, as long as the summary itself fits the documented bound;
		// when even it cannot fit max_chars, the bound wins (as for every
		// other section). The fit check uses the composed summary length
		// (marker + '\n- ' + title) plus the closing marker and the leading
		// newline — reviewer round 2 caught a +2 under-reserve here.
		let blockedReserved = false;
		if (nextBlocked) {
			const blockedMarker = `## Phase ${nextBlocked.number} [BLOCKED]`;
			const blockedSummary = `${blockedMarker}\n- ${nextBlocked.title}`;
			if (
				!trimmed.includes(blockedMarker) &&
				blockedSummary.length + closingMarker.length + 1 <= maxChars
			) {
				const room = Math.max(
					0,
					maxChars - blockedSummary.length - closingMarker.length - 1,
				);
				if (trimmed.length > room) {
					trimmed = trimmed.slice(0, room);
					const trimNewline = trimmed.lastIndexOf('\n');
					if (trimNewline > 0) {
						trimmed = trimmed.slice(0, trimNewline);
					}
				}
				output = `${trimmed}\n${blockedSummary}${closingMarker}`;
				blockedReserved = true;
			}
		}
		if (!blockedReserved) {
			output = `${trimmed}${closingMarker}`;
		}
	}

	return output;
}

/**
 * Effective plan-cursor controls for the issue #2580 contract: the
 * `plan_cursor` schema block (enabled/max_tokens/lookahead_tasks) must reach
 * BOTH system-enhancer context paths and the context budget report through
 * one shared resolver so the three consumers cannot drift apart again.
 *
 * Field defaults mirror PlanCursorConfigSchema (src/config/schema.ts) and
 * extractPlanCursor's own parameter defaults, so an absent or partial block
 * (raw test configs bypass zod) yields byte-identical pre-#2580 behavior.
 * Out-of-range values are clamped to the schema bounds as defense in depth —
 * zod already rejects them for parsed configs.
 */
export interface PlanCursorControls {
	enabled: boolean;
	maxTokens: number;
	lookaheadTasks: number;
}

export function resolvePlanCursorControls(
	planCursor?:
		| {
				enabled?: boolean;
				max_tokens?: number;
				lookahead_tasks?: number;
		  }
		| null
		| undefined,
): PlanCursorControls {
	// Number.isFinite guards (#2838 review N-001): Math.round('abc') is NaN and
	// NaN sails through Math.min/Math.max untouched, which would silently
	// disable the extractor's final max_tokens cap. Production configs are
	// defended upstream by the loader's sanitizeMalformedValues; this keeps
	// the documented clamping contract true for raw (non-zod) callers too.
	const rawMaxTokens = Number(planCursor?.max_tokens ?? 1500);
	const rawLookahead = Number(planCursor?.lookahead_tasks ?? 2);
	return {
		// Boolean coercion (#2838 review N-002): absent → true; truthy values
		// (1, 'yes') → true; falsy values (false, 0, '') → false.
		enabled:
			planCursor?.enabled === undefined ? true : Boolean(planCursor.enabled),
		maxTokens: Number.isFinite(rawMaxTokens)
			? Math.min(4000, Math.max(500, Math.round(rawMaxTokens)))
			: 1500,
		lookaheadTasks: Number.isFinite(rawLookahead)
			? Math.min(5, Math.max(0, Math.round(rawLookahead)))
			: 2,
	};
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals: {
	extractCurrentPhase: typeof extractCurrentPhase;
	extractCurrentTask: typeof extractCurrentTask;
	extractDecisions: typeof extractDecisions;
	extractIncompleteTasks: typeof extractIncompleteTasks;
	extractPatterns: typeof extractPatterns;
	extractCurrentPhaseFromPlan: typeof extractCurrentPhaseFromPlan;
	extractCurrentTaskFromPlan: typeof extractCurrentTaskFromPlan;
	extractIncompleteTasksFromPlan: typeof extractIncompleteTasksFromPlan;
	extractPlanCursor: typeof extractPlanCursor;
	resolvePlanCursorControls: typeof resolvePlanCursorControls;
} = {
	extractCurrentPhase,
	extractCurrentTask,
	extractDecisions,
	extractIncompleteTasks,
	extractPatterns,
	extractCurrentPhaseFromPlan,
	extractCurrentTaskFromPlan,
	extractIncompleteTasksFromPlan,
	extractPlanCursor,
	resolvePlanCursorControls,
};
