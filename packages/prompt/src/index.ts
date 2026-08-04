/**
 * @megaai/prompt — prompts are compiled, not hand-written.
 *
 * Assembles system and task prompts from structured parts (role, tool
 * catalog, constraints, context, output spec) and defines the action
 * protocol every agent answers in.
 */

import type { ChatContentPart, ChatMessage, TaskRecord } from '@megaai/types';

/** The JSON contract agents must answer with (parsed by @megaai/actions). */
export const ACTION_PROTOCOL = `Respond with a single JSON object and nothing else:
{
  "thoughts": "brief private reasoning",
  "summary": "one or two sentences describing what you did, written for the human dashboard",
  "actions": [
    { "tool": "<tool name>", "input": { ... }, "reason": "why this action" }
  ]
}
Rules:
- Only use tools from the tool catalog; keep "actions" empty when none are needed.
- File paths are relative to the project workspace.
- Never invent tool names or extra top-level keys.`;

/** `{{name}}` substitution — unknown variables render as empty strings. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined ? '' : String(value);
  });
}

export interface SystemPromptParts {
  agentName: string;
  role: string;
  toolCatalog?: string;
  constraints?: string[];
  extraSections?: Array<{ title: string; body: string }>;
}

export function buildSystemPrompt(parts: SystemPromptParts): string {
  const sections: string[] = [
    `You are ${parts.agentName}, an autonomous agent inside MegaAI — an AI system that runs software projects end to end.`,
    `## Role\n${parts.role}`,
  ];
  if (parts.toolCatalog && parts.toolCatalog.length > 0) {
    sections.push(`## Tool catalog\n${parts.toolCatalog}`);
  }
  const constraints = [
    'Stay strictly within the current task; do not invent extra scope.',
    'Prefer small, verifiable steps over sweeping changes.',
    ...(parts.constraints ?? []),
  ];
  sections.push(`## Constraints\n${constraints.map((c) => `- ${c}`).join('\n')}`);
  for (const extra of parts.extraSections ?? []) {
    sections.push(`## ${extra.title}\n${extra.body}`);
  }
  sections.push(`## Output format\n${ACTION_PROTOCOL}`);
  return sections.join('\n\n');
}

export interface TaskPromptParts {
  task: Pick<TaskRecord, 'title' | 'description' | 'agentKind'>;
  contextText?: string;
  priorAttemptError?: string;
  /** Images already loaded and base64-encoded (see @megaai/orchestrator, TaskRecord.attachments). */
  images?: ChatContentPart[];
}

export function buildTaskMessages(parts: TaskPromptParts): ChatMessage[] {
  const lines: string[] = [
    `# Task\n${parts.task.title}`,
    parts.task.description ? `## Details\n${parts.task.description}` : '',
    parts.contextText ? `## Context\n${parts.contextText}` : '',
    parts.images && parts.images.length > 0
      ? `## Attachments\n${parts.images.length} image(s) are attached below — look at them before answering.`
      : '',
    parts.priorAttemptError
      ? `## Previous attempt failed\n${parts.priorAttemptError}\nFix the cause and try a different approach.`
      : '',
    'Execute this task now and answer in the required JSON format.',
  ].filter((line) => line.length > 0);
  const text = lines.join('\n\n');
  const content: ChatMessage['content'] =
    parts.images && parts.images.length > 0 ? [{ type: 'text', text }, ...parts.images] : text;
  return [{ role: 'user', content }];
}
