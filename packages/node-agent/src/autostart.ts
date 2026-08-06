/**
 * "Whenever the laptop is open, the agent should already be there."
 *
 * On Windows that means a Scheduled Task, not a Startup-folder shortcut and
 * not a service. A shortcut cannot restart itself when it crashes; a service
 * runs in session 0, where it cannot see your desktop, cannot drive Chrome for
 * WhatsApp, and cannot tell whether you are at the keyboard — which is the one
 * signal this whole agent is built around.
 *
 * Three defaults in the generated task are deliberate and easy to get wrong:
 *
 *   - `DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` are **false**.
 *     Windows sets both to true by default, so an agent installed the normal
 *     way silently refuses to run the moment you unplug — you would see a
 *     laptop that "works at the desk and not on the sofa" with nothing to
 *     explain it. Battery is handled properly by the resource guard instead,
 *     which stops at 20% rather than at the sight of a battery.
 *   - `ExecutionTimeLimit` is `PT0S`, meaning none. The default kills a task
 *     after three days; this one is meant to keep running.
 *   - `MultipleInstances` is `IgnoreNew`, so a logon while it is already
 *     running does not start a second agent competing with the first.
 */

import path from 'node:path';

export interface AutostartOptions {
  /** The node binary that will run it. */
  execPath: string;
  /** The agent entry script. */
  scriptPath: string;
  args?: string[];
  /** Where to run it from. */
  workingDir?: string;
  taskName?: string;
  /** `DOMAIN\\user`, for the Windows task's principal. */
  userId?: string;
  platform?: NodeJS.Platform;
  /** Where the generated file should be written. */
  stateDir?: string;
}

/**
 * How a generated file has to be written.
 *
 * `utf16le-bom` is not a preference. `schtasks /Create /XML` decides how to
 * read the file from its byte-order mark: without one it reads UTF-16 bytes as
 * ANSI, sees `<` followed by a NUL, and rejects the whole thing with
 * "The task XML is malformed. (1,2)::ERROR: one root element". Writing UTF-16
 * *without* the mark fails in exactly the same way as writing UTF-8, which is
 * why this travels with the plan instead of being left to the caller.
 */
export type FileEncoding = 'utf8' | 'utf16le-bom';

export interface AutostartPlan {
  platform: NodeJS.Platform;
  /** Written first… */
  files: Array<{ path: string; contents: string; encoding: FileEncoding }>;
  /** …then these are run, in order. */
  commands: Array<{ command: string; args: string[] }>;
  /** What to tell the person doing it — *after* it has been checked. */
  summary: string;
  /** How to undo it. */
  removeCommand?: { command: string; args: string[] };
  /**
   * Proves the thing was actually installed.
   *
   * Every command above can print an error and still leave the installer
   * looking like it worked. Asking the operating system whether the task
   * exists is the only answer worth reporting.
   */
  verifyCommand?: { command: string; args: string[] };
}

const DEFAULT_TASK_NAME = 'MegaAI Node Agent';

function quoteWindows(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The Task Scheduler definition, ready for `schtasks /Create /XML`. */
export function windowsTaskXml(options: AutostartOptions): string {
  const workingDir = options.workingDir ?? path.win32.dirname(options.scriptPath);
  const argumentLine = [options.scriptPath, ...(options.args ?? [])].map(quoteWindows).join(' ');
  const principal = options.userId
    ? `      <UserId>${escapeXml(options.userId)}</UserId>\n`
    : '';

  // UTF-16 with a BOM is what schtasks expects; the caller writes it that way.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>MegaAI works on your projects while you are away, and stays out of the way while you are here.</Description>
    <URI>\\${escapeXml(options.taskName ?? DEFAULT_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
${principal}      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(options.execPath)}</Command>
      <Arguments>${escapeXml(argumentLine)}</Arguments>
      <WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** A systemd **user** unit — no root, and it starts when you log in. */
export function systemdUnit(options: AutostartOptions): string {
  const workingDir = options.workingDir ?? path.dirname(options.scriptPath);
  const command = [options.execPath, options.scriptPath, ...(options.args ?? [])].join(' ');
  return `[Unit]
Description=MegaAI node agent
After=network-online.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${workingDir}
Restart=always
RestartSec=30
# The resource guard decides how hard to work; this only stops it winning
# every scheduling fight with whatever you are doing.
Nice=10

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(options: AutostartOptions): string {
  const workingDir = options.workingDir ?? path.dirname(options.scriptPath);
  const args = [options.execPath, options.scriptPath, ...(options.args ?? [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.megaai.node-agent</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(workingDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
`;
}

/** Everything needed to make the agent start by itself on this platform. */
export function autostartPlan(options: AutostartOptions): AutostartPlan {
  const platform = options.platform ?? process.platform;
  const taskName = options.taskName ?? DEFAULT_TASK_NAME;

  if (platform === 'win32') {
    const stateDir = options.stateDir ?? path.win32.dirname(options.scriptPath);
    const xmlPath = path.win32.join(stateDir, 'megaai-node-agent.xml');
    return {
      platform,
      files: [{ path: xmlPath, contents: windowsTaskXml({ ...options, taskName }), encoding: 'utf16le-bom' }],
      commands: [
        // /F replaces an existing registration, so re-running the installer
        // after an upgrade updates the task instead of failing.
        { command: 'schtasks.exe', args: ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'] },
        { command: 'schtasks.exe', args: ['/Run', '/TN', taskName] },
      ],
      verifyCommand: { command: 'schtasks.exe', args: ['/Query', '/TN', taskName] },
      removeCommand: { command: 'schtasks.exe', args: ['/Delete', '/TN', taskName, '/F'] },
      summary: `Registered "${taskName}" to start 30 seconds after you log in, hidden, restarting itself if it crashes, and running on battery as well as mains.`,
    };
  }

  if (platform === 'darwin') {
    const home = process.env['HOME'] ?? '.';
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.megaai.node-agent.plist');
    return {
      platform,
      files: [{ path: plistPath, contents: launchdPlist(options), encoding: 'utf8' }],
      commands: [{ command: 'launchctl', args: ['load', '-w', plistPath] }],
      removeCommand: { command: 'launchctl', args: ['unload', '-w', plistPath] },
      verifyCommand: { command: 'launchctl', args: ['list', 'com.megaai.node-agent'] },
      summary: 'Installed a LaunchAgent that starts at login and restarts if it stops.',
    };
  }

  const home = process.env['HOME'] ?? '.';
  const unitPath = path.join(home, '.config', 'systemd', 'user', 'megaai-node-agent.service');
  return {
    platform,
    files: [{ path: unitPath, contents: systemdUnit(options), encoding: 'utf8' }],
    verifyCommand: { command: 'systemctl', args: ['--user', 'is-enabled', 'megaai-node-agent.service'] },
    commands: [
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'megaai-node-agent.service'] },
      // Without lingering, the agent stops the moment you log out of the
      // desktop — which is exactly when it is supposed to be working.
      { command: 'loginctl', args: ['enable-linger'] },
    ],
    removeCommand: { command: 'systemctl', args: ['--user', 'disable', '--now', 'megaai-node-agent.service'] },
    summary: 'Installed a systemd user service that starts at login, restarts on failure and keeps running after you log out.',
  };
}
