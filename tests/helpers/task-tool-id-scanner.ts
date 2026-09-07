import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Issue #2529 ratchet scanner — shared by the ratchet test and the
 * delegation-gate host-task-id coverage test.
 *
 * Two predicates, because the host's native subagent tool id is the lowercase
 * `task` and task-equality comparisons split by HOW the operand is derived:
 *
 * A. EXCLUSIVE 'Task' comparison — dead code against the real host unless the
 *    same condition also tests the lowercase spelling (the paired both-spelling
 *    idiom). Still ratcheted toward zero.
 * B. NORMALIZER-PROVENANCE task comparison — any `=== / !==` comparison
 *    against the 'Task'/'task' literals whose operand is derived from
 *    `normalizeToolName`/`normalizeToolNameLowerCase`. These normalizers strip
 *    the first dot-separated segment (`notes.task` → `task`), so a filesystem
 *    custom tool id is misclassified as the host task tool. The paired idiom
 *    is NOT an exemption here: pairing fixes case only, not dot-truncation.
 *    Every such site must use the `isTaskToolId` boundary instead.
 *
 * Dot-safe forms that are deliberately NOT flagged: comparisons on the RAW
 * operand (`tool === 'Task' || tool === 'task'`, `tool.toLowerCase() === 'task'`)
 * — a raw string never contains a truncated dot segment — and the boundary
 * predicate's own definition site (src/hooks/normalize-tool-name.ts), which is
 * exempt from predicate B when scanning a tree.
 */

export const EXCLUSIVE_TASK_COMPARISON = /(?:===|!==)\s*(['"])Task\1/;
export const TASK_LITERAL_COMPARISON = /(?:===|!==)\s*(['"])(?:Task|task)\1/;
const LOWERCASE_TASK_COMPARISON = /(?:===|!==)\s*(['"])task\1/;
const NORMALIZER_CALL = /\bnormalizeToolName(?:LowerCase)?\s*\(/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

export interface ScanOptions {
	/** Repo-relative file paths whose task-literal comparisons are exempt
	 * from predicate B (the boundary predicate's own definition site). */
	exemptProvenanceFiles?: string[];
}

function isCommentLine(line: string): boolean {
	return COMMENT_LINE.test(line);
}

/** Operand identifier a task-literal comparison is testing (best effort). */
function comparisonOperand(line: string): string | null {
	const match = TASK_LITERAL_COMPARISON.exec(line);
	if (!match || match.index === undefined) return null;
	const before = line.slice(0, match.index).trim();
	const operand = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
	return operand ? operand[1] : null;
}

function hasNormalizerProvenance(
	lines: string[],
	index: number,
	operand: string | null,
): boolean {
	const start = Math.max(0, index - 6);
	const end = Math.min(lines.length, index + 3);
	for (let j = start; j < end; j += 1) {
		const windowLine = lines[j];
		if (isCommentLine(windowLine)) continue;
		if (!NORMALIZER_CALL.test(windowLine)) continue;
		// Direct inline derivation: `normalizeToolName(x) === 'task'`.
		if (j === index) return true;
		// Variable provenance: the comparison operand is assigned from a
		// normalizer call in the window. Requiring the operand to appear in
		// the assignment avoids flagging coincidental proximity to unrelated
		// normalizer calls on raw operands.
		if (
			operand &&
			new RegExp(
				`\\b${operand.replace(/\$/g, '\\$')}\\s*=[^=].*\\bnormalizeToolName(?:LowerCase)?\\s*\\(`,
			).test(windowLine)
		) {
			return true;
		}
	}
	return false;
}

export interface ScanViolation {
	kind: 'exclusive-task' | 'normalizer-provenance-task';
	file: string;
	line: number;
	source: string;
}

/** Scan one file's text. `file` is used verbatim in violations (display only). */
export function scanSourceText(
	file: string,
	text: string,
	options: ScanOptions = {},
): ScanViolation[] {
	const violations: ScanViolation[] = [];
	const lines = text.split(/\r?\n/);
	const provenanceExempt = (options.exemptProvenanceFiles ?? []).includes(file);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (isCommentLine(line)) continue;
		if (EXCLUSIVE_TASK_COMPARISON.test(line)) {
			// Predicate A: paired both-spelling comparison (this line + next 2)
			// on a raw operand is the dot-safe legacy idiom, not the defect.
			const window = lines.slice(i, i + 3).filter((l) => !isCommentLine(l));
			if (!LOWERCASE_TASK_COMPARISON.test(window.join('\n'))) {
				violations.push({
					kind: 'exclusive-task',
					file,
					line: i + 1,
					source: line.trim(),
				});
			}
		}
		if (
			!provenanceExempt &&
			TASK_LITERAL_COMPARISON.test(line) &&
			hasNormalizerProvenance(lines, i, comparisonOperand(line))
		) {
			violations.push({
				kind: 'normalizer-provenance-task',
				file,
				line: i + 1,
				source: line.trim(),
			});
		}
	}
	return violations;
}

function* listSourceFiles(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* listSourceFiles(full);
			continue;
		}
		if (!entry.name.endsWith('.ts')) continue;
		if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
		if (entry.name.endsWith('.d.ts')) continue;
		yield full;
	}
}

/** Scan a whole source tree (recursively, .ts production files only). */
export function scanSourceTree(
	dir: string,
	options: ScanOptions = {},
): ScanViolation[] {
	const violations: ScanViolation[] = [];
	for (const file of listSourceFiles(dir)) {
		// Violations and exemption entries use dir-relative posix paths.
		const rel = path.relative(dir, file).split(path.sep).join('/');
		violations.push(
			...scanSourceText(rel, fs.readFileSync(file, 'utf8'), options),
		);
	}
	return violations;
}
