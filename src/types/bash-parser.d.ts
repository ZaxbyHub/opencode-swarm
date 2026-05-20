/**
 * TypeScript declarations for bash-parser
 * Minimal declarations sufficient for build — AST is dynamic, use index signatures where needed
 */

declare module 'bash-parser' {
	export interface WordNode {
		type: 'Word';
		text: string;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface RedirectNode {
		type: 'Redirect';
		op: WordNode;
		file: WordNode;
		numberIo?: WordNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface CommandNode {
		type: 'Command';
		name?: WordNode;
		prefix?: WordNode[];
		suffix?: WordNode[];
		redirections?: RedirectNode[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		async?: boolean;
		bang?: boolean;
		[key: string]: unknown;
	}

	export interface SimpleCommandNode {
		type: 'SimpleCommand';
		name: WordNode;
		suffix?: WordNode[];
		[key: string]: unknown;
	}

	export interface PipelineNode {
		type: 'Pipeline';
		commands: CommandNode[];
		bang?: boolean;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface SubshellNode {
		type: 'Subshell';
		list: CommandNode | PipelineNode | LogicalExpressionNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface CompoundListNode {
		type: 'CompoundList';
		commands: (CommandNode | PipelineNode | LogicalExpressionNode)[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface LogicalExpressionNode {
		type: 'LogicalExpression';
		op: 'and' | 'or';
		left: CommandNode | PipelineNode | SubshellNode | LogicalExpressionNode;
		right: CommandNode | PipelineNode | SubshellNode | LogicalExpressionNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface ForNode {
		type: 'For';
		name: WordNode;
		wordlist?: WordNode[];
		do: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface WhileNode {
		type: 'While';
		clause: CompoundListNode;
		do: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface UntilNode {
		type: 'Until';
		clause: CompoundListNode;
		do: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface IfNode {
		type: 'If';
		clause: CompoundListNode;
		then: CompoundListNode;
		else?: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface FunctionNode {
		type: 'Function';
		name: WordNode;
		body: CommandNode;
		redirections?: RedirectNode[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface CaseItemNode {
		type: 'CaseItem';
		pattern: WordNode[];
		body: CompoundListNode;
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface CaseNode {
		type: 'Case';
		clause: WordNode;
		cases?: CaseItemNode[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export type ASTNode =
		| WordNode
		| RedirectNode
		| CommandNode
		| SimpleCommandNode
		| PipelineNode
		| SubshellNode
		| CompoundListNode
		| LogicalExpressionNode
		| ForNode
		| WhileNode
		| UntilNode
		| IfNode
		| FunctionNode
		| CaseNode
		| CaseItemNode
		| ScriptNode;

	export interface ScriptNode {
		type: 'Script';
		commands: (
			| CommandNode
			| PipelineNode
			| LogicalExpressionNode
			| SubshellNode
		)[];
		loc?: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		[key: string]: unknown;
	}

	export interface ParseOptions {
		mode?: 'posix' | 'bash' | 'word-expansion';
		insertLOC?: boolean;
	}

	function parse(command: string, options?: ParseOptions): ScriptNode;
	export default parse;
}
