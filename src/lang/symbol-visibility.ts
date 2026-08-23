export const SYMBOL_VISIBILITY_VALUES = [
	'public',
	'internal',
	'protected',
	'private',
	'package',
	'unknown',
] as const;
export type SymbolVisibility = (typeof SYMBOL_VISIBILITY_VALUES)[number];

export const SYMBOL_EXPORTED_REASON_VALUES = [
	'explicit_export',
	'top_level_public',
	'naming_convention',
	'modifier',
	'header_declaration',
	'namespace_public',
	'module_public',
	'unknown',
] as const;
export type SymbolExportedReason =
	(typeof SYMBOL_EXPORTED_REASON_VALUES)[number];

export const SYMBOL_API_SURFACE_KIND_VALUES = [
	'export',
	'public',
	'entrypoint',
	'test',
	'private',
	'unknown',
] as const;
export type SymbolApiSurfaceKind =
	(typeof SYMBOL_API_SURFACE_KIND_VALUES)[number];

export interface SymbolVisibilityInfo {
	exported: boolean;
	visibility: SymbolVisibility;
	exportedReason: SymbolExportedReason;
	apiSurfaceKind: SymbolApiSurfaceKind;
}

export interface SymbolVisibilityNode {
	type: string;
	text: string;
	parent: SymbolVisibilityNode | null;
	children: Array<SymbolVisibilityNode | null>;
}

export interface CommonJsExportInfo {
	localName: string;
	exportedName: string;
	exportedReason: 'explicit_export';
	sourceIndex: number;
}

export interface SymbolVisibilityContext {
	grammarId: string;
	localName: string;
	kind:
		| 'function'
		| 'class'
		| 'const'
		| 'type'
		| 'interface'
		| 'enum'
		| 'method';
	defNode: SymbolVisibilityNode;
	rootNode: SymbolVisibilityNode;
	isTopLevel: boolean;
	explicitExported: boolean;
	commonJsExport?: CommonJsExportInfo;
	pythonAllNames?: Set<string> | null;
	/** For Python methods: true if the enclosing class is exported (in __all__ or public naming convention) */
	pythonParentClassExported?: boolean;
	/**
	 * Tree-sitter node type of the nearest enclosing type container
	 * (`class_declaration`, `interface_declaration`, `enum_declaration`,
	 * `record_declaration`, `struct_declaration`, `object_declaration`), or
	 * `undefined` when the declaration has no enclosing type container.
	 *
	 * Only populated for the JVM/.NET grammars (java/kotlin/csharp), where the
	 * *kind* of container decides the implicit visibility of a member that
	 * carries no explicit modifier (an interface member is implicitly public in
	 * both Java and C#, a C# class member is implicitly private, a Java class
	 * member is implicitly package-private).
	 */
	parentContainerType?: string;
}

const PUBLIC_INFO: SymbolVisibilityInfo = {
	exported: true,
	visibility: 'public',
	exportedReason: 'top_level_public',
	apiSurfaceKind: 'public',
};

const PRIVATE_INFO: SymbolVisibilityInfo = {
	exported: false,
	visibility: 'private',
	exportedReason: 'unknown',
	apiSurfaceKind: 'private',
};

/**
 * Grammars whose members' implicit visibility depends on the *kind* of the
 * enclosing type container rather than on a naming convention.
 */
const CONTAINER_SCOPED_GRAMMARS = new Set(['java', 'kotlin', 'csharp']);

/** Node types that declare a type (as opposed to a member of a type). */
const TYPE_DECLARATION_NODE_TYPES = new Set([
	'class_declaration',
	'interface_declaration',
	'enum_declaration',
	'record_declaration',
	'struct_declaration',
	'object_declaration',
]);

/**
 * Implicit visibility of a declaration that carries no explicit modifier,
 * given its language and the kind of type container it lives in.
 *
 * | container            | java    | kotlin | csharp   |
 * |----------------------|---------|--------|----------|
 * | interface            | public  | public | public   |
 * | class / record       | package | public | private  |
 * | enum                 | package | public | private  |
 * | struct               | —       | —      | private  |
 * | (none)               | package | public | internal |
 *
 * Java and C# interface members are *implicitly public* — that row is the
 * reason this takes the container node type and not a boolean.
 */
