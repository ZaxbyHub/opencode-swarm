import type { Language, Node, QueryMatch, Tree } from 'web-tree-sitter';
import {
	collectCommonJsExports,
	collectPythonAllNames,
	getSymbolVisibilityInfo,
	type SymbolVisibilityInfo,
} from './symbol-visibility';

/** Lazy cache for the Query constructor — avoids loading web-tree-sitter WASM at module-init time. */
let _QueryCtor:
	| null
	| (new (
			lang: Language,
			pattern: string,
	  ) => {
			matches: (node: Node) => QueryMatch[];
	  }) = null;

export interface FileSymbolFacts {
	defs: Array<{
		name: string;
		kind:
			| 'function'
			| 'class'
			| 'const'
			| 'type'
			| 'interface'
			| 'enum'
			| 'method';
		exported: boolean;
		visibilityInfo?: SymbolVisibilityInfo;
		startLine: number;
		endLine: number;
	}>;
	imports: Array<{
		specifier: string;
		importType:
			| 'commonjs'
			| 'named'
			| 'namespace'
			| 'default'
			| 'sideeffect'
			| 'type';
		bindings: Array<{ imported: string; local: string }>;
		reExport?: boolean;
		exportedBindings?: Array<{ imported: string; exported: string }>;
		startLine?: number;
		endLine?: number;
	}>;
	refs: Array<{
		identifier: string;
		line: number;
		enclosingDecl: string | null;
	}>;
}

/**
 * Timeout for symbol-extraction operations. Mirrors AST_TIMEOUT_MS in ast-diff.ts.
 * Wraps BOTH grammar load (WASM) AND parser.parse() in a single race.
 */
const AST_TIMEOUT_MS = 500;

/**
 * Per-grammar query sets. Task 1.1 defines only 'typescript' as the exemplar;
 * additional grammars are added in task 1.2.
 */
const QUERIES: Record<
	string,
	{ defs: string; imports: string; refs: string; exports: string }
> = {
	typescript: {
		defs: `
			(function_declaration name: (identifier) @func.name) @func.def
			(generator_function_declaration name: (identifier) @func.name) @func.def
			(class_declaration name: (type_identifier) @class.name) @class.def
			(lexical_declaration
				(variable_declarator name: (identifier) @const.name)
			) @const.def
			(type_alias_declaration name: (type_identifier) @type.name) @type.def
			(interface_declaration name: (type_identifier) @interface.name) @interface.def
			(enum_declaration name: (identifier) @enum.name) @enum.def
			(method_definition name: (property_identifier) @method.name) @method.def
		`,
		imports: `
			(import_statement) @import
			(call_expression
				function: (identifier) @require.name
				arguments: (arguments (string) @require.specifier)
			) @require
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: `
			(export_statement) @export
		`,
	},
	javascript: {
		defs: `
			(function_declaration name: (identifier) @func.name) @func.def
			(generator_function_declaration name: (identifier) @func.name) @func.def
			(class_declaration name: (identifier) @class.name) @class.def
			(lexical_declaration
				(variable_declarator name: (identifier) @const.name)
			) @const.def
			(method_definition name: (property_identifier) @method.name) @method.def
		`,
		imports: `
			(import_statement) @import
			(call_expression
				function: (identifier) @require.name
				arguments: (arguments (string) @require.specifier)
			) @require
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: `
			(export_statement) @export
		`,
	},
	tsx: {
		defs: `
			(function_declaration name: (identifier) @func.name) @func.def
			(generator_function_declaration name: (identifier) @func.name) @func.def
			(class_declaration name: (type_identifier) @class.name) @class.def
			(lexical_declaration
				(variable_declarator name: (identifier) @const.name)
			) @const.def
			(type_alias_declaration name: (type_identifier) @type.name) @type.def
			(interface_declaration name: (type_identifier) @interface.name) @interface.def
			(enum_declaration name: (identifier) @enum.name) @enum.def
			(method_definition name: (property_identifier) @method.name) @method.def
		`,
		imports: `
			(import_statement) @import
			(call_expression
				function: (identifier) @require.name
				arguments: (arguments (string) @require.specifier)
			) @require
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: `
			(export_statement) @export
		`,
	},
	python: {
		defs: `
			(function_definition
				(identifier) @func.name
			) @func.def
			(class_definition
				(identifier) @class.name
			) @class.def
		`,
		imports: `
			(import_statement) @import
			(import_from_statement) @import
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: ``,
	},
	rust: {
		defs: `
			(function_item
				(identifier) @func.name
			) @func.def
			(struct_item
				name: (type_identifier) @struct.name
			) @struct.def
			(enum_item
				name: (type_identifier) @enum.name
			) @enum.def
			(trait_item
				name: (type_identifier) @trait.name
			) @trait.def
			(mod_item
				name: (identifier) @mod.name
			) @mod.def
		`,
		imports: `
			(use_declaration) @import
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: ``,
	},
	go: {
		defs: `
			(function_declaration name: (identifier) @func.name) @func.def
			(method_declaration name: (field_identifier) @method.name) @method.def
			(type_declaration (type_spec name: (type_identifier) @type.name)) @type.def
			(var_declaration (var_spec name: (identifier) @const.name)) @const.def
			(const_declaration (const_spec name: (identifier) @const.name)) @const.def
		`,
		imports: `
			(import_declaration) @import
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: ``,
	},
	java: {
		defs: `
			(method_declaration
				(identifier) @func.name
			) @func.def
			(constructor_declaration
				(identifier) @ctor.name
			) @ctor.def
			(class_declaration
				(identifier) @class.name
			) @class.def
			(interface_declaration
				(identifier) @interface.name
			) @interface.def
			(enum_declaration
				(identifier) @enum.name
			) @enum.def
			(record_declaration
				(identifier) @record.name
			) @record.def
		`,
		imports: `
			(import_declaration) @import
		`,
		refs: `
			(identifier) @ref.identifier
			(type_identifier) @ref.identifier
		`,
		exports: ``,
	},
	kotlin: {
		defs: `
			(function_declaration
				(simple_identifier) @func.name
			) @func.def
			(class_declaration
				(type_identifier) @class.name
			) @class.def
			(object_declaration
				(type_identifier) @object.name
			) @object.def
		`,
		imports: `
			(import_header) @import
		`,
		refs: `
			(identifier) @ref.identifier
			(simple_identifier) @ref.identifier
			(type_identifier) @ref.identifier
		`,
		exports: ``,
	},
	csharp: {
		defs: `
			(method_declaration name: (identifier) @func.name) @func.def
			(constructor_declaration name: (identifier) @ctor.name) @ctor.def
			(class_declaration name: (identifier) @class.name) @class.def
			(interface_declaration name: (identifier) @interface.name) @interface.def
			(struct_declaration name: (identifier) @struct.name) @struct.def
			(enum_declaration name: (identifier) @enum.name) @enum.def
			(record_declaration name: (identifier) @record.name) @record.def
		`,
		imports: `
			(using_directive) @import
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: ``,
	},
	cpp: {
		defs: `
			(function_definition
				(function_declarator
					declarator: (identifier) @func.name
				)
			) @func.def
			(function_definition
				declarator: (pointer_declarator
					declarator: (function_declarator
						declarator: (identifier) @func.name
					)
				)
			) @func.def
			(function_definition
				(function_declarator
					declarator: (qualified_identifier (identifier) @func.name)
				)
			) @func.def
			(declaration
				declarator: (function_declarator
					declarator: (identifier) @func.name
				)
			) @func.def
			(declaration
				declarator: (pointer_declarator
					declarator: (function_declarator
						declarator: (identifier) @func.name
					)
				)
			) @func.def
			(function_definition
				(function_declarator
					declarator: (field_identifier) @method.name
				)
			) @method.def
			(field_declaration
				(function_declarator
					declarator: (field_identifier) @method.name
				)
			) @method.def
			(class_specifier name: (type_identifier) @class.name) @class.def
			(struct_specifier name: (type_identifier) @struct.name) @struct.def
			(enum_specifier name: (type_identifier) @enum.name) @enum.def
			(type_definition declarator: (type_identifier) @type.name) @type.def
		`,
		imports: `
			(preproc_include) @import
			(using_declaration) @import
		`,
		refs: `
			(identifier) @ref.identifier
			(namespace_identifier) @ref.identifier
			(type_identifier) @ref.identifier
		`,
		exports: ``,
	},
	swift: {
		defs: `
			(function_declaration name: (simple_identifier) @func.name) @func.def
			(protocol_function_declaration name: (simple_identifier) @func.name) @func.def
			(class_declaration name: (type_identifier) @class.name) @class.def
			(class_declaration
				name: (user_type (type_identifier) @extension.name)
			) @extension.def
			(protocol_declaration name: (type_identifier) @protocol.name) @protocol.def
			(typealias_declaration name: (type_identifier) @type.name) @type.def
		`,
		imports: `
			(import_declaration) @import
		`,
		refs: `
			(identifier) @ref.identifier
			(simple_identifier) @ref.identifier
			(type_identifier) @ref.identifier
		`,
		exports: ``,
	},
	dart: {
		defs: `
			(function_signature
				name: (identifier) @func.name
			) @func.def
			(class_definition name: (identifier) @class.name) @class.def
		`,
		imports: `
			(library_import) @import
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: `
			(export_directive) @export
		`,
	},
	ruby: {
		defs: `
			(method name: (identifier) @func.name) @func.def
			(class name: (constant) @class.name) @class.def
		`,
		imports: `
			(call
				(identifier) @require.name
				(argument_list (string (string_content) @require.specifier))
			) @require
		`,
		refs: `
			(identifier) @ref.identifier
		`,
		exports: ``,
	},
	php: {
		defs: `
			(function_definition
				name: (name) @func.name
			) @func.def
			(class_declaration name: (name) @class.name) @class.def
			(interface_declaration name: (name) @interface.name) @interface.def
		`,
		imports: `
			(namespace_use_declaration) @import
		`,
		refs: `
			(name) @ref.identifier
		`,
		exports: ``,
	},
};

