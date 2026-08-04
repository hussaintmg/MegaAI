/**
 * MongoDB client — cached across serverless invocations (and dev hot reloads)
 * so each function instance holds one connection pool.
 */

import { MongoClient, type Db } from 'mongodb';

const globalForMongo = globalThis as unknown as { _megaaiMongo?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForMongo._megaaiMongo) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    globalForMongo._megaaiMongo = MongoClient.connect(uri).then((client) =>
      client.db(process.env.MONGODB_DB || 'megaai'),
    );
  }
  return globalForMongo._megaaiMongo;
}
