import type { SastContext, SastMatch } from './index';

export type JavascriptCallFamily =
	| 'eval'
	| 'function-constructor'
	| 'exec'
	| 'timer-string'
	| 'document-write'
	| 'postmessage';

export type JavascriptCallDisposition =
	| 'confirmed'
	| 'safe'
	| 'ambiguous'
	| 'none';

type TokenKind =
	| 'identifier'
	| 'string'
	| 'template'
	| 'regex'
	| 'number'
	| 'punctuator';

interface Token {
	kind: TokenKind;
	value: string;
	start: number;
	end: number;
}

type BindingFact =
	| 'child-direct'
	| 'child-namespace'
	| 'other-import'
	| 'regex';

interface Analysis {
	tokens: Token[];
	lineStarts: number[];
	scopeAtToken: number[];
	scopeParents: number[];
	scopeIsFunction: boolean[];
	declarations: Map<string, number>;
	declarationScopes: Map<string, Map<number, number>>;
	facts: Map<string, Set<BindingFact>>;
	factScopes: Map<string, Map<number, Set<BindingFact>>>;
	reassigned: Set<string>;
	reassignedScopes: Map<string, Set<number>>;
	mutatedMembers: Set<string>;
	mutatedMemberScopes: Map<string, Set<number>>;
	requireDerived: Set<string>;
	requireDerivedScopes: Map<string, Set<number>>;
	parameterScopes: Map<number, number>;
	varDeclarationIndexes: Set<number>;
	oversizedOrMalformed: boolean;
}

interface Callee {
	name: string;
	receiver?: string;
	receiverKind?: 'identifier' | 'regex' | 'direct-child-require';
	openParen: number;
}

const MAX_ANALYSIS_BYTES = 512 * 1024;
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const analysisByContext = new WeakMap<SastContext, Analysis>();
const dispositionByContext = new WeakMap<
	SastContext,
	Map<string, JavascriptCallDisposition>
>();
const tokenPairsByList = new WeakMap<Token[], Map<number, number>>();
const ASSIGNMENTS = new Set([
	'=',
	'+=',
	'-=',
	'*=',
	'/=',
	'%=',
	'&&=',
	'||=',
	'??=',
]);
const DECLARATION_KEYWORDS = new Set(['const', 'let', 'var']);

function isIdentifierStart(char: string): boolean {
	return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string): boolean {
	return /[A-Za-z0-9_$]/.test(char);
}

function canStartRegex(previous: Token | undefined): boolean {
	if (!previous) return true;
	if (previous.kind === 'identifier') {
		return [
			'return',
			'throw',
			'case',
			'delete',
			'typeof',
			'void',
			'yield',
			'await',
		].includes(previous.value);
	}
	return (
		previous.kind === 'punctuator' &&
		[
			'(',
			'[',
			'{',
			'=',
			':',
			',',
			';',
			'!',
			'?',
			'=>',
			'&&',
			'||',
			'??',
		].includes(previous.value)
	);
}

function tokenize(content: string): { tokens: Token[]; malformed: boolean } {
	const tokens: Token[] = [];
	let malformed = false;
	let index = 0;
	while (index < content.length) {
		const char = content[index]!;
		const next = content[index + 1];
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		if (char === '/' && next === '/') {
			index += 2;
			while (index < content.length && content[index] !== '\n') index++;
			continue;
		}
		if (char === '/' && next === '*') {
			const start = index;
			index += 2;
			while (
				index < content.length &&
				!(content[index] === '*' && content[index + 1] === '/')
			) {
				index++;
			}
			if (index >= content.length) {
				malformed = true;
				break;
			}
			index += 2;
			if (index <= start) malformed = true;
			continue;
		}
		if (char === '"' || char === "'") {
			const quote = char;
			const start = index++;
			let value = '';
			let closed = false;
			while (index < content.length) {
				const current = content[index]!;
				if (current === '\\') {
					value += current;
					if (index + 1 < content.length) value += content[index + 1];
					index += 2;
					continue;
				}
				if (current === quote) {
					index++;
					closed = true;
					break;
				}
				value += current;
				index++;
			}
			if (!closed) malformed = true;
			tokens.push({ kind: 'string', value, start, end: index });
			continue;
		}
		if (char === '`') {
			const start = index++;
			tokens.push({ kind: 'template', value: '', start, end: start + 1 });
			let closed = false;
			while (index < content.length) {
				if (content[index] === '\\') {
					index += 2;
					continue;
				}
				if (content[index] === '$' && content[index + 1] === '{') {
					const expressionStart = index + 2;
					let cursor = expressionStart;
					let depth = 1;
					let quote: string | null = null;
					while (cursor < content.length && depth > 0) {
						const current = content[cursor]!;
						if (quote) {
							if (current === '\\') cursor++;
							else if (current === quote) quote = null;
						} else if (current === '"' || current === "'") quote = current;
						else if (current === '{') depth++;
						else if (current === '}') depth--;
						cursor++;
					}
					if (depth !== 0) {
						malformed = true;
						index = cursor;
						break;
					}
					const nested = tokenize(content.slice(expressionStart, cursor - 1));
					for (const token of nested.tokens) {
						tokens.push({
							...token,
							start: token.start + expressionStart,
							end: token.end + expressionStart,
						});
					}
					malformed ||= nested.malformed;
					index = cursor;
					continue;
				}
				if (content[index] === '`') {
					index++;
					closed = true;
					break;
				}
				index++;
			}
			if (!closed) malformed = true;
			continue;
		}
		if (char === '/' && canStartRegex(tokens.at(-1))) {
			const start = index++;
			let inClass = false;
			let closed = false;
			while (index < content.length) {
				const current = content[index]!;
				if (current === '\\') {
					index += 2;
					continue;
				}
				if (current === '[') inClass = true;
				if (current === ']') inClass = false;
				if (current === '/' && !inClass) {
					index++;
					while (index < content.length && /[A-Za-z]/.test(content[index]!))
						index++;
					closed = true;
					break;
				}
				if (current === '\n') break;
				index++;
			}
			if (!closed) malformed = true;
			tokens.push({
				kind: 'regex',
				value: content.slice(start, index),
				start,
				end: index,
			});
			continue;
		}
		if (isIdentifierStart(char)) {
			const start = index++;
			while (index < content.length && isIdentifierPart(content[index]!))
				index++;
			tokens.push({
				kind: 'identifier',
				value: content.slice(start, index),
				start,
				end: index,
			});
			continue;
		}
		if (/\d/.test(char)) {
			const start = index++;
			while (index < content.length && /[\w.]/.test(content[index]!)) index++;
			tokens.push({
				kind: 'number',
				value: content.slice(start, index),
				start,
				end: index,
			});
			continue;
		}
		const punctuator = [
			'?.',
			'=>',
			'===',
			'!==',
			'==',
			'!=',
			'++',
			'--',
			'+=',
			'-=',
			'*=',
			'/=',
			'%=',
			'&&=',
			'||=',
			'??=',
			'&&',
			'||',
			'??',
			'...',
		].find((candidate) => content.startsWith(candidate, index));
		const value = punctuator ?? char;
		tokens.push({
			kind: 'punctuator',
			value,
			start: index,
			end: index + value.length,
		});
		index += value.length;
	}
	return { tokens, malformed };
}

