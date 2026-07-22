/**
 * index.ts — Entry point for the standalone AI proxy.
 *
 * Loads config from environment variables (or .env file via dotenv),
 * then starts the HTTP proxy server.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node dist/index.js
 *   # or with .env file:
 *   node --env-file=.env dist/index.js
 */

import 'dotenv/config';
import { ProxyServer } from './proxy-server';
import type { ProxyConfig } from './types';

const config: ProxyConfig = {
  port:             parseInt(process.env.PROXY_PORT             ?? '3100'),
  host:             process.env.PROXY_HOST                      ?? '127.0.0.1',
  rateLimitSeconds: parseFloat(process.env.PROXY_RATE_LIMIT_SECONDS ?? '0'),
  rateLimitWait:    process.env.PROXY_RATE_LIMIT_WAIT            === 'true',
  logRequests:      process.env.PROXY_LOG_REQUESTS              === 'true',
  showToken:        process.env.PROXY_SHOW_TOKEN                === 'true',
  storageDir:       process.env.PROXY_STORAGE_DIR               ?? './data',
  integrationId:    process.env.PROXY_INTEGRATION_ID            ?? 'standalone-aiproxy',
};

const proxy = new ProxyServer(config);

// Warm up auth before accepting requests — runs device flow if GHU_APP_TOKEN is not set
import { getGitHubToken } from './copilot-auth';

getGitHubToken()
  .then(() => proxy.start())
  .catch(err => {
    console.error('[proxy] Auth failed:', err.message);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGINT',  () => { proxy.stop(); process.exit(0); });
process.on('SIGTERM', () => { proxy.stop(); process.exit(0); });
