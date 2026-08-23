/**
 * #1466 (Phase 6): PII detection at the memory write boundary.
 *
 * Two implementations behind one interface:
 * - `RegexPiiDetector` (default, dependency-free): email / phone /
 *   credit-card (Luhn-validated) / SSN / IP-address patterns.
 * - `NerPiiDetector` (opt-in via `memory.redaction.piiDetector: 'ner'`):
 *   lazy-loads the OPTIONAL `@xenova/transformers` peer dependency for
 *   person/organization/location NER. The module is resolved at RUNTIME via
 *   `createRequire` — there is no static import, so the plugin bundle never
 *   references the package and default installs stay dependency-free
 *   (AGENTS.md invariant 2). When the package is absent the detector throws
 *   a typed `MemoryPiiDetectorError` with install instructions instead of a
 *   raw ERR_MODULE_NOT_FOUND (the #1873 lesson: fail with a typed, actionable
 *   error rather than an opaque crash on an optional runtime path).
 */
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryPiiDetectorError } from './errors';

export type PiiType =
	| 'email'
	| 'phone'
	| 'credit_card'
	| 'ssn'
	| 'ip_address'
	| 'person'
	| 'organization'
	| 'location';

export interface PiiFinding {
	type: PiiType;
	/** The matched text. NEVER persist or log this — findings summaries are
	 * reduced to type/counts/score at every logging boundary. */
	match: string;
	/** Detector confidence in [0,1]. The rejection threshold compares the
	 * maximum finding confidence against `memory.redaction.piiThreshold`. */
	confidence: number;
}

export interface PiiDetector {
	readonly id: 'regex' | 'ner';
	/** Async because the NER implementation awaits model inference. */
	detect(text: string): Promise<PiiFinding[]>;
}

/**
 * Score model (#1466): the max finding confidence. A single high-confidence
 * finding (a Luhn-valid card, an email) is enough to exceed the 0.7 default
 * threshold; low-confidence families (bare IP addresses at 0.5) are reported
 * but do not reject on their own.
 */
export function computePiiScore(findings: PiiFinding[]): number {
	return findings.reduce((max, f) => Math.max(max, f.confidence), 0);
}

/** Reduce findings to a loggable summary — no matched text leaves this module. */
export function summarizePiiFindings(findings: PiiFinding[]): {
	score: number;
	countsByType: Record<string, number>;
} {
	const countsByType: Record<string, number> = {};
	for (const f of findings) {
		countsByType[f.type] = (countsByType[f.type] ?? 0) + 1;
	}
	return { score: computePiiScore(findings), countsByType };
}

const CREDIT_CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Separator-structured phone: requires 10+ digits split by spaces/dashes/dots
// with at least one separator, so bare long digit runs (commit shas, ids) do
// not match.
const PHONE_RE =
	/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function luhnValid(digits: string): boolean {
	const s = digits.replace(/[^0-9]/g, '');
	if (s.length < 13 || s.length > 19) return false;
	let sum = 0;
	let dbl = false;
	for (let i = s.length - 1; i >= 0; i--) {
		let d = s.charCodeAt(i) - 48;
		if (dbl) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		dbl = !dbl;
	}
	return sum % 10 === 0;
}

function octetsValid(m: RegExpExecArray): boolean {
	return [m[1], m[2], m[3], m[4]].every((o) => {
		const n = Number(o);
		return Number.isInteger(n) && n >= 0 && n <= 255;
	});
}

// PR #2310 feedback FB-4: zero-width and invisible characters used to break
// digit grouping / domain matching. NFKC alone does NOT remove them, so they
// are stripped explicitly (same character class the repo's
// external-content-scanner uses for invisible-content stripping).
const INVISIBLE_CHARS_RE = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;

/**
 * Normalize text for DETECTION only (the stored/returned text is untouched):
 * NFKC folds fullwidth/compatibility digits and letters to ASCII, and
 * invisible characters are stripped. Without this, fullwidth digits fully
 * evade SSN/credit-card/phone/IP detection and zero-width spaces split
 * digit groups (execution-probed in the PR #2310 review).
 */
function normalizeForDetection(text: string): string {
	return text.normalize('NFKC').replace(INVISIBLE_CHARS_RE, '');
}

/** Dependency-free detector (default). */
export class RegexPiiDetector implements PiiDetector {
	readonly id = 'regex' as const;

