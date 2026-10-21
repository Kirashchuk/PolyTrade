import { timingSafeEqual } from 'node:crypto';

export interface GuardConfig { port: number; token: string; devPort?: number; }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function localHost(request: Request, config: GuardConfig): void {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  const ports = [config.port, config.devPort ?? 5178];
  if (!ports.some(p => [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`].includes(host.toLowerCase()))) throw new HttpError(403, 'Untrusted local host');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site access is disabled');
  const origin = request.headers.get('origin');
  if (origin && !ports.some(p => [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`].includes(origin))) throw new HttpError(403, 'Untrusted origin');
}
export function requireControl(request: Request, config: GuardConfig): void {
  localHost(request, config);
  const value = request.headers.get('x-polytrade-token') ?? request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(value); const b = Buffer.from(config.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'A local control session is required');
  if (!['GET', 'HEAD', 'DELETE'].includes(request.method) && !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use application/json');
}
/** Web Locks and the browser live journal are per origin, so live execution has exactly one browser origin. */
export const liveOrigin = (config: GuardConfig): string => `http://127.0.0.1:${config.port}`;
export function requireLiveOrigin(request: Request, config: GuardConfig): void {
  const host = request.headers.get('host') ?? new URL(request.url).host, origin = request.headers.get('origin');
  if (host.toLowerCase() !== `127.0.0.1:${config.port}` || (origin !== null && origin !== liveOrigin(config))) throw new HttpError(403, `Live trading runs only at ${liveOrigin(config)}: browser locks and the live journal are per origin.`);
}
export async function readJson(request: Request, limit = 16_384): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text) > limit) throw new HttpError(413, 'Request body too large');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
