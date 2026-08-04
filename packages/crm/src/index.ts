/**
 * @megaai/crm — the CRM engine (Phase 3).
 *
 * Keeps the client side of a delivery current: clients, leads, activities and
 * invoices, all behind the four-method `Database` contract (JSON files in
 * production, in-memory in tests). Leads are scored by an injected scorer —
 * the trained `@megaai/models` lead-scoring model when wired in — so "new lead"
 * immediately becomes "hot / warm / cold." Exposed to agents as `crm.*` tools.
 */

import type { Collection, Database, EventPublisher, Tool } from '@megaai/contracts';
import type { JsonObject, JsonValue, Timestamp } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { type Clock, newId, systemClock } from '@megaai/utils';

export type ClientStatus = 'prospect' | 'lead' | 'active' | 'churned';
export type LeadBand = 'hot' | 'warm' | 'cold' | 'unscored';
export type ActivityKind = 'note' | 'call' | 'email' | 'meeting' | 'status' | 'invoice';
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'void';

export interface CrmClient {
  id: string;
  name: string;
  email?: string;
  company?: string;
  status: ClientStatus;
  notes?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CrmLead {
  id: string;
  name: string;
  clientId?: string;
  source?: string;
  signals?: JsonObject;
  score?: number;
  band: LeadBand;
  createdAt: Timestamp;
}

export interface CrmActivity {
  id: string;
  clientId: string;
  kind: ActivityKind;
  summary: string;
  at: Timestamp;
}

export interface CrmInvoice {
  id: string;
  clientId: string;
  number: string;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  dueAt?: Timestamp;
  createdAt: Timestamp;
}

/** Injected lead scorer — typically the trained lead-scoring model. */
export type LeadScorer = (signals: JsonObject) => { band: string; score: number } | undefined;

export interface CrmEngineOptions {
  database: Database;
  clock?: Clock;
  bus?: EventPublisher;
  scoreLead?: LeadScorer;
}

export const CrmEvents = {
  ClientUpserted: 'crm.client.upserted',
  LeadRecorded: 'crm.lead.recorded',
  InvoiceCreated: 'crm.invoice.created',
} as const;

export class CrmEngine {
  private readonly clock: Clock;
  private readonly clients: Collection<CrmClient>;
  private readonly leads: Collection<CrmLead>;
  private readonly activities: Collection<CrmActivity>;
  private readonly invoices: Collection<CrmInvoice>;

  constructor(private readonly options: CrmEngineOptions) {
    this.clock = options.clock ?? systemClock;
    this.clients = options.database.collection<CrmClient>('crm_clients');
    this.leads = options.database.collection<CrmLead>('crm_leads');
    this.activities = options.database.collection<CrmActivity>('crm_activities');
    this.invoices = options.database.collection<CrmInvoice>('crm_invoices');
  }

  /* --------------------------- clients --------------------------- */

  /** Create or update a client (matched by id, else by email). */
  async upsertClient(input: {
    id?: string;
    name: string;
    email?: string;
    company?: string;
    status?: ClientStatus;
    notes?: string;
  }): Promise<CrmClient> {
    if (!input.name?.trim()) throw new MegaError('INVALID_INPUT', 'client needs a name');
    const now = this.clock.now();
    const existing = input.id ? await this.clients.get(input.id) : input.email ? await this.findClientByEmail(input.email) : undefined;
    const client: CrmClient = existing
      ? {
          ...existing,
          name: input.name,
          email: input.email ?? existing.email,
          company: input.company ?? existing.company,
          status: input.status ?? existing.status,
          notes: input.notes ?? existing.notes,
          updatedAt: now,
        }
      : {
          id: input.id ?? newId('client'),
          name: input.name,
          email: input.email,
          company: input.company,
          status: input.status ?? 'prospect',
          notes: input.notes,
          createdAt: now,
          updatedAt: now,
        };
    await this.clients.put(client);
    this.options.bus?.emit(CrmEvents.ClientUpserted, { client }, 'crm');
    return client;
  }

