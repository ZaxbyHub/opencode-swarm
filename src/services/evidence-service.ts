import type {
	Evidence,
	ReviewEvidence,
	TestEvidence,
} from '../config/evidence-schema';
import {
	listEvidenceTaskIds as _listEvidenceTaskIds,
	loadEvidence as _loadEvidence,
} from '../evidence/manager';

/**
 * _internals — DI seam for testing async I/O without cross-module mocks.
 */
export const _internals = {
	loadEvidence: _loadEvidence,
	listEvidenceTaskIds: _listEvidenceTaskIds,
};

/**
 * Structured evidence entry for a task.
 */
export interface EvidenceEntryData {
	index: number;
	entry: Evidence;
	type: string;
	verdict: string;
	verdictIcon: string;
	agent: string;
	summary: string;
	timestamp: string;
	details: Record<string, string | number | undefined>;
}

/**
 * Structured evidence data for a single task.
 */
export interface TaskEvidenceData {
	hasEvidence: boolean;
	taskId: string;
	createdAt: string;
	updatedAt: string;
	entries: EvidenceEntryData[];
}

/**
 * Structured evidence list data for all tasks.
 */
export interface EvidenceListData {
	hasEvidence: boolean;
	tasks: Array<{
		taskId: string;
		entryCount: number;
		lastUpdated: string;
	}>;
}

/**
 * Get emoji for verdict type.
 */
function getVerdictIcon(verdict: string): string {
	switch (verdict) {
		case 'pass':
		case 'approved':
			return '✅';
		case 'fail':
		case 'rejected':
			return '❌';
		case 'info':
			return 'ℹ️';
		default:
			return '';
	}
}

/**
 * Format a single evidence entry as structured data.
 */
function formatEvidenceEntry(
	index: number,
	entry: Evidence,
): EvidenceEntryData {
	const details: Record<string, string | number | undefined> = {};

	if (entry.type === 'review') {
		const reviewEntry = entry as ReviewEvidence;
		details.risk = reviewEntry.risk;
		details.issues = reviewEntry.issues?.length;
	} else if (entry.type === 'test') {
		const testEntry = entry as TestEvidence;
		details.tests_passed = testEntry.tests_passed;
		details.tests_failed = testEntry.tests_failed;
	}

	return {
		index,
		entry,
		type: entry.type,
		verdict: entry.verdict,
		verdictIcon: getVerdictEmoji(entry.verdict),
		agent: entry.agent,
		summary: entry.summary,
		timestamp: entry.timestamp,
		details,
	};
}

/**
 * Get emoji for verdict type (exported for use in entry formatting).
 */
export function getVerdictEmoji(verdict: string): string {
	return getVerdictIcon(verdict);
}

/**
 * Get evidence data for a specific task.
 */
export async function getTaskEvidenceData(
	directory: string,
	taskId: string,
): Promise<TaskEvidenceData> {
	const result = await _internals.loadEvidence(directory, taskId);

	if (result.status !== 'found') {
		return {
			hasEvidence: false,
			taskId,
			createdAt: '',
			updatedAt: '',
			entries: [],
		};
	}

	const entries: EvidenceEntryData[] = [];
	for (let i = 0; i < result.bundle.entries.length; i++) {
		entries.push(formatEvidenceEntry(i + 1, result.bundle.entries[i]));
	}

	return {
		hasEvidence: true,
		taskId,
		createdAt: result.bundle.created_at,
		updatedAt: result.bundle.updated_at,
		entries,
	};
}

/**
 * Get list of all evidence bundles.
 */
export async function getEvidenceListData(
	directory: string,
): Promise<EvidenceListData> {
	const taskIds = await _internals.listEvidenceTaskIds(directory);

	if (taskIds.length === 0) {
		return { hasEvidence: false, tasks: [] };
	}

	const tasks: EvidenceListData['tasks'] = [];

	for (const taskId of taskIds) {
		const result = await _internals.loadEvidence(directory, taskId);
		if (result.status === 'found') {
			tasks.push({
				taskId,
				entryCount: result.bundle.entries.length,
				lastUpdated: result.bundle.updated_at,
			});
		} else {
			tasks.push({
				taskId,
				entryCount: 0,
				lastUpdated: 'unknown',
			});
		}
	}

	return { hasEvidence: true, tasks };
}

/**
 * Format evidence list as markdown for command output.
 */