const CAPTURE_KIND: Record<string, FileSymbolFacts['defs'][0]['kind']> = {
	func: 'function',
	class: 'class',
	const: 'const',
	type: 'type',
	interface: 'interface',
	enum: 'enum',
	method: 'method',
	struct: 'type',
	trait: 'interface',
	mod: 'type',
	object: 'class',
	mixin: 'type',
	protocol: 'interface',
	record: 'class',
	// Deliberately `ctor`, not `constructor`: `CAPTURE_KIND['constructor']`
	// would resolve to `Object.prototype.constructor` through the prototype
	// chain, and `??` would not fire because a function is not nullish.
	// The `Object.hasOwn` guard at the lookup site closes the class for any
	// future prefix; this name keeps the query readable regardless.
	ctor: 'method',
	// Swift extension blocks parse as `class_declaration` with a `user_type`
	// name; the extended type is already declared elsewhere, so the extension
	// contributes a type-level augmentation rather than a new type.
	extension: 'type',
};

const DEF_TYPES = new Set([
	'function_declaration',
	'class_declaration',
	'variable_declaration',
	'type_alias_declaration',
	'interface_declaration',
	'enum_declaration',
	'method_definition',
	'function_item',
	'function_signature',
	'class_specifier',
	'struct_specifier',
	'struct_item',
	'struct_declaration',
	'record_declaration',
	'constructor_declaration',
	'method_declaration',
	'type_declaration',
	'object_declaration',
	'protocol_declaration',
	'mixin_declaration',
	'function_definition',
	'generator_function_declaration',
	'class_definition',
	'lexical_declaration',
	'impl_item',
	'enum_item',
	'trait_item',
	'mod_item',
	'var_declaration',
	'const_declaration',
	'method',
	'class',
]);

/** Grammars whose members live inside an explicit type container. */
const JVM_GRAMMARS = new Set(['java', 'kotlin', 'csharp']);

/**
 * Type-container node types for java/kotlin/csharp. A `func`/`ctor` capture
 * with one of these as an ancestor is a *member*, not a free function, and the
 * matched container's node type also decides the member's implicit visibility
 * (see `containerScopedDefaultVisibility` in `symbol-visibility.ts`).
 */
const JVM_CONTAINER_TYPES = new Set([
	'class_declaration',
	'interface_declaration',
	'struct_declaration',
	'object_declaration',
	'enum_declaration',
	'record_declaration',
]);

/**
 * Type-container node types for the cpp/swift member re-typing and container
 * defaults. Only the SPECIFIER/DECLARATION nodes are listed, never the body
 * (`field_declaration_list`): the ancestor walk passes through the body to the
 * specifier, and the specifier kind is what the cpp container default needs
 * (class members default private, struct/union members public).
 */
const NATIVE_CONTAINER_TYPES = new Set([
	// cpp: class/struct/union (an in-class constructor prototype parses as a
	// plain `declaration` inside the specifier's field_declaration_list).
	'class_specifier',
	'struct_specifier',
	'union_specifier',
	// swift: class/struct/enum/extension all parse as class_declaration.
	'class_declaration',
	'protocol_declaration',
]);

const PARAM_TYPES = new Set([
	'formal_parameters',
	'required_parameter',
	'optional_parameter',
	'rest_parameter',
	'array_pattern',
	'object_pattern',
]);

/**
 * Swift-only addition to {@link PARAM_TYPES}. The swift grammar's `parameter`
 * node wraps each parameter's names and type, and without this skip the
 * parameter NAMES (`func f(_ input: Int)`) leak into refs. The skip is
 * deliberately grammar-scoped rather than added to PARAM_TYPES: the same node
 * type name exists in the csharp, kotlin, and rust grammars, where a
 * parameter-position TYPE is a genuine reference signal — most notably for
 * Kotlin named imports, whose bindings are marked used by body/parameter
 * refs (final-critic finding on issue #1530).
 */
const SWIFT_REF_PARAM_TYPES = new Set([...PARAM_TYPES, 'parameter']);

/**
 * Extract symbol, import, and reference facts from a source string using
 * tree-sitter.
 *
 * Fail-open: returns null on grammar-load failure, timeout, or parse error.
 * The 500 ms `AST_TIMEOUT_MS` race bounds the async `loadGrammar` WASM load
 * and races the parse attempt, but cannot hard-interrupt a synchronous
 * `parser.parse()` once it begins (mirrors the `computeASTDiff` pattern in
 * `src/diff/ast-diff.ts`). The primary async risk (WASM grammar load) IS
 * bounded.
 *
 * The parsed tree is always deleted: the inner async IIFE owns tree cleanup
 * via its own `finally` block (deletes the tree after `buildFacts` regardless
 * of whether the outer race rejects on timeout). Tree cleanup is handled
 * solely by that inner `finally`; there is no outer backstop.
 *
 * @param grammarId - Tree-sitter grammar id (e.g. 'typescript')
 * @param source - Source code text
 * @returns FileSymbolFacts, or null on failure
 */
