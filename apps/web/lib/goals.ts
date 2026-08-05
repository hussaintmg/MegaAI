/**
 * Goal documents: one per submitted goal, updated live by the executor.
 */

import { ObjectId, type Collection } from 'mongodb';
import { getDb } from './db';
import type { GoalFile, GoalProviderTally } from './delivery';

export type GoalStatus = 'queued' | 'dispatched' | 'running' | 'completed' | 'failed' | 'error';

export interface GoalEvent {
  at: Date;
  type: string;
  message: string;
}

export {
  sanitizeGoalFiles,
  sanitizeProviderTallies,
  type GoalFile,
  type GoalProviderTally,
} from './delivery';

export interface GoalDoc {
  _id?: ObjectId;
  goal: string;
  status: GoalStatus;
  source: 'dashboard' | 'schedule';
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
  events: GoalEvent[];
  report?: string;
  files?: string[];
  contents?: GoalFile[];
  providers?: GoalProviderTally[];
  usage?: { requests: number; tokens: number; costUsd: number };
  error?: string;
}

export async function goalsCollection(): Promise<Collection<GoalDoc>> {
  const db = await getDb();
  return db.collection<GoalDoc>('goals');
}

export function parseGoalId(id: string): ObjectId | undefined {
  try {
    return new ObjectId(id);
  } catch {
    return undefined;
  }
}

export async function pushGoalEvent(id: ObjectId, type: string, message: string): Promise<void> {
  const goals = await goalsCollection();
  await goals.updateOne(
    { _id: id },
    {
      $push: { events: { $each: [{ at: new Date(), type, message: message.slice(0, 1000) }], $slice: -500 } },
      $set: { updatedAt: new Date() },
    },
  );
}