export function formatEvidenceListMarkdown(list: EvidenceListData): string {
	if (!list.hasEvidence || list.tasks.length === 0) {
		return 'No evidence bundles found.';
	}

	const tableLines = [
		'## Evidence Bundles',
		'',
		'| Task | Entries | Last Updated |',
		'|------|---------|-------------|',
	];

	for (const task of list.tasks) {
		tableLines.push(
			`| ${task.taskId} | ${task.entryCount} | ${task.lastUpdated} |`,
		);
	}

	return tableLines.join('\n');
}

/**
 * Format task evidence as markdown for command output.
 */
export function formatTaskEvidenceMarkdown(evidence: TaskEvidenceData): string {
	if (!evidence.hasEvidence) {
		return `No evidence found for task ${evidence.taskId}.`;
	}

	const lines = [
		`## Evidence for Task ${evidence.taskId}`,
		'',
		`**Created**: ${evidence.createdAt}`,
		`**Updated**: ${evidence.updatedAt}`,
		`**Entries**: ${evidence.entries.length}`,
	];

	if (evidence.entries.length > 0) {
		lines.push('');
	}

	for (const entry of evidence.entries) {
		lines.push(...formatEntryMarkdown(entry));
	}

	return lines.join('\n');
}

/**
 * Format a single evidence entry as markdown.
 */
function formatEntryMarkdown(entryData: EvidenceEntryData): string[] {
	const lines: string[] = [];

	// Header with type and verdict
	lines.push(
		`### Entry ${entryData.index}: ${entryData.type} (${entryData.verdict}) ${entryData.verdictIcon}`,
	);
	lines.push(`- **Agent**: ${entryData.agent}`);
	lines.push(`- **Summary**: ${entryData.summary}`);
	lines.push(`- **Time**: ${entryData.timestamp}`);

	// Type-specific details
	if (entryData.type === 'review') {
		lines.push(`- **Risk Level**: ${entryData.details.risk}`);
		if (entryData.details.issues && Number(entryData.details.issues) > 0) {
			lines.push(`- **Issues**: ${entryData.details.issues}`);
		}
	} else if (entryData.type === 'test') {
		lines.push(
			`- **Tests**: ${entryData.details.tests_passed} passed, ${entryData.details.tests_failed} failed`,
		);
	}

	lines.push('');
	return lines;
}

/**
 * Handle evidence command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export async function handleEvidenceCommand(
	directory: string,
	args: string[],
): Promise<string> {
	// Mode 1: List all evidence bundles
	if (args.length === 0) {
		const listData = await getEvidenceListData(directory);
		return formatEvidenceListMarkdown(listData);
	}

	// Mode 2: Show specific task evidence
	const taskId = args[0];
	const evidenceData = await getTaskEvidenceData(directory, taskId);
	return formatTaskEvidenceMarkdown(evidenceData);
}

/**
 * Handle evidence summary command - generates completion ratio and blockers report.
 */
export async function handleEvidenceSummaryCommand(
	directory: string,
): Promise<string> {
	const { buildEvidenceSummary } = await import('./evidence-summary-service');
	const artifact = await buildEvidenceSummary(directory);

	if (!artifact) {
		return 'No plan found. Run `/swarm plan` to check plan status.';
	}

	const lines: string[] = [
		'## Evidence Summary',
		'',
		`**Generated**: ${artifact.generated_at}`,
		`**Overall Completion**: ${Math.round(artifact.overallCompletionRatio * 100)}%`,
		'',
	];

	// Per-phase breakdown
	for (const phase of artifact.phaseSummaries) {
		lines.push(`### Phase ${phase.phaseId}: ${phase.phaseName}`);
		lines.push(`- Completion: ${Math.round(phase.completionRatio * 100)}%`);
		if (phase.blockers.length > 0) {
			lines.push(
				`- Blockers: ${phase.blockers.map((b) => `[${b.severity}] ${b.reason}`).join('; ')}`,
			);
		}
		lines.push('');
	}

	// Overall blockers
	if (artifact.overallBlockers.length > 0) {
		lines.push('### Blockers');
		for (const blocker of artifact.overallBlockers) {
			lines.push(
				`- [${blocker.severity}] ${blocker.reason} (Task ${blocker.taskId})`,
			);
		}
		lines.push('');
	} else {
		lines.push('### Blockers');
		lines.push('None — all completed tasks have required evidence.');
		lines.push('');
	}

	return lines.join('\n');
}
