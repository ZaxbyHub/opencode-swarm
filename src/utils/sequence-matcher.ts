/**
 * Faithful TypeScript port of CPython's `difflib.SequenceMatcher`.
 *
 * Implements the Ratcliff/Obershelp pattern-matching algorithm with the
 * "popular element" (autojunk) guard, so that `.ratio()` produces values
 * identical to CPython 3.x for the BMP character content used by the
 * fuzzy-match strategies. The thresholds in `src/utils/fuzzy-match.ts`
 * (0.50 / 0.70 / 0.80) were tuned against CPython's exact `2*M/T` ratio
 * formula, so substituting a Levenshtein-based library would silently
 * break those thresholds.
 *
 * Porting notes:
 * - Operates on **UTF-16 code units** (`s[i]`, `s.length`, `s.charCodeAt(i)`)
 *   consistently throughout. CPython operates on Unicode code points; for
 *   ASCII/BMP content the two coincide. Astral-plane characters (emoji)
 *   consume two UTF-16 units, so ratios for emoji-heavy input may differ
 *   marginally from CPython. This is acceptable for the fuzzy-match use
 *   case (source-code patches) and is round-trip-safe — no index mixing,
 *   no file corruption.
 * - `autojunk` defaults to `true`, matching CPython. When `b.length >= 200`
 *   and an element appears more than 1% of the time in `b`, it is treated
 *   as "popular" and excluded as an anchor candidate in `find_longest_match`.
 *   This is essential for ratio fidelity on real file sections.
 */

export interface Match {
	/** Start index in sequence `a`. */
	a: number;
	/** Start index in sequence `b`. */
	b: number;
	/** Length of the matching block. */
	size: number;
}

export type OpcodeTag = 'equal' | 'replace' | 'delete' | 'insert';

export interface Opcode {
	tag: OpcodeTag;
	i1: number;
	i2: number;
	j1: number;
	j2: number;
}

/** A predicate that marks a character as "junk" (never a sync point). */
export type IsJunk = ((ch: string) => boolean) | null;

/**
 * Difflib-compatible sequence matcher. Construct with two strings, then
 * call `.ratio()`, `.get_matching_blocks()`, or `.get_opcodes()`.
 */
export class SequenceMatcher {
	private a: string;
	private b: string;
	private isJunk: IsJunk;
	private autoJunk: boolean;

	// `b2j[ch]` = array of indices in `b` where `ch` occurs (non-junk only).
	private b2j: Map<string, number[]> = new Map();
	// Characters treated as "popular" (heuristic) — excluded from anchoring.
	private popularSet: Set<string> = new Set();
	// Cached matching blocks.
	private matchingBlocks: Match[] | null = null;

	constructor(isJunk: IsJunk, a: string, b: string, autoJunk = true) {
		this.a = a;
		this.b = b;
		this.isJunk = isJunk;
		this.autoJunk = autoJunk;
		this.chainB();
	}

	/** Allow changing the input sequences (mirrors CPython `set_seqs`/`set_seq2`). */
	setSeqs(a: string, b: string): void {
		this.a = a;
		this.b = b;
		this.matchingBlocks = null;
		this.chainB();
	}

	/** Precompute the `b` index map and the popular-element set. */
	private chainB(): void {
		const b = this.b;
		const b2j: Map<string, number[]> = new Map();
		for (let i = 0; i < b.length; i++) {
			const ch = b[i];
			const positions = b2j.get(ch);
			if (positions === undefined) {
				b2j.set(ch, [i]);
			} else {
				positions.push(i);
			}
		}

		// Remove junk elements from b2j.
		if (this.isJunk) {
			const junk: string[] = [];
			for (const ch of b2j.keys()) {
				if (this.isJunk(ch)) junk.push(ch);
			}
			for (const ch of junk) b2j.delete(ch);
		}

		// Popular heuristic: for long `b`, mark elements appearing > 1% of the
		// time as popular and purge them from the index. This prevents
		// pathological O(n*m) behavior on sequences dominated by a few
		// repeated tokens (e.g. whitespace in source files). CPython applies
		// this when `autojunk=true` (the default) and `len(b) >= 200`.
		this.popularSet = new Set();
		if (this.autoJunk && b.length >= 200) {
			const threshold = b.length * 0.01 + 0.5;
			const popular: string[] = [];
			for (const [ch, indices] of b2j) {
				if (indices.length > threshold) {
					popular.push(ch);
				}
			}
			for (const ch of popular) {
				this.popularSet.add(ch);
				b2j.delete(ch);
			}
		}
		this.b2j = b2j;
	}

	/**
	 * Find the longest matching block in `a[alo:ahi]` and `b[blo:bhi]`.
	 *
	 * Returns `{ a, b, size }` where `size` is maximal; ties are broken by
	 * smallest `a`, then smallest `b` (CPython canonical tiebreak).
	 *
	 * A "match" means `a[i] === b[j]` and the run extends as far as possible.
	 * Elements in the popular set are only used as anchor candidates when no
	 * non-popular match exists (CPython behavior: popular elements are
	 * excluded from `b2j`, so they only match opportunistically via the
	 * extending run after a non-popular anchor).
	 */
	findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
		const a = this.a;
		const b = this.b;
		const b2j = this.b2j;

