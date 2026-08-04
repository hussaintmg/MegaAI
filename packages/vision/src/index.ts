/**
 * @megaai/vision — the vision engine (Phase 3): reads images out of the
 * sandboxed workspace and turns them into multimodal chat content.
 *
 * Understanding the image is delegated to whichever provider serves the
 * request — vision-capable models take `ChatImagePart`s directly (see
 * `@megaai/types` and `@megaai/prompt`'s `buildTaskMessages({ images })`).
 * This package only handles the safe, sandboxed plumbing: validating the
 * file lives in the workspace, checking its type and size, and
 * base64-encoding it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ChatImagePart, JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Tool } from '@megaai/contracts';
import { resolveInWorkspace } from '@megaai/tools';

const MIME_BY_EXT: Record<string, ChatImagePart['mimeType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Enough for a full-page screenshot; keeps prompts and memory bounded. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ReadImageResult {
  path: string;
  mimeType: ChatImagePart['mimeType'];
  bytes: number;
  part: ChatImagePart;
}

/** Read an image from inside the workspace sandbox as a base64 `ChatImagePart`. */
export function readImagePart(workspaceRoot: string, relPath: string): ReadImageResult {
  const target = resolveInWorkspace(workspaceRoot, relPath);
  const mimeType = MIME_BY_EXT[extname(target).toLowerCase()];
  if (!mimeType) {
    throw new MegaError(
      'INVALID_INPUT',
      `Unsupported image type "${extname(target)}" (expected .png, .jpg, .jpeg, .webp or .gif)`,
    );
  }
  if (!existsSync(target)) throw new MegaError('NOT_FOUND', `Image not found: ${relPath}`);
  const bytes = statSync(target).size;
  if (bytes > MAX_IMAGE_BYTES) {
    throw new MegaError('INVALID_INPUT', `Image too large (${bytes} bytes > ${MAX_IMAGE_BYTES})`);
  }
  const data = readFileSync(target).toString('base64');
  return { path: relPath, mimeType, bytes, part: { type: 'image', mimeType, data } };
}

function str(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new MegaError('INVALID_INPUT', `Tool input "${key}" must be a string`);
  }
  return value;
}

/** Agent-facing tool: read a workspace image and return it base64-encoded. */
export const visionReadImageTool: Tool = {
  name: 'vision.readImage',
  description:
    'Read a PNG/JPEG/WebP/GIF image from the project workspace (e.g. a screenshot) and return it base64-encoded for visual analysis',
  inputSchema: { path: 'string (relative, .png/.jpg/.jpeg/.webp/.gif)' },
  permissions: ['vision.read'],
  async execute(input, ctx) {
    const result = readImagePart(ctx.workspaceRoot, str(input, 'path'));
    const out: JsonValue = {
      path: result.path,
      mimeType: result.mimeType,
      bytes: result.bytes,
      base64: result.part.data,
    };
    return out;
  },
};

/** The vision tool set agents may use inside their workspace. */
export function createVisionTools(): Tool[] {
  return [visionReadImageTool];
}