  async findClientByEmail(email: string): Promise<CrmClient | undefined> {
    const lower = email.toLowerCase();
    const matches = await this.clients.find((c) => (c.email ?? '').toLowerCase() === lower);
    return matches[0];
  }

  /** Resolve a client reference (id or email) to a record. */
  async resolveClient(ref: string): Promise<CrmClient | undefined> {
    return (await this.clients.get(ref)) ?? (await this.findClientByEmail(ref));
  }

  getClient(id: string): Promise<CrmClient | undefined> {
    return this.clients.get(id);
  }

  listClients(): Promise<CrmClient[]> {
    return this.clients.all();
  }

  /* ---------------------------- leads ---------------------------- */

  /** Record a lead and score it (hot/warm/cold) via the injected scorer. */
  async recordLead(input: { name: string; clientId?: string; source?: string; signals?: JsonObject }): Promise<CrmLead> {
    if (!input.name?.trim()) throw new MegaError('INVALID_INPUT', 'lead needs a name');
    const scored = input.signals && this.options.scoreLead ? this.options.scoreLead(input.signals) : undefined;
    const band: LeadBand = scored ? (['hot', 'warm', 'cold'].includes(scored.band) ? (scored.band as LeadBand) : 'unscored') : 'unscored';
    const lead: CrmLead = {
      id: newId('lead'),
      name: input.name,
      clientId: input.clientId,
      source: input.source,
      signals: input.signals,
      score: scored?.score,
      band,
      createdAt: this.clock.now(),
    };
    await this.leads.put(lead);
    this.options.bus?.emit(CrmEvents.LeadRecorded, { lead }, 'crm');
    return lead;
  }

  listLeads(): Promise<CrmLead[]> {
    return this.leads.all();
  }

  async hotLeads(): Promise<CrmLead[]> {
    return this.leads.find((l) => l.band === 'hot');
  }

  /* -------------------------- activities ------------------------- */

  async logActivity(clientRef: string, kind: ActivityKind, summary: string): Promise<CrmActivity> {
    const client = await this.resolveClient(clientRef);
    if (!client) throw new MegaError('NOT_FOUND', `No client matching "${clientRef}"`);
    if (!summary?.trim()) throw new MegaError('INVALID_INPUT', 'activity needs a summary');
    const activity: CrmActivity = { id: newId('act'), clientId: client.id, kind, summary, at: this.clock.now() };
    await this.activities.put(activity);
    return activity;
  }

  async listActivities(clientId?: string): Promise<CrmActivity[]> {
    const all = await this.activities.all();
    const filtered = clientId ? all.filter((a) => a.clientId === clientId) : all;
    return filtered.sort((a, b) => b.at - a.at);
  }

  /* --------------------------- invoices -------------------------- */

  async createInvoice(clientRef: string, input: { amount: number; currency?: string; dueAt?: Timestamp; status?: InvoiceStatus; number?: string }): Promise<CrmInvoice> {
    const client = await this.resolveClient(clientRef);
    if (!client) throw new MegaError('NOT_FOUND', `No client matching "${clientRef}"`);
    if (!(input.amount > 0)) throw new MegaError('INVALID_INPUT', 'invoice amount must be positive');
    const invoice: CrmInvoice = {
      id: newId('inv'),
      clientId: client.id,
      number: input.number ?? `INV-${(await this.invoices.all()).length + 1}`,
      amount: input.amount,
      currency: input.currency ?? 'USD',
      status: input.status ?? 'draft',
      dueAt: input.dueAt,
      createdAt: this.clock.now(),
    };
    await this.invoices.put(invoice);
    this.options.bus?.emit(CrmEvents.InvoiceCreated, { invoice }, 'crm');
    return invoice;
  }

  async setInvoiceStatus(id: string, status: InvoiceStatus): Promise<CrmInvoice> {
    const invoice = await this.invoices.get(id);
    if (!invoice) throw new MegaError('NOT_FOUND', `No invoice "${id}"`);
    const updated = { ...invoice, status };
    await this.invoices.put(updated);
    return updated;
  }

  async listInvoices(clientId?: string): Promise<CrmInvoice[]> {
    const all = await this.invoices.all();
    return clientId ? all.filter((i) => i.clientId === clientId) : all;
  }