function addDeclaration(analysis: Analysis, name: string): void {
	analysis.declarations.set(name, (analysis.declarations.get(name) ?? 0) + 1);
}

function addFact(
	analysis: Analysis,
	name: string,
	fact: BindingFact,
	tokenIndex: number,
): void {
	const facts = analysis.facts.get(name) ?? new Set<BindingFact>();
	facts.add(fact);
	analysis.facts.set(name, facts);
	const scope = declarationScope(analysis, tokenIndex);
	const scopedFacts =
		analysis.factScopes.get(name) ?? new Map<number, Set<BindingFact>>();
	const factsAtScope = scopedFacts.get(scope) ?? new Set<BindingFact>();
	factsAtScope.add(fact);
	scopedFacts.set(scope, factsAtScope);
	analysis.factScopes.set(name, scopedFacts);
}

function addScopedMarker(
	store: Map<string, Set<number>>,
	name: string,
	scope: number,
): void {
	const scopes = store.get(name) ?? new Set<number>();
	scopes.add(scope);
	store.set(name, scopes);
}

function hasScopedMarker(
	store: Map<string, Set<number>>,
	name: string,
	scope: number | null,
): boolean {
	return scope !== null && (store.get(name)?.has(scope) ?? false);
}

function visibleScopeAt(
	analysis: Analysis,
	name: string,
	callIndex: number,
): number {
	return (
		visibleDeclarationScope(analysis, name, callIndex) ??
		analysis.scopeAtToken[callIndex] ??
		0
	);
}

function hasVisibleMarker(
	analysis: Analysis,
	store: Map<string, Set<number>>,
	name: string,
	callIndex: number,
): boolean {
	let scope = visibleScopeAt(analysis, name, callIndex);
	while (scope >= 0) {
		if (store.get(name)?.has(scope)) return true;
		scope = analysis.scopeParents[scope] ?? -1;
	}
	return false;
}

function factsAtVisibleScope(
	analysis: Analysis,
	name: string,
	callIndex: number,
): Set<BindingFact> | undefined {
	const scope = visibleDeclarationScope(analysis, name, callIndex);
	return scope === null ? undefined : analysis.factScopes.get(name)?.get(scope);
}

function tokenPairs(tokens: Token[]): Map<number, number> {
	const cached = tokenPairsByList.get(tokens);
	if (cached) return cached;
	const pairs = new Map<number, number>();
	const stack: Array<{ value: string; index: number }> = [];
	const matching: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
	for (let index = 0; index < tokens.length; index++) {
		const value = tokens[index]?.value;
		if (value === '(' || value === '[' || value === '{') {
			stack.push({ value, index });
			continue;
		}
		const open = matching[value ?? ''];
		if (!open) continue;
		const top = stack.at(-1);
		if (!top || top.value !== open) continue;
		stack.pop();
		pairs.set(top.index, index);
		pairs.set(index, top.index);
	}
	tokenPairsByList.set(tokens, pairs);
	return pairs;
}

function pairedToken(tokens: Token[], index: number): number {
	return tokenPairs(tokens).get(index) ?? -1;
}

