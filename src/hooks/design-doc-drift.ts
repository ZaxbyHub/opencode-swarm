import * as fs from 'node:fs';
import * as path from 'node:path';

import { getGlobalEventBus } from '../background/event-bus.js';
import { readEffectiveSpecSync } from '../sdd/effective-spec';
import * as logger from '../utils/logger';
import type { DocDriftReport } from './curator-types.js';
import { validateSwarmPath } from './utils.js';

/**
 * Design-doc drift detection (issue #1080).
 *
 * Deterministic, fail-open check that compares the generated design docs
 * (domain/technical-spec/behavior-spec/reference) against the current code and
 * spec via the traceability registry written by the docs_design agent. It runs
 * at PHASE-WRAP (advisory only) and writes `.swarm/doc-drift-phase-N.json`.
 *
 * This is NOT the spec-drift gate (that is evidence-based, produced by
 * critic_drift_verifier). It is purely mtime + traceability based: no LLM call,
 * no subprocess. It never throws — design-doc lag must not block a phase.
 */

const DOC_DRIFT_REPORT_PREFIX = 'doc-drift-phase-';

/** Cap on the traceability.json read to avoid memory exhaustion (1 MiB). */
const MAX_TRACEABILITY_BYTES = 1024 * 1024;

/** The fixed set of design docs the docs_design agent owns, keyed by doc name. */
const DESIGN_DOC_FILES: Record<string, string> = {
	domain: 'domain.md',
	'technical-spec': 'technical-spec.md',
	'behavior-spec': 'behavior-spec.md',
	'reference-impl': path.join('reference', 'reference-impl.md'),
	'idiom-notes': path.join('reference', 'idiom-notes.md'),
};

const TRACEABILITY_REL = path.join('reference', 'traceability.json');

interface TraceabilitySection {
	section_id: string;
	doc: string;
	title?: string;
	spec_frs?: string[];
	invariants?: string[];
	code_anchors?: string[];
}

interface TraceabilityRegistry {
	schema_version?: number;
	sections?: TraceabilitySection[];
}

