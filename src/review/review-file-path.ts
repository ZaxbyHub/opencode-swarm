/**
 * #3844: the FILE path of a review finding is model-authored free text, so
 * it is redacted before it is persisted — but only when it names no real
 * file.
 *
 * A real repository path is not a secret, and redacting one BREAKS the
 * review: the redactor's long mixed-class base64 rule counts `/` as a
 * base64 character, so an ordinary deep path (a Java/Kotlin service, a
 * TypeScript monorepo package) matches it — and a redacted path does not
 * resolve, so the finding silently stops anchoring (and stops blocking the
 * phase gate).
 *
 * So the rule is: a path that the review scope KNOWS is real is kept
 * verbatim, and only a path that names no real file is redacted.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	EVIDENCE_FINDING_FILE_MAX,
	redactEvidenceField,
} from '../security/evidence-redaction.js';

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/**
 * A repository-relative path, or null when the value is not one (absolute,
 * drive-qualified, UNC, escaping, or carrying a control character).
 */
export function normalizedRelativePath(file: string): string | null {
	if (
		file.length === 0 ||
		file.length > 500 ||
		hasControlCharacter(file) ||
		/^[A-Za-z]:[\\/]/.test(file) ||
		file.startsWith('\\\\') ||
		file.startsWith('//') ||
		path.isAbsolute(file)
	) {
		return null;
	}
	const normalized = file.replaceAll('\\', '/');
	const segments = normalized.split('/');
	if (
		segments.some((segment) => segment === '..' || segment === '') ||
		normalized.startsWith('/')
	) {
		return null;
	}
	return normalized.replace(/^\.\//, '');
}

export function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

/**
 * Whether a finding's file names a path that RESOLVES inside the project.
 */
export function pathResolvesInsideProject(
	directory: string,
	file: string,
): boolean {
	const normalized = normalizedRelativePath(file);
	if (!normalized) return false;
	try {
		const root = fs.realpathSync(directory);
		const currentPath = fs.realpathSync(
			path.resolve(root, ...normalized.split('/')),
		);
		return isWithinRoot(root, currentPath);
	} catch {
		return false;
	}
}

/**
 * The file path as it is PERSISTED.
 *
 * @param knownPaths paths the review scope knows to be real — for a range
 *   diff they come from the resolved TARGET commit, not from the current
 *   checkout, so a target-side path is real even when the checkout does not
 *   contain it.
 */
export function redactReviewFilePath(
	directory: string,
	file: string,
	knownPaths?: ReadonlySet<string>,
): string {
	if (typeof file !== 'string' || file.length === 0) return file;
	const normalized = normalizedRelativePath(file);
	if (normalized && knownPaths?.has(normalized)) return file;
	if (pathResolvesInsideProject(directory, file)) return file;
	return redactEvidenceField(file, EVIDENCE_FINDING_FILE_MAX);
}

/**
 * A `path:line` location: the path part is redacted by the same rule, the
 * line suffix is untouched.
 *
 * A LEGACY (non-JSON) review issue carries its location in the ISSUES
 * line, so the path in it is model-authored free text like any other.
 */
export function redactLocationPath(
	directory: string,
	location: string,
): string {
	if (typeof location !== 'string' || location.length === 0) return location;
	const match = /^(.*):(\d+)$/.exec(location);
	if (!match) {
		// No `path:line` shape: the whole string is free text, and it is
		// redacted by the same rule.
		return redactReviewFilePath(directory, location);
	}
	return `${redactReviewFilePath(directory, match[1])}:${match[2]}`;
}