function containerScopedDefaultVisibility(
	grammarId: string,
	containerType: string | undefined,
): SymbolVisibility {
	if (containerType === 'interface_declaration') return 'public';
	switch (grammarId) {
		case 'kotlin':
			return 'public';
		case 'java':
			return 'package';
		default:
			// csharp: top-level types default to `internal`, members of a type
			// default to `private`.
			return containerType === undefined ? 'internal' : 'private';
	}
}

export function collectCommonJsExports(
	source: string,
): Map<string, CommonJsExportInfo> {
	const sanitized = maskCommentsAndStrings(source);
	const exportsByLocal = new Map<string, CommonJsExportInfo>();

	const add = (
		localName: string,
		exportedName: string,
		sourceIndex: number,
	) => {
		if (!isIdentifier(localName) || !isIdentifier(exportedName)) return;
		const existing = exportsByLocal.get(localName);
		if (existing && existing.sourceIndex <= sourceIndex) return;
		exportsByLocal.set(localName, {
			localName,
			exportedName,
			exportedReason: 'explicit_export',
			sourceIndex,
		});
	};

	for (const match of sanitized.matchAll(
		/\bmodule\s*\.\s*exports\s*=\s*([A-Za-z_$][\w$]*)\b/g,
	)) {
		add(match[1], match[1], match.index ?? 0);
	}

	// Limitation: [^}]* cannot span nested braces — exports after the first nested
	// `}` in `module.exports = { config: { port: 3000 }, handler }` are silently
	// dropped. Use dot-assignment (`exports.handler = handler`) for such patterns.
	// A brace-balanced parser would fix this but adds complexity for an uncommon
	// pattern; documented here as a known conservative limitation.
	for (const match of sanitized.matchAll(
		/\bmodule\s*\.\s*exports\s*=\s*\{([^}]*)\}/g,
	)) {
		const body = match[1];
		const baseIndex = match.index ?? 0;
		for (const part of body.split(',')) {
			const entry = part.trim();
			if (!entry) continue;
			const alias = entry.match(
				/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/,
			);
			if (alias) {
				add(alias[2], alias[1], baseIndex + match[0].indexOf(part));
				continue;
			}
			const shorthand = entry.match(/^([A-Za-z_$][\w$]*)$/);
			if (shorthand) {
				add(shorthand[1], shorthand[1], baseIndex + match[0].indexOf(part));
			}
		}
	}

	for (const match of sanitized.matchAll(
		/\b(?:module\s*\.\s*exports|exports)\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g,
	)) {
		add(match[2], match[1], match.index ?? 0);
	}

	return exportsByLocal;
}

export function collectPythonAllNames(source: string): Set<string> | null {
	const match = source.match(/__all__\s*=\s*([[({])([\s\S]*?)[\])}]/);
	if (!match) return null;
	const body = match[2].trim();
	if (!body) return new Set();
	const names = new Set<string>();
	for (const part of body.split(',')) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const stringMatch = trimmed.match(/^['"]([^'"]+)['"]$/);
		if (!stringMatch) return null;
		names.add(stringMatch[1]);
	}
	return names;
}

