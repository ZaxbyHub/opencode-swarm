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

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Builds the "Documents cache" report section. Returns '' when no caps are
 * configured (the cache is append-only and was not swept). The section is
 * appended to both the dry-run preview and the execution report so the
 * cache retention is always visible when configured (issue #1184).
 */
function formatDocumentsCacheSection(
	cache: {
		inventory: number;
		selected: number;
		archived: number;
		corrupt: number;
		bytesBefore: number;
		bytesAfter: number;
		dryRun: boolean;
		aborted: boolean;
	},
	maxBytes?: number,
	maxRecords?: number,
): string {
	const capsConfigured =
		(typeof maxBytes === 'number' && maxBytes > 0) ||
		(typeof maxRecords === 'number' && maxRecords > 0);
	if (!capsConfigured) return '';

	const lines: string[] = [
		'',
		'### Documents cache (`.swarm/evidence-cache/documents.jsonl`)',
	];
	if (cache.aborted) {
		lines.push(
			`**Aborted**: file exceeds the 100 MiB read cap; left untouched. Set a tighter cap or prune manually.`,
		);
		return lines.join('\n');
	}
	const capParts: string[] = [];
	if (typeof maxBytes === 'number' && maxBytes > 0) {
		capParts.push(`max ${formatBytes(maxBytes)}`);
	}
	if (typeof maxRecords === 'number' && maxRecords > 0) {
		capParts.push(`max ${maxRecords} records`);
	}
	lines.push(`**Retention caps**: ${capParts.join(', ')}`);
	lines.push(
		`**Inventory**: ${cache.inventory} record(s), ${formatBytes(cache.bytesBefore)}`,
	);
	if (cache.dryRun) {
		lines.push(
			`**Would prune**: ${cache.selected} record(s) → ${formatBytes(cache.bytesAfter)}`,
		);
	} else {
		lines.push(
			`**Pruned**: ${cache.archived} record(s) → ${formatBytes(cache.bytesAfter)}`,
		);
	}
	if (cache.corrupt > 0) {
		lines.push(
			`**Corrupt rows dropped**: ${cache.corrupt} (unparseable lines removed from the cache; reported, not relocated)`,
		);
	}
	return lines.join('\n');
}

/** Handles `/swarm archive` with a truthful preview/execution report. */
export async function handleArchiveCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const config = loadPluginConfig(directory);
	const maxAgeDays = config?.evidence?.max_age_days ?? 90;
	const maxBundles = config?.evidence?.max_bundles ?? 1000;
	const cacheMaxBytes = config?.evidence?.cache_max_bytes;
	const cacheMaxRecords = config?.evidence?.cache_max_records;
	const dryRun = args.includes('--dry-run');
	const report = await archiveEvidence(directory, maxAgeDays, maxBundles, {
		report: true,
		dryRun,
		now: _internals.now(),
		cacheMaxBytes,
		cacheMaxRecords,
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
		// Compute the cache section once so it can be appended to any dry-run
		// return path when caps are configured (issue #1184 — cache retention
		// is independent of bundle retention and must be visible even when no
		// bundles are eligible).
		const cacheSection = formatDocumentsCacheSection(
			report.documentsCache,
			cacheMaxBytes,
			cacheMaxRecords,
		);
		if (selectedCount === 0) {
			const baseMsg =
				corruptCount > 0
					? `No valid evidence bundles to archive. Preserved ${corruptCount} corrupt evaluation artifact(s) for data-quality review.`
					: inventoryCount === 0
						? 'No evidence bundles to archive.'
						: `No evidence bundles older than ${maxAgeDays} days found, and bundle count (${inventoryCount}) is within max_bundles limit (${maxBundles}).`;
			if (cacheSection) {
				return `${baseMsg}\n\n## Archive Preview (dry run)\n${cacheSection}`;
			}
			return baseMsg;
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
		if (cacheSection) lines.push(cacheSection);
		return lines.join('\n');
	}

	if (archivedCount === 0) {
		const failedCount =
			report.failedEvidence.length + report.evaluation.failed.length;
		const cacheSection = formatDocumentsCacheSection(
			report.documentsCache,
			cacheMaxBytes,
			cacheMaxRecords,
		);
		// When the cache was swept, surface a full report even if no bundles
		// were archived (issue #1184 — cache retention is independent of bundle
		// retention). Otherwise preserve the terse "nothing to archive" message.
		if (cacheSection && report.documentsCache.archived > 0) {
			const lines = [
				'## Documents Cache Pruned',
				'',
				'No evidence bundles were archived.',
				cacheSection,
			];
			return lines.join('\n');
		}
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
	const cacheSection = formatDocumentsCacheSection(
		report.documentsCache,
		cacheMaxBytes,
		cacheMaxRecords,
	);
	if (cacheSection) lines.push(cacheSection);
	return lines.join('\n');
}