export async function extractFileSymbols(
	grammarId: string,
	source: string,
): Promise<FileSymbolFacts | null> {
	// Use a ref object so the async closure can store the parsed tree for
	// cleanup in the finally block without triggering TypeScript
	// control-flow narrowing to `never` on a captured outer local.
	const treeRef = { value: null as Tree | null };
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	try {
		const result = await Promise.race([
			(async (): Promise<FileSymbolFacts | null> => {
				// Inner IIFE owns its tree: delete it after buildFacts
				// regardless of whether buildFacts throws or returns null.
				// This prevents a WASM tree leak when the outer race rejects
				// (timeout) — the inner IIFE keeps running after the outer
				// catch, so its own finally is the only reliable cleanup.
				try {
					// Lazy-init the Query constructor on first call (off the module-init path).
					if (!_QueryCtor) {
						const wts = await import('web-tree-sitter');
						_QueryCtor = wts.Query;
					}
					const { loadGrammar: loadGrammarDynamic } = await import(
						'./runtime.js'
					);
					const parser = await loadGrammarDynamic(grammarId);
					treeRef.value = parser.parse(source);
					if (!treeRef.value) return null;

					const qs = QUERIES[grammarId];
					if (!qs) return null;

					return buildFacts(treeRef.value, qs, grammarId);
				} finally {
					if (treeRef.value) {
						treeRef.value.delete();
						treeRef.value = null;
					}
				}
			})(),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new Error('AST_TIMEOUT')),
					AST_TIMEOUT_MS,
				);
			}),
		]).finally(() => {
			if (timeoutId) clearTimeout(timeoutId);
		});

		return result;
	} catch {
		return null;
	}
}

type TsNode = Tree['rootNode'];

function asTs(node: Tree['rootNode']): TsNode {
	return node as TsNode;
}

