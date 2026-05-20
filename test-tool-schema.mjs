import { tool } from '@opencode-ai/plugin/tool';
console.log('tool:', typeof tool);
console.log('tool.schema:', typeof tool.schema);
if (tool.schema) {
  console.log('tool.schema keys:', Object.keys(tool.schema).slice(0, 10));
  console.log('tool.schema.string:', typeof tool.schema.string);
  console.log('tool.schema.boolean:', typeof tool.schema.boolean);
  const str = tool.schema.string();
  console.log('z.string() returns:', str);
  console.log('z.string().min:', typeof str.min);
}
