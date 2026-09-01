import 'server-only';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/*
 * The database handle.
 *
 * Created lazily. `next build` imports route modules to collect page data, and
 * a client that connects at module scope would make the build fail on any
 * machine without DATABASE_URL set — including CI, and including a first clone
 * before anyone has configured anything. Failing at first *use* instead means
 * the build works and the error, when it comes, names the missing variable.
 */

let client: ReturnType<typeof postgres> | null = null;
let handle: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (handle) return handle;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.',
    );
  }

  client = postgres(url, {
    // Serverless invocations are short-lived; a large pool per instance just
    // exhausts the database's connection limit.
    max: 4,
    idle_timeout: 20,
    // A hung query on the money path should fail fast rather than pin a
    // connection until the platform kills the whole invocation.
    connect_timeout: 10,
  });

  handle = drizzle(client, { schema });
  return handle;
}

export { schema };