function buildFacts(
	tree: Tree,
	qs: { defs: string; imports: string; refs: string; exports: string },
	grammarId: string,
): FileSymbolFacts {
	const root = asTs(tree.rootNode);
	const lang = tree.language;
	if (!lang) return { defs: [], imports: [], refs: [] };

	const defMatches = safeMatches(lang, qs.defs, root);
	const importMatches = safeMatches(lang, qs.imports, root);
	const refMatches = safeMatches(lang, qs.refs, root);
	const exportMatches = safeMatches(lang, qs.exports, root);

	const exportNodes: TsNode[] = [];
	for (const m of exportMatches) {
		const cap = m.captures.find((c) => c.name === 'export');
		if (cap) exportNodes.push(asTs(cap.node));
	}
	const commonJsExports = isEsMGrammar(grammarId)
		? collectCommonJsExports(root.text)
		: new Map();
	const pythonAllNames =
		grammarId === 'python' ? collectPythonAllNames(root.text) : null;

	const defs: FileSymbolFacts['defs'] = [];
	const defNodes: Array<{ node: TsNode; name: string }> = [];
	const defNameKeys = new Set<string>();

	for (const m of defMatches) {
		const defCap = m.captures.find((c) => c.name.endsWith('.def'));
		const nameCaps = m.captures.filter((c) => c.name.endsWith('.name'));
		if (!defCap || nameCaps.length === 0) continue;

		const kindKey = defCap.name.replace(/\.def$/, '');
		const originalDefNode = asTs(defCap.node);
		let defNode = originalDefNode;
		// `Object.hasOwn`, not `?? `: a capture prefix that collides with an
		// `Object.prototype` member (`constructor`, `toString`, `valueOf`, …)
		// would otherwise resolve to the inherited value, which is not nullish
		// and so silently survives the `??` fallback.
		let kind: FileSymbolFacts['defs'][0]['kind'] = Object.hasOwn(
			CAPTURE_KIND,
			kindKey,
		)
			? CAPTURE_KIND[kindKey]
			: 'function';
		if (
			grammarId === 'python' &&
			kindKey === 'func' &&
			hasAncestorOfType(originalDefNode, 'class_definition')
		) {
			kind = 'method';
		}
		if (
			grammarId === 'rust' &&
			kindKey === 'func' &&
			hasAncestorOfType(originalDefNode, 'impl_item')
		) {
			kind = 'method';
		}
		// java/kotlin/csharp: one ancestor walk serves both the member re-typing
		// (F1) and the container-kind visibility default (F2). Only `func`/`ctor`
		// captures are re-typed — a *nested type* stays a type.
		let parentContainerType: string | undefined;
		if (JVM_GRAMMARS.has(grammarId)) {
			parentContainerType = nearestAncestorType(
				originalDefNode,
				JVM_CONTAINER_TYPES,
			);
			if (
				parentContainerType !== undefined &&
				(kindKey === 'func' || kindKey === 'ctor')
			) {
				kind = 'method';
			}
		}
		// cpp/swift: members are re-typed the same way, and the container type
		// feeds the container-scoped implicit-visibility default (Swift members
		// default `internal`; C++ class members default private, struct/union
		// members public — see containerScopedDefaultVisibility).
		if (grammarId === 'cpp' || grammarId === 'swift') {
			parentContainerType = nearestAncestorType(
				originalDefNode,
				NATIVE_CONTAINER_TYPES,
			);
			if (parentContainerType !== undefined && kindKey === 'func') {
				kind = 'method';
			}
		}
		const explicitExported = exportNodes.some((en) =>
			isNodeInside(en, defNode),
		);

		// For ESM default exports, normalize the exported name to 'default'
		// so it matches the 'default' sentinel used by parseEsmImport and
		// the sync builder's export naming.
		//
		// The def must be the statement's OWN declaration, not merely nested
		// inside it. `isNodeInside` is a pure span-containment test, so for
		// `export default class Foo { bar() {} }` it is true for the class AND
		// for every method, getter and static inside it — each of which was then
		// renamed to `default` and marked exported, destroying the real name
		// `Foo`. Ask the grammar which node the statement actually declares.
		let isDefaultExport = false;
		if (explicitExported && isEsMGrammar(grammarId)) {
			isDefaultExport = exportNodes.some(
				(en) =>
					isDefaultExportStatement(en) && isOwnExportDeclaration(en, defNode),
			);
		}

		// Dart: function_body is a sibling of function_signature under program.
		// Extend the def span to include the body so enclosingDecl resolution
		// covers the function body region.
		if (grammarId === 'dart' && defNode.type === 'function_signature') {
			const rawBody = defNode.nextSibling;
			if (rawBody) {
				const bodyNode = asTs(rawBody);
				if (bodyNode.type === 'function_body') {
					defNode = asTs({
						...defNode,
						endIndex: bodyNode.endIndex,
						endPosition: bodyNode.endPosition,
					} as TsNode);
				}
			}
		}
		if (
			grammarId === 'python' &&
			defNode.parent?.type === 'decorated_definition'
		) {
			defNode = asTs(defNode.parent);
		}

		// For Python methods, determine if the parent class is exported
		let pythonParentClassExported = false;
		if (grammarId === 'python' && kind === 'method') {
			let current: TsNode | null = originalDefNode.parent;
			while (current) {
				if (current.type === 'class_definition') {
					const classNameNode = current.children?.find(
						(c): c is TsNode => c != null && c.type === 'identifier',
					);
					if (classNameNode) {
						const className = classNameNode.text;
						pythonParentClassExported = pythonAllNames
							? pythonAllNames.has(className)
							: !className.startsWith('_');
					}
					break;
				}
				current = current.parent;
			}
		}

		for (const nc of nameCaps) {
			const nameNode = asTs(nc.node);
			const localName = nameNode.text;
			const commonJsExport = commonJsExports.get(localName);
			const visibilityInfo = getSymbolVisibilityInfo({
				grammarId,
				localName,
				kind,
				defNode: originalDefNode,
				rootNode: root,
				isTopLevel: isTopLevelDef(originalDefNode, root),
				explicitExported,
				commonJsExport,
				pythonAllNames,
				pythonParentClassExported,
				parentContainerType,
			});
			const exportedName = isDefaultExport
				? 'default'
				: (commonJsExport?.exportedName ?? localName);

			defs.push({
				name: exportedName,
				kind,
				exported: visibilityInfo.exported,
				visibilityInfo,
				startLine: defNode.startPosition.row + 1,
				endLine: defNode.endPosition.row + 1,
			});
			// Keep `defNodes` in step with `defs[].name` so `enclosingDecl` on a
			// ref inside an extension function reports the same symbol name the
			// def was emitted under.
			defNodes.push({ node: defNode, name: localName });
			defNameKeys.add(nodeKey(nameNode));
		}
	}

	const importsWithIndex: Array<{
		index: number;
		entry: FileSymbolFacts['imports'][0];
	}> = [];
	const addImport = (
		entry: FileSymbolFacts['imports'][0] | FileSymbolFacts['imports'] | null,
		node: TsNode,
	) => {
		if (!entry) return;
		for (const item of Array.isArray(entry) ? entry : [entry]) {
			const pythonExportedBindings =
				grammarId === 'python' && pythonAllNames && item.bindings.length > 0
					? item.bindings
							.filter((binding) => pythonAllNames.has(binding.local))
							.map((binding) => ({
								imported: binding.imported,
								exported: binding.local,
							}))
					: [];
			const normalizedItem =
				pythonExportedBindings.length > 0
					? {
							...item,
							reExport: true,
							exportedBindings: pythonExportedBindings,
						}
					: item;
			importsWithIndex.push({
				index: node.startIndex,
				entry: normalizedItem.reExport
					? {
							...normalizedItem,
							startLine: node.startPosition.row + 1,
							endLine: node.endPosition.row + 1,
						}
					: normalizedItem,
			});
		}
	};
	for (const m of importMatches) {
		const importCap = m.captures.find((c) => c.name === 'import');
		if (importCap) {
			const importNode = asTs(importCap.node);
			const rawText = importNode.text.trim();
			// Go block import: `import ( "fmt" "os" )` — find the
			// import_spec_list child, then iterate its import_spec children.
			if (grammarId === 'go' && rawText.startsWith('import (')) {
				const seenGoSpecifiers = new Set<string>();
				const specListNode = importNode.children.find(
					(c): c is TsNode => c !== null && c.type === 'import_spec_list',
				);
				if (specListNode) {
					for (const spec of asTs(specListNode).children) {
						if (spec && spec.type === 'import_spec') {
							const parsed = parseGoImportHardened(spec.text.trim());
							if (parsed) seenGoSpecifiers.add(parsed.specifier);
							addImport(parsed, asTs(spec));
						}
					}
				}
				for (const parsed of parseGoBlockImports(rawText)) {
					if (seenGoSpecifiers.has(parsed.specifier)) continue;
					addImport(parsed, importNode);
				}
			} else {
				const parsed = parseImport(grammarId, rawText);
				addImport(parsed, importNode);
			}
		}
		// Ruby require/require_relative fallback
		if (grammarId === 'ruby') {
			const reqName = m.captures.find((c) => c.name === 'require.name');
			const reqSpec = m.captures.find((c) => c.name === 'require.specifier');
			if (reqName && reqSpec) {
				const fnText = asTs(reqName.node).text;
				if (fnText === 'require' || fnText === 'require_relative') {
					// Pass the full call text (e.g. "require 'json'") so parseRubyRequire
					// can strip the require keyword; fall back to bare specifier.
					const callNode = asTs(reqName.node).parent;
					const rawText = callNode ? callNode.text : asTs(reqSpec.node).text;
					const parsed = parseRubyRequire(rawText);
					addImport(parsed, asTs(callNode ?? reqSpec.node));
				}
			}
		}
		// CommonJS require() fallback for TS/JS/TSX
		if (isEsMGrammar(grammarId)) {
			const reqName = m.captures.find((c) => c.name === 'require.name');
			const reqSpec = m.captures.find((c) => c.name === 'require.specifier');
			if (reqName && reqSpec) {
				const fnText = asTs(reqName.node).text;
				if (fnText === 'require') {
					const specText = asTs(reqSpec.node).text.replace(/['"]/g, '');
					addImport(
						{
							specifier: specText,
							importType: 'commonjs',
							bindings: [],
						},
						asTs(reqName.node),
					);
				}
			}
		}
	}
	if (isEsMGrammar(grammarId)) {
		for (const exportNode of exportNodes) {
			addImport(parseImport(grammarId, exportNode.text.trim()), exportNode);
		}
	}
	const imports = importsWithIndex
		.sort((a, b) => a.index - b.index)
		.map((item) => item.entry);

	const topLevelDefs = defNodes
		.filter((d) => isTopLevelDef(d.node, root))
		.map((d) => ({ name: d.name, node: d.node }));

	const refs: FileSymbolFacts['refs'] = [];
	const refParamTypes =
		grammarId === 'swift' ? SWIFT_REF_PARAM_TYPES : PARAM_TYPES;
	for (const m of refMatches) {
		const cap = m.captures.find((c) => c.name === 'ref.identifier');
		if (!cap) continue;
		const refNode = asTs(cap.node);

		if (defNameKeys.has(nodeKey(refNode))) continue;
		if (hasAncestorOfType(refNode, 'import_statement')) continue;
		if (isInsideImportStatement(refNode)) continue;
		if (hasAncestorOfType(refNode, refParamTypes)) continue;
		if (refNode.text === 'require' && isInsideRequireCall(refNode)) continue;

		refs.push({
			identifier: refNode.text,
			line: refNode.startPosition.row + 1,
			enclosingDecl: findEnclosingDecl(refNode, topLevelDefs),
		});
	}

	// An ANONYMOUS default export (`export default class { ... }`) has no name
	// capture, so the loop above produced no def for the declaration itself.
	// Before default-export scoping was fixed, a member inside it was renamed to
	// `default` and stood in for the module default; scoping that correctly to
	// the owning declaration removed the stand-in and left the file with NO
	// `default` entry at all, so `import X from './m'` could no longer match.
	// Emit the real thing: one `default` def spanning the declaration.
	if (isEsMGrammar(grammarId)) {
		for (const en of exportNodes) {
			if (!isDefaultExportStatement(en)) continue;
			const owner =
				en.childForFieldName?.('declaration') ??
				en.childForFieldName?.('value');
			if (!owner) continue;
			const alreadyNamed = defs.some(
				(d) =>
					d.startLine === owner.startPosition.row + 1 && d.name === 'default',
			);
			if (alreadyNamed) continue;
			const kind = owner.type.includes('class') ? 'class' : 'function';
			defs.push({
				name: 'default',
				kind,
				exported: true,
				startLine: owner.startPosition.row + 1,
				endLine: owner.endPosition.row + 1,
			});
		}
	}

	return { defs, imports, refs };
}

function safeMatches(
	lang: Language,
	pattern: string,
	root: Tree['rootNode'],
): QueryMatch[] {
	// Fail-open if called before the lazy cache is initialised.
	if (!_QueryCtor) return [];
	try {
		const q = new _QueryCtor(lang, pattern);
		return q.matches(root);
	} catch {
		return [];
	}
}

function parseEsmImport(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();

	const sideEffect = t.match(/^import\s+['"]([^'"]+)['"]/);
	if (sideEffect) {
		return { specifier: sideEffect[1], importType: 'sideeffect', bindings: [] };
	}

	const reExportAllAs = t.match(
		/^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/,
	);
	if (reExportAllAs) {
		return {
			specifier: reExportAllAs[2],
			importType: 'namespace',
			bindings: [{ imported: '*', local: reExportAllAs[1] }],
			reExport: true,
			exportedBindings: [{ imported: '*', exported: reExportAllAs[1] }],
		};
	}

	const reExportAll = t.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/);
	if (reExportAll) {
		return {
			specifier: reExportAll[1],
			importType: 'namespace',
			bindings: [],
			reExport: true,
		};
	}

	const namedTypeReExport = t.match(
		/^export\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,
	);
	if (namedTypeReExport) {
		return {
			specifier: namedTypeReExport[2],
			importType: 'type',
			bindings: [],
			reExport: true,
		};
	}

	const namedReExport = t.match(
		/^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,
	);
	if (namedReExport) {
		const bindings: Array<{ imported: string; local: string }> = [];
		const exportedBindings: Array<{ imported: string; exported: string }> = [];
		for (const rawPart of namedReExport[1].split(',')) {
			const p = rawPart.trim();
			if (!p) continue;
			if (/^type\s+/.test(p)) continue;
			const alias = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
			const imported = alias ? alias[1] : p;
			const exported = alias ? alias[2] : p;
			if (!/^[A-Za-z_$][\w$]*$/.test(imported)) continue;
			if (!/^[A-Za-z_$][\w$]*$/.test(exported)) continue;
			bindings.push({ imported, local: exported });
			exportedBindings.push({ imported, exported });
		}
		return {
			specifier: namedReExport[2],
			importType: 'named',
			bindings,
			reExport: true,
			exportedBindings,
		};
	}

	// Strip optional `type` qualifier: "import type { ... }" → "import { ... }"
	// Track whether it was a type-only import (all bindings are type-only).
	const isTypeOnlyImport = /^import\s+type\s/.test(t);
	const withoutTypeQualifier = t.replace(/^import\s+type\s+/, 'import ');

	// Named imports: handles `import { foo }`, `import type { foo }`,
	// and mixed `import { type Foo, bar }` (inline type modifier per binding).
	const named = withoutTypeQualifier.match(
		/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,
	);
	if (named) {
		// `import type { Foo }` → all bindings are type-only → empty bindings
		if (isTypeOnlyImport) {
			return { specifier: named[2], importType: 'named', bindings: [] };
		}

		const bindings: Array<{ imported: string; local: string }> = [];
		for (const part of named[1].split(',')) {
			const p = part.trim();
			if (!p) continue;
			if (/^type\s+/.test(p)) continue;
			// Strip inline `type` modifier: "type Foo" → "Foo"
			const stripped = p.replace(/^type\s+/, '');
			// If the entire binding is just `type` keyword (degenerate), skip it
			if (!stripped) continue;
			const alias = stripped.match(
				/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/,
			);
			if (alias) {
				bindings.push({ imported: alias[1], local: alias[2] });
			} else if (/^[A-Za-z_$][\w$]*$/.test(stripped)) {
				bindings.push({ imported: stripped, local: stripped });
			}
		}
		return { specifier: named[2], importType: 'named', bindings };
	}

	// Combined ESM imports: `import <Default>, { <named> } from '<spec>'`
	// or `import <Default>, * as <ns> from '<spec>'`.
	// Must be checked before the default-only and namespace-only branches.
	const combined = withoutTypeQualifier.match(
		/^import\s+([A-Za-z_$][\w$]*)\s*,\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/,
	);
	if (combined) {
		if (isTypeOnlyImport) {
			return {
				specifier: combined[3],
				importType: 'named',
				bindings: [],
			};
		}
		return {
			specifier: combined[3],
			importType: 'named',
			bindings: [
				{ imported: 'default', local: combined[1] },
				{ imported: '*', local: combined[2] },
			],
		};
	}

	const combinedNamed = withoutTypeQualifier.match(
		/^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,
	);
	if (combinedNamed) {
		if (isTypeOnlyImport) {
			return {
				specifier: combinedNamed[3],
				importType: 'named',
				bindings: [],
			};
		}
		const bindings: Array<{ imported: string; local: string }> = [
			{ imported: 'default', local: combinedNamed[1] },
		];
		for (const part of combinedNamed[2].split(',')) {
			const p = part.trim();
			if (!p) continue;
			if (/^type\s+/.test(p)) continue;
			const stripped = p.replace(/^type\s+/, '');
			if (!stripped) continue;
			const alias = stripped.match(
				/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/,
			);
			if (alias) {
				bindings.push({ imported: alias[1], local: alias[2] });
			} else if (/^[A-Za-z_$][\w$]*$/.test(stripped)) {
				bindings.push({ imported: stripped, local: stripped });
			}
		}
		return { specifier: combinedNamed[3], importType: 'named', bindings };
	}

	const ns = t.match(
		/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/,
	);
	if (ns) {
		return {
			specifier: ns[2],
			importType: 'namespace',
			bindings: [{ imported: '*', local: ns[1] }],
		};
	}

	const def = t.match(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/);
	if (def) {
		return {
			specifier: def[2],
			importType: 'default',
			bindings: [{ imported: 'default', local: def[1] }],
		};
	}

	return null;
}

/**
 * Dispatch table: tree-sitter grammar id → language-specific import parser.
 * Each parser receives the raw captured node text and returns a normalized
 * FileSymbolFacts.imports entry, or null if the text does not match.
 */
function parseImport(
	grammarId: string,
	text: string,
): FileSymbolFacts['imports'][0] | FileSymbolFacts['imports'] | null {
	switch (grammarId) {
		case 'python':
			return parsePythonImportHardened(text);
		case 'rust':
			return parseRustUseHardened(text);
		case 'go':
			return parseGoImportHardened(text);
		case 'java':
			return parseJavaImport(text);
		case 'kotlin':
			return parseKotlinImport(text);
		case 'csharp':
			return parseCSharpUsing(text);
		case 'cpp':
			return parseCppInclude(text);
		case 'swift':
			return parseSwiftImport(text);
		case 'dart':
			return parseDartImport(text);
		case 'ruby':
			return parseRubyRequire(text);
		case 'php':
			return parsePhpUse(text);
		case 'typescript':
		case 'tsx':
		case 'javascript':
			return parseEsmImport(text);
		default:
			return null;
	}
}

function _parsePythonImport(
	text: string,
): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// import foo            → specifier: 'foo',  bindings: []
	// import foo as bar     → specifier: 'foo',  bindings: [{imported:'foo', local:'bar'}]
	// from foo import bar   → specifier: 'foo',  bindings: [{imported:'bar', local:'bar'}]
	// from foo import bar as baz → specifier: 'foo', bindings: [{imported:'bar', local:'baz'}]
	const fullImport = t.match(/^import\s+(.+)$/);
	if (fullImport) {
		const rest = fullImport[1].trim();
		const alias = rest.match(/^(\w+)\s+as\s+(\w+)$/);
		if (alias) {
			return {
				specifier: alias[1],
				importType: 'named',
				bindings: [{ imported: alias[1], local: alias[2] }],
			};
		}
		// bare module import — no bindings to track
		return { specifier: rest, importType: 'namespace', bindings: [] };
	}
	const fromImport = t.match(/^from\s+(\S+)\s+import\s+(.+)$/);
	if (fromImport) {
		const bindings: Array<{ imported: string; local: string }> = [];
		for (const part of fromImport[2].split(',')) {
			const p = part.trim();
			if (!p) continue;
			const alias = p.match(/^(\w+)\s+as\s+(\w+)$/);
			if (alias) {
				bindings.push({ imported: alias[1], local: alias[2] });
			} else {
				bindings.push({ imported: p, local: p });
			}
		}
		return { specifier: fromImport[1], importType: 'named', bindings };
	}
	return null;
}

