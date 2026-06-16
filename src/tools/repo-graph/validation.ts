/**
 * Validation functions for workspace paths, graph nodes, and graph edges.
 *
 * All public functions throw descriptive errors on invalid input so callers
 * can surface actionable messages rather than obscure downstream failures.
 */

import {
	containsControlChars,
	containsPathTraversal,
} from '../../utils/path-security';
import {
	DATA_ACCESS_VALUES,
	DATA_OPERATION_VALUES,
	FILE_ROLE_VALUES,
	type GraphEdge,
	type GraphNode,
	IMPORT_TYPE_VALUES,
	ONTOLOGY_FINDING_SEVERITY_VALUES,
	ROUTE_METHOD_VALUES,
	ROUTE_SOURCE_VALUES,
	SECURITY_CONFIDENCE_VALUES,
	SECURITY_KIND_VALUES,
} from './types';

const FILE_ROLE_SET = new Set<string>(FILE_ROLE_VALUES);
const ROUTE_METHOD_SET = new Set<string>(ROUTE_METHOD_VALUES);
const ROUTE_SOURCE_SET = new Set<string>(ROUTE_SOURCE_VALUES);
const DATA_OPERATION_SET = new Set<string>(DATA_OPERATION_VALUES);
const DATA_ACCESS_SET = new Set<string>(DATA_ACCESS_VALUES);
const SECURITY_KIND_SET = new Set<string>(SECURITY_KIND_VALUES);
const SECURITY_CONFIDENCE_SET = new Set<string>(SECURITY_CONFIDENCE_VALUES);
const ONTOLOGY_FINDING_SEVERITY_SET = new Set<string>(
	ONTOLOGY_FINDING_SEVERITY_VALUES,
);
const IMPORT_TYPE_SET = new Set<string>(IMPORT_TYPE_VALUES);
const ONTOLOGY_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// ============ Validation ============

/**
 * Validate that a workspace directory is safe to use.
 * Accepts both absolute and relative paths.
 *
 * @param workspace - The workspace directory (path, absolute or relative, e.g. "/home/user/project" or "my-project")
 * @throws Error if the workspace is invalid
 */
export function validateWorkspace(workspace: string): void {
	if (!workspace || typeof workspace !== 'string' || workspace.trim() === '') {
		throw new Error('Invalid workspace: must be a non-empty string');
	}
	if (containsControlChars(workspace)) {
		throw new Error('Invalid workspace: control characters detected');
	}
	if (containsPathTraversal(workspace)) {
		throw new Error('Invalid workspace: path traversal detected');
	}
}

/**
 * Validate a graph node before adding to the graph.
 * @param node - The node to validate
 * @throws Error if the node is invalid
 */
export function validateGraphNode(node: GraphNode): void {
	if (!node || typeof node !== 'object') {
		throw new Error('Invalid node: must be an object');
	}
	if (!node.filePath || typeof node.filePath !== 'string') {
		throw new Error('Invalid node: filePath is required');
	}
	// filePath must be absolute
	if (
		!node.filePath.startsWith('/') &&
		!/^[A-Za-z]:[/\\]/.test(node.filePath)
	) {
		throw new Error('Invalid node: filePath must be absolute');
	}
	if (containsPathTraversal(node.filePath)) {
		throw new Error('Invalid node: filePath contains path traversal');
	}
	if (containsControlChars(node.filePath)) {
		throw new Error('Invalid node: filePath contains control characters');
	}
	if (!node.moduleName || typeof node.moduleName !== 'string') {
		throw new Error('Invalid node: moduleName is required');
	}
	// moduleName must be a relative path (not absolute, no traversal)
	if (
		node.moduleName.startsWith('/') ||
		node.moduleName.startsWith('\\') ||
		/^[A-Za-z]:[/\\]/.test(node.moduleName)
	) {
		throw new Error('Invalid node: moduleName must be relative');
	}
	if (containsPathTraversal(node.moduleName)) {
		throw new Error('Invalid node: moduleName contains path traversal');
	}
	if (containsControlChars(node.moduleName)) {
		throw new Error('Invalid node: moduleName contains control characters');
	}
	if (typeof node.language !== 'string') {
		throw new Error('Invalid node: language is required');
	}
	if (typeof node.mtime !== 'string') {
		throw new Error('Invalid node: mtime is required');
	}
	if (!Array.isArray(node.exports)) {
		throw new Error('Invalid node: exports must be an array');
	}
	for (const exp of node.exports) {
		if (typeof exp !== 'string') {
			throw new Error('Invalid node: exports must be an array of strings');
		}
		if (containsControlChars(exp)) {
			const preview = exp.slice(0, 120);
			throw new Error(
				`Invalid node: exports contains control characters (file=${node.filePath}, value="${preview}")`,
			);
		}
	}
	if (!Array.isArray(node.imports)) {
		throw new Error('Invalid node: imports must be an array');
	}
	for (const imp of node.imports) {
		if (typeof imp !== 'string') {
			throw new Error('Invalid node: imports must be an array of strings');
		}
		if (containsControlChars(imp)) {
			const preview = imp.slice(0, 120);
			throw new Error(
				`Invalid node: imports contains control characters (file=${node.filePath}, value="${preview}")`,
			);
		}
	}
	if (node.ontology !== undefined) {
		validateOntologyStrings(node);
	}
}

