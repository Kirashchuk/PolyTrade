import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { onLog, type Logger } from '../log.ts';
import type { AlertRow, DashboardState } from './types.ts';

export interface DashboardSource { dashboardState(): DashboardState; stop(reason: string): Promise<void>; }
export interface DashboardOptions { port: number; source: DashboardSource; log: Logger; token?: string; }
export interface DashboardHandle { url: string; token: string; port: number; stop(): void; }

const PUBLIC = join(import.meta.dir, 'public');
const ASSETS: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
/** Info-level events worth showing next to warnings and errors. */
const FEED_INFO = new Set(['fill', 'cancelAll', 'reconciled', 'quotes pulled', 'leverage set', 'leverage confirmed', "dead man's switch armed", 'quoter running', 'rewards', 'private stream authenticated']);

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...SECURITY, 'content-type': 'application/json' } });

/**
 * Request handler: loopback Host only (DNS-rebinding guard), same-origin fetches only, and the only mutation
 * (`POST /api/stop`) also needs the per-process control token and a JSON body.
 */
export function createDashboardHandler(config: { port: () => number; token: string; source: DashboardSource; alerts: () => AlertRow[]; assets: Map<string, string> }) {
  const allowedHosts = () => ['127.0.0.1', 'localhost', '[::1]'].map((h) => `${h}:${config.port()}`);
  const local = (request: Request) => {
    const host = (request.headers.get('host') ?? '').toLowerCase();
    if (!allowedHosts().includes(host)) throw new HttpError(403, 'Untrusted host');
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site access is disabled');
    const origin = request.headers.get('origin');
    if (origin && !allowedHosts().map((h) => `http://${h}`).includes(origin.toLowerCase())) throw new HttpError(403, 'Untrusted origin');
  };
  const control = async (request: Request) => {
    local(request);
    const given = Buffer.from(request.headers.get('x-quoter-token') ?? ''), expected = Buffer.from(config.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Control token required');
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use application/json');
    const text = await request.text();
    if (text.length > 1_024) throw new HttpError(413, 'Body too large');
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (!body || typeof body !== 'object' || (body as { confirm?: unknown }).confirm !== true) throw new HttpError(400, 'Confirmation required');
  };

  return async (request: Request): Promise<Response> => {
    try {
      const { pathname } = new URL(request.url);
      local(request);
      const asset = ASSETS[pathname];
      if (asset && request.method === 'GET') return new Response(config.assets.get(pathname) ?? '', { headers: { ...SECURITY, 'content-type': asset[1] } });
      if (pathname === '/api/session' && request.method === 'GET') return json({ token: config.token });
      if (pathname === '/api/state' && request.method === 'GET') return json({ ...config.source.dashboardState(), alerts: config.alerts() });
      if (pathname === '/api/stop' && request.method === 'POST') {
        await control(request);
        void config.source.stop('dashboard stop');
        return json({ status: 'stopping' });
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: 'Internal error' }, 500);
    }
  };
}

export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const token = options.token ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const assets = new Map<string, string>();
  for (const [path, [file]] of Object.entries(ASSETS)) assets.set(path, await Bun.file(join(PUBLIC, file)).text());
  const alerts: AlertRow[] = [];
  const unsubscribe = onLog((line, level) => {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (level === 'debug' || (level === 'info' && !FEED_INFO.has(String(record.msg)))) return;
    const { t, level: _level, scope: _scope, msg, ...rest } = record;
    alerts.unshift({ t: String(t), level, msg: String(msg), detail: JSON.stringify(rest).slice(0, 400) });
    if (alerts.length > 60) alerts.pop();
  });
  let port = options.port;
  const handler = createDashboardHandler({ port: () => port, token, source: options.source, alerts: () => alerts, assets });
  const server = Bun.serve({ hostname: '127.0.0.1', port: options.port, fetch: handler });
  port = server.port ?? options.port;
  const url = `http://127.0.0.1:${port}`;
  options.log.info('dashboard', { url });
  return { url, token, port, stop: () => { unsubscribe(); server.stop(true); } };
}
