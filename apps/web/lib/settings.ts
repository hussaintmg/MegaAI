/**
 * Reading and writing the one settings document.
 *
 * The shape and every pure transform live in `settings-model.ts`, and are
 * re-exported here so callers see one module.
 */

import { getDb } from './db';
import { DEFAULTS, type SettingsDoc } from './settings-model.ts';

export * from './settings-model.ts';

export async function loadSettingsDoc(): Promise<SettingsDoc> {
  const db = await getDb();
  const doc = await db.collection<SettingsDoc>('settings').findOne({ _id: 'settings' });
  return {
    _id: 'settings',
    ...DEFAULTS,
    ...doc,
    email: { ...DEFAULTS.email, ...doc?.email },
    deploy: { ...DEFAULTS.deploy, ...doc?.deploy },
    providers: doc?.providers ?? {},
  };
}

export async function saveSettingsDoc(doc: SettingsDoc): Promise<void> {
  const db = await getDb();
  await db.collection<SettingsDoc>('settings').replaceOne({ _id: 'settings' }, doc, { upsert: true });
}