function buildScopes(tokens: Token[]): {
	scopeAtToken: number[];
	scopeParents: number[];
	scopeIsFunction: boolean[];
} {
	const scopeAtToken: number[] = [];
	const scopeParents = [-1];
	const scopeIsFunction = [true];
	const stack = [0];
	const braceCreatesScope: boolean[] = [];
	for (let index = 0; index < tokens.length; index++) {
		scopeAtToken[index] = stack.at(-1)!;
		if (tokens[index]?.value === '{') {
			const previous = tokens[index - 1];
			let cursor = index - 1;
			let importClause = false;
			while (cursor >= 0 && ![';', '{', '}'].includes(tokens[cursor]!.value)) {
				if (tokens[cursor]?.value === 'import') importClause = true;
				cursor--;
			}
			const createsScope =
				!importClause &&
				!DECLARATION_KEYWORDS.has(previous?.value ?? '') &&
				!['=', '(', '[', ',', ':', 'return'].includes(previous?.value ?? '');
			braceCreatesScope.push(createsScope);
			if (createsScope) {
				const child = scopeParents.length;
				scopeParents.push(stack.at(-1)!);
				const previousValue = previous?.value;
				let functionBody = previousValue === '=>';
				if (previousValue === ')') {
					const open = pairedToken(tokens, index - 1);
					for (let cursor = open - 1; cursor >= 0; cursor--) {
						const value = tokens[cursor]?.value;
						if (value === 'function') {
							functionBody = true;
							break;
						}
						if (value === ';' || value === '{' || value === '}') break;
					}
				}
				scopeIsFunction.push(functionBody);
				stack.push(child);
			}
		} else if (tokens[index]?.value === '}') {
			if (braceCreatesScope.pop() && stack.length > 1) stack.pop();
		}
	}
	return { scopeAtToken, scopeParents, scopeIsFunction };
}

function declarationScope(analysis: Analysis, tokenIndex: number): number {
	if (analysis.varDeclarationIndexes.has(tokenIndex)) {
		let scope = analysis.scopeAtToken[tokenIndex] ?? 0;
		while (scope > 0 && !analysis.scopeIsFunction[scope]) {
			scope = analysis.scopeParents[scope] ?? 0;
		}
		return scope;
	}
	const parameterScope = analysis.parameterScopes.get(tokenIndex);
	if (parameterScope !== undefined) return parameterScope;
	return analysis.scopeAtToken[tokenIndex] ?? 0;
}

function visibleDeclarationScope(
	analysis: Analysis,
	name: string,
	callIndex: number,
): number | null {
	const scopes = analysis.declarationScopes.get(name);
	if (!scopes) return null;
	let scope = analysis.scopeAtToken[callIndex] ?? 0;
	while (scope >= 0) {
		if (scopes.has(scope)) return scope;
		scope = analysis.scopeParents[scope] ?? -1;
	}
	return null;
}

function matchingToken(
	tokens: Token[],
	start: number,
	open: string,
	close: string,
): number {
	if (tokens[start]?.value !== open) return -1;
	const match = pairedToken(tokens, start);
	return tokens[match]?.value === close ? match : -1;
}

function moduleAtCall(
	tokens: Token[],
	start: number,
	callee: string,
): string | null {
	if (
		tokens[start]?.value !== callee ||
		tokens[start + 1]?.value !== '(' ||
		tokens[start + 2]?.kind !== 'string' ||
		tokens[start + 3]?.value !== ')'
	) {
		return null;
	}
	return tokens[start + 2]!.value;
}

function declarationNames(
	tokens: Token[],
	start: number,
	end: number,
): Array<{ name: string; index: number }> {
	const names: Array<{ name: string; index: number }> = [];
	if (tokens[start]?.value === '{') {
		for (let index = start + 1; index < end; index++) {
			const token = tokens[index];
			if (token?.kind !== 'identifier') continue;
			if (tokens[index + 1]?.value === ':') {
				const local = tokens[index + 2];
				if (local?.kind === 'identifier')
					names.push({ name: local.value, index: index + 2 });
				index += 2;
			} else if (tokens[index - 1]?.value !== ':') {
				names.push({ name: token.value, index });
			}
		}
	} else if (tokens[start]?.kind === 'identifier') {
		names.push({ name: tokens[start]!.value, index: start });
	}
	return names;
}

function nextFunctionOpen(tokens: Token[], start: number): number {
	for (let index = start + 1; index < tokens.length; index++) {
		const value = tokens[index]?.value;
		if (value === '(') return index;
		if (value === '{' || value === ';' || value === '=>') return -1;
	}
	return -1;
}

function nextFunctionBody(tokens: Token[], start: number): number {
	for (let index = start; index < tokens.length; index++) {
		const value = tokens[index]?.value;
		if (value === '{') return index;
		if (value === ';' || value === '=>') return -1;
	}
	return -1;
}

