/**
 * Turning a MongoDB connection failure into something you can act on.
 *
 * `querySrv ECONNREFUSED _mongodb._tcp.cluster0.abc.mongodb.net` is a true
 * sentence that tells almost nobody what to do. It means the DNS server this
 * machine uses would not answer an SRV lookup — which many home routers and
 * most school and office networks will not — and it has a fix that takes two
 * minutes. Printing the raw error and stopping wastes those two minutes on
 * finding out what the words mean.
 */

export interface MongoTrouble {
  /** One line: what actually went wrong. */
  summary: string;
  /** What to do about it, in order of how likely it is to be the answer. */
  fixes: string[];
  /** Waiting might fix this on its own — the network could come back. */
  transient: boolean;
}

export function explainMongoFailure(error: unknown, uri: string): MongoTrouble {
  const message = error instanceof Error ? error.message : String(error);
  const host = /@([^/?,]+)/.exec(uri)?.[1] ?? 'the cluster';

  if (/querySrv|ESERVFAIL|ENOTFOUND _mongodb/.test(message)) {
    return {
      summary: `this machine's DNS would not answer the SRV lookup for ${host} (${message.trim()})`,
      transient: true,
      fixes: [
        'Use the connection string without +srv. In Atlas: Connect → Drivers → change the driver version to "Node.js 2.2.12 or later". That gives a mongodb:// string listing the servers directly, which needs no SRV lookup.',
        'Or change this machine\'s DNS to 8.8.8.8 / 1.1.1.1 — many home routers and most office and campus networks do not serve SRV records.',
        'If you are on a VPN or a corporate network, it may be blocking the lookup entirely.',
      ],
    };
  }

  if (/Authentication failed|bad auth/i.test(message)) {
    return {
      summary: 'the cluster refused the username or password in the connection string',
      transient: false,
      fixes: [
        'Check the password in the string — if it contains @ : / ? # or %, each has to be percent-encoded.',
        'Confirm the database user still exists in Atlas → Database Access.',
        'Save the corrected one with: megaai-node set MEGAAI_MONGODB_URI "…"',
      ],
    };
  }

  if (/timed out|ETIMEDOUT|ECONNRESET|server selection/i.test(message)) {
    return {
      summary: `could not reach ${host} before the timeout (${message.trim().slice(0, 200)})`,
      transient: true,
      fixes: [
        "Add this machine's IP in Atlas → Network Access. A cluster that has never seen your address simply does not answer.",
        'Check the machine is online at all.',
      ],
    };
  }

  if (/ECONNREFUSED/.test(message)) {
    return {
      summary: `${host} refused the connection (${message.trim().slice(0, 200)})`,
      transient: true,
      fixes: [
        'If this is a MongoDB you run yourself, check it is actually started.',
        'If it is Atlas, add this machine in Network Access.',
      ],
    };
  }

  return {
    summary: message.trim().slice(0, 300),
    transient: true,
    fixes: ['Check the connection string with: megaai-node set'],
  };
}
