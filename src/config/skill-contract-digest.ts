/**
 * Shared skill contract-digest primitives (issue #2601).
 *
 * Single source of truth for the `swarm-contract-digest` stamp scheme
 * introduced by #2859 F6: both the dev-time drift-check detector
 * (scripts/drift-check.ts) and the runtime activation/wake verification
 * (src/services/pr-workflow-skill-contract.ts) import from here so the two
 * surfaces can never disagree on what the stamp means. Previously these
 * helpers lived only in the dev-time script; src/ must not import from
 * scripts/, so the algorithms moved here and the script re-exports them.
 */
import { createHash } from 'node:crypto';

export const SKILL_CONTRACT_DIGEST_KEY = 'swarm-contract-digest';

/**
 * Split a SKILL.md into its frontmatter block (fences included) and body.
 * A file without a well-formed opening/closing fence pair has no frontmatter.
 * CRLF-tolerant (PR #3387 follow-up, FB-028): line endings are normalized
 * before the fence scan, so a CRLF file returns real slices instead of an
 * empty frontmatter — the previous LF-only scan silently disabled every
 * bounded frontmatter surgery (stamp reads still worked because they
 * normalize separately, but the reviser's version bumps no-op'd while the
 * revision notes still claimed a bump). Returned slices are LF-normalized;
 * every digest consumer normalizes the body anyway, so hashes are unchanged,
 * and LF is the repo's checked-out policy (`.gitattributes` eol=lf).
 */
export function splitSkillFrontmatter(content: string): {
	frontmatter: string;
	body: string;
} {
	const normalized = content.replace(/\r\n/g, '\n');
	if (!normalized.startsWith('---\n')) {
		return { frontmatter: '', body: normalized };
	}
	const end = normalized.indexOf('\n---\n', 4);
	if (end === -1) {
		return { frontmatter: '', body: normalized };
	}
	return {
		frontmatter: normalized.slice(0, end + 5),
		body: normalized.slice(end + 5),
	};
}

/**
 * 12-hex content digest of a skill BODY (frontmatter excluded, line endings
 * normalized) — stable across platforms regardless of checkout EOL settings.
 */
export function skillContractDigest(body: string): string {
	const normalized = body.replace(/\r\n/g, '\n');
	return createHash('sha256')
		.update(normalized, 'utf8')
		.digest('hex')
		.slice(0, 12);
}

/**
 * Read the stamped contract digest from a frontmatter block, if present.
 * Accepts the spec shape (a two-space-indented child of the `metadata:` map,
 * issue #2907) and the legacy column-0 form so consumer installs generated
 * before the migration keep verifying.
 *
 * Structural anchor (issue #3215): the two-space child form is only searched
 * INSIDE a metadata block — entered at a column-0 `metadata:` key line
 * (case-insensitive, comment-tolerant) and ended by the next column-0 key.
 * A column-0 YAML comment line is state-neutral (it neither opens nor closes
 * the block), so comment-annotated frontmatter keeps resolving. Indented
 * lines outside a metadata block (e.g. two-space continuations of a
 * `description: >` folded block scalar) can never resolve, and block-scalar
 * content cannot reach the column-0 legacy anchor in valid YAML.
 * The stamp-line regexes are case-SENSITIVE lowercase — the canonical writer
 * form — so the reader never resolves a stamp `writeSkillContractStamp`
 * cannot rewrite (PR #3387 review: an accept-widening the writer cannot
 * match turns the documented `--write` remediation into a false-success
 * loop).
 * String.match rather than RegExp.exec: the SAST callee-binding classifier
 * (issue #2300) flags an unresolved .exec member call as exec-like.
 */
export function readSkillContractStamp(
	frontmatter: string,
): string | undefined {
	const legacyLine = new RegExp(
		`^${SKILL_CONTRACT_DIGEST_KEY}: "?([0-9a-f]{12})"?[ \\t]*$`,
	);
	const childLine = new RegExp(
		`^ {2}${SKILL_CONTRACT_DIGEST_KEY}: (?:"([0-9a-f]{12})"|([0-9a-f]{12}))[ \\t]*$`,
	);
	const metadataOpen = /^metadata:[ \t]*(?:#.*)?$/i;
	let inMetadataBlock = false;
	for (const line of frontmatter.replace(/\r\n/g, '\n').split('\n')) {
		if (line.trim() === '') continue;
		if (/^\s/.test(line)) {
			if (!inMetadataBlock) continue;
			const child = line.match(childLine);
			if (child) return child[1] ?? child[2];
			continue;
		}
		// Column-0 YAML comment: state-neutral — it neither carries the
		// legacy stamp nor closes the metadata block.
		if (line.startsWith('#')) continue;
		// Column-0 line: the legacy stamp form is accepted anywhere; a
		// `metadata:` key line opens (any other column-0 key closes) the block.
		const legacy = line.match(legacyLine);
		if (legacy) return legacy[1];
		inMetadataBlock = metadataOpen.test(line);
	}
	return undefined;
}

/**
 * Rewrite an existing stamp IN PLACE with `digest`, using the exact same
 * structural walk as {@link readSkillContractStamp} so the writer's match
 * set can never diverge from the reader's (PR #3387 review: the previous
 * unscoped first-match regex rewrote a stamp-shaped decoy inside a block
 * scalar while the real metadata-child stamp stayed stale — a false-success
 * remediation loop). Returns the rewritten frontmatter and whether a stamp
 * line was found and replaced; `replaced: false` means the caller must fall
 * back to insertion.
 */
export function writeSkillContractStamp(
	frontmatter: string,
	digest: string,
): { next: string; replaced: boolean } {
	const legacyLine = new RegExp(
		`^${SKILL_CONTRACT_DIGEST_KEY}: "?[0-9a-f]{12}"?[ \\t]*$`,
	);
	const childLine = new RegExp(
		`^ {2}${SKILL_CONTRACT_DIGEST_KEY}: "?[0-9a-f]{12}"?[ \\t]*$`,
	);
	const metadataOpen = /^metadata:[ \t]*(?:#.*)?$/i;
	const lines = frontmatter.replace(/\r\n/g, '\n').split('\n');
	let inMetadataBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.trim() === '') continue;
		if (/^\s/.test(line)) {
			if (!inMetadataBlock) continue;
			if (childLine.test(line)) {
				const indent = /^ */.exec(line)?.[0] ?? '';
				lines[i] = `${indent}${SKILL_CONTRACT_DIGEST_KEY}: "${digest}"`;
				return { next: lines.join('\n'), replaced: true };
			}
			continue;
		}
		if (line.startsWith('#')) continue;
		if (legacyLine.test(line)) {
			lines[i] = `${SKILL_CONTRACT_DIGEST_KEY}: "${digest}"`;
			return { next: lines.join('\n'), replaced: true };
		}
		inMetadataBlock = metadataOpen.test(line);
	}
	return { next: frontmatter, replaced: false };
}