function parsePythonImportHardened(
	text: string,
): FileSymbolFacts['imports'][0] | FileSymbolFacts['imports'] | null {
	const t = text.trim();
	const fullImport = t.match(/^import\s+(.+)$/);
	if (fullImport) {
		const entries: FileSymbolFacts['imports'] = [];
		for (const rawPart of fullImport[1].split(',')) {
			const part = rawPart.trim();
			if (!part) continue;
			const alias = part.match(/^([\w.]+)\s+as\s+(\w+)$/);
			const specifier = alias ? alias[1] : part;
			const local = alias ? alias[2] : specifier.split('.')[0];
			if (!specifier || !/^\w+$/.test(local)) continue;
			entries.push({
				specifier,
				importType: alias ? 'named' : 'namespace',
				bindings: [{ imported: specifier, local }],
			});
		}
		if (entries.length === 0) return null;
		return entries.length === 1 ? entries[0] : entries;
	}

	const fromImport = t.match(/^from\s+(\S+)\s+import\s+(.+)$/);
	if (!fromImport) return null;
	const bindings: Array<{ imported: string; local: string }> = [];
	for (const rawPart of fromImport[2].split(',')) {
		const part = rawPart.trim();
		if (!part) continue;
		if (part === '*') {
			return {
				specifier: normalizePythonModuleSpecifier(fromImport[1]),
				importType: 'namespace',
				bindings: [],
			};
		}
		const alias = part.match(/^(\w+)\s+as\s+(\w+)$/);
		if (alias) {
			bindings.push({ imported: alias[1], local: alias[2] });
		} else if (/^\w+$/.test(part)) {
			bindings.push({ imported: part, local: part });
		}
	}
	return {
		specifier: normalizePythonModuleSpecifier(fromImport[1]),
		importType: 'named',
		bindings,
	};
}

