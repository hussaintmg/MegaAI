/**
 * @megaai/comm — the communication engine (Phase 3, milestone 4).
 *
 * Channels all speak one `send()` shape, so Slack/Discord/Telegram (incoming
 * webhooks), email (pluggable), or an in-memory capture look identical to
 * callers. Two consumers:
 *   - the `comm.send` tool, so agents can message clients (approval-gated),
 *   - the `NotificationEngine`, which watches lifecycle events and pushes
 *     progress to the operator's own channel — the "MegaAI keeps showing you
 *     progress" part of the vision.
 *
 * Offline-first: the default `captured` channel records messages in memory
 * (dashboard + tests read them); real delivery is a `webhook` channel behind
 * a host allowlist.
 */

import type { EventEnvelope, JsonObject, JsonValue, Timestamp } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, newId, systemClock, truncate } from '@megaai/utils';
import type { EventBus, Subscription } from '@megaai/events';
import type { Tool } from '@megaai/contracts';

export interface OutboundMessage {
  to?: string;
  subject?: string;
  text: string;
  meta?: JsonObject;
}

export interface SendReceipt {
  id: string;
  channel: string;
  ok: boolean;
  at: Timestamp;
  detail?: string;
}

export interface Channel {
  readonly name: string;
  readonly kind: string;
  send(message: OutboundMessage): Promise<SendReceipt>;
}

/** In-memory channel — the offline default; the dashboard reads its log. */
export class CapturedChannel implements Channel {
  readonly kind = 'captured';
  readonly messages: Array<OutboundMessage & { at: Timestamp }> = [];