function validateOntologyStrings(node: GraphNode): void {
	const ontology = node.ontology;
	if (!ontology || typeof ontology !== 'object') {
		throw new Error('Invalid node: ontology must be an object');
	}
	const values: string[] = [
		...(ontology.roles ?? []),
		ontology.packageBoundary,
		...(ontology.routes ?? []).flatMap((route) => [
			route.method,
			route.path,
			route.source,
		]),
		...(ontology.dataOperations ?? []).flatMap((fact) => [
			fact.operation,
			fact.access,
			fact.entity ?? '',
			fact.evidence,
		]),
		...(ontology.security ?? []).flatMap((fact) => [
			fact.kind,
			fact.evidence,
			fact.confidence,
		]),
		...(ontology.conventions ?? []).flatMap((fact) => [
			fact.name,
			fact.evidence,
		]),
		...(ontology.findings ?? []).flatMap((finding) => [
			finding.code,
			finding.severity,
			finding.message,
		]),
	];
	for (const value of values) {
		if (typeof value !== 'string') {
			throw new Error('Invalid node: ontology contains non-string value');
		}
		if (containsControlChars(value)) {
			const preview = value.slice(0, 120);
			throw new Error(
				`Invalid node: ontology contains control characters (file=${node.filePath}, value="${preview}")`,
			);
		}
	}
	for (const role of ontology.roles ?? []) {
		validateAllowedOntologyValue(node, 'ontology.roles', role, FILE_ROLE_SET);
	}
	for (const route of ontology.routes ?? []) {
		validateAllowedOntologyValue(
			node,
			'ontology.routes.method',
			route.method,
			ROUTE_METHOD_SET,
		);
		validateAllowedOntologyValue(
			node,
			'ontology.routes.source',
			route.source,
			ROUTE_SOURCE_SET,
		);
	}
	for (const fact of ontology.dataOperations ?? []) {
		validateAllowedOntologyValue(
			node,
			'ontology.dataOperations.operation',
			fact.operation,
			DATA_OPERATION_SET,
		);
		validateAllowedOntologyValue(
			node,
			'ontology.dataOperations.access',
			fact.access,
			DATA_ACCESS_SET,
		);
	}
	for (const fact of ontology.security ?? []) {
		validateAllowedOntologyValue(
			node,
			'ontology.security.kind',
			fact.kind,
			SECURITY_KIND_SET,
		);
		validateAllowedOntologyValue(
			node,
			'ontology.security.confidence',
			fact.confidence,
			SECURITY_CONFIDENCE_SET,
		);
	}
	for (const finding of ontology.findings ?? []) {
		validateOntologyName(node, 'ontology.findings.code', finding.code);
		validateAllowedOntologyValue(
			node,
			'ontology.findings.severity',
			finding.severity,
			ONTOLOGY_FINDING_SEVERITY_SET,
		);
	}
}

function validateOntologyName(
	node: GraphNode,
	field: string,
	value: string,
): void {
	if (ONTOLOGY_NAME_PATTERN.test(value)) return;
	const preview = value.slice(0, 120);
	throw new Error(
		`Invalid node: ${field} must be lower_snake_case (file=${node.filePath}, value="${preview}")`,
	);
}

function validateAllowedOntologyValue(
	node: GraphNode,
	field: string,
	value: string,
	allowed: ReadonlySet<string>,
): void {
	if (allowed.has(value)) return;
	const preview = value.slice(0, 120);
	throw new Error(
		`Invalid node: ${field} contains invalid value (file=${node.filePath}, value="${preview}")`,
	);
}

/**
 * Validate a graph edge before adding to the graph.
 * @param edge - The edge to validate
 * @throws Error if the edge is invalid
 */
export function validateGraphEdge(edge: GraphEdge): void {
	if (!edge || typeof edge !== 'object') {
		throw new Error('Invalid edge: must be an object');
	}
	if (!edge.source || typeof edge.source !== 'string') {
		throw new Error('Invalid edge: source is required');
	}
	if (!edge.target || typeof edge.target !== 'string') {
		throw new Error('Invalid edge: target is required');
	}
	if (
		containsPathTraversal(edge.source) ||
		containsPathTraversal(edge.target)
	) {
		throw new Error('Invalid edge: path traversal detected');
	}
	if (containsControlChars(edge.source) || containsControlChars(edge.target)) {
		throw new Error('Invalid edge: control characters detected');
	}
	if (!edge.importSpecifier || typeof edge.importSpecifier !== 'string') {
		throw new Error('Invalid edge: importSpecifier is required');
	}
	if (containsControlChars(edge.importSpecifier)) {
		throw new Error(
			'Invalid edge: importSpecifier contains control characters',
		);
	}
	if (!IMPORT_TYPE_SET.has(edge.importType)) {
		throw new Error('Invalid edge: importType is invalid');
	}
	if (edge.importedSymbols !== undefined) {
		if (!Array.isArray(edge.importedSymbols)) {
			throw new Error('Invalid edge: importedSymbols must be an array');
		}
		for (const symbol of edge.importedSymbols) {
			if (typeof symbol !== 'string') {
				throw new Error(
					'Invalid edge: importedSymbols must be an array of strings',
				);
			}
			if (containsControlChars(symbol)) {
				throw new Error(
					'Invalid edge: importedSymbols contains control characters',
				);
			}
		}
	}
}