function normalizePythonModuleSpecifier(specifier: string): string {
	const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
	if (leadingDots === 0) return specifier;
	const rest = specifier.slice(leadingDots).replace(/\./g, '/');
	const prefix = leadingDots === 1 ? './' : '../'.repeat(leadingDots - 1);
	return `${prefix}${rest}`;
}

function _parseRustUse(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// use foo::bar::baz;
	// use foo::bar::baz as alias;
	// use foo::{Bar, Baz};
	const m = t.match(/^use\s+(.+?)\s*as\s+(\w+)\s*;?\s*$/);
	if (m) {
		return {
			specifier: m[1].trim(),
			importType: 'named',
			bindings: [{ imported: m[1].trim(), local: m[2] }],
		};
	}
	const simple = t.match(/^use\s+(.+?)\s*;?\s*$/);
	if (simple) {
		return {
			specifier: simple[1].trim(),
			importType: 'namespace',
			bindings: [],
		};
	}
	return null;
}

function parseRustUseHardened(
	text: string,
): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	const aliased = t.match(/^use\s+(.+?)\s+as\s+(\w+)\s*;?\s*$/);
	if (aliased) {
		const parts = aliased[1].trim().split('::').filter(Boolean);
		const imported = parts.pop() ?? aliased[1].trim();
		const specifier = parts.length > 0 ? parts.join('::') : aliased[1].trim();
		return {
			specifier,
			importType: 'named',
			bindings: [{ imported, local: aliased[2] }],
		};
	}

	const grouped = t.match(/^use\s+(.+?)::\{(.+)\}\s*;?\s*$/);
	if (grouped) {
		const base = grouped[1].trim();
		const bindings: Array<{ imported: string; local: string }> = [];
		for (const rawPart of grouped[2].split(',')) {
			const part = rawPart.trim();
			if (!part) continue;
			const alias = part.match(/^(\w+)\s+as\s+(\w+)$/);
			if (alias) {
				bindings.push({ imported: alias[1], local: alias[2] });
			} else if (/^\w+$/.test(part)) {
				const local = part === 'self' ? base.split('::').pop() || base : part;
				bindings.push({ imported: part, local });
			}
		}
		return { specifier: base, importType: 'named', bindings };
	}

	const simple = t.match(/^use\s+(.+?)\s*;?\s*$/);
	if (!simple) return null;
	const parts = simple[1].trim().split('::').filter(Boolean);
	const imported = parts.pop() ?? simple[1].trim();
	const specifier = parts.length > 0 ? parts.join('::') : simple[1].trim();
	const local = imported;
	return {
		specifier,
		importType: 'named',
		bindings: /^\w+$/.test(imported) ? [{ imported, local }] : [],
	};
}

function parseGoBlockImports(text: string): FileSymbolFacts['imports'] {
	const entries: FileSymbolFacts['imports'] = [];
	const body = text.match(/^import\s*\(([\s\S]*?)\)\s*$/)?.[1];
	if (!body) return entries;
	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('//')) continue;
		const parsed = parseGoImportHardened(trimmed);
		if (parsed) entries.push(parsed);
	}
	return entries;
}

function _parseGoImport(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// Block import: `import ( "fmt" "os" )` — return null here; buildFacts
	// detects block imports via the raw text starting with 'import (' and
	// iterates each import_spec child via its own capture walk.
	if (t.startsWith('import (')) return null;

	// Bare aliased spec from a block-import child: `f "fmt"`
	const bareAliased = t.match(/^(\w+)\s+"([^"]+)"$/);
	if (bareAliased) {
		return {
			specifier: bareAliased[2],
			importType: 'named',
			bindings: [{ imported: bareAliased[2], local: bareAliased[1] }],
		};
	}

	// Single-line `import foo "bar"` (aliased)
	const aliased = t.match(/^import\s+(\w+)\s+"([^"]+)"/);
	if (aliased) {
		return {
			specifier: aliased[2],
			importType: 'named',
			bindings: [{ imported: aliased[2], local: aliased[1] }],
		};
	}
	// Single-line `import "bar"` or bare quoted specifier `"bar"` (from a
	// block-import child that buildFacts feeds directly)
	const simple = t.match(/^import\s+"([^"]+)"|^"([^"]+)"$/);
	if (simple) {
		return {
			specifier: simple[1] ?? simple[2],
			importType: 'namespace',
			bindings: [],
		};
	}
	return null;
}

