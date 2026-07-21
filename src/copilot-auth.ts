/**
 * copilot-auth.ts
 *
 * Authenticates with the GitHub Copilot API.
 *
 * Auth flow:
 *   1. If GHU_APP_TOKEN is set, use it directly (previously obtained OAuth token).
 *   2. Otherwise, run GitHub OAuth Device Flow once — the proxy shows a URL+code,
 *      the user authorizes in a browser, and the resulting OAuth token is automatically
 *      saved to .env. All future restarts are fully non-interactive.
 */

import * as fs from 'fs';
import * as path from 'path';

interface CopilotToken {
  token: string;
  expiresAt: number;
  baseUrl: string;
}

let _cached: CopilotToken | null = null;
const REFRESH_BUFFER_SECS = 60;

// VS Code's GitHub OAuth app client ID — produces gho_ tokens accepted by Copilot API
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_SCOPES = 'read:user';

export function resolveBaseUrl(token: string): string {
  if (token.includes('proxy-ep=proxy.enterprise.')) {
    return 'https://api.enterprise.githubcopilot.com';
  }
  if (token.includes('proxy-ep=proxy.business.')) {
    return 'https://api.business.githubcopilot.com';
  }
  return 'https://api.githubcopilot.com';
}

function isExpiringSoon(expiresAt: number): boolean {
  return Date.now() / 1000 > expiresAt - REFRESH_BUFFER_SECS;
}

export async function getCopilotToken(): Promise<{ token: string; baseUrl: string }> {
  if (_cached && !isExpiringSoon(_cached.expiresAt)) {
    return { token: _cached.token, baseUrl: _cached.baseUrl };
  }

  const githubToken = await getGitHubToken();

  // Try Copilot JWT exchange first (works for Individual accounts)
  const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${githubToken}`,
      'Editor-Version': 'vscode/1.99.0',
      'Editor-Plugin-Version': 'copilot/1.0.0',
      'User-Agent': 'GithubCopilot/1.0.0',
    },
  });

  if (resp.ok) {
    const data = await resp.json() as { token: string; expires_at?: number };
    _cached = {
      token: data.token,
      expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + 1800,
      baseUrl: resolveBaseUrl(data.token),
    };
    console.log('[auth] Copilot JWT obtained via token exchange');
    return { token: _cached.token, baseUrl: _cached.baseUrl };
  }

  // Business/Enterprise: exchange returns 404 — use token directly on individual endpoint.
  // OAuth tokens (gho_) are accepted; PATs are not.
  if (resp.status === 404) {
    if (githubToken.startsWith('ghp_')) {
      throw new Error(
        'PATs (ghp_) are not accepted by the Copilot API on Enterprise accounts.\n' +
        'Remove GHU_APP_TOKEN from your .env to trigger OAuth Device Flow, which\n' +
        'will obtain a compatible OAuth token (gho_) automatically.'
      );
    }
    console.log('[auth] Token exchange returned 404 — using OAuth token directly');
    _cached = {
      token: githubToken,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      baseUrl: 'https://api.githubcopilot.com',
    };
    return { token: _cached.token, baseUrl: _cached.baseUrl };
  }

  throw new Error(`Failed to get Copilot token: ${resp.status} ${resp.statusText}`);
}

// Singleton: ensures only one device flow runs even if multiple requests arrive concurrently
let _deviceFlowPromise: Promise<string> | null = null;

/**
 * Get a GitHub OAuth token.
 * Uses GHU_APP_TOKEN if set, otherwise runs the OAuth Device Flow (once).
 */
export async function getGitHubToken(): Promise<string> {
  if (process.env.GHU_APP_TOKEN) {
    return process.env.GHU_APP_TOKEN;
  }
  if (!_deviceFlowPromise) {
    _deviceFlowPromise = runDeviceFlow().catch(err => {
      _deviceFlowPromise = null; // allow retry on next request
      throw err;
    });
  }
  return _deviceFlowPromise;
}

/**
 * GitHub OAuth Device Flow.
 * Prompts the user to visit a URL once to authorize the app.
 * Returns a gho_ OAuth token accepted by the Copilot API.
 */
async function runDeviceFlow(): Promise<string> {
  // Step 1: Request device + user code
  const codeResp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }),
  });

  if (!codeResp.ok) {
    throw new Error(`Device flow init failed: ${codeResp.status}`);
  }

  const { device_code, user_code, verification_uri, expires_in, interval } =
    await codeResp.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

  console.log('\n' + '='.repeat(60));
  console.log('[auth] GitHub authorization required (one-time setup)');
  console.log('='.repeat(60));
  console.log(`  1. Open: ${verification_uri}`);
  console.log(`  2. Enter code: ${user_code}`);
  console.log(`  3. Authorize "GitHub Copilot" when prompted`);
  console.log('='.repeat(60));
  console.log('[auth] Waiting for authorization...\n');

  // Step 2: Poll until authorized
  const deadline = Date.now() + expires_in * 1000;
  const pollInterval = (interval + 1) * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));

    const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await tokenResp.json() as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.access_token) {
      console.log('[auth] Authorization successful — OAuth token obtained');
      // Persist to GHU_APP_TOKEN so future restarts skip the device flow
      process.env.GHU_APP_TOKEN = data.access_token;
      _persistToken(data.access_token);
      return data.access_token;
    }

    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (data.error === 'expired_token') throw new Error('Device flow expired. Restart the proxy to try again.');
    if (data.error) throw new Error(`Device flow error: ${data.error} — ${data.error_description}`);
  }

  throw new Error('Device flow timed out. Restart the proxy to try again.');
}

/**
 * Persist the OAuth token to the .env file so future restarts skip the device flow.
 */
function _persistToken(token: string): void {
  // Always save relative to this module's directory, not process.cwd()
  const envPath = path.join(__dirname, '..', '.env');
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (content.includes('GHU_APP_TOKEN=')) {
      content = content.replace(/^#?\s*GHU_APP_TOKEN=.*/m, `GHU_APP_TOKEN=${token}`);
    } else {
      content = `GHU_APP_TOKEN=${token}\n` + content;
    }
    fs.writeFileSync(envPath, content, 'utf8');
    console.log('[auth] Token saved to .env — future restarts will be non-interactive');
  } catch {
    console.log('[auth] Could not save token to .env — set GHU_APP_TOKEN=' + token.slice(0, 10) + '... manually');
  }
}

export function invalidateCache(): void {
  _cached = null;
}

export function getCachedTokenString(): string | null {
  return _cached?.token ?? null;
}

export function getCachedExpiresAt(): number | null {
  return _cached?.expiresAt ?? null;
}