	async detect(rawText: string): Promise<PiiFinding[]> {
		const text = normalizeForDetection(rawText);
		const findings: PiiFinding[] = [];
		CREDIT_CARD_RE.lastIndex = 0;
		for (const m of text.matchAll(CREDIT_CARD_RE)) {
			if (m[0] && luhnValid(m[0])) {
				findings.push({ type: 'credit_card', match: m[0], confidence: 0.95 });
			}
		}
		EMAIL_RE.lastIndex = 0;
		for (const m of text.matchAll(EMAIL_RE)) {
			if (m[0]) findings.push({ type: 'email', match: m[0], confidence: 0.9 });
		}
		PHONE_RE.lastIndex = 0;
		for (const m of text.matchAll(PHONE_RE)) {
			if (m[0]) findings.push({ type: 'phone', match: m[0], confidence: 0.7 });
		}
		SSN_RE.lastIndex = 0;
		for (const m of text.matchAll(SSN_RE)) {
			if (m[0]) findings.push({ type: 'ssn', match: m[0], confidence: 0.85 });
		}
		IPV4_RE.lastIndex = 0;
		for (const m of text.matchAll(IPV4_RE)) {
			if (m[0] && octetsValid(m)) {
				findings.push({
					type: 'ip_address',
					match: m[0],
					confidence: 0.5,
				});
			}
		}
		return findings;
	}
}

/**
 * BIO label (prefix-stripped) → PII type. `MISC` and unknown labels are
 * intentionally unmapped — they are not PII for this policy.
 */
const NER_ENTITY_TYPE_MAP: Record<string, PiiType> = {
	PER: 'person',
	ORG: 'organization',
	LOC: 'location',
};

const NER_MODEL_ID = 'Xenova/bert-base-NER';
/**
 * Absolute model cache dir. Computed from os.homedir() — Node's fs (and
 * transformers.js) do NOT tilde-expand, so a literal '~' would silently
 * create a relative `./~` directory under the plugin host's cwd instead of
 * the user cache (final-critic item 2).
 */
const NER_MODEL_CACHE_DIR = path.join(
	os.homedir(),
	'.cache',
	'opencode-swarm',
	'models',
);

/**
 * DI seam (repo convention, cf. `src/db/sqlite-loader.ts:_internals`). Tests
 * inject a fake module loader to exercise both the loaded path and the
 * absent-module typed-error path without installing a ~110MB model. Production
 * code never mutates this.
 */
export const _internals: {
	requireModule: (id: string) => unknown;
	reset: () => void;
} = {
	requireModule: (id: string) => {
		// Runtime resolution only — no static import of the peer dependency.
		// `createRequire` keeps this opaque to bundlers (they cannot statically
		// resolve the argument), preserving bundle portability.
		const req = createRequire(import.meta.url);
		return req(id);
	},
	reset: () => {
		_internals.requireModule = (id: string) => {
			const req = createRequire(import.meta.url);
			return req(id);
		};
	},
};

/**
 * Real @xenova/transformers@2.17.2 TokenClassificationPipeline output shape
 * (verified against the package source at tag 2.17.2, pipelines.js:370-439):
 * for a single string input the callback resolves to a FLAT ARRAY of token
 * objects `{ entity, score, index, word, start, end }`. The `entity` label is
 * the model's raw id2label value — BIO tags like `B-PER` / `I-LOC` for NER
 * models. There is NO `grouped_entities` aggregation and NO `answer` wrapper
 * at this version (that shape belongs to the question-answering pipeline) —
 * consecutive-token grouping is done by the consumer (groupConsecutive
 * below). PR #2310 feedback FB-1: the original implementation parsed a
 * non-existent shape and would have silently returned zero findings.
 */
interface TransformersTokenEntity {
	entity: string;
	score: number;
	index: number;
	word: string;
}

interface TransformersModule {
	pipeline: (
		task: string,
		model: string,
		options?: { quantized?: boolean },
	) => Promise<(text: string) => Promise<TransformersTokenEntity[]>>;
	env?: { cacheDir?: string };
}

/**
 * Opt-in NER detector. Construction is cheap; the model loads on first
 * `detect()` (memoized in-flight — PR #2310 feedback FB-5: concurrent first
 * calls must share one load, the library does not dedupe internally) and is
 * cached on the instance. Absent peer dependency → typed
 * `MemoryPiiDetectorError` (fail-closed with an install hint).
 */
export class NerPiiDetector implements PiiDetector {
	readonly id = 'ner' as const;
	private pipeline:
		| Awaited<ReturnType<TransformersModule['pipeline']>>
		| undefined;
	private pipelinePromise:
		| Promise<Awaited<ReturnType<TransformersModule['pipeline']>>>
		| undefined;
	private loadError: MemoryPiiDetectorError | undefined;

