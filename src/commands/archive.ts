import { loadPluginConfig } from '../config/loader';
import { archiveEvidence } from '../evidence/manager';

export const _internals: { now: () => Date } = {
	now: () => new Date(),
};

function artifactLabel(artifact: {
	namespace: 'evaluation-run' | 'gate-audit';
	id: string;
}): string {
	return `${artifact.namespace}/${artifact.id}`;
}

/** Handles `/swarm archive` with a truthful preview/execution report. */
export async function handleArchiveCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const config = loadPluginConfig(directory);
	const maxAgeDays = config?.evidence?.max_age_days ?? 90;
	const maxBundles = config?.evidence?.max_bundles ?? 1000;
	const dryRun = args.includes('--dry-run');
	const report = await archiveEvidence(directory, maxAgeDays, maxBundles, {
		report: true,
		dryRun,
		now: _internals.now(),
	});

	const evaluationSelected = report.evaluation.selected.map(artifactLabel);
	const evaluationArchived = report.evaluation.archived.map(artifactLabel);
	const selectedCount =
		report.selectedEvidence.length + evaluationSelected.length;
	const archivedCount =
		report.archivedEvidence.length + evaluationArchived.length;
	const corruptCount = report.evaluation.corrupt.length;
	const inventoryCount =
		report.inventoryEvidence.length + report.evaluation.inventory.length;

	if (dryRun) {
		if (selectedCount === 0) {
			if (corruptCount > 0) {
				return `No valid evidence bundles to archive. Preserved ${corruptCount} corrupt evaluation artifact(s) for data-quality review.`;
			}
			if (inventoryCount === 0) return 'No evidence bundles to archive.';
			return `No evidence bundles older than ${maxAgeDays} days found, and bundle count (${inventoryCount}) is within max_bundles limit (${maxBundles}).`;
		}
		const lines = [
			'## Archive Preview (dry run)',
			'',
			`**Retention**: ${maxAgeDays} days`,
			`**Max bundles**: ${maxBundles}`,
			`**Would archive**: ${selectedCount} bundle(s)`,
		];
		if (report.selectedEvidenceByAge.length > 0) {
			lines.push(
				'',
				`**Age-based (${report.selectedEvidenceByAge.length})**:`,
				...report.selectedEvidenceByAge.map((id) => `- ${id}`),
			);
		}
		if (report.selectedEvidenceByCount.length > 0) {
			lines.push(
				'',
				`**Max bundles limit (${report.selectedEvidenceByCount.length})**:`,
				...report.selectedEvidenceByCount.map((id) => `- ${id}`),
			);
		}
		const selectedRuns = report.evaluation.selected.filter(
			(artifact) => artifact.namespace === 'evaluation-run',
		);
		const selectedAudits = report.evaluation.selected.filter(
			(artifact) => artifact.namespace === 'gate-audit',
		);
		if (selectedRuns.length > 0) {
			lines.push(
				'',
				`**Evaluation runs (${selectedRuns.length})**:`,
				...selectedRuns.map((artifact) => `- ${artifactLabel(artifact)}`),
			);
		}
		if (selectedAudits.length > 0) {
			lines.push(
				'',
				`**Gate-audit runs (${selectedAudits.length})**:`,
				...selectedAudits.map((artifact) => `- ${artifactLabel(artifact)}`),
			);
		}
		if (report.evaluation.protected.length > 0 || corruptCount > 0) {
			lines.push(
				'',
				`**Evaluation artifacts preserved**: ${report.evaluation.protected.length} lineage-protected, ${corruptCount} corrupt/data-quality`,
			);
		}
		return lines.join('\n');
	}

	if (archivedCount === 0) {
		const failedCount =
			report.failedEvidence.length + report.evaluation.failed.length;
		if (failedCount > 0) {
			return `No evidence bundles were archived; ${failedCount} selected deletion(s) failed and remain on disk.`;
		}
		if (corruptCount > 0) {
			return `No valid evidence bundles were archived. Preserved ${corruptCount} corrupt evaluation artifact(s) for data-quality review.`;
		}
		if (inventoryCount === 0) return 'No evidence bundles to archive.';
		return `No evidence bundles older than ${maxAgeDays} days found.`;
	}

	const lines = [
		'## Evidence Archived',
		'',
		`**Retention**: ${maxAgeDays} days`,
		`**Archived**: ${archivedCount} bundle(s)`,
		'',
		...report.archivedEvidence.map((id) => `- ${id}`),
		...evaluationArchived.map((id) => `- ${id}`),
	];
	const failedCount =
		report.failedEvidence.length + report.evaluation.failed.length;
	if (failedCount > 0) {
		lines.push('', `**Failed deletions preserved**: ${failedCount}`);
	}
	return lines.join('\n');
}
