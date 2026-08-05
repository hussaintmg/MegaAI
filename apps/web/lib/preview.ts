/**
 * Turn one delivered HTML file into a self-contained page.
 *
 * The dashboard previews a delivery inside a sandboxed, null-origin iframe, so
 * the page cannot fetch its own stylesheet or script — they have to be inlined
 * first, or every preview renders as unstyled markup.
 */

import type { GoalFile } from './delivery';

export function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Resolve a relative href in `from`'s directory. Empty for absolute URLs. */
export function resolveRelative(from: string, href: string): string {
  const clean = href.split(/[?#]/)[0] ?? '';
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return '';
  if (clean.startsWith('/')) return clean.slice(1);
  const dir = from.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') dir.pop();
    else dir.push(part);
  }
  return dir.join('/');
}

export function buildPreview(file: GoalFile, files: readonly GoalFile[]): string {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const lookup = (href: string): string | undefined => {
    const target = resolveRelative(file.path, href);
    if (!target) return undefined;
    const hit = byPath.get(target) ?? files.find((f) => f.path.endsWith(`/${target}`));
    return hit?.text;
  };

  let html = file.text ?? '';
  // Function replacers throughout: `$&` and `$1` occur in real CSS and JS, and
  // as a replacement *string* they would corrupt the file being inlined.
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*['"]?stylesheet/i.test(tag)) return tag;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const css = href ? lookup(href) : undefined;
    return css === undefined ? tag : `<style>\n${css}\n</style>`;
  });
  html = html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs: string) => {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const js = src ? lookup(src) : undefined;
    // A closing tag inside the source would end the block early.
    return js === undefined ? tag : `<script>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });
  return html;
}