function collectDeclarations(analysis: Analysis): Set<number> {
	const { tokens } = analysis;
	const declarationTokenIndexes = new Set<number>();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token) continue;
		if (token.value === 'import') {
			if (tokens[index + 1]?.value === 'type') continue;
			if (tokens[index + 1]?.value === '{') {
				const close = matchingToken(tokens, index + 1, '{', '}');
				for (let cursor = index + 2; cursor > 0 && cursor < close; cursor++) {
					const imported = tokens[cursor];
					if (imported?.kind !== 'identifier') continue;
					if (imported.value === 'type') {
						while (cursor < close && tokens[cursor]?.value !== ',') cursor++;
						continue;
					}
					const local =
						tokens[cursor + 1]?.value === 'as' ? tokens[cursor + 2] : imported;
					if (local?.kind === 'identifier') {
						addDeclaration(analysis, local.value);
						declarationTokenIndexes.add(
							tokens[cursor + 1]?.value === 'as' ? cursor + 2 : cursor,
						);
					}
					while (cursor < close && tokens[cursor]?.value !== ',') cursor++;
				}
			} else if (
				tokens[index + 1]?.value === '*' &&
				tokens[index + 2]?.value === 'as'
			) {
				const local = tokens[index + 3];
				if (local?.kind === 'identifier') {
					addDeclaration(analysis, local.value);
					declarationTokenIndexes.add(index + 3);
				}
			} else if (tokens[index + 1]?.kind === 'identifier') {
				addDeclaration(analysis, tokens[index + 1]!.value);
				declarationTokenIndexes.add(index + 1);
			}
		}
		if (DECLARATION_KEYWORDS.has(token.value)) {
			const start = index + 1;
			const close =
				tokens[start]?.value === '{'
					? matchingToken(tokens, start, '{', '}')
					: start + 1;
			for (const item of declarationNames(tokens, start, close)) {
				addDeclaration(analysis, item.name);
				declarationTokenIndexes.add(item.index);
				if (token.value === 'var')
					analysis.varDeclarationIndexes.add(item.index);
			}
		}
		if (
			(token.value === 'function' || token.value === 'class') &&
			tokens[index + 1]?.kind === 'identifier'
		) {
			addDeclaration(analysis, tokens[index + 1]!.value);
			declarationTokenIndexes.add(index + 1);
		}
		if (token.value === 'function') {
			const open = nextFunctionOpen(tokens, index);
			if (open > index) {
				const close = matchingToken(tokens, open, '(', ')');
				const body = close >= 0 ? nextFunctionBody(tokens, close + 1) : -1;
				const bodyScope =
					body >= 0
						? (analysis.scopeAtToken[body + 1] ?? analysis.scopeAtToken[body]!)
						: undefined;
				for (let cursor = open + 1; cursor < close; cursor++) {
					if (
						tokens[cursor]?.kind === 'identifier' &&
						tokens[cursor - 1]?.value !== '.'
					) {
						addDeclaration(analysis, tokens[cursor]!.value);
						declarationTokenIndexes.add(cursor);
						if (bodyScope !== undefined)
							analysis.parameterScopes.set(cursor, bodyScope);
						while (cursor < close && tokens[cursor]?.value !== ',') cursor++;
					}
				}
			}
		}
		if (
			token.value === 'catch' &&
			tokens[index + 1]?.value === '(' &&
			tokens[index + 2]?.kind === 'identifier'
		) {
			addDeclaration(analysis, tokens[index + 2]!.value);
			declarationTokenIndexes.add(index + 2);
		}
		if (token.kind === 'identifier' && tokens[index + 1]?.value === '=>') {
			addDeclaration(analysis, token.value);
			declarationTokenIndexes.add(index);
			const body = nextFunctionBody(tokens, index + 2);
			if (body >= 0)
				analysis.parameterScopes.set(
					index,
					analysis.scopeAtToken[body + 1] ?? analysis.scopeAtToken[body]!,
				);
		}
		if (token.value === '=>') {
			let close = index - 1;
			while (close >= 0 && tokens[close]?.value !== ')') close--;
			let cursor = close - 1;
			let depth = 1;
			while (cursor >= 0 && depth > 0) {
				if (tokens[cursor]?.value === ')') depth++;
				else if (tokens[cursor]?.value === '(') depth--;
				cursor--;
			}
			const body = nextFunctionBody(tokens, index + 1);
			const bodyScope =
				body >= 0
					? (analysis.scopeAtToken[body + 1] ?? analysis.scopeAtToken[body]!)
					: undefined;
			for (cursor += 2; cursor < close; cursor++) {
				if (tokens[cursor]?.kind === 'identifier') {
					addDeclaration(analysis, tokens[cursor]!.value);
					declarationTokenIndexes.add(cursor);
					if (bodyScope !== undefined)
						analysis.parameterScopes.set(cursor, bodyScope);
					while (cursor < close && tokens[cursor]?.value !== ',') cursor++;
				}
			}
		}
	}
	return declarationTokenIndexes;
}

