/**
 * @megaai/node-agent — the part of MegaAI that runs on your own machine.
 *
 * The cloud can schedule and remember; it cannot open your editor, run your
 * builds, drive the coding agents you pay for, or send a WhatsApp from your
 * Chrome. This package is the body that can — and it is written around one
 * promise: *the laptop stays yours*.
 *
 *   `machine`    what the machine is doing (cheap signals every tick, the
 *                expensive ones from a probe that runs once)
 *   `guard`      full / gentle / stop, with hysteresis so it cannot flap
 *   `launcher`   spawning the coding CLIs on Windows without the shim traps
 *   `state`      the node's identity and its sessions, across reboots
 *   `agent`      the loop: look, report, take work, keep the lease alive
 *   `coder-task` the task kind that hands work down the line of agents
 *   `plan-task`  the one that plans a goal and keeps the others fed
 *   `gui`        opening real applications and driving them with the mouse
 *   `autostart`  making it come back on its own after a restart
 */

export * from './machine.js';
export * from './guard.js';
export * from './launcher.js';
export * from './state.js';
export * from './agent.js';
export * from './coder-task.js';
export * from './plan-task.js';
export * from './gui.js';
export * from './autostart.js';
