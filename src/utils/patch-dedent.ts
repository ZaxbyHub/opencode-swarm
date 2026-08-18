/**
 * Issue #2206: models routinely emit unified diffs / native patches indented
 * inside a fenced markdown, YAML, or JSON block (e.g. `  --- a/file`). Every
 * diff parser in this repo anchors `diff --git` / `---` / `+++` / `@@` at
 * column 0, so an indented payload is not recognized — the write-target
 * resolver reports "no recognizable write targets", `swarm_apply_patch` fails
 * to parse hunks, and a stray `*** End Patch` trailer misclassifies the payload
 * as a malformed native patch.
 *
 * This normalizer strips the MINIMUM COMMON leading whitespace across all
 * non-empty lines, restoring column-0 semantics in one place instead of
 * widening every anchored regex (which would misclassify hunk context lines
 * whose file content itself starts with `---` — see the plan-critic analysis
 * for #2206).
 *
 * Properties:
 *  - A column-0 patch has minIndent 0 → returned byte-identical (after \r\n
 *    normalization), so existing behavior is unchanged.
 *  - A uniformly indented patch (wrapper indent N) has every line stripped by
 *    exactly N chars: `+`/`-`/`\` markers return to column 0 and context lines
 *    keep their structural space marker (position N+1 is content, not wrapper).
 *  - Empty lines (and whitespace-only lines) are skipped when computing the
 *    minimum indent. Truly empty lines (`line.length === 0`) carry no
 *    characters so the length-guarded slice leaves them intact. Whitespace-only
 *    lines whose length is >= minIndent ARE sliced to the prefix-stripped
 *    remainder (e.g. a 3-space line with minIndent=3 becomes ''), which is
 *    safe for downstream parsers because they treat whitespace-only lines as
 *    no-content.
 *  - Mixed indentation (some lines shallower than others) yields minIndent 0 →
 *    no-op; the payload fails to parse exactly as it does today (fail-clean,
 *    no corruption).
 */
export function normalizePatchIndentation(text: string): string {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const lines = normalized.split('\n');
	let minIndent = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
		if (indent < minIndent) minIndent = indent;
	}
	if (minIndent === 0 || !Number.isFinite(minIndent)) return normalized;
	return lines
		.map((line) => (line.length >= minIndent ? line.slice(minIndent) : line))
		.join('\n');
}
