/**
 * Work that happens on the screen, not in a pipe.
 *
 * Most coding work is better off headless — it runs while you are using the
 * laptop, it survives the lid closing, and nothing steals your focus. But some
 * of it genuinely is not: opening VS Code on the project so you can look at it
 * in the morning, and running Codex as the full application inside that editor
 * rather than as a one-shot command, with the brief actually delivered into it.
 *
 * That is what this file does, on Windows, with no new dependencies: a small
 * language of steps — launch, focus, move, click, key, paste — rendered into a
 * PowerShell script that drives the real mouse and the real keyboard through
 * `user32.dll`.
 *
 * Two decisions worth knowing about:
 *
 * **Long text is pasted, never typed.** `SendKeys` mangles a multi-line brief:
 * `+^%~(){}[]` are all control characters to it, a newline submits the prompt
 * halfway through, and a 4 KB brief takes half a minute of visible typing that
 * any stray keystroke corrupts. The brief goes to a file, the file goes to the
 * clipboard, and one Ctrl+V puts it in exactly as written.
 *
 * **The brief never goes inside the script.** A generated PowerShell literal
 * containing an arbitrary 4 KB of quotes, backticks, `$variables` and Windows
 * paths is a quoting bug waiting to happen, and the failure mode is a script
 * that runs something other than what was intended. It is read from a file at
 * run time instead, so nothing in the brief is ever parsed as code.
 */

import type { JsonObject } from '@megaai/types';
import type { TaskContext, TaskHandler, TaskOutcome } from './agent.js';

export type GuiStep =
  /** Start an application. */
  | { do: 'launch'; file: string; args?: string[] }
  /** Bring the window whose title contains this to the front. */
  | { do: 'focus'; titleContains: string; timeoutMs?: number }
  | { do: 'move'; x: number; y: number }
  | { do: 'click'; x?: number; y?: number; button?: 'left' | 'right'; double?: boolean }
  /** A key sequence in SendKeys notation, e.g. `^\`` or `{ENTER}`. */
  | { do: 'keys'; keys: string }
  /** Short literal text, typed. */
  | { do: 'type'; text: string }
  /** The contents of a file, pasted through the clipboard. */
  | { do: 'paste'; path: string }
  | { do: 'wait'; ms: number };

/* ------------------------------------------------------------------ *
 * Escaping — the whole game
 * ------------------------------------------------------------------ */

/** A PowerShell single-quoted literal. Doubling the quote is the only escape. */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Literal text as SendKeys sees it.
 *
 * `+`, `^` and `%` are Shift, Ctrl and Alt; `~` is Enter; braces and brackets
 * group. Typing a Windows path or a shell command without escaping these sends
 * key combinations instead of characters — which on a focused editor is how you
 * get an unrecoverable mess rather than an error.
 */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (char) => `{${char}}`);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const PREAMBLE = [
  '$ErrorActionPreference = ' + psLiteral('Stop'),
  'Add-Type -AssemblyName System.Windows.Forms',
  '$signature = @"',
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);',
  '"@',
  'if (-not ("MegaAIInput" -as [type])) {',
  '  Add-Type -MemberDefinition $signature -Name MegaAIInput -Namespace Win32 | Out-Null',
  '}',
  'function Send-Click($down, $up) {',
  '  [Win32.MegaAIInput]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)',
  '  Start-Sleep -Milliseconds 40',
  '  [Win32.MegaAIInput]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)',
  '}',
].join('\n');

/**
 * Bring a window forward and prove it worked.
 *
 * `AppActivate` is the reliable one and it needs a process id, so the window is
 * found by title first. Failing loudly matters here more than anywhere else in
 * this file: every step after a failed focus is typed into whatever window
 * happened to be in front, which could be anything.
 */
function focusScript(step: Extract<GuiStep, { do: 'focus' }>): string {
  const timeout = Math.max(1_000, step.timeoutMs ?? 20_000);
  return [
    `$deadline = (Get-Date).AddMilliseconds(${timeout})`,
    '$target = $null',
    'while ((Get-Date) -lt $deadline -and -not $target) {',
    `  $target = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like ${psLiteral(
      `*${step.titleContains}*`,
    )} } | Select-Object -First 1`,
    '  if (-not $target) { Start-Sleep -Milliseconds 500 }',
    '}',
    `if (-not $target) { throw ${psLiteral(`no window whose title contains "${step.titleContains}" ever appeared`)} }`,
    '$shell = New-Object -ComObject WScript.Shell',
    '$shell.AppActivate($target.Id) | Out-Null',
    '[Win32.MegaAIInput]::SetForegroundWindow($target.MainWindowHandle) | Out-Null',
    'Start-Sleep -Milliseconds 400',
  ].join('\n');
}