function collectFacts(analysis: Analysis): void {
	const { tokens } = analysis;
	for (let index = 0; index < tokens.length; index++) {
		if (
			tokens[index]?.value === 'import' &&
			tokens[index + 1]?.value !== 'type'
		) {
			if (tokens[index + 1]?.value === '{') {
				const close = matchingToken(tokens, index + 1, '{', '}');
				const module =
					tokens[close + 1]?.value === 'from' ? tokens[close + 2]?.value : null;
				for (let cursor = index + 2; cursor > 0 && cursor < close; cursor++) {
					const imported = tokens[cursor];
					if (imported?.kind !== 'identifier') continue;
					if (imported.value === 'type') {
						while (cursor < close && tokens[cursor]?.value !== ',') cursor++;
						continue;
					}
					const local =
						tokens[cursor + 1]?.value === 'as' ? tokens[cursor + 2] : imported;
					if (local?.kind === 'identifier') {
						if (
							CHILD_PROCESS_MODULES.has(module ?? '') &&
							imported.value === 'exec'
						) {
							addFact(
								analysis,
								local.value,
								'child-direct',
								tokens[cursor + 1]?.value === 'as' ? cursor + 2 : cursor,
							);
						} else if (module)
							addFact(
								analysis,
								local.value,
								'other-import',
								tokens[cursor + 1]?.value === 'as' ? cursor + 2 : cursor,
							);
					}
					while (cursor < close && tokens[cursor]?.value !== ',') cursor++;
				}
			} else if (
				tokens[index + 1]?.value === '*' &&
				tokens[index + 2]?.value === 'as'
			) {
				const local = tokens[index + 3];
				const module =
					tokens[index + 4]?.value === 'from' ? tokens[index + 5]?.value : null;
				if (local?.kind === 'identifier' && module) {
					addFact(
						analysis,
						local.value,
						CHILD_PROCESS_MODULES.has(module)
							? 'child-namespace'
							: 'other-import',
						index + 3,
					);
					analysis.requireDerived.add(local.value);
					addScopedMarker(
						analysis.requireDerivedScopes,
						local.value,
						declarationScope(analysis, index + 3),
					);
				}
			} else if (
				tokens[index + 1]?.kind === 'identifier' &&
				tokens[index + 2]?.value === '=' &&
				tokens[index + 3]?.value === 'require'
			) {
				const module = moduleAtCall(tokens, index + 3, 'require');
				if (module)
					addFact(
						analysis,
						tokens[index + 1]!.value,
						CHILD_PROCESS_MODULES.has(module)
							? 'child-namespace'
							: 'other-import',
						index + 1,
					);
			} else if (
				tokens[index + 1]?.kind === 'identifier' &&
				tokens[index + 2]?.value === 'from' &&
				tokens[index + 3]?.kind === 'string'
			) {
				const local = tokens[index + 1]!;
				addFact(
					analysis,
					local.value,
					CHILD_PROCESS_MODULES.has(tokens[index + 3]!.value)
						? 'child-namespace'
						: 'other-import',
					index + 1,
				);
			}
		}
		if (!DECLARATION_KEYWORDS.has(tokens[index]?.value ?? '')) continue;
		const start = index + 1;
		if (tokens[start]?.value === '{') {
			const close = matchingToken(tokens, start, '{', '}');
			const rhs = close + 1;
			const module =
				tokens[rhs]?.value === '='
					? moduleAtCall(tokens, rhs + 1, 'require')
					: null;
			const namespace =
				tokens[rhs]?.value === '=' && tokens[rhs + 1]?.kind === 'identifier'
					? tokens[rhs + 1]!.value
					: null;
			for (let cursor = start + 1; cursor < close; cursor++) {
				const imported = tokens[cursor];
				if (imported?.kind !== 'identifier') continue;
				const local =
					tokens[cursor + 1]?.value === ':' ? tokens[cursor + 2] : imported;
				if (local?.kind === 'identifier' && imported.value === 'exec') {
					if (module && CHILD_PROCESS_MODULES.has(module)) {
						addFact(
							analysis,
							local.value,
							'child-direct',
							tokens[cursor + 1]?.value === ':' ? cursor + 2 : cursor,
						);
						analysis.requireDerived.add(local.value);
						addScopedMarker(
							analysis.requireDerivedScopes,
							local.value,
							declarationScope(
								analysis,
								tokens[cursor + 1]?.value === ':' ? cursor + 2 : cursor,
							),
						);
					} else if (
						namespace &&
						hasUniqueFact(analysis, namespace, rhs + 1, 'child-namespace')
					) {
						addFact(
							analysis,
							local.value,
							'child-direct',
							tokens[cursor + 1]?.value === ':' ? cursor + 2 : cursor,
						);
						if (
							hasScopedMarker(
								analysis.requireDerivedScopes,
								namespace,
								visibleDeclarationScope(analysis, namespace, rhs + 1),
							)
						) {
							analysis.requireDerived.add(local.value);
							addScopedMarker(
								analysis.requireDerivedScopes,
								local.value,
								declarationScope(
									analysis,
									tokens[cursor + 1]?.value === ':' ? cursor + 2 : cursor,
								),
							);
						}
					}
				}
				while (cursor < close && tokens[cursor]?.value !== ',') cursor++;
			}
			continue;
		}
		const local = tokens[start];
		if (local?.kind !== 'identifier' || tokens[start + 1]?.value !== '=')
			continue;
		const rhs = start + 2;
		const module = moduleAtCall(tokens, rhs, 'require');
		if (module) {
			addFact(
				analysis,
				local.value,
				CHILD_PROCESS_MODULES.has(module) ? 'child-namespace' : 'other-import',
				start,
			);
			analysis.requireDerived.add(local.value);
			addScopedMarker(
				analysis.requireDerivedScopes,
				local.value,
				declarationScope(analysis, start),
			);
		} else if (
			tokens[rhs]?.value === 'import' ||
			(tokens[rhs]?.value === 'await' && tokens[rhs + 1]?.value === 'import')
		) {
			const importIndex = tokens[rhs]?.value === 'await' ? rhs + 1 : rhs;
			const importedModule = moduleAtCall(tokens, importIndex, 'import');
			if (importedModule) {
				addFact(
					analysis,
					local.value,
					CHILD_PROCESS_MODULES.has(importedModule)
						? 'child-namespace'
						: 'other-import',
					start,
				);
			}
		} else if (
			tokens[rhs]?.kind === 'regex' ||
			(tokens[rhs]?.value === 'new' && tokens[rhs + 1]?.value === 'RegExp')
		) {
			addFact(analysis, local.value, 'regex', start);
		} else if (
			tokens[rhs]?.kind === 'identifier' &&
			(tokens[rhs + 1]?.value === '.' || tokens[rhs + 1]?.value === '?.') &&
			tokens[rhs + 2]?.value === 'exec' &&
			hasUniqueFact(analysis, tokens[rhs]!.value, rhs, 'child-namespace')
		) {
			addFact(analysis, local.value, 'child-direct', start);
			if (
				hasScopedMarker(
					analysis.requireDerivedScopes,
					tokens[rhs]!.value,
					visibleDeclarationScope(analysis, tokens[rhs]!.value, rhs),
				)
			) {
				analysis.requireDerived.add(local.value);
				addScopedMarker(
					analysis.requireDerivedScopes,
					local.value,
					declarationScope(analysis, start),
				);
			}
		}
	}
}

