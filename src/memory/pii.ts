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

/** Dependency-free detector (default). */
export class RegexPiiDetector implements PiiDetector {
	readonly id = 'regex' as const;

	async detect(text: string): Promise<PiiFinding[]> {
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

const NER_ENTITY_TYPE_MAP: Record<
	string,
	{ type: PiiType; confidence: number }
> = {
	PER: { type: 'person', confidence: 0.9 },
	ORG: { type: 'organization', confidence: 0.8 },
	LOC: { type: 'location', confidence: 0.8 },
};

const NER_MODEL_ID = 'Xenova/bert-base-NER';
const NER_MODEL_CACHE_DIR = '~/.cache/opencode-swarm/models';

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

interface TransformersPipelineOutput {
	answer: Array<{ entity_group: string; word: string }>;
}

interface TransformersModule {
	pipeline: (
		task: string,
		model: string,
		options?: { quantized?: boolean },
	) => Promise<
		(
			text: string,
			options: { grouped_entities: boolean },
		) => Promise<TransformersPipelineOutput | TransformersPipelineOutput[]>
	>;
	env?: { cacheDir?: string };
}

/**
 * Opt-in NER detector. Construction is cheap; the model loads on first
 * `detect()` and is cached on the instance. Absent peer dependency → typed
 * `MemoryPiiDetectorError` (fail-closed with an install hint).
 */
export class NerPiiDetector implements PiiDetector {
	readonly id = 'ner' as const;
	private pipeline:
		| Awaited<ReturnType<TransformersModule['pipeline']>>
		| undefined;
	private loadError: MemoryPiiDetectorError | undefined;

	/**
	 * Eagerly verify module availability without loading the model. Used by
	 * the write boundary to surface configuration problems before any text is
	 * processed.
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

	private async getPipeline() {
		if (this.pipeline) return this.pipeline;
		const mod = this.loadModule();
		this.pipeline = await mod.pipeline('token-classification', NER_MODEL_ID, {
			quantized: true,
		});
		return this.pipeline;
	}

	async detect(text: string): Promise<PiiFinding[]> {
		const pipe = await this.getPipeline();
		const output = await pipe(text, { grouped_entities: true });
		const groups = Array.isArray(output) ? output[0] : output;
		if (!groups?.answer) return [];
		const findings: PiiFinding[] = [];
		for (const entity of groups.answer) {
			const mapped = NER_ENTITY_TYPE_MAP[entity.entity_group];
			if (mapped && entity.word) {
				findings.push({
					type: mapped.type,
					match: entity.word,
					confidence: mapped.confidence,
				});
			}
		}
		return findings;
	}
}

export function createPiiDetector(kind: 'regex' | 'ner'): PiiDetector {
	return kind === 'ner' ? new NerPiiDetector() : new RegexPiiDetector();
}
