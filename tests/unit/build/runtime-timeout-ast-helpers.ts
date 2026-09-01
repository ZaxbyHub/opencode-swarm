import ts from 'typescript';

export function unwrapExpression(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

export function isNamedReference(
	node: ts.Expression,
	aliases: ReadonlySet<string>,
): boolean {
	const expression = unwrapExpression(node);
	return ts.isIdentifier(expression) && aliases.has(expression.text);
}

export function collectBindingAliases(
	pattern: ts.ObjectBindingPattern,
	propertyText: string,
	aliases: Set<string>,
	markChanged: () => void,
): void {
	for (const element of pattern.elements) {
		if (
			propertyNameText(element.propertyName ?? element.name) === propertyText &&
			ts.isIdentifier(element.name) &&
			!aliases.has(element.name.text)
		) {
			aliases.add(element.name.text);
			markChanged();
		}
		if (ts.isObjectBindingPattern(element.name)) {
			collectBindingAliases(element.name, propertyText, aliases, markChanged);
		}
	}
}

export function isStringReference(
	node: ts.Expression,
	aliases: ReadonlySet<string>,
	literalText: string,
): boolean {
	const expression = unwrapExpression(node);
	return (
		(ts.isIdentifier(expression) && aliases.has(expression.text)) ||
		staticStringValue(expression) === literalText
	);
}

export function isTimeoutKeyReference(
	node: ts.Expression,
	aliases: ReadonlySet<string>,
): boolean {
	return isStringReference(node, aliases, 'timeout');
}

export function isReflectGetReference(
	node: ts.Expression,
	reflectAliases: ReadonlySet<string> = new Set(['Reflect']),
): boolean {
	const expression = unwrapExpression(node);
	return (
		(ts.isPropertyAccessExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			reflectAliases.has(expression.expression.text) &&
			expression.name.text === 'get') ||
		(ts.isElementAccessExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			reflectAliases.has(expression.expression.text) &&
			expression.argumentExpression !== undefined &&
			ts.isStringLiteralLike(expression.argumentExpression) &&
			expression.argumentExpression.text === 'get')
	);
}

export function propertyNameText(
	name: ts.PropertyName | undefined,
): string | undefined {
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
	if (ts.isComputedPropertyName(name))
		return staticStringValue(name.expression);
	return undefined;
}

export function staticStringValue(
	node: ts.Expression,
	aliases: ReadonlyMap<string, string> = new Map(),
): string | undefined {
	const expression = unwrapExpression(node);
	if (ts.isStringLiteralLike(expression)) return expression.text;
	if (ts.isIdentifier(expression)) return aliases.get(expression.text);
	if (
		ts.isBinaryExpression(expression) &&
		expression.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		const left = staticStringValue(expression.left, aliases);
		const right = staticStringValue(expression.right, aliases);
		return left !== undefined && right !== undefined ? left + right : undefined;
	}
	return undefined;
}

export function countTimeoutBindings(pattern: ts.ObjectBindingPattern): number {
	return pattern.elements.reduce((count, element) => {
		const current =
			propertyNameText(element.propertyName ?? element.name) === 'timeout'
				? 1
				: 0;
		return (
			count +
			current +
			(ts.isObjectBindingPattern(element.name)
				? countTimeoutBindings(element.name)
				: 0)
		);
	}, 0);
}

export function countNestedTimeoutBindings(
	pattern: ts.ObjectBindingPattern,
): number {
	return pattern.elements.reduce((count, element) => {
		const property = propertyNameText(element.propertyName ?? element.name);
		if (property !== 'AbortSignal') return count;
		return (
			count +
			(ts.isObjectBindingPattern(element.name)
				? countTimeoutBindings(element.name)
				: 0)
		);
	}, 0);
}

export function countNestedTimeoutObjectProperties(
	object: ts.ObjectLiteralExpression,
): number {
	return object.properties.reduce((count, property) => {
		if (propertyNameText(property.name) !== 'AbortSignal') return count;
		if (!ts.isPropertyAssignment(property)) return count;
		if (ts.isObjectLiteralExpression(property.initializer)) {
			return (
				count +
				property.initializer.properties.filter(
					(nested) => propertyNameText(nested.name) === 'timeout',
				).length
			);
		}
		return 0;
	}, 0);
}

export function hasShadowingBinding(
	sourceFile: ts.SourceFile,
	name: string,
	node?: ts.Node,
): boolean {
	let shadowed = false;
	const limit = node?.getStart(sourceFile) ?? Number.POSITIVE_INFINITY;
	const visit = (current: ts.Node): void => {
		if (shadowed || current.getStart(sourceFile) >= limit) return;
		if (
			!ts.isImportSpecifier(current) &&
			(ts.isVariableDeclaration(current) || ts.isParameter(current)) &&
			current.name !== undefined &&
			bindingNameContains(current.name, name)
		) {
			shadowed = true;
			return;
		}
		if (
			ts.isCatchClause(current) &&
			current.variableDeclaration !== undefined &&
			bindingNameContains(current.variableDeclaration.name, name)
		) {
			shadowed = true;
			return;
		}
		if (
			(ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) &&
			current.name?.text === name
		) {
			shadowed = true;
			return;
		}
		if (
			(ts.isFunctionExpression(current) || ts.isClassExpression(current)) &&
			current.name?.text === name
		) {
			shadowed = true;
			return;
		}
		ts.forEachChild(current, visit);
	};
	visit(sourceFile);
	return shadowed;
}

export function bindingNameContains(
	binding: ts.BindingName,
	name: string,
): boolean {
	if (ts.isIdentifier(binding)) return binding.text === name;
	return binding.elements.some(
		(element) =>
			!ts.isOmittedExpression(element) &&
			bindingNameContains(element.name, name),
	);
}
