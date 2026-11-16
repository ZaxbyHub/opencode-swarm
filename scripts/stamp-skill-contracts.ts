/**
 * Issue #2859 (F6): write `swarm-contract-digest:` content stamps into the
 * frontmatter of the mirrored PR-workflow skills (see STAMPED_PR_WORKFLOW_SKILLS
 * in scripts/drift-check.ts). The stamp is a 12-hex sha256 of the skill BODY
 * (frontmatter excluded, line endings normalized) so it survives checkout EOL
 * differences. Idempotent: re-running replaces any existing stamp.
 *
 * Usage:
 *   bun run scripts/stamp-skill-contracts.ts --write   # write stamps
 *   bun run scripts/stamp-skill-contracts.ts            # check only (exit 1 on drift)
 *
 * The drift-check detector `user-global-skill-staleness` treats a repo-side
 * stamp/body mismatch as a warning — run this script after editing any of the
 * stamped skills.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	readSkillContractStamp,
	SKILL_CONTRACT_DIGEST_KEY,
	skillContractDigest,
	splitSkillFrontmatter,
	writeSkillContractStamp,
} from '../src/config/skill-contract-digest.js';
import { STAMPED_PR_WORKFLOW_SKILLS } from './drift-check';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

if (import.meta.main) {
	let drift = 0;
	for (const slug of STAMPED_PR_WORKFLOW_SKILLS) {
		const file = path.join(REPO_ROOT, '.opencode', 'skills', slug, 'SKILL.md');
		const content = readFileSync(file, 'utf8');
		const normalized = content.replace(/\r\n/g, '\n');
		const { frontmatter, body } = splitSkillFrontmatter(normalized);
		const digest = skillContractDigest(body);
		const existing = readSkillContractStamp(frontmatter);
		if (existing === digest) {
			console.log(`ok      ${slug} ${digest}`);
			continue;
		}
		if (!WRITE) {
			console.log(
				`drift   ${slug}: stamp ${existing ?? '<none>'} != body ${digest} (run with --write)`,
			);
			drift += 1;
			continue;
		}
		// Re-stamp through the shared structural walk (writeSkillContractStamp)
		// so the writer's match set is exactly the reader's — a stamp the reader
		// resolves can always be rewritten, and a stamp-shaped decoy inside a
		// block scalar is never touched (PR #3387 review). Insertion is the only
		// fallback, and only when no stamp line exists at all.
		const { frontmatter: fmSlice, body: bodySlice } =
			splitSkillFrontmatter(normalized);
		const written = writeSkillContractStamp(fmSlice, digest);
		const next = written.replaced
			? written.next + bodySlice
			: insertStamp(normalized, digest);
		// N-3 (PR #2863 review): a skill without a frontmatter fence made the
		// helper return the input unchanged and the loop still wrote it and
		// reported `stamped` — a false success. Fail closed instead so the next
		// check run keeps flagging the slug instead of silently "fixing" it.
		if ((!existing && next === normalized) || (!written.replaced && next === normalized)) {
			console.error(
				`skipped ${slug}: no rewritable stamp line and no insertion point; fix the SKILL.md frontmatter`,
			);
			drift += 1;
			continue;
		}
		writeFileSync(file, next, 'utf8');
		console.log(`stamped ${slug} ${digest}${existing ? ` (was ${existing})` : ''}`);
	}
	if (drift > 0) process.exit(1);
}

/**
 * Insert the stamp as a quoted-string child of the `metadata:` map when one
 * exists (spec shape, issue #2907), otherwise as the LAST top-level
 * frontmatter key immediately before the closing fence: the legacy
 * positional contract only requires the fence to open with name:, and the
 * pre-#2907 runtime closure asserted `audience:` directly after `name:`.
 * Exported for unit tests (the script body runs only under import.meta.main).
 */
export function insertStamp(content: string, digest: string): string {
	// Search the FRONTMATTER slice only: a column-0 `metadata:` in the skill
	// body must never capture the stamp (PRR-006) — an unbounded whole-file
	// match produced a self-invalidating stamp inside body text.
	const { frontmatter: fmSlice, body: bodySlice } =
		splitSkillFrontmatter(content);
	// No frontmatter at all: the `\n---\n` fallback below would find the
	// first BODY horizontal rule and inject a stamp-shaped line into skill
	// body text (follow-up review of PR #3392). Return unchanged so the
	// caller's fail-closed guard skips the slug instead of "stamping" it.
	if (fmSlice === '') return content;
	// Same opener the reader accepts (comment-tolerant, case-insensitive) so
	// an insertion point always implies the reader will resolve the child.
	const metadataLabel = /^metadata:[ \t]*(?:#[^\n]*)?[ \t]*$/im.exec(fmSlice);
	if (metadataLabel?.index !== undefined) {
		// +1 skips the line terminator (content is LF-normalized above).
		const afterLabel = metadataLabel.index + metadataLabel[0].length + 1;
		const child = `  ${SKILL_CONTRACT_DIGEST_KEY}: "${digest}"\n`;
		return fmSlice.slice(0, afterLabel) + child + fmSlice.slice(afterLabel) + bodySlice;
	}
	const close = content.indexOf('\n---\n');
	if (close === -1) return content;
	return content.slice(0, close) + `\n${SKILL_CONTRACT_DIGEST_KEY}: "${digest}"` + content.slice(close);
}