function parseGoImportHardened(
	text: string,
): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	if (t.startsWith('import (')) return null;

	// The `(?!import\b)` guard matters: without it, a SINGLE-LINE bare import
	// (`import "fmt"`) matched the bare-alias pattern with the literal keyword
	// `import` captured as the alias, yielding `{imported:'fmt', local:'import'}`.
	// Block-form bare imports were unaffected, so the two forms disagreed. A bare
	// import has no alias in either form and must fall through to `simple` below.
	const aliased =
		t.match(/^(?!import\b)([\w._]+)\s+["`]([^"`]+)["`]$/) ??
		t.match(/^import\s+([\w._]+)\s+["`]([^"`]+)["`]/);
	if (aliased) {
		if (aliased[1] === '_') {
			return { specifier: aliased[2], importType: 'sideeffect', bindings: [] };
		}
		if (aliased[1] === '.') {
			return {
				specifier: aliased[2],
				importType: 'namespace',
				bindings: [{ imported: '*', local: '.' }],
			};
		}
		return {
			specifier: aliased[2],
			importType: 'named',
			bindings: [{ imported: aliased[2], local: aliased[1] }],
		};
	}

	const simple = t.match(/^import\s+["`]([^"`]+)["`]|^["`]([^"`]+)["`]$/);
	if (!simple) return null;
	return {
		specifier: simple[1] ?? simple[2],
		importType: 'namespace',
		bindings: [],
	};
}

/**
 * Final segment of a dotted path (`java.util.List` -> `List`).
 *
 * `bindings[].imported` is consumed as the `toSymbol` of a graph edge
 * (the `toSymbol:` assignments in `buildSymbolEdges` /
 * `src/tools/repo-graph/builder.ts`), so it must be the *declaration
 * name* found in the target file — never the fully-qualified path, which
 * matches no def anywhere.
 */
function finalDottedSegment(path: string): string {
	// Strip a generic argument list first. A C# alias RHS may be a constructed
	// type (`using L = System.Collections.Generic.List<int>;`), and splitting on
	// the last dot alone produced `List<int>` as the `imported` name — which can
	// never match a declaration in the target file, silently creating a wrong
	// binding instead of cleanly omitting one. That violates this module's own
	// contract that `bindings[].imported` is the declaration name found in the
	// target file. A dot inside the generic arguments is also not a namespace
	// separator, so the argument list must go before `lastIndexOf('.')` runs.
	const withoutGenerics = path.replace(/<.*>$/s, '');
	const lastDot = withoutGenerics.lastIndexOf('.');
	return lastDot === -1 ? withoutGenerics : withoutGenerics.slice(lastDot + 1);
}

function parseJavaImport(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// import foo.Bar;
	// import static foo.Bar.baz;
	// import foo.*;  /  import static foo.Bar.*;
	const m = t.match(/^import\s+(static\s+)?([^;\s]+)\s*;?\s*$/);
	if (!m) return null;
	const isStatic = Boolean(m[1]);
	const path = m[2];
	const last = finalDottedSegment(path);
	// On-demand import: no single symbol is bound.
	if (last === '*') {
		return { specifier: path, importType: 'namespace', bindings: [] };
	}
	// `import static foo.Bar.baz` binds the member `baz` declared by the type
	// `foo.Bar`, so the module specifier is the type, not the member.
	const lastDot = path.lastIndexOf('.');
	const specifier = isStatic && lastDot !== -1 ? path.slice(0, lastDot) : path;
	return {
		specifier,
		importType: 'named',
		bindings: [{ imported: last, local: last }],
	};
}

function parseKotlinImport(text: string): FileSymbolFacts['imports'][0] | null {
	// import foo.Bar
	// import foo.Bar as baz
	// import foo.*
	// Multiple per import_header — each line is captured
	const t = text.trim();
	const aliased = t.match(/^import\s+([^;\s]+)\s+as\s+(\w+)/);
	if (aliased) {
		return {
			specifier: aliased[1],
			importType: 'named',
			bindings: [
				{ imported: finalDottedSegment(aliased[1]), local: aliased[2] },
			],
		};
	}
	const simple = t.match(/^import\s+([^;\s]+)/);
	if (!simple) return null;
	const path = simple[1];
	const last = finalDottedSegment(path);
	// Kotlin has no namespace-import form other than `a.b.*`; a plain import
	// always names one declaration.
	if (last === '*') {
		return { specifier: path, importType: 'namespace', bindings: [] };
	}
	return {
		specifier: path,
		importType: 'named',
		bindings: [{ imported: last, local: last }],
	};
}

function parseCSharpUsing(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// using foo;
	// using foo = foo.Bar;
	// using static foo.Bar;
	// global using foo;           (C# 10+; the default shape of a .NET 6+
	//                              GlobalUsings.cs, so omitting it silently
	//                              drops every import in modern projects)
	const m = t.match(
		/^(?:global\s+)?using\s+(?:static\s+)?([^=;\s]+)\s*(?:=\s*(.+?))?\s*;?\s*$/,
	);
	if (!m) return null;
	if (m[2]) {
		// Alias: `using Alias = System.Text.StringBuilder;`. The specifier stays
		// the full dotted right-hand side (parallel to a Java single-type
		// import); only the bound symbol becomes the final segment.
		const target = m[2].trim();
		return {
			specifier: target,
			importType: 'named',
			bindings: [{ imported: finalDottedSegment(target), local: m[1].trim() }],
		};
	}
	// A plain `using System.Text;` imports a namespace, not a declaration.
	return { specifier: m[1].trim(), importType: 'namespace', bindings: [] };
}