  constructor(
    readonly name = 'captured',
    private readonly clock: Clock = systemClock,
    private readonly capacity = 500,
  ) {}

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const at = this.clock.now();
    this.messages.push({ ...message, at });
    if (this.messages.length > this.capacity) this.messages.splice(0, this.messages.length - this.capacity);
    return { id: newId('msg'), channel: this.name, ok: true, at };
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/**
 * Posts messages as JSON to a webhook URL (Slack/Discord/Telegram incoming
 * webhooks, or your own endpoint). Host-allowlisted.
 */
export class WebhookChannel implements Channel {
  readonly kind = 'webhook';

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly options: { allowedHosts?: string[]; timeoutMs?: number; clock?: Clock } = {},
  ) {
    const host = parseConfiguredUrl(url, 'The webhook URL').hostname;
    const allowed = options.allowedHosts ?? [];
    if (allowed.length > 0 && !allowed.some((h) => host === h || host.endsWith(`.${h}`))) {
      throw new MegaError('PERMISSION_DENIED', `Webhook host "${host}" is not on the comm allowlist`);
    }
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const clock = this.options.clock ?? systemClock;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message.text, subject: message.subject, to: message.to, meta: message.meta }),
        signal: controller.signal,
      });
      return {
        id: newId('msg'),
        channel: this.name,
        ok: response.ok,
        at: clock.now(),
        detail: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      return { id: newId('msg'), channel: this.name, ok: false, at: clock.now(), detail: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Email — RFC5322 composition + pluggable transport (SMTP / HTTP API)
 * ------------------------------------------------------------------ */

export interface EmailEnvelope {
  from: string;
  to: string;
  subject: string;
  text: string;
  date: string;
  messageId: string;
  /** The full RFC5322 message (headers + body). */
  raw: string;
}

export interface EmailResult {
  ok: boolean;
  detail?: string;
}

/** The seam a real backend implements: SMTP, an email API, a queue, … */
export type EmailTransport = (envelope: EmailEnvelope) => Promise<EmailResult>;

export interface EmailChannelOptions {
  from: string;
  defaultTo?: string;
  /** Real delivery backend; when omitted the channel composes + captures only. */
  transport?: EmailTransport;
  clock?: Clock;
  capacity?: number;
}

/**
 * Native email channel: composes a proper RFC5322 message and hands it to a
 * transport. Offline-first — with no transport it records composed envelopes
 * (readable in tests / the dashboard); a real SMTP or HTTP-API transport plugs
 * in via `createSmtpTransport` / `createHttpEmailTransport`.
 */
export class EmailChannel implements Channel {
  readonly kind = 'email';
  readonly sent: EmailEnvelope[] = [];
  private readonly clock: Clock;
  private readonly capacity: number;

  constructor(
    readonly name: string,
    private readonly options: EmailChannelOptions,
  ) {
    if (!options.from || !options.from.trim()) throw new MegaError('INVALID_INPUT', 'EmailChannel needs a "from" address');
    this.clock = options.clock ?? systemClock;
    this.capacity = options.capacity ?? 500;
  }

  compose(message: OutboundMessage): EmailEnvelope {
    const to = message.to ?? this.options.defaultTo;
    if (!to || !to.trim()) throw new MegaError('INVALID_INPUT', 'email needs a recipient (message.to or a configured default)');
    const subject = message.subject ?? '(no subject)';
    const date = new Date(this.clock.now()).toUTCString();
    const messageId = `<${newId('email')}@megaai>`;
    const headers = [
      `From: ${this.options.from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ];
    return { from: this.options.from, to, subject, text: message.text, date, messageId, raw: `${headers.join('\r\n')}\r\n\r\n${message.text}` };
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const envelope = this.compose(message);
    const at = this.clock.now();
    this.sent.push(envelope);
    if (this.sent.length > this.capacity) this.sent.splice(0, this.sent.length - this.capacity);
    if (!this.options.transport) {
      return { id: newId('msg'), channel: this.name, ok: true, at, detail: 'composed (no transport configured — captured)' };
    }
    try {
      const result = await this.options.transport(envelope);
      return { id: newId('msg'), channel: this.name, ok: result.ok, at, detail: result.detail };
    } catch (err) {
      return { id: newId('msg'), channel: this.name, ok: false, at, detail: String(err) };
    }
  }
}

/** Parse a configured URL, naming the setting so the message is actionable. */
function parseConfiguredUrl(url: string, setting: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new MegaError(
      'INVALID_INPUT',
      `${setting} is not a valid URL: "${url}". It needs the scheme too, e.g. https://api.example.com/send`,
      { setting, value: url },
    );
  }
}

/** Deliver email by POSTing to an HTTP email API (SendGrid/Postmark-style). Host-allowlisted. */
export function createHttpEmailTransport(
  url: string,
  options: { allowedHosts?: string[]; timeoutMs?: number; apiKey?: string; headers?: Record<string, string> } = {},
): EmailTransport {
  const host = parseConfiguredUrl(url, 'The email API URL').hostname;
  const allowed = options.allowedHosts ?? [];
  if (allowed.length > 0 && !allowed.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new MegaError('PERMISSION_DENIED', `Email API host "${host}" is not on the comm allowlist`);
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  return async (envelope) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ from: envelope.from, to: envelope.to, subject: envelope.subject, text: envelope.text }),
        signal: controller.signal,
      });
      return { ok: response.ok, detail: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, detail: String(err) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** SMTP transport seam via the optional `nodemailer` package (dynamic import). */
export function createSmtpTransport(options: { host: string; port?: number; secure?: boolean; auth?: { user: string; pass: string } }): EmailTransport {
  return async (envelope) => {
    try {
      const moduleName = 'nodemailer';
      const nodemailer = (await import(moduleName)) as {
        createTransport?: (opts: unknown) => { sendMail(mail: unknown): Promise<unknown> };
      };
      if (!nodemailer.createTransport) return { ok: false, detail: 'nodemailer not installed' };
      const transporter = nodemailer.createTransport({ host: options.host, port: options.port ?? 587, secure: options.secure ?? false, auth: options.auth });
      await transporter.sendMail({ from: envelope.from, to: envelope.to, subject: envelope.subject, text: envelope.text });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: `smtp: ${String(err)}` };
    }
  };
}