	/**
	 * Eagerly verify module availability without loading the model. Available
	 * for callers that want to surface opt-in misconfiguration (e.g. a future
	 * doctor/validate surface) before any text is processed; ordinary callers
	 * hit the same typed error from the first detect().
	 */
	assertAvailable(): void {
		this.loadModule();
	}

	private loadModule(): TransformersModule {
		if (this.loadError) throw this.loadError;
		try {
			const mod = _internals.requireModule('@xenova/transformers') as
				| TransformersModule
				| undefined;
			if (!mod || typeof mod.pipeline !== 'function') {
				throw new MemoryPiiDetectorError(
					'@xenova/transformers is installed but does not expose pipeline()',
				);
			}
			// Best-effort model cache placement; failure to set it is not fatal.
			try {
				if (mod.env && typeof mod.env === 'object') {
					mod.env.cacheDir = NER_MODEL_CACHE_DIR;
				}
			} catch {
				// ignore — cache placement is advisory
			}
			return mod;
		} catch (err) {
			const typed =
				err instanceof MemoryPiiDetectorError
					? err
					: new MemoryPiiDetectorError(
							`memory.redaction.piiDetector 'ner' requires the optional peer dependency @xenova/transformers, which is not installed in this environment. Install it (e.g. \`bun add @xenova/transformers\`) or set memory.redaction.piiDetector back to 'regex'. Original error: ${err instanceof Error ? err.message : String(err)}`,
						);
			this.loadError = typed;
			throw typed;
		}
	}

	private getPipeline() {
		// In-flight memoization: concurrent first detect() calls share one
		// pipeline construction (the library has no internal load dedupe).
		this.pipelinePromise ??= this.loadModule()
			.pipeline('token-classification', NER_MODEL_ID, {
				quantized: true,
			})
			.then((pipe) => {
				this.pipeline = pipe;
				return pipe;
			});
		return this.pipelinePromise;
	}

	async detect(text: string): Promise<PiiFinding[]> {
		const pipe = this.pipeline ?? (await this.getPipeline());
		// Real 2.17.2 contract: flat array of {entity:'B-PER'|'I-LOC'..., score,
		// index, word, ...} for single-string input. No options, no aggregation.
		const tokens = await pipe(text);
		if (!Array.isArray(tokens)) return [];
		return groupConsecutiveEntities(tokens);
	}
}

/**
 * Group consecutive BIO-tagged tokens (adjacent `index` values, same label
 * after B-/I- prefix stripping) into single findings, mimicking the
 * aggregation upstream libraries provide. Group confidence is the MINIMUM
 * token score (conservative: a chain is only as strong as its weakest link).
 */
function groupConsecutiveEntities(
	tokens: TransformersTokenEntity[],
): PiiFinding[] {
	const findings: PiiFinding[] = [];
	let current: {
		type: PiiType;
		word: string;
		minScore: number;
		lastIndex: number;
	} | null = null;
	const flush = () => {
		if (current) {
			findings.push({
				type: current.type,
				match: current.word,
				confidence: current.minScore,
			});
			current = null;
		}
	};
	for (const token of tokens) {
		// Strip BIO prefix: `B-PER`/`I-PER` → `PER`. Labels without a prefix
		// (rare configs) pass through unchanged.
		const label = token.entity.replace(/^[BI]-/, '');
		const type = NER_ENTITY_TYPE_MAP[label];
		if (!type || !token.word) {
			flush();
			continue;
		}
		// Adjacency by token INDEX (not array position): the 2.17.x pipeline
		// emits one entry per input token position with the tokenizer's own
		// index, and the upstream tokenizer decodes wordpieces into whole
		// words before emitting, so consecutive same-entity tokens of one
		// mention occupy contiguous index values for the NER models we pin
		// (bert-base-NER). A future model that skips O tokens between parts
		// would simply yield separate per-part findings (safe degradation),
		// never a false merge.
		if (
			current &&
			current.type === type &&
			token.index === current.lastIndex + 1
		) {
			current.word = `${current.word} ${token.word}`;
			current.minScore = Math.min(current.minScore, token.score);
			current.lastIndex = token.index;
		} else {
			flush();
			current = {
				type,
				word: token.word,
				minScore: token.score,
				lastIndex: token.index,
			};
		}
	}
	flush();
	return findings;
}

export function createPiiDetector(kind: 'regex' | 'ner'): PiiDetector {
	return kind === 'ner' ? new NerPiiDetector() : new RegexPiiDetector();
}