function hasUniqueFact(
	analysis: Analysis,
	name: string,
	callIndex: number,
	fact: BindingFact,
): boolean {
	const scope = visibleDeclarationScope(analysis, name, callIndex);
	const facts =
		scope === null ? undefined : analysis.factScopes.get(name)?.get(scope);
	return (
		scope !== null &&
		analysis.declarationScopes.get(name)?.get(scope) === 1 &&
		!hasScopedMarker(analysis.reassignedScopes, name, scope) &&
		facts?.size === 1 &&
		facts.has(fact)
	);
}

function buildAnalysis(context: SastContext): Analysis {
	const lineStarts = [0];
	for (let index = 0; index < context.content.length; index++) {
		if (context.content[index] === '\n') lineStarts.push(index + 1);
	}
	if (context.content.length > MAX_ANALYSIS_BYTES) {
		return {
			tokens: [],
			lineStarts,
			scopeAtToken: [],
			scopeParents: [-1],
			scopeIsFunction: [true],
			declarations: new Map(),
			declarationScopes: new Map(),
			facts: new Map(),
			factScopes: new Map(),
			reassigned: new Set(),
			reassignedScopes: new Map(),
			mutatedMembers: new Set(),
			mutatedMemberScopes: new Map(),
			requireDerived: new Set(),
			requireDerivedScopes: new Map(),
			parameterScopes: new Map(),
			varDeclarationIndexes: new Set(),
			oversizedOrMalformed: true,
		};
	}
	const tokenized = tokenize(context.content);
	const scopes = buildScopes(tokenized.tokens);
	const analysis: Analysis = {
		tokens: tokenized.tokens,
		lineStarts,
		scopeAtToken: scopes.scopeAtToken,
		scopeParents: scopes.scopeParents,
		scopeIsFunction: scopes.scopeIsFunction,
		declarations: new Map(),
		declarationScopes: new Map(),
		facts: new Map(),
		factScopes: new Map(),
		reassigned: new Set(),
		reassignedScopes: new Map(),
		mutatedMembers: new Set(),
		mutatedMemberScopes: new Map(),
		requireDerived: new Set(),
		requireDerivedScopes: new Map(),
		parameterScopes: new Map(),
		varDeclarationIndexes: new Set(),
		oversizedOrMalformed: tokenized.malformed,
	};
	const declarationIndexes = collectDeclarations(analysis);
	for (const index of declarationIndexes) {
		const name = analysis.tokens[index]?.value;
		if (!name) continue;
		const scope = declarationScope(analysis, index);
		const counts =
			analysis.declarationScopes.get(name) ?? new Map<number, number>();
		counts.set(scope, (counts.get(scope) ?? 0) + 1);
		analysis.declarationScopes.set(name, counts);
	}
	collectFacts(analysis);
	for (let index = 0; index < analysis.tokens.length; index++) {
		const token = analysis.tokens[index];
		if (token?.kind !== 'identifier' || declarationIndexes.has(index)) continue;
		const previous = analysis.tokens[index - 1]?.value;
		if (previous === '.' || previous === '?.') {
			if (
				token.value === 'exec' &&
				(ASSIGNMENTS.has(analysis.tokens[index + 1]?.value ?? '') ||
					analysis.tokens[index - 3]?.value === 'delete')
			) {
				const receiver = analysis.tokens[index - 2];
				if (receiver?.kind === 'identifier') {
					analysis.mutatedMembers.add(receiver.value);
					addScopedMarker(
						analysis.mutatedMemberScopes,
						receiver.value,
						visibleDeclarationScope(analysis, receiver.value, index - 2) ??
							analysis.scopeAtToken[index - 2] ??
							0,
					);
				}
			}
			continue;
		}
		if (
			ASSIGNMENTS.has(analysis.tokens[index + 1]?.value ?? '') ||
			previous === '++' ||
			previous === '--' ||
			analysis.tokens[index + 1]?.value === '++' ||
			analysis.tokens[index + 1]?.value === '--'
		) {
			analysis.reassigned.add(token.value);
			addScopedMarker(
				analysis.reassignedScopes,
				token.value,
				visibleDeclarationScope(analysis, token.value, index) ??
					analysis.scopeAtToken[index] ??
					0,
			);
		}
	}
	return analysis;
}

function getAnalysis(context: SastContext): Analysis {
	let analysis = analysisByContext.get(context);
	if (!analysis) {
		analysis = buildAnalysis(context);
		analysisByContext.set(context, analysis);
	}
	return analysis;
}