export function getSymbolVisibilityInfo(
	ctx: SymbolVisibilityContext,
): SymbolVisibilityInfo {
	if (hasPrivateContainer(ctx.defNode, ctx.grammarId)) {
		return { ...PRIVATE_INFO };
	}

	if (ctx.explicitExported || ctx.commonJsExport) {
		return {
			exported: true,
			visibility: 'public',
			exportedReason: 'explicit_export',
			apiSurfaceKind: 'export',
		};
	}

	const ownVisibility = visibilityFromText(ctx.grammarId, ctx.defNode.text);
	if (ctx.kind === 'method') {
		if (ctx.grammarId === 'go') {
			return isUppercasePublic(ctx.localName)
				? {
						...PUBLIC_INFO,
						exportedReason: 'naming_convention',
					}
				: { ...PRIVATE_INFO };
		}
		if (ctx.grammarId === 'python' && ctx.pythonParentClassExported) {
			// Python methods are exported if their parent class is exported
			// (unless the method starts with _ or is __init__)
			const isPrivate = ctx.localName.startsWith('_');
			const isInit = ctx.localName === '__init__';
			if (isPrivate || isInit) {
				return { ...PRIVATE_INFO };
			}
			return {
				exported: true,
				visibility: 'public',
				exportedReason: 'modifier',
				apiSurfaceKind: 'public',
			};
		}
		if (
			ownVisibility === 'unknown' &&
			CONTAINER_SCOPED_GRAMMARS.has(ctx.grammarId)
		) {
			// No explicit modifier: the language's implicit visibility depends on
			// the kind of container. Members are never file-level exports.
			const implicit = containerScopedDefaultVisibility(
				ctx.grammarId,
				ctx.parentContainerType,
			);
			return {
				exported: false,
				visibility: implicit,
				exportedReason: 'module_public',
				apiSurfaceKind: implicit === 'private' ? 'private' : 'public',
			};
		}
		return {
			exported: false,
			visibility: ownVisibility,
			exportedReason: ownVisibility === 'unknown' ? 'unknown' : 'modifier',
			apiSurfaceKind: ownVisibility === 'private' ? 'private' : 'public',
		};
	}
	if (!ctx.isTopLevel && isMemberLikeNode(ctx.defNode)) {
		return {
			exported: false,
			visibility: ownVisibility === 'unknown' ? 'public' : ownVisibility,
			exportedReason:
				ownVisibility === 'unknown' ? 'module_public' : 'modifier',
			apiSurfaceKind: ownVisibility === 'private' ? 'private' : 'public',
		};
	}

	// A nested *type* declaration (`public static class Builder`, a member
	// interface, a member enum/record) is not implicitly private — it takes
	// modifier-derived visibility, defaulting by container kind. It is still
	// not a file-level module export, so `exported` stays false.
	if (
		!ctx.isTopLevel &&
		CONTAINER_SCOPED_GRAMMARS.has(ctx.grammarId) &&
		TYPE_DECLARATION_NODE_TYPES.has(ctx.defNode.type)
	) {
		const nestedVisibility =
			ownVisibility === 'unknown'
				? containerScopedDefaultVisibility(
						ctx.grammarId,
						ctx.parentContainerType,
					)
				: ownVisibility;
		return {
			exported: false,
			visibility: nestedVisibility,
			exportedReason:
				ownVisibility === 'unknown' ? 'module_public' : 'modifier',
			apiSurfaceKind: nestedVisibility === 'private' ? 'private' : 'public',
		};
	}

	if (!ctx.isTopLevel) return { ...PRIVATE_INFO };

	switch (ctx.grammarId) {
		case 'typescript':
		case 'javascript':
		case 'tsx':
			return { ...PRIVATE_INFO };
		case 'python':
			return pythonVisibility(ctx);
		case 'rust':
			return rustVisibility(ctx);
		case 'go':
			return isUppercasePublic(ctx.localName)
				? {
						...PUBLIC_INFO,
						exportedReason: 'naming_convention',
					}
				: { ...PRIVATE_INFO };
		case 'java':
		case 'kotlin':
		case 'csharp':
		case 'swift':
		case 'php':
			return modifierLanguageVisibility(ctx);
		case 'cpp':
			return cppVisibility(ctx);
		case 'dart':
			return ctx.localName.startsWith('_')
				? { ...PRIVATE_INFO }
				: { ...PUBLIC_INFO, exportedReason: 'naming_convention' };
		case 'ruby':
			return ctx.localName.startsWith('_')
				? { ...PRIVATE_INFO }
				: { ...PUBLIC_INFO, exportedReason: 'module_public' };
		default:
			return {
				exported: false,
				visibility: 'unknown',
				exportedReason: 'unknown',
				apiSurfaceKind: 'unknown',
			};
	}
}

