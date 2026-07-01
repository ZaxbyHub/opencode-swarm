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
	if (hasPrivateContainer(ctx.defNode)) return { ...PRIVATE_INFO };

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
	const normalized = declarationPrefix(text).trimStart();
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

function declarationPrefix(text: string): string {
	const bodyStart = text.search(/[{\n]/);
	return bodyStart === -1 ? text : text.slice(0, bodyStart);
}

function defaultModuleVisibility(grammarId: string): SymbolVisibility {
	switch (grammarId) {
		case 'kotlin':
		case 'swift':
		case 'csharp':
			return 'internal';
		case 'php':
			return 'public';
		default:
			return 'public';
	}
}

function hasPrivateContainer(node: SymbolVisibilityNode): boolean {
	let current = node.parent;
	while (current) {
		if (
			isContainerNode(current) &&
			visibilityFromText('', current.text) === 'private'
		) {
			return true;
		}
		current = current.parent;
	}
	return false;
}

function isContainerNode(node: SymbolVisibilityNode): boolean {
	return /(?:class|struct|interface|object|protocol|namespace|module)/.test(
		node.type,
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