function stepScript(step: GuiStep): string {
  switch (step.do) {
    case 'launch': {
      const args = (step.args ?? []).map(psLiteral).join(', ');
      return args
        ? `Start-Process -FilePath ${psLiteral(step.file)} -ArgumentList @(${args})`
        : `Start-Process -FilePath ${psLiteral(step.file)}`;
    }
    case 'focus':
      return focusScript(step);
    case 'move':
      return `[Win32.MegaAIInput]::SetCursorPos(${Math.round(step.x)}, ${Math.round(step.y)}) | Out-Null`;
    case 'click': {
      const lines: string[] = [];
      if (step.x !== undefined && step.y !== undefined) {
        lines.push(`[Win32.MegaAIInput]::SetCursorPos(${Math.round(step.x)}, ${Math.round(step.y)}) | Out-Null`);
        lines.push('Start-Sleep -Milliseconds 80');
      }
      const [down, up] = step.button === 'right' ? ['0x0008', '0x0010'] : ['0x0002', '0x0004'];
      lines.push(`Send-Click ${down} ${up}`);
      if (step.double) {
        lines.push('Start-Sleep -Milliseconds 60', `Send-Click ${down} ${up}`);
      }
      return lines.join('\n');
    }
    case 'keys':
      return `[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(step.keys)})\nStart-Sleep -Milliseconds 120`;
    case 'type':
      return `[System.Windows.Forms.SendKeys]::SendWait(${psLiteral(
        escapeSendKeys(step.text),
      )})\nStart-Sleep -Milliseconds 120`;
    case 'paste':
      return [
        `$text = [System.IO.File]::ReadAllText(${psLiteral(step.path)}, [System.Text.Encoding]::UTF8)`,
        'Set-Clipboard -Value $text',
        'Start-Sleep -Milliseconds 200',
        `[System.Windows.Forms.SendKeys]::SendWait('^v')`,
        'Start-Sleep -Milliseconds 400',
      ].join('\n');
    case 'wait':
      return `Start-Sleep -Milliseconds ${Math.max(0, Math.round(step.ms))}`;
  }
}

/** The whole script, ready to hand to `powershell.exe -File`. */
export function renderGuiScript(steps: readonly GuiStep[]): string {
  const body = steps.map((step, index) => `# step ${index + 1}: ${step.do}\n${stepScript(step)}`);
  return [PREAMBLE, ...body, `Write-Output ${psLiteral('megaai-gui: done')}`].join('\n\n') + '\n';
}

/** How to run it: STA because the clipboard needs it, no profile so it is fast. */
export function guiScriptCommand(scriptPath: string): { file: string; args: string[] } {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  };
}

/* ------------------------------------------------------------------ *
 * The things we actually want to do on screen
 * ------------------------------------------------------------------ */

export interface EditorOptions {
  projectDir: string;
  /** The VS Code launcher — `code`, or a full path when it is not on PATH. */
  editorCommand?: string;
  /** Part of the window title once it is open. */
  windowTitle?: string;
}

/** Open the project in VS Code and wait until its window is actually there. */
export function openEditorSteps(options: EditorOptions): GuiStep[] {
  return [
    { do: 'launch', file: options.editorCommand ?? 'code', args: [options.projectDir] },
    { do: 'wait', ms: 3_000 },
    { do: 'focus', titleContains: options.windowTitle ?? 'Visual Studio Code', timeoutMs: 45_000 },
  ];
}

export interface CoderInEditorOptions extends EditorOptions {
  /** What to start in the terminal — `codex`, `claude`, `opencode`. */
  command: string;
  /** The file holding the brief. Pasted, so its contents arrive intact. */
  promptFile: string;
  /** How long the agent needs before it is ready for input. */
  startupMs?: number;
  /** Enter submits in every one of these; some want it twice. */
  submitTwice?: boolean;
}

/**
 * Open the project in VS Code, start the coding agent as a full application in
 * its terminal, and hand it the brief.
 *
 * The order is the order a person would do it in, and the waits are there for
 * the same reason a person waits: the editor takes a few seconds to draw, and
 * a terminal that has not finished starting swallows whatever you type at it.
 */
export function openCoderInEditorSteps(options: CoderInEditorOptions): GuiStep[] {
  return [
    ...openEditorSteps(options),
    // Ctrl+` is the integrated terminal. A fresh one, so we are not typing into
    // whatever was left running in there yesterday.
    { do: 'keys', keys: '^`' },
    { do: 'wait', ms: 1_500 },
    { do: 'type', text: options.command },
    { do: 'keys', keys: '{ENTER}' },
    { do: 'wait', ms: options.startupMs ?? 8_000 },
    { do: 'paste', path: options.promptFile },
    { do: 'keys', keys: '{ENTER}' },
    ...(options.submitTwice ? [{ do: 'wait' as const, ms: 500 }, { do: 'keys' as const, keys: '{ENTER}' }] : []),
  ];
}