function tokenIndexAtOffset(tokens: Token[], offset: number): number {
	let low = 0;
	let high = tokens.length - 1;
	while (low <= high) {
		const mid = (low + high) >>> 1;
		const token = tokens[mid]!;
		if (offset < token.start) high = mid - 1;
		else if (offset >= token.end) low = mid + 1;
		else return mid;
	}
	return -1;
}

function directRequireBefore(tokens: Token[], dotIndex: number): boolean {
	if (tokens[dotIndex - 1]?.value !== ')') return false;
	for (let start = dotIndex - 2; start >= 0 && start >= dotIndex - 5; start--) {
		const module = moduleAtCall(tokens, start, 'require');
		if (module && start + 4 === dotIndex)
			return CHILD_PROCESS_MODULES.has(module);
	}
	return false;
}

function isTransparentWrapperCall(tokens: Token[], openIndex: number): boolean {
	return tokens[openIndex - 1]?.kind === 'identifier'
		? tokens[openIndex - 1]!.value === 'promisify'
		: false;
}

function shouldSkipTrailingClose(
	tokens: Token[],
	nameIndex: number,
	closeIndex: number,
): boolean {
	const openIndex = pairedToken(tokens, closeIndex);
	if (openIndex < 0 || openIndex > nameIndex) return false;
	const beforeOpen = tokens[openIndex - 1];
	if (
		!beforeOpen ||
		(beforeOpen.kind !== 'identifier' &&
			beforeOpen.kind !== 'string' &&
			beforeOpen.kind !== 'regex' &&
			beforeOpen.value !== ')' &&
			beforeOpen.value !== ']')
	) {
		return true;
	}
	return isTransparentWrapperCall(tokens, openIndex);
}

function parseCallee(tokens: Token[], nameIndex: number): Callee | null {
	const nameToken = tokens[nameIndex];
	if (!nameToken) return null;
	let cursor = nameIndex + 1;
	if (nameToken.kind === 'string') {
		if (
			tokens[nameIndex - 1]?.value !== '[' ||
			tokens[nameIndex + 1]?.value !== ']'
		)
			return null;
		cursor = nameIndex + 2;
	}
	// Parenthesized and indirect calls such as `(eval)(input)` and
	// `(0, eval)(input)` retain eval semantics. Ordinary argument positions such
	// as `foo(a, exec)(input)` must not attribute the returned function back to
	// the identifier argument itself.
	while (
		tokens[cursor]?.value === ')' &&
		shouldSkipTrailingClose(tokens, nameIndex, cursor)
	) {
		cursor++;
	}
	if (tokens[cursor]?.value === '?.') cursor++;
	if (tokens[cursor]?.value !== '(') return null;
	const callee: Callee = { name: nameToken.value, openParen: cursor };
	const accessIndex =
		nameToken.kind === 'string' ? nameIndex - 1 : nameIndex - 1;
	if (nameToken.kind === 'string') {
		const receiver = tokens[nameIndex - 2];
		if (receiver?.kind === 'identifier') {
			callee.receiver = receiver.value;
			callee.receiverKind = 'identifier';
		} else if (receiver?.kind === 'regex') callee.receiverKind = 'regex';
		return callee;
	}
	if (
		tokens[accessIndex]?.value === '.' ||
		tokens[accessIndex]?.value === '?.'
	) {
		const receiver = tokens[accessIndex - 1];
		if (receiver?.kind === 'identifier') {
			callee.receiver = receiver.value;
			callee.receiverKind = 'identifier';
		} else if (receiver?.kind === 'regex') callee.receiverKind = 'regex';
		else if (directRequireBefore(tokens, accessIndex))
			callee.receiverKind = 'direct-child-require';
	}
	return callee;
}

function bindingDisposition(
	analysis: Analysis,
	name: string,
	confirmedFact: BindingFact,
	callIndex: number,
): JavascriptCallDisposition {
	const visibleScope = visibleDeclarationScope(analysis, name, callIndex);
	if (visibleScope === null) return 'ambiguous';
	const declarationCount =
		analysis.declarationScopes.get(name)?.get(visibleScope) ?? 0;
	const facts = analysis.factScopes.get(name)?.get(visibleScope);
	if (
		hasScopedMarker(analysis.requireDerivedScopes, name, visibleScope) &&
		globalDisposition(analysis, 'require', callIndex) !== 'confirmed'
	) {
		return 'ambiguous';
	}
	if (
		declarationCount !== 1 ||
		hasScopedMarker(analysis.reassignedScopes, name, visibleScope) ||
		!facts ||
		facts.size !== 1
	) {
		return 'ambiguous';
	}
	if (facts.has(confirmedFact)) return 'confirmed';
	if (facts.has('other-import') || facts.has('regex')) return 'safe';
	return 'ambiguous';
}

function globalDisposition(
	analysis: Analysis,
	name: string,
	callIndex: number,
): JavascriptCallDisposition {
	const visibleScope = visibleDeclarationScope(analysis, name, callIndex);
	if (
		visibleScope === null &&
		!hasVisibleMarker(analysis, analysis.reassignedScopes, name, callIndex)
	) {
		return 'confirmed';
	}
	const facts =
		visibleScope === null
			? undefined
			: analysis.factScopes.get(name)?.get(visibleScope);
	if (
		facts?.size === 1 &&
		facts.has('other-import') &&
		visibleScope !== null &&
		analysis.declarationScopes.get(name)?.get(visibleScope) === 1 &&
		!hasScopedMarker(analysis.reassignedScopes, name, visibleScope)
	) {
		return 'safe';
	}
	return 'ambiguous';
}

