/**
 * Generated-skill validation gate.
 *
 * Eval fixtures live under `.swarm/skills/evals/<slug>/*.json`. Each fixture can
 * be either a single case, an array of cases, or `{ "cases": [...] }`.
 *
 * This service is deterministic and fail-open only when no eval set exists.
 * Malformed eval files fail closed so a broken gate cannot silently approve a
 * promotion.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_EVAL_FILES = 50;
const MAX_EVAL_FILE_BYTES = 64 * 1024;
const MAX_EVAL_CASES = 100;
const MAX_PHRASES_PER_CASE = 40;
const MAX_PHRASE_LENGTH = 160;
const MAX_REJECTED_EDIT_RECORDS = 200;
const REJECTED_PREVIEW_BYTES = 800;

export interface SkillEvalCase {
	id?: string;
	task?: string;
	required_phrases?: string[];
	forbidden_phrases?: string[];
}

export interface SkillCaseEvaluation {
	id: string;
	candidateScore: number;
	incumbentScore: number;
	candidateFailures: string[];
	incumbentFailures: string[];
}

export type SkillEvaluationStatus =
	| 'unevaluated'
	| 'passed'
	| 'rejected'
	| 'invalid_eval_set';

export interface SkillEvaluationResult {
	status: SkillEvaluationStatus;
	passed: boolean;
	reason: string;
	evalFiles: string[];
	caseCount: number;
	candidateScore: number;
	incumbentScore: number;
	caseResults: SkillCaseEvaluation[];
}

export interface EvaluateSkillChangeRequest {
	directory: string;
	slug: string;
	candidateContent: string;
	incumbentContent?: string;
	operation: string;
}

export interface RejectedSkillEditRecord {
	timestamp: string;
	slug: string;
	operation: string;
	reason: string;
	candidateHash: string;
	candidateNormalizedHash?: string;
	incumbentHash?: string;
	candidateScore: number;
	incumbentScore: number;
	evalFiles: string[];
	caseCount: number;
	candidatePreview: string;
}

function isValidSlug(slug: string): boolean {
	return SLUG_PATTERN.test(slug);
}

function normalizePhrase(input: unknown): string | undefined {
	if (typeof input !== 'string') return undefined;
	const value = input.replace(/\s+/g, ' ').trim();
	if (!value) return undefined;
	return value.slice(0, MAX_PHRASE_LENGTH);
}

function normalizePhraseList(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of input.slice(0, MAX_PHRASES_PER_CASE)) {
		const value = normalizePhrase(raw);
		if (!value) continue;
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
}

function normalizeEvalCase(
	input: unknown,
	fallbackId: string,
): SkillEvalCase | undefined {
	if (!input || typeof input !== 'object') return undefined;
	const record = input as Record<string, unknown>;
	const id = normalizePhrase(record.id) ?? fallbackId;
	const task = normalizePhrase(record.task);
	const required_phrases = normalizePhraseList(record.required_phrases);
	const forbidden_phrases = normalizePhraseList(record.forbidden_phrases);
	if (required_phrases.length === 0 && forbidden_phrases.length === 0) {
		return undefined;
	}
	return {
		id,
		task,
		required_phrases,
		forbidden_phrases,
	};
}

function casesFromParsedJson(
	parsed: unknown,
	fileLabel: string,
): SkillEvalCase[] {
	const rawCases = Array.isArray(parsed)
		? parsed
		: parsed &&
				typeof parsed === 'object' &&
				Array.isArray((parsed as { cases?: unknown }).cases)
			? (parsed as { cases: unknown[] }).cases
			: [parsed];
	const cases: SkillEvalCase[] = [];
	for (let i = 0; i < rawCases.length && cases.length < MAX_EVAL_CASES; i++) {
		const normalized = normalizeEvalCase(rawCases[i], `${fileLabel}#${i + 1}`);
		if (normalized) cases.push(normalized);
	}
	return cases;
}

function evalRoot(directory: string, slug: string): string {
	return path.join(directory, '.swarm', 'skills', 'evals', slug);
}

function isInsidePath(root: string, target: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	return (
		resolvedTarget === resolvedRoot ||
		resolvedTarget.startsWith(resolvedRoot + path.sep)
	);
}

export function rejectedEditsPath(directory: string): string {
	return path.join(directory, '.swarm', 'skills', 'rejected-edits.jsonl');
}

async function loadEvalSet(
	directory: string,
	slug: string,
): Promise<{
	status: 'missing' | 'loaded' | 'invalid';
	files: string[];
	cases: SkillEvalCase[];
	reason?: string;
}> {
	if (!isValidSlug(slug)) {
		return {
			status: 'invalid',
			files: [],
			cases: [],
			reason: 'invalid slug',
		};
	}

	const root = evalRoot(directory, slug);
	if (!existsSync(root)) {
		return { status: 'missing', files: [], cases: [] };
	}
	let realRoot: string;
	try {
		realRoot = await realpath(root);
		const realDirectory = await realpath(directory);
		if (!isInsidePath(realDirectory, realRoot)) {
			return {
				status: 'invalid',
				files: [],
				cases: [],
				reason: 'eval directory escaped project root',
			};
		}
	} catch (err) {
		return {
			status: 'invalid',
			files: [],
			cases: [],
			reason: `eval directory unreadable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (err) {
		return {
			status: 'invalid',
			files: [],
			cases: [],
			reason: `eval directory unreadable: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const files = entries
		.filter((name) => name.endsWith('.json'))
		.sort((a, b) => a.localeCompare(b))
		.slice(0, MAX_EVAL_FILES);
	if (files.length === 0) {
		return { status: 'missing', files: [], cases: [] };
	}

	const cases: SkillEvalCase[] = [];
	const fileLabels: string[] = [];
	for (const file of files) {
		const fullPath = path.join(root, file);
		const resolved = path.resolve(fullPath);
		const resolvedRoot = path.resolve(root);
		if (!isInsidePath(resolvedRoot, resolved)) {
			return {
				status: 'invalid',
				files: fileLabels,
				cases,
				reason: `eval path escaped root: ${file}`,
			};
		}

		let readPath = fullPath;
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			const linkInfo = await lstat(fullPath);
			if (linkInfo.isSymbolicLink()) {
				const realFile = await realpath(fullPath);
				if (!isInsidePath(realRoot, realFile)) {
					return {
						status: 'invalid',
						files: fileLabels,
						cases,
						reason: `eval path escaped root: ${file}`,
					};
				}
				readPath = realFile;
				info = await stat(realFile);
			} else {
				if (!linkInfo.isFile()) continue;
				info = linkInfo;
			}
		} catch (err) {
			return {
				status: 'invalid',
				files: fileLabels,
				cases,
				reason: `eval file unreadable: ${file}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		if (!info.isFile()) continue;
		if (info.size > MAX_EVAL_FILE_BYTES) {
			return {
				status: 'invalid',
				files: fileLabels,
				cases,
				reason: `eval file too large: ${file}`,
			};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(readPath, 'utf-8'));
		} catch (err) {
			return {
				status: 'invalid',
				files: fileLabels,
				cases,
				reason: `eval file invalid JSON: ${file}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		fileLabels.push(path.relative(directory, fullPath).replace(/\\/g, '/'));
		cases.push(...casesFromParsedJson(parsed, file));
		if (cases.length >= MAX_EVAL_CASES) break;
	}

	if (cases.length === 0) {
		return {
			status: 'invalid',
			files: fileLabels,
			cases: [],
			reason: 'eval set contained no valid cases',
		};
	}

	return {
		status: 'loaded',
		files: fileLabels,
		cases: cases.slice(0, MAX_EVAL_CASES),
	};
}

function includesPhrase(content: string, phrase: string): boolean {
	return content.toLowerCase().includes(phrase.toLowerCase());
}

function evaluateContent(
	content: string,
	testCase: SkillEvalCase,
): {
	score: number;
	failures: string[];
} {
	const failures: string[] = [];
	const required = testCase.required_phrases ?? [];
	const forbidden = testCase.forbidden_phrases ?? [];
	let requiredHits = 0;

	for (const phrase of required) {
		if (includesPhrase(content, phrase)) {
			requiredHits++;
		} else {
			failures.push(`missing required phrase: ${phrase}`);
		}
	}
	for (const phrase of forbidden) {
		if (includesPhrase(content, phrase)) {
			failures.push(`contains forbidden phrase: ${phrase}`);
		}
	}

	const requiredScore =
		required.length === 0 ? 1 : requiredHits / Math.max(1, required.length);
	const forbiddenPenalty = forbidden.some((phrase) =>
		includesPhrase(content, phrase),
	)
		? 1
		: 0;
	return {
		score: Math.max(0, requiredScore - forbiddenPenalty),
		failures,
	};
}

function average(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hashContent(content: string | undefined): string | undefined {
	if (content === undefined) return undefined;
	return createHash('sha256').update(content).digest('hex');
}

function normalizeRejectedContent(content: string): string {
	return content
		.replace(/^generated_at:\s*\S+\s*$/gim, 'generated_at: <generated>')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

function hashNormalizedContent(
	content: string | undefined,
): string | undefined {
	if (content === undefined) return undefined;
	return hashContent(normalizeRejectedContent(content));
}

export async function evaluateSkillChange(
	req: EvaluateSkillChangeRequest,
): Promise<SkillEvaluationResult> {
	const evalSet = await loadEvalSet(req.directory, req.slug);
	if (evalSet.status === 'missing') {
		return {
			status: 'unevaluated',
			passed: true,
			reason: 'no eval set found',
			evalFiles: [],
			caseCount: 0,
			candidateScore: 0,
			incumbentScore: 0,
			caseResults: [],
		};
	}
	if (evalSet.status === 'invalid') {
		return {
			status: 'invalid_eval_set',
			passed: false,
			reason: evalSet.reason ?? 'invalid eval set',
			evalFiles: evalSet.files,
			caseCount: evalSet.cases.length,
			candidateScore: 0,
			incumbentScore: 0,
			caseResults: [],
		};
	}

	const caseResults: SkillCaseEvaluation[] = [];
	for (const testCase of evalSet.cases) {
		const candidate = evaluateContent(req.candidateContent, testCase);
		const incumbent = evaluateContent(req.incumbentContent ?? '', testCase);
		caseResults.push({
			id: testCase.id ?? 'case',
			candidateScore: candidate.score,
			incumbentScore: incumbent.score,
			candidateFailures: candidate.failures,
			incumbentFailures: incumbent.failures,
		});
	}

	const candidateScore = average(
		caseResults.map((entry) => entry.candidateScore),
	);
	const incumbentScore = req.incumbentContent
		? average(caseResults.map((entry) => entry.incumbentScore))
		: 0;
	const passed = req.incumbentContent
		? caseResults.every(
				(entry) =>
					entry.candidateScore >= entry.incumbentScore &&
					entry.candidateFailures.length <= entry.incumbentFailures.length,
			) &&
			caseResults.some(
				(entry) =>
					entry.candidateScore > entry.incumbentScore ||
					entry.candidateFailures.length < entry.incumbentFailures.length,
			)
		: caseResults.every(
				(entry) =>
					entry.candidateScore >= 1 && entry.candidateFailures.length === 0,
			);
	const reason = passed
		? req.incumbentContent
			? 'candidate strictly improves incumbent on every eval case'
			: 'candidate satisfies eval set'
		: req.incumbentContent
			? 'candidate did not strictly improve incumbent on every eval case'
			: 'candidate did not satisfy eval set';

	return {
		status: passed ? 'passed' : 'rejected',
		passed,
		reason,
		evalFiles: evalSet.files,
		caseCount: evalSet.cases.length,
		candidateScore,
		incumbentScore,
		caseResults,
	};
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, content, 'utf-8');
	await rename(tmp, filePath);
}

export async function appendRejectedSkillEdit(
	req: EvaluateSkillChangeRequest,
	evaluation: SkillEvaluationResult,
): Promise<void> {
	const filePath = rejectedEditsPath(req.directory);
	const record: RejectedSkillEditRecord = {
		timestamp: new Date().toISOString(),
		slug: req.slug,
		operation: req.operation,
		reason: evaluation.reason,
		candidateHash: hashContent(req.candidateContent) ?? '',
		candidateNormalizedHash: hashNormalizedContent(req.candidateContent),
		incumbentHash: hashContent(req.incumbentContent),
		candidateScore: evaluation.candidateScore,
		incumbentScore: evaluation.incumbentScore,
		evalFiles: evaluation.evalFiles,
		caseCount: evaluation.caseCount,
		candidatePreview: req.candidateContent
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, REJECTED_PREVIEW_BYTES),
	};

	let prior: string[] = [];
	try {
		prior = (await readFile(filePath, 'utf-8'))
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0);
	} catch {
		prior = [];
	}
	const next = [
		...prior.slice(Math.max(0, prior.length - (MAX_REJECTED_EDIT_RECORDS - 1))),
		JSON.stringify(record),
	];
	await atomicWrite(filePath, `${next.join('\n')}\n`);
}

export async function isRejectedSkillContent(
	directory: string,
	slug: string,
	content: string,
): Promise<boolean> {
	const exactHash = hashContent(content);
	const normalizedHash = hashNormalizedContent(content);
	let raw = '';
	try {
		raw = await readFile(rejectedEditsPath(directory), 'utf-8');
	} catch {
		return false;
	}
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: Partial<RejectedSkillEditRecord>;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed.slug !== slug) continue;
		if (parsed.candidateHash && parsed.candidateHash === exactHash) {
			return true;
		}
		if (
			parsed.candidateNormalizedHash &&
			parsed.candidateNormalizedHash === normalizedHash
		) {
			return true;
		}
	}
	return false;
}

export const _internals = {
	loadEvalSet,
	evaluateContent,
	rejectedEditsPath,
	hashNormalizedContent,
};