/** Return mtime in ms for a path, or null if it does not exist / cannot stat. */
function mtimeMsOrNull(absPath: string): number | null {
	try {
		return fs.statSync(absPath).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Resolve a project-relative anchor path safely under `directory`. Returns null
 * if the anchor escapes the project root (defense against `..`/absolute paths
 * in a hand-edited traceability.json).
 */
function resolveAnchorWithin(directory: string, anchor: string): string | null {
	if (!anchor || typeof anchor !== 'string') return null;
	const root = path.resolve(directory);
	const resolved = path.resolve(root, anchor);
	const rel = path.relative(root, resolved);
	if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return resolved;
}

/**
 * Run the deterministic design-doc drift check for a phase.
 *
 * @param directory  project root
 * @param phase      phase number
 * @param outDir     design-doc output directory (project-relative, e.g. "docs")
 * @returns the written DocDriftReport, or null if the check failed (fail-open).
 */
export async function runDesignDocDriftCheck(
	directory: string,
	phase: number,
	outDir: string,
): Promise<DocDriftReport | null> {
	try {
		const root = path.resolve(directory);
		const outAbs = path.resolve(root, outDir);

		// 0. Defense-in-depth: refuse to probe a docs dir outside the project root.
		//    Config (schema refine) and the command both validate out_dir, but this
		//    guard ensures the drift check can never stat arbitrary host paths.
		const outRel = path.relative(root, outAbs);
		if (outRel.startsWith('..') || path.isAbsolute(outRel)) {
			return null;
		}

		// 1. Discover which design docs exist + their mtimes. Use a Map keyed by
		//    the known doc names so a hostile `section.doc` (e.g. "__proto__")
		//    cannot reach Object.prototype.
		const docMtimes = new Map<string, number | null>();
		const checkedDocs: string[] = [];
		const missingDocs: string[] = [];
		for (const [docName, relFile] of Object.entries(DESIGN_DOC_FILES)) {
			const abs = path.join(outAbs, relFile);
			const mtime = mtimeMsOrNull(abs);
			docMtimes.set(docName, mtime);
			if (mtime === null) {
				missingDocs.push(path.join(outDir, relFile));
			} else {
				checkedDocs.push(path.join(outDir, relFile));
			}
		}

		// 2. Load the traceability registry. Without it (or with no docs present),
		//    there is nothing to map — report NO_DOCS so phase-wrap can skip sync.
		//    Cap the read size so a giant hand-crafted registry can't exhaust memory.
		const traceabilityAbs = path.join(outAbs, TRACEABILITY_REL);
		let registry: TraceabilityRegistry | null = null;
		try {
			const stat = await fs.promises.stat(traceabilityAbs);
			if (stat.size <= MAX_TRACEABILITY_BYTES) {
				const raw = await fs.promises.readFile(traceabilityAbs, 'utf-8');
				const parsed = JSON.parse(raw) as unknown;
				registry =
					parsed && typeof parsed === 'object' && !Array.isArray(parsed)
						? (parsed as TraceabilityRegistry)
						: null;
			}
		} catch {
			registry = null;
		}

		const noDocs = checkedDocs.length === 0 || registry === null;

		// 3. Spec mtime — a spec.md change after a doc implies the doc may be stale.
		const effectiveSpec = readEffectiveSpecSync(root);
		const specMtime =
			effectiveSpec?.source === 'swarm'
				? mtimeMsOrNull(path.join(root, '.swarm', 'spec.md'))
				: effectiveSpec?.mtime
					? Date.parse(effectiveSpec.mtime)
					: null;

		// 4. Walk sections; flag a section stale when a mapped code anchor (or the
		//    spec, if the section cites FRs) is newer than its owning doc.
		const staleSections: DocDriftReport['stale_sections'] = [];
		if (!noDocs && Array.isArray(registry?.sections)) {
			for (const section of registry.sections) {
				if (!section || typeof section.section_id !== 'string') continue;
				// A section whose `doc` is not one of the known design docs is a
				// registry error, not doc drift — skip it rather than crying stale.
				if (typeof section.doc !== 'string' || !docMtimes.has(section.doc)) {
					continue;
				}
				const docMtime = docMtimes.get(section.doc) ?? null;
				// If the owning (known) doc is missing on disk, that is itself drift.
				if (docMtime === null) {
					staleSections.push({
						section_id: section.section_id,
						doc: section.doc,
						reason: 'owning design doc is missing',
					});
					continue;
				}

				let flagged = false;
				for (const anchor of section.code_anchors ?? []) {
					const anchorAbs = resolveAnchorWithin(directory, anchor);
					if (anchorAbs === null) continue;
					const anchorMtime = mtimeMsOrNull(anchorAbs);
					if (anchorMtime !== null && anchorMtime > docMtime) {
						staleSections.push({
							section_id: section.section_id,
							doc: section.doc,
							reason: `code anchor ${anchor} changed after the doc`,
						});
						flagged = true;
						break;
					}
				}

				if (
					!flagged &&
					specMtime !== null &&
					specMtime > docMtime &&
					(section.spec_frs?.length ?? 0) > 0
				) {
					staleSections.push({
						section_id: section.section_id,
						doc: section.doc,
						reason: 'effective spec changed after the doc',
					});
				}
			}
		}

		const verdict: DocDriftReport['verdict'] = noDocs
			? 'NO_DOCS'
			: staleSections.length > 0
				? 'DOC_STALE'
				: 'DOC_FRESH';

		const report: DocDriftReport = {
			schema_version: 1,
			phase,
			timestamp: new Date().toISOString(),
			out_dir: outDir,
			verdict,
			stale_sections: staleSections,
			missing_docs: missingDocs,
			checked_docs: checkedDocs,
		};

		// 5. Persist the signal under .swarm/.
		const filename = `${DOC_DRIFT_REPORT_PREFIX}${phase}.json`;
		const filePath = validateSwarmPath(directory, filename);
		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(
			filePath,
			JSON.stringify(report, null, 2),
			'utf-8',
		);

		getGlobalEventBus().publish('curator.docdrift.completed', {
			phase,
			verdict,
			stale_count: staleSections.length,
			report_path: filePath,
		});

		return report;
	} catch (err) {
		// Fail-open: design-doc drift must NEVER block phase completion.
		try {
			getGlobalEventBus().publish('curator.error', {
				operation: 'docdrift',
				phase,
				error: String(err),
			});
		} catch {
			/* event bus failure is non-fatal */
		}
		logger.warn(
			`[design-doc-drift] check failed for phase ${phase}: ${String(err)}`,
		);
		return null;
	}
}

export const _internals = {
	mtimeMsOrNull,
	resolveAnchorWithin,
	DESIGN_DOC_FILES,
};