function pythonVisibility(ctx: SymbolVisibilityContext): SymbolVisibilityInfo {
	if (ctx.pythonAllNames) {
		return ctx.pythonAllNames.has(ctx.localName)
			? {
					exported: true,
					visibility: 'public',
					exportedReason: 'module_public',
					apiSurfaceKind: 'public',
				}
			: { ...PRIVATE_INFO };
	}
	return ctx.localName.startsWith('_')
		? { ...PRIVATE_INFO }
		: { ...PUBLIC_INFO, exportedReason: 'naming_convention' };
}

function rustVisibility(ctx: SymbolVisibilityContext): SymbolVisibilityInfo {
	const text = ctx.defNode.text.trimStart();
	if (!/^pub\b|^pub\s*\(/.test(text)) return { ...PRIVATE_INFO };
	const internal = /^pub\s*\(\s*(crate|super|in\b)/.test(text);
	return {
		exported: true,
		visibility: internal ? 'internal' : 'public',
		exportedReason: 'modifier',
		apiSurfaceKind: 'public',
	};
}

function modifierLanguageVisibility(
	ctx: SymbolVisibilityContext,
): SymbolVisibilityInfo {
	if (ctx.grammarId === 'php' && ctx.localName.startsWith('_')) {
		return { ...PRIVATE_INFO };
	}
	const visibility = visibilityFromText(ctx.grammarId, ctx.defNode.text);
	if (visibility === 'private') return { ...PRIVATE_INFO };
	if (visibility === 'unknown') {
		const defaultVisibility =
			ctx.grammarId === 'java'
				? 'package'
				: defaultModuleVisibility(ctx.grammarId);
		return {
			exported: true,
			visibility: defaultVisibility,
			exportedReason: 'module_public',
			apiSurfaceKind: 'public',
		};
	}
	return {
		exported: true,
		visibility,
		exportedReason: 'modifier',
		apiSurfaceKind: 'public',
	};
}

function cppVisibility(ctx: SymbolVisibilityContext): SymbolVisibilityInfo {
	const text = ctx.defNode.text.trimStart();
	if (/^static\b/.test(text) || ctx.localName.startsWith('_')) {
		return { ...PRIVATE_INFO };
	}
	return {
		exported: true,
		visibility: 'public',
		exportedReason: 'namespace_public',
		apiSurfaceKind: 'public',
	};
}

function visibilityFromText(grammarId: string, text: string): SymbolVisibility {
	const normalized = declarationPrefix(grammarId, text).trimStart();
	if (/\b(private|fileprivate)\b/.test(normalized)) return 'private';
	if (/\bprotected\b/.test(normalized)) return 'protected';
	if (/\binternal\b/.test(normalized)) return 'internal';
	if (/\b(public|open)\b/.test(normalized)) return 'public';
	if (
		grammarId === 'rust' &&
		/^pub\s*\(\s*(crate|super|in\b)/.test(normalized)
	) {
		return 'internal';
	}
	if (grammarId === 'rust' && /^pub\b|^pub\s*\(/.test(normalized)) {
		return 'public';
	}
	return 'unknown';
}

/**
 * Grammars for which a declaration may begin with annotations/attributes that
 * must be skipped before the visibility modifier is reached. Restricted to the
 * JVM/.NET grammars so decorator-carrying TypeScript/Python/PHP declarations
 * keep their existing behavior.
 */
const ANNOTATED_DECLARATION_GRAMMARS = new Set(['java', 'kotlin', 'csharp']);

/**
 * Index just past a balanced bracket group starting at `open`, or -1 if the
 * group never closes. Depth-aware, so nested groups are consumed whole
 * (`[Attr(new[] { 1 })]`, `[JsonConverter(typeof(List<int>))]`), and
 * string/char literals inside the group are skipped so a bracket or quote in
 * an argument string cannot end it early.
 *
 * A regex cannot do this: `\[[^\][]*\]` stops at the first inner `[`, which
 * left the residue in the scan and made `[Attr(new[] { 1 })] public void M()`
 * resolve to `private`.
 */
/**
 * Index of the closing quote of the string/char literal opening at `quote`, or
 * `text.length` if it never closes.
 *
 * Handles C# VERBATIM strings (`@"..."`), where a backslash is a literal
 * character and the escape for a quote is a doubled `""`. Applying C-style
 * backslash escaping to `@"C:\temp\"` swallows the closing quote, so the
 * enclosing attribute never closes and the whole annotation is left in the
 * scanned text — which made `[Attr(@"C:\temp\")] public void M()` resolve to
 * `private` instead of `public`.
 */
function endOfStringLiteral(text: string, quote: number): number {
	const q = text[quote];
	const verbatim = q === '"' && text[quote - 1] === '@';
	let i = quote + 1;
	while (i < text.length) {
		if (verbatim) {
			if (text[i] === q) {
				// A doubled quote is an escaped quote and continues the string.
				if (text[i + 1] === q) {
					i += 2;
					continue;
				}
				return i;
			}
			i++;
			continue;
		}
		if (text[i] === '\\') {
			i += 2;
			continue;
		}
		if (text[i] === q) return i;
		i++;
	}
	return text.length;
}

function skipBalanced(
	text: string,
	open: number,
	ignoreQuotes = false,
): number {
	const openCh = text[open];
	const closeCh = openCh === '(' ? ')' : ']';
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const ch = text[i];
		if (!ignoreQuotes && (ch === '"' || ch === "'")) {
			i = endOfStringLiteral(text, i);
			continue;
		}
		if (ch === openCh) depth++;
		else if (ch === closeCh) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/**
 * `skipBalanced`, with a bracket-only retry when quote-aware scanning fails to
 * close the group.
 *
 * Any unmodelled string flavor — a C# verbatim `@"..."`, an interpolated
 * `$@"..."`, a C# 11 raw `"""..."""`, or whatever ships next — makes the
 * quote-aware pass run off the end of the text. Falling back to a pure
 * bracket-depth scan bounds the blast radius of that whole class: the worst
 * case becomes a bracket inside a string ending the group early, which is
 * strictly better than abandoning the strip and scanning annotation residue as
 * if it were the declaration (that is what reported public members as private).
 */
function skipBalancedResilient(text: string, open: number): number {
	const strict = skipBalanced(text, open);
	if (strict !== -1) return strict;
	return skipBalanced(text, open, true);
}

/**
 * Drop leading Java/Kotlin annotations (`@Foo`, `@Foo(...)`, use-site targets
 * like `@field:Inject`) and C# attribute lists (`[Attr]`, `[Attr(...)]`) so the
 * real visibility modifier becomes visible. Unbalanced input falls back to the
 * text scanned so far rather than looping or throwing.
 */
function stripLeadingAnnotations(text: string): string {
	let i = 0;
	for (;;) {
		while (i < text.length && /\s/.test(text[i])) i++;
		const ch = text[i];
		if (ch === '@') {
			let j = i + 1;
			// Name, allowing dots and a Kotlin use-site target (`@field:Inject`).
			while (j < text.length && /[\w.:]/.test(text[j])) j++;
			let k = j;
			while (k < text.length && /\s/.test(text[k])) k++;
			if (text[k] === '(') {
				const end = skipBalancedResilient(text, k);
				if (end === -1) return text.slice(i);
				i = end;
			} else if (j === i + 1) {
				// A bare `@` with no name is not valid source, but discarding the
				// rest of the declaration because of it would hide the real
				// modifier. Skip the stray character and keep scanning; `i`
				// strictly increases, so this cannot loop.
				i = j;
			} else {
				i = j;
			}
			continue;
		}
		if (ch === '[') {
			const end = skipBalancedResilient(text, i);
			if (end === -1) return text.slice(i);
			i = end;
			continue;
		}
		return text.slice(i);
	}
}

/**
 * Blank out string and char literal CONTENTS (keeping the quotes and length)
 * so a modifier keyword appearing inside a literal — `@Foo(bar("private"))`,
 * or a default string argument — cannot be mistaken for a real modifier.
 */
function maskStringLiterals(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch !== '"' && ch !== "'") {
			out += ch;
			continue;
		}
		// Same verbatim-string rules as skipBalanced: a doubled quote inside
		// `@"..."` is content, and a backslash is literal.
		const end = endOfStringLiteral(text, i);
		out += ch;
		out += ' '.repeat(Math.max(0, Math.min(end, text.length) - i - 1));
		if (end < text.length) out += text[end];
		i = end;
	}
	return out;
}

/**
 * The header of a declaration — everything before the body or the first line
 * break. For JVM/.NET grammars, leading annotations are skipped first, so
 * `@Override\npublic void run()` still exposes the `public` modifier instead of
 * truncating to `@Override`.
 */
function declarationPrefix(grammarId: string, text: string): string {
	const scanned = ANNOTATED_DECLARATION_GRAMMARS.has(grammarId)
		? maskStringLiterals(stripLeadingAnnotations(text))
		: text;
	const bodyStart = scanned.search(/[{\n]/);
	return bodyStart === -1 ? scanned : scanned.slice(0, bodyStart);
}

function defaultModuleVisibility(grammarId: string): SymbolVisibility {
	switch (grammarId) {
		case 'swift':
		case 'csharp':
			return 'internal';
		// Kotlin's default is `public`, not `internal`.
		case 'kotlin':
			return 'public';
		case 'php':
			return 'public';
		default:
			return 'public';
	}
}

function hasPrivateContainer(
	node: SymbolVisibilityNode,
	grammarId: string,
): boolean {
	let current = node.parent;
	while (current) {
		if (
			isContainerNode(current) &&
			visibilityFromText(grammarId, current.text) === 'private'
		) {
			return true;
		}
		current = current.parent;
	}
	return false;
}

function isContainerNode(node: SymbolVisibilityNode): boolean {
	// The first alternative is intentionally unanchored (it must keep matching
	// `class_specifier`, `struct_item`, `namespace_definition`, …). The
	// enum/record alternative IS anchored: a bare `enum` would also match
	// `enum_constant`, `enum_body`, and C#'s `enum_member_declaration_list`.
	return (
		/(?:class|struct|interface|object|protocol|namespace|module)/.test(
			node.type,
		) || /^(?:enum|record)_declaration$/.test(node.type)
	);
}

function isMemberLikeNode(node: SymbolVisibilityNode): boolean {
	return /(?:method|function)_declaration|function_definition/.test(node.type);
}

function isUppercasePublic(name: string): boolean {
	return /^[A-Z]/.test(name);
}

function isIdentifier(value: string): boolean {
	return /^[A-Za-z_$][\w$]*$/.test(value);
}

function maskCommentsAndStrings(source: string): string {
	const chars = [...source];
	let i = 0;
	while (i < chars.length) {
		const ch = chars[i];
		const next = chars[i + 1];
		if (ch === '/' && next === '/') {
			chars[i++] = ' ';
			chars[i++] = ' ';
			while (i < chars.length && chars[i] !== '\n') chars[i++] = ' ';
			continue;
		}
		if (ch === '/' && next === '*') {
			chars[i++] = ' ';
			chars[i++] = ' ';
			while (i < chars.length) {
				const end = chars[i] === '*' && chars[i + 1] === '/';
				chars[i++] = ' ';
				if (end) {
					chars[i++] = ' ';
					break;
				}
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			chars[i++] = ' ';
			while (i < chars.length) {
				if (chars[i] === '\\') {
					chars[i++] = ' ';
					if (i < chars.length) chars[i++] = ' ';
					continue;
				}
				const done = chars[i] === quote;
				chars[i++] = ' ';
				if (done) break;
			}
			continue;
		}
		i++;
	}
	return chars.join('');
}