export class CommEngine {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly clock: Clock = systemClock) {}

  register(channel: Channel): void {
    if (this.channels.has(channel.name)) {
      throw new MegaError('ALREADY_EXISTS', `Channel "${channel.name}" already registered`);
    }
    this.channels.set(channel.name, channel);
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }

  list(): Array<{ name: string; kind: string }> {
    return [...this.channels.values()].map((channel) => ({ name: channel.name, kind: channel.kind }));
  }

  async send(channelName: string, message: OutboundMessage): Promise<SendReceipt> {
    const channel = this.channels.get(channelName);
    if (!channel) throw new MegaError('NOT_FOUND', `No channel "${channelName}"`);
    if (!message.text || message.text.trim().length === 0) {
      throw new MegaError('INVALID_INPUT', 'message text must not be empty');
    }
    return channel.send(message);
  }
}

/* ------------------------------------------------------------------ *
 * Notification engine — event-driven operator updates
 * ------------------------------------------------------------------ */

export type NotificationFormatter = (event: EventEnvelope) => OutboundMessage | undefined;

/** Turn well-known lifecycle events into human-readable operator messages. */
export const defaultFormatter: NotificationFormatter = (event) => {
  const payload = event.payload as JsonObject;
  switch (event.type) {
    case Events.GoalCompleted:
      return { subject: 'Goal completed', text: `✅ Goal completed: ${truncate(String(payload.goal ?? ''), 200)}` };
    case Events.GoalFailed:
      return {
        subject: 'Goal needs attention',
        text: `⚠️ Goal did not fully complete (${String(payload.status ?? 'unknown')}): ${truncate(String(payload.goal ?? ''), 200)}`,
      };
    case Events.ApprovalRequested: {
      const approval = payload.approval as { description?: string } | undefined;
      return { subject: 'Approval needed', text: `⏸ Approval needed: ${truncate(approval?.description ?? '', 200)}` };
    }
    case Events.ProjectCompleted: {
      const project = payload.project as { name?: string } | undefined;
      return { subject: 'Project completed', text: `📦 Project completed: ${project?.name ?? ''}` };
    }
    default:
      return undefined;
  }
};

export interface NotificationEngineOptions {
  bus: EventBus;
  comm: CommEngine;
  /** Channel to deliver operator notifications to. */
  channel: string;
  /** Event types to notify on. */
  events: string[];
  formatter?: NotificationFormatter;
  onError?: (err: unknown) => void;
}

export class NotificationEngine {
  readonly name = 'notifications';
  private readonly subscriptions: Subscription[] = [];
  private sent = 0;

  constructor(private readonly options: NotificationEngineOptions) {}

  start(): void {
    if (this.options.channel === 'none' || !this.options.comm.has(this.options.channel)) return;
    const formatter = this.options.formatter ?? defaultFormatter;
    for (const type of this.options.events) {
      this.subscriptions.push(
        this.options.bus.on(type, (event) => {
          const message = formatter(event);
          if (!message) return;
          this.options.comm
            .send(this.options.channel, message)
            .then(() => {
              this.sent += 1;
            })
            .catch((err) => this.options.onError?.(err));
        }),
      );
    }
  }

  stop(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions.length = 0;
  }

  notificationsSent(): number {
    return this.sent;
  }
}

/* ------------------------------------------------------------------ *
 * Agent-facing tool
 * ------------------------------------------------------------------ */

function str(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new MegaError('INVALID_INPUT', `Tool input "${key}" must be a string`);
  return value;
}

export function createCommTool(comm: CommEngine, defaultChannel = 'captured'): Tool {
  return {
    name: 'comm.send',
    description: 'Send a message on a channel (e.g. to a client). Approval-gated.',
    inputSchema: { channel: 'string (optional; defaults to the configured channel)', to: 'string (optional)', subject: 'string (optional)', text: 'string' },
    permissions: ['comm.send'],
    async execute(input) {
      const channel = typeof input.channel === 'string' ? input.channel : defaultChannel;
      const receipt = await comm.send(channel, {
        to: typeof input.to === 'string' ? input.to : undefined,
        subject: typeof input.subject === 'string' ? input.subject : undefined,
        text: str(input, 'text'),
      });
      return receipt as unknown as JsonValue;
    },
  };
}