function parseCppInclude(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// Quoted include: #include "foo.h" / #include "sub/foo.h" / #include "../x.h".
	// Local includes resolve relative to the including file, so the specifier is
	// normalized to a './'-prefixed form that resolveModuleSpecifier can turn
	// into a file edge.
	const quoted = t.match(/^#\s*include\s+"([^"]+)"/);
	if (quoted) {
		const raw = quoted[1];
		const specifier = raw.startsWith('.') ? raw : `./${raw}`;
		return { specifier, importType: 'default', bindings: [] };
	}
	// Angle include: #include <foo.h>. Without build-system include paths these
	// stay external/unresolved (bare specifier; resolveModuleSpecifier returns
	// null and they are not reported as unresolved relative imports).
	const angle = t.match(/^#\s*include\s+<([^>]+)>/);
	if (angle) {
		return { specifier: angle[1], importType: 'namespace', bindings: [] };
	}
	// using foo::bar;
	// using namespace foo;
	const using = t.match(/^using\s+(?:namespace\s+)?(.+?)\s*;?\s*$/);
	if (using) {
		return {
			specifier: using[1].trim(),
			importType: 'namespace',
			bindings: [],
		};
	}
	return null;
}

function parseSwiftImport(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// Optional leading attributes: @_testable import Foo / @_exported import Foo
	const attrs = /^(?:@\w+(?:\([^)\n]*\))?\s+)*/.source;
	// import Foo                        → namespace import of module Foo
	// import Foo.Bar                    → namespace import of submodule Foo.Bar
	// import class Foo.Bar              → named import: module Foo, symbol Bar
	// import class Foo.Bar.Baz          → named import: module Foo, symbol Baz
	//   (middle components are a nested module path; the LAST component is the
	//   imported symbol — conservative, matches how the symbol is referenced)
	// The kind group requires its own trailing whitespace, so a module that
	// merely starts with a keyword (`import classFoo`) is not split.
	const m = t.match(
		new RegExp(
			`${attrs}import\\s+((?:class|struct|enum|protocol|typealias|func|var|let)\\s+)?([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\s*$`,
		),
	);
	if (!m) return null;
	const path = m[2]!.split('.');
	if (m[1] !== undefined && path.length >= 2) {
		const imported = path[path.length - 1]!;
		return {
			specifier: path[0]!,
			importType: 'named',
			bindings: [{ imported, local: imported }],
		};
	}
	// No kind keyword, or a kind with no dotted path (not valid Swift — keep
	// the whole specifier rather than dropping the import).
	return { specifier: m[2]!, importType: 'namespace', bindings: [] };
}

function parseDartImport(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// import 'foo';
	// import 'foo' as bar;
	// import 'foo' show A, B;
	// import 'foo' hide A;
	const m = t.match(/^import\s+['"]([^'"]+)['"]\s+as\s+(\w+)/);
	if (m) {
		return {
			specifier: m[1],
			importType: 'named',
			bindings: [{ imported: m[1], local: m[2] }],
		};
	}
	const simple = t.match(/^import\s+['"]([^'"]+)['"]/);
	if (simple) {
		return { specifier: simple[1], importType: 'namespace', bindings: [] };
	}
	return null;
}

function parseRubyRequire(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// Input is the string_content node text (no surrounding quotes).
	// e.g. "json" for require 'json'
	// e.g. "./foo" for require_relative './foo'
	// When the require keyword is included (full call text), strip it.
	const stripped = t
		.replace(/^(?:require(?:_relative)?)\s+['"]?/, '')
		.replace(/['"]$/, '');
	if (!stripped || stripped === t) return null;
	const isRelative = stripped.startsWith('./') || stripped.startsWith('../');
	return {
		specifier: stripped,
		importType: isRelative ? 'default' : 'namespace',
		bindings: [],
	};
}

function parsePhpUse(text: string): FileSymbolFacts['imports'][0] | null {
	const t = text.trim();
	// use foo\Bar;
	// use foo\Bar as Baz;
	// use function foo\baz;
	// use const foo\BAZ;
	const m = t.match(
		/^use\s+(?:(?:function|const)\s+)?([^;\s]+)\s+as\s+(\w+)\s*;?\s*$/i,
	);
	if (m) {
		return {
			specifier: m[1],
			importType: 'named',
			bindings: [{ imported: m[1], local: m[2] }],
		};
	}
	const simple = t.match(
		/^use\s+(?:(?:function|const)\s+)?([^;\s]+)\s*;?\s*$/i,
	);
	if (simple) {
		return { specifier: simple[1], importType: 'namespace', bindings: [] };
	}
	return null;
}

function isTopLevelDef(defNode: TsNode, root: TsNode): boolean {
	let parent: TsNode | null = defNode.parent;
	while (parent && parent !== root) {
		if (DEF_TYPES.has(parent.type)) return false;
		parent = parent.parent;
	}
	return true;
}

function findEnclosingDecl(
	refNode: TsNode,
	topLevelDefs: Array<{ name: string; node: TsNode }>,
): string | null {
	let best: { name: string; node: TsNode } | null = null;
	let bestDist = Infinity;

	for (const def of topLevelDefs) {
		if (isNodeInside(def.node, refNode)) {
			const dist = refNode.startPosition.row - def.node.startPosition.row;
			if (dist < bestDist) {
				bestDist = dist;
				best = def;
			}
		}
	}

	return best?.name ?? '<module>';
}

function isNodeInside(outer: TsNode, inner: TsNode): boolean {
	return (
		inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex
	);
}

/**
 * Node type of the nearest ancestor whose type is in `types`, or `undefined`.
 * Unlike `hasAncestorOfType` this reports *which* container matched, which the
 * container-kind visibility matrix needs.
 */
function nearestAncestorType(
	node: TsNode,
	types: Set<string>,
): string | undefined {
	let current: TsNode | null = node.parent;
	while (current) {
		if (types.has(current.type)) return current.type;
		current = current.parent;
	}
	return undefined;
}

function hasAncestorOfType(node: TsNode, types: Set<string> | string): boolean {
	const typeSet = typeof types === 'string' ? new Set([types]) : types;
	let current: TsNode | null = node.parent;
	while (current) {
		if (typeSet.has(current.type)) return true;
		current = current.parent;
	}
	return false;
}

function isInsideRequireCall(node: TsNode): boolean {
	let current: TsNode | null = node.parent;
	while (current) {
		if (current.type === 'call_expression') {
			const fn = current.children.find((c) => c && c.type === 'identifier');
			if (fn && fn.text === 'require') return true;
		}
		if (DEF_TYPES.has(current.type)) return false;
		current = current.parent;
	}
	return false;
}

/**
 * Returns true if the node is nested inside an import/use/using declaration
 * (i.e. the identifier is part of an import statement itself, not a usage).
 * This prevents import-line identifiers (e.g. 'p' in `import X as p`,
 * 'Map' in `use ... as Map`, 'List' in `import java.util.List`) from
 * appearing in the refs list before the body refs.
 */
const IMPORT_ANCESTOR_TYPES = new Set([
	'import_statement',
	'import_from_statement',
	'import_declaration',
	'import_header',
	'use_declaration',
	'using_directive',
	'namespace_use_declaration',
	'library_import', // dart
]);

function isInsideImportStatement(node: TsNode): boolean {
	return hasAncestorOfType(node, IMPORT_ANCESTOR_TYPES);
}

function nodeKey(node: TsNode): string {
	return `${node.startPosition.row},${node.startPosition.column}-${node.endPosition.row},${node.endPosition.column}`;
}

/**
 * True when `defNode` is the declaration an export statement itself declares,
 * rather than something nested deeper inside it.
 *
 * Uses the grammar's own `declaration` / `value` field accessors instead of
 * enumerating child node types: the field is defined by the grammar for every
 * legal shape, so this stays correct for `export default class`,
 * `export default function`, `export default <expression>` and anything a
 * future grammar bump adds, without a skip-list to keep in sync.
 *
 * Members of an `export default` declaration are still `exported` (matching the
 * named-export path, where `export class Foo { bar() {} }` marks `bar`
 * exported). They simply keep their real names instead of all becoming
 * `default`.
 */
function isOwnExportDeclaration(en: TsNode, defNode: TsNode): boolean {
	const owner =
		en.childForFieldName?.('declaration') ?? en.childForFieldName?.('value');
	if (owner) {
		return (
			owner.startIndex === defNode.startIndex &&
			owner.endIndex === defNode.endIndex
		);
	}
	// No declaration/value field (unusual grammar shape): fall back to the old
	// containment test rather than silently dropping the default marking.
	return isNodeInside(en, defNode);
}

function isDefaultExportStatement(en: TsNode): boolean {
	// Structural check: export_statement has a 'default' keyword child
	if (en.children.some((c) => c !== null && c.type === 'default')) {
		return true;
	}
	// Fallback: text-based check for robustness
	return /^export\s+default\b/.test(en.text);
}

function isEsMGrammar(grammarId: string): boolean {
	return (
		grammarId === 'typescript' ||
		grammarId === 'tsx' ||
		grammarId === 'javascript'
	);
}