/* ------------------------------------------------------------------ *
 * As a task
 * ------------------------------------------------------------------ */

export interface GuiTaskPayload {
  kind: 'gui';
  /** `editor` opens the project; `coder` opens the agent inside it. */
  action: 'editor' | 'coder' | 'steps';
  projectDir: string;
  /** For `coder`: which agent, and what to tell it. */
  command?: string;
  prompt?: string;
  editorCommand?: string;
  windowTitle?: string;
  /** For `steps`: drive it yourself. */
  steps?: GuiStep[];
}

export function isGuiPayload(payload: JsonObject): payload is JsonObject & GuiTaskPayload {
  return (
    payload['kind'] === 'gui' &&
    typeof payload['projectDir'] === 'string' &&
    ['editor', 'coder', 'steps'].includes(payload['action'] as string)
  );
}

/**
 * The steps a GUI task turns into.
 *
 * Separated from running them so the plan can be shown before anything moves
 * the mouse — `megaai-node gui --dry-run` prints exactly this.
 */
export function planGuiSteps(payload: GuiTaskPayload, promptFile: string): { steps: GuiStep[]; error?: string } {
  const editor = {
    projectDir: payload.projectDir,
    ...(payload.editorCommand ? { editorCommand: payload.editorCommand } : {}),
    ...(payload.windowTitle ? { windowTitle: payload.windowTitle } : {}),
  };
  if (payload.action === 'editor') return { steps: openEditorSteps(editor) };
  if (payload.action === 'steps') {
    return payload.steps && payload.steps.length > 0
      ? { steps: payload.steps }
      : { steps: [], error: 'a "steps" task has to say what the steps are' };
  }
  if (!payload.command) return { steps: [], error: 'a "coder" task has to say which agent to open (codex, claude, opencode)' };
  if (!payload.prompt?.trim()) return { steps: [], error: 'a "coder" task has to carry the brief to hand over' };
  return {
    steps: openCoderInEditorSteps({ ...editor, command: payload.command, promptFile }),
  };
}

export interface GuiHandlerOptions {
  /** Where the generated script and the brief are written. */
  scratchDir: string;
  writeFile: (path: string, contents: string) => void;
  /** Runs the script. Same shape as the coder launcher, deliberately. */
  run: (file: string, args: string[]) => Promise<{ exitCode: number; output: string }>;
  platform?: NodeJS.Platform;
  /** For a unique file name per run without reaching for a clock in a test. */
  uniqueSuffix?: () => string;
}

export function createGuiHandler(options: GuiHandlerOptions): TaskHandler {
  const platform = options.platform ?? process.platform;
  const unique = options.uniqueSuffix ?? (() => Date.now().toString(36));

  return async (context: TaskContext): Promise<TaskOutcome> => {
    const payload = context.task.payload;
    if (!isGuiPayload(payload)) {
      return { kind: 'failed', error: 'a gui task needs an action (editor, coder or steps) and a projectDir' };
    }
    if (platform !== 'win32') {
      // Everything here is `user32.dll`. Saying so beats a PowerShell that is
      // not installed reporting ENOENT from three layers down.
      return {
        kind: 'failed',
        error: `driving applications on screen is implemented for Windows; this machine is ${platform}`,
      };
    }

    const suffix = unique();
    const promptFile = `${options.scratchDir}/gui-${suffix}.prompt.txt`;
    const scriptFile = `${options.scratchDir}/gui-${suffix}.ps1`;

    const planned = planGuiSteps(payload, promptFile);
    if (planned.error) return { kind: 'failed', error: planned.error };

    if (payload.prompt) options.writeFile(promptFile, payload.prompt);
    options.writeFile(scriptFile, renderGuiScript(planned.steps));
    context.log(`driving the screen: ${planned.steps.map((step) => step.do).join(' → ')}`);

    const command = guiScriptCommand(scriptFile);
    const outcome = await options.run(command.file, command.args);

    if (outcome.exitCode === 0 && /megaai-gui: done/.test(outcome.output)) {
      return {
        kind: 'done',
        result: { steps: planned.steps.length, action: payload.action, output: outcome.output.slice(-2_000) },
      };
    }
    return {
      kind: 'failed',
      error:
        `driving the screen stopped at exit ${outcome.exitCode}. ` +
        `The script is at ${scriptFile} if you want to run it yourself. ` +
        outcome.output.trim().split(/\r?\n/).slice(-6).join(' ').slice(0, 600),
    };
  };
}