  /** Total amount on invoices that are not yet paid/void. */
  async outstanding(): Promise<number> {
    const all = await this.invoices.all();
    return all.filter((i) => i.status === 'draft' || i.status === 'sent').reduce((sum, i) => sum + i.amount, 0);
  }

  async summary(): Promise<{ clients: number; leads: number; hotLeads: number; invoices: number; outstanding: number }> {
    const [clients, leads, hot, invoices, outstanding] = await Promise.all([
      this.clients.all(),
      this.leads.all(),
      this.hotLeads(),
      this.invoices.all(),
      this.outstanding(),
    ]);
    return { clients: clients.length, leads: leads.length, hotLeads: hot.length, invoices: invoices.length, outstanding };
  }
}

/* ------------------------------------------------------------------ *
 * Agent-facing tools (all on the `crm` permission)
 * ------------------------------------------------------------------ */

function str(input: JsonObject, key: string, required = true): string | undefined {
  const value = input[key];
  if (typeof value === 'string') return value;
  if (required) throw new MegaError('INVALID_INPUT', `crm tool input "${key}" must be a string`);
  return undefined;
}

export function createCrmTools(crm: CrmEngine): Tool[] {
  const upsertClient: Tool = {
    name: 'crm.client.upsert',
    description: 'Create or update a client record (matched by id or email)',
    inputSchema: { name: 'string', email: 'string (optional)', company: 'string (optional)', status: 'prospect|lead|active|churned (optional)', notes: 'string (optional)' },
    permissions: ['crm'],
    async execute(input) {
      const status = str(input, 'status', false);
      return (await crm.upsertClient({
        id: str(input, 'id', false),
        name: str(input, 'name')!,
        email: str(input, 'email', false),
        company: str(input, 'company', false),
        status: status as ClientStatus | undefined,
        notes: str(input, 'notes', false),
      })) as unknown as JsonValue;
    },
  };
  const addLead: Tool = {
    name: 'crm.lead.add',
    description: 'Record a lead; it is scored hot/warm/cold when signals are provided',
    inputSchema: { name: 'string', source: 'string (optional)', client: 'string (optional client id/email)', signals: 'object (optional lead features)' },
    permissions: ['crm'],
    async execute(input) {
      const signals = input.signals && typeof input.signals === 'object' && !Array.isArray(input.signals) ? (input.signals as JsonObject) : undefined;
      return (await crm.recordLead({ name: str(input, 'name')!, clientId: str(input, 'client', false), source: str(input, 'source', false), signals })) as unknown as JsonValue;
    },
  };
  const logActivity: Tool = {
    name: 'crm.activity.log',
    description: 'Log an activity (note/call/email/meeting/status) against a client',
    inputSchema: { client: 'string (client id/email)', kind: 'note|call|email|meeting|status', summary: 'string' },
    permissions: ['crm'],
    async execute(input) {
      const kind = (str(input, 'kind', false) ?? 'note') as ActivityKind;
      return (await crm.logActivity(str(input, 'client')!, kind, str(input, 'summary')!)) as unknown as JsonValue;
    },
  };
  const createInvoice: Tool = {
    name: 'crm.invoice.create',
    description: 'Create an invoice for a client',
    inputSchema: { client: 'string (client id/email)', amount: 'number', currency: 'string (optional)', status: 'draft|sent|paid|void (optional)' },
    permissions: ['crm'],
    async execute(input) {
      const amount = typeof input.amount === 'number' ? input.amount : Number(input.amount);
      const status = str(input, 'status', false);
      return (await crm.createInvoice(str(input, 'client')!, { amount, currency: str(input, 'currency', false), status: status as InvoiceStatus | undefined })) as unknown as JsonValue;
    },
  };
  const summary: Tool = {
    name: 'crm.summary',
    description: 'Summarise the CRM: client, lead, hot-lead and invoice counts plus outstanding balance',
    inputSchema: {},
    permissions: ['crm'],
    async execute() {
      return (await crm.summary()) as unknown as JsonValue;
    },
  };
  return [upsertClient, addLead, logActivity, createInvoice, summary];
}
