import { config } from 'dotenv';
import path from 'node:path';

// .env.test is gitignored and holds real endpoints/credentials for whichever
// Trino/Postgres servers are reachable from this machine; .env.test.example
// documents the shape for anyone setting it up fresh.
config({ path: path.resolve(__dirname, '../../.env.test') });