		let bestI = alo;
		let bestJ = blo;
		let bestSize = 0;

		// `j2len[j+1]` = length of the longest match ending at `a[i-1], b[j]`.
		// Using a Map instead of CPython's array for sparse efficiency.
		const j2len: Map<number, number> = new Map();

		// CPython semantics: popular elements are removed from `b2j` and are
		// NOT re-anchored in `findLongest_match`. They can still extend an
		// existing run started by a non-popular anchor (via the DP `j2len`
		// carry) but they do not initiate matches. We intentionally skip
		// characters whose only presence is in `popularSet`. This is what
		// produces ratio divergence between `autojunk=true|false` and is
		// essential for threshold fidelity on long file sections.
		for (let i = alo; i < ahi; i++) {
			const ch = a[i];
			const positions = b2j.get(ch);
			if (positions === undefined) {
				// `ch` is either junk, popular, or absent from b. In all three
				// cases it cannot anchor a new match this iteration. The DP
				// row simply resets (newJ2len stays empty).
				j2len.clear();
				continue;
			}
			const newJ2len: Map<number, number> = new Map();
			// Iterate positions in `b` where `ch` occurs, within [blo, bhi).
			for (const j of positions) {
				if (j < blo) continue;
				if (j >= bhi) break;
				const k = j2len.get(j - 1) ?? 0;
				const size = k + 1;
				newJ2len.set(j, size);
				if (size > bestSize) {
					bestI = i - size + 1;
					bestJ = j - size + 1;
					bestSize = size;
				}
			}
			j2len.clear();
			for (const [k, v] of newJ2len) j2len.set(k, v);
		}

		// Extend the best match backward and forward over equal characters
		// (CPython does this to coalesce adjacent equal runs that the
		// dynamic-programming scan didn't merge).
		while (bestI > alo && bestJ > blo && a[bestI - 1] === b[bestJ - 1]) {
			bestI--;
			bestJ--;
			bestSize++;
		}
		while (
			bestI + bestSize < ahi &&
			bestJ + bestSize < bhi &&
			a[bestI + bestSize] === b[bestJ + bestSize]
		) {
			bestSize++;
		}

		return { a: bestI, b: bestJ, size: bestSize };
	}

	/** Recursively compute the list of matching blocks (descending order). */
	getMatchingBlocks(): Match[] {
		if (this.matchingBlocks !== null) return this.matchingBlocks;

		const la = this.a.length;
		const lb = this.b.length;
		const matches: Match[] = [];

		const stack: Array<[number, number, number, number]> = [[0, la, 0, lb]];
		while (stack.length > 0) {
			const [alo, ahi, blo, bhi] = stack.pop()!;
			const m = this.findLongestMatch(alo, ahi, blo, bhi);
			const { a: i, b: j, size } = m;
			if (size > 0) {
				matches.push(m);
				if (alo < i && blo < j) stack.push([alo, i, blo, j]);
				if (i + size < ahi && j + size < bhi) {
					stack.push([i + size, ahi, j + size, bhi]);
				}
			}
		}
		// Sort by `a` ascending (CPython does this via the recursion order;
		// we sort defensively since our stack is LIFO).
		matches.sort((x, y) => x.a - y.a || x.b - y.b);
		// Append the terminal sentinel.
		matches.push({ a: la, b: lb, size: 0 });
		this.matchingBlocks = matches;
		return matches;
	}

	/**
	 * Return a float in [0, 1]: `2*M / T`, where `M` is the total matched
	 * characters and `T` is the sum of the two sequence lengths.
	 * Returns `1.0` when both sequences are empty (matches CPython).
	 */
	ratio(): number {
		const matches = this.getMatchingBlocks();
		let m = 0;
		for (const block of matches) m += block.size;
		const t = this.a.length + this.b.length;
		if (t === 0) return 1.0;
		return (2.0 * m) / t;
	}

	/** Compute the opcodes describing how to turn `a` into `b`. */
	getOpcodes(): Opcode[] {
		const blocks = this.getMatchingBlocks();
		const opcodes: Opcode[] = [];
		let i = 0;
		let j = 0;
		for (const block of blocks) {
			const { a: ai, b: bj, size } = block;
			// Emit replace/delete/insert for the gap before this equal block.
			if (i < ai && j < bj) {
				opcodes.push({ tag: 'replace', i1: i, i2: ai, j1: j, j2: bj });
			} else if (i < ai) {
				opcodes.push({ tag: 'delete', i1: i, i2: ai, j1: j, j2: bj });
			} else if (j < bj) {
				opcodes.push({ tag: 'insert', i1: i, i2: ai, j1: j, j2: bj });
			}
			// Emit equal for the block itself (size 0 on the sentinel → skipped).
			if (size > 0) {
				opcodes.push({
					tag: 'equal',
					i1: ai,
					i2: ai + size,
					j1: bj,
					j2: bj + size,
				});
			}
			i = ai + size;
			j = bj + size;
		}
		return opcodes;
	}
}
