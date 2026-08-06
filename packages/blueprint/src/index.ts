/**
 * @megaai/blueprint — the plan, the prompts, and who starts next.
 *
 * The division of labour this package exists to enforce:
 *
 *   **MegaAI's own model thinks. It never types.** It plans the work, writes
 *   the briefs and decides who goes next.
 *
 *   **Claude Code, Codex and OpenCode write every line of code.** Nothing here
 *   produces a source file; it produces the instruction one of them is given.
 */

export {
  SURFACES,
  WEB_APP_SURFACES,
  blueprintFromJson,
  blueprintToJson,
  extractJson,
  missingSurfaces,
  parseBlueprint,
  planningPrompt,
  type Blueprint,
  type ParseResult,
  type PlanRequest,
  type Surface,
  type WorkPiece,
} from './blueprint.js';

export { STANDARD, taskTitle, writeAllPrompts, writePrompt, type PromptOptions } from './prompts.js';

export {
  busyFiles,
  completedSummaries,
  pathsCollide,
  piecesCollide,
  progressOf,
  schedule,
  type PieceState,
  type PieceStatus,
  type ScheduleOptions,
  type ScheduleResult,
} from './schedule.js';
