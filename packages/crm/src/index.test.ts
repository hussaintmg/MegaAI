import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { MemoryDatabase } from '@megaai/database';
import { CrmEngine, createCrmTools, type LeadScorer } from './index.js';

const scorer: LeadScorer = (signals) => {
  const budget = typeof signals.budget === 'number' ? signals.budget : 0;
  return budget > 0.7 ? { band: 'hot', score: 0.9 } : budget > 0.4 ? { band: 'warm', score: 0.6 } : { band: 'cold', score: 0.8 };
};

function engine() {
  return new CrmEngine({ database: new MemoryDatabase(), clock: new ManualClock(1_000), scoreLead: scorer });
}

test('upsertClient creates then updates (matched by email)', async () => {
  const crm = engine();
  const created = await crm.upsertClient({ name: 'Acme', email: 'ops@acme.test', company: 'Acme Inc' });
  assert.equal(created.status, 'prospect');
  const updated = await crm.upsertClient({ name: 'Acme Corp', email: 'ops@acme.test', status: 'active' });
  assert.equal(updated.id, created.id); // same record, matched by email
  assert.equal(updated.name, 'Acme Corp');
  assert.equal(updated.status, 'active');
  assert.equal((await crm.listClients()).length, 1);
});

test('recordLead scores hot/warm/cold via the injected scorer', async () => {
  const crm = engine();
  const hot = await crm.recordLead({ name: 'Big Co', source: 'referral', signals: { budget: 0.9 } });
  const cold = await crm.recordLead({ name: 'Tiny Co', signals: { budget: 0.1 } });
  const unscored = await crm.recordLead({ name: 'No Signals' });
  assert.equal(hot.band, 'hot');
  assert.equal(hot.score, 0.9);
  assert.equal(cold.band, 'cold');
  assert.equal(unscored.band, 'unscored');
  assert.equal((await crm.hotLeads()).length, 1);
});

test('activities and invoices attach to a client and roll up in summary', async () => {
  const crm = engine();
  const client = await crm.upsertClient({ name: 'Acme', email: 'ops@acme.test' });
  await crm.logActivity('ops@acme.test', 'call', 'Kickoff call'); // resolve by email
  await crm.logActivity(client.id, 'meeting', 'Requirements review'); // resolve by id
  const inv = await crm.createInvoice(client.id, { amount: 5000, currency: 'USD', status: 'sent' });
  assert.equal(inv.clientId, client.id);
  assert.equal((await crm.listActivities(client.id)).length, 2);

  await crm.recordLead({ name: 'Lead', signals: { budget: 0.9 } });
  const summary = await crm.summary();
  assert.equal(summary.clients, 1);
  assert.equal(summary.leads, 1);
  assert.equal(summary.hotLeads, 1);
  assert.equal(summary.invoices, 1);
  assert.equal(summary.outstanding, 5000);

  await crm.setInvoiceStatus(inv.id, 'paid');
  assert.equal((await crm.summary()).outstanding, 0);

  await assert.rejects(crm.logActivity('nobody@nowhere.test', 'note', 'x'), /No client/);
  await assert.rejects(crm.createInvoice(client.id, { amount: -1 }), /amount/);
});

test('crm tools cover the workflow and enforce the crm permission', async () => {
  const crm = engine();
  const tools = createCrmTools(crm);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const t of tools) assert.deepEqual(t.permissions, ['crm']);

  await byName['crm.client.upsert']!.execute({ name: 'Acme', email: 'ops@acme.test', status: 'active' }, { workspaceRoot: '/tmp' });
  const lead = (await byName['crm.lead.add']!.execute({ name: 'Hot Lead', signals: { budget: 0.95 } }, { workspaceRoot: '/tmp' })) as { band: string };
  assert.equal(lead.band, 'hot');
  await byName['crm.activity.log']!.execute({ client: 'ops@acme.test', kind: 'email', summary: 'Sent proposal' }, { workspaceRoot: '/tmp' });
  await byName['crm.invoice.create']!.execute({ client: 'ops@acme.test', amount: 1200 }, { workspaceRoot: '/tmp' });
  const summary = (await byName['crm.summary']!.execute({}, { workspaceRoot: '/tmp' })) as { clients: number; hotLeads: number; outstanding: number };
  assert.equal(summary.clients, 1);
  assert.equal(summary.hotLeads, 1);
  assert.equal(summary.outstanding, 1200);
});