function firstArgument(tokens: Token[], openParen: number): Token | undefined {
	return tokens[openParen + 1];
}

function oversizedCandidate(
	match: SastMatch,
	family: JavascriptCallFamily,
): JavascriptCallDisposition {
	const expected =
		family === 'exec'
			? ['exec']
			: family === 'eval'
				? ['eval']
				: family === 'function-constructor'
					? ['Function']
					: family === 'timer-string'
						? ['setTimeout', 'setInterval']
						: family === 'document-write'
							? ['write']
							: ['addEventListener'];
	return expected.includes(match.text) ? 'ambiguous' : 'none';
}

function classifyJavascriptCallUncached(
	match: SastMatch,
	context: SastContext,
	family: JavascriptCallFamily,
): JavascriptCallDisposition {
	const analysis = getAnalysis(context);
	if (analysis.oversizedOrMalformed) return oversizedCandidate(match, family);
	const offset = (analysis.lineStarts[match.line - 1] ?? 0) + match.column - 1;
	const tokenIndex = tokenIndexAtOffset(analysis.tokens, offset);
	if (tokenIndex < 0) return 'none';
	const callee = parseCallee(analysis.tokens, tokenIndex);
	if (!callee) return 'none';
	const argument = firstArgument(analysis.tokens, callee.openParen);

	switch (family) {
		case 'exec':
			if (!argument || argument.value === ')') return 'none';
			if (callee.receiverKind === 'regex') return 'safe';
			if (callee.receiverKind === 'direct-child-require') {
				if (callee.name !== 'exec') return 'none';
				return globalDisposition(analysis, 'require', tokenIndex) ===
					'confirmed'
					? 'confirmed'
					: 'ambiguous';
			}
			if (callee.receiver) {
				if (callee.name !== 'exec') return 'none';
				if (
					hasScopedMarker(
						analysis.mutatedMemberScopes,
						callee.receiver,
						visibleDeclarationScope(analysis, callee.receiver, tokenIndex),
					)
				) {
					return 'ambiguous';
				}
				return bindingDisposition(
					analysis,
					callee.receiver,
					'child-namespace',
					tokenIndex,
				);
			}
			if (
				callee.name === 'exec' ||
				factsAtVisibleScope(analysis, callee.name, tokenIndex)?.has(
					'child-direct',
				)
			) {
				return bindingDisposition(
					analysis,
					callee.name,
					'child-direct',
					tokenIndex,
				);
			}
			return 'none';
		case 'eval':
			if (callee.name !== 'eval') return 'none';
			if (callee.receiver) {
				if (['globalThis', 'window', 'self'].includes(callee.receiver)) {
					return globalDisposition(analysis, callee.receiver, tokenIndex);
				}
				return bindingDisposition(
					analysis,
					callee.receiver,
					'child-namespace',
					tokenIndex,
				) === 'safe'
					? 'safe'
					: 'ambiguous';
			}
			return globalDisposition(analysis, 'eval', tokenIndex);
		case 'function-constructor':
			if (
				callee.name !== 'Function' ||
				analysis.tokens[tokenIndex - 1]?.value !== 'new'
			)
				return 'none';
			return globalDisposition(analysis, 'Function', tokenIndex);
		case 'timer-string':
			if (
				!['setTimeout', 'setInterval'].includes(callee.name) ||
				!argument ||
				!['string', 'template'].includes(argument.kind)
			)
				return 'none';
			if (callee.receiver) {
				if (['globalThis', 'window', 'self'].includes(callee.receiver))
					return globalDisposition(analysis, callee.receiver, tokenIndex);
				return bindingDisposition(
					analysis,
					callee.receiver,
					'child-namespace',
					tokenIndex,
				) === 'safe'
					? 'safe'
					: 'ambiguous';
			}
			return globalDisposition(analysis, callee.name, tokenIndex);
		case 'document-write':
			if (callee.name !== 'write' || callee.receiver !== 'document')
				return 'none';
			return globalDisposition(analysis, 'document', tokenIndex) === 'confirmed'
				? 'confirmed'
				: 'ambiguous';
		case 'postmessage':
			if (
				callee.name !== 'addEventListener' ||
				argument?.kind !== 'string' ||
				argument.value !== 'message'
			)
				return 'none';
			if (callee.receiver) {
				if (['globalThis', 'window', 'self'].includes(callee.receiver))
					return globalDisposition(analysis, callee.receiver, tokenIndex);
				return bindingDisposition(
					analysis,
					callee.receiver,
					'child-namespace',
					tokenIndex,
				) === 'safe'
					? 'safe'
					: 'ambiguous';
			}
			return globalDisposition(analysis, 'addEventListener', tokenIndex);
	}
}

export function classifyJavascriptCall(
	match: SastMatch,
	context: SastContext,
	family: JavascriptCallFamily,
): JavascriptCallDisposition {
	const key = `${family}:${match.line}:${match.column}:${match.text}`;
	const cache = dispositionByContext.get(context) ?? new Map();
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const disposition = classifyJavascriptCallUncached(match, context, family);
	cache.set(key, disposition);
	dispositionByContext.set(context, cache);
	return disposition;
}
