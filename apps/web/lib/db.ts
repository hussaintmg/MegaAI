/**
 * MongoDB client — cached across serverless invocations (and dev hot reloads)
 * so each function instance holds one connection pool.
 *
 * The cached promise is cleared if it rejects: caching a failed connection
 * would leave the app permanently broken until redeploy after one transient
 * Atlas blip. Indexes are created as part of the same cached promise, so the
 * unique constraint on users.email always exists before any insert.
 */

import { MongoClient, type Db } from 'mongodb';

const globalForMongo = globalThis as unknown as { _megaaiMongo?: Promise<Db> };

async function connect(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const client = await MongoClient.connect(uri);
  const db = client.db(process.env.MONGODB_DB || 'megaai');
  // Makes "check then insert" safe against concurrent requests.
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  return db;
}

export function getDb(): Promise<Db> {
  if (!globalForMongo._megaaiMongo) {
    globalForMongo._megaaiMongo = connect().catch((err) => {
      globalForMongo._megaaiMongo = undefined;
      throw err;
    });
  }
  return globalForMongo._megaaiMongo;
}
