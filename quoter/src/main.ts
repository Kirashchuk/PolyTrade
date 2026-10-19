import { join, resolve } from 'node:path';
import { QuoterBot } from './bot.ts';
import { assertOrderPlacementAllowed } from './compliance.ts';
import { loadSettings, type Settings } from './config.ts';
import { obtainCredentials, type Credentials } from './credentials.ts';
import { D } from './decimal.ts';
import { EgressPool, parseEgressList } from './egress.ts';
import { loadEnv } from './env.ts';
import { checkAgainstInstrument, findInstrument, type Instrument } from './instruments.ts';
import { createLogger, errorText, type Level, type Logger } from './log.ts';
import { Clock, REST_BASE, RestClient, WS_URL } from './rest.ts';
import { signOperation } from './signer.ts';
import { ManagedSocket } from './socket.ts';

const ROOT = resolve(import.meta.dir, '..');
const USAGE = `Polymarket Perps liquidity quoter

  bun src/main.ts probe                    egress routes, server time, instrument, public stream (read-only)
  bun src/main.ts dry-run                  live public data, simulated ladder and reward metrics, no writes
  bun src/main.ts status                   private account state for the instrument (read-only)
  bun src/main.ts run --live               quote with real orders (config mode: live + jurisdiction gate)
  bun src/main.ts cancel-all --live        cancel every open order on the instrument

Options: --config <path> (default config/quoter.yaml, falling back to config/example.yaml)`;

interface Context { env: Record<string, string | undefined>; settings: Settings; warnings: string[]; log: Logger; egress: EgressPool; rest: RestClient; clock: Clock; configPath: string; }

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index > 0 ? Bun.argv[index + 1] : undefined;
}

async function context(): Promise<Context> {
  const env = loadEnv(join(ROOT, '.env'));
  const level = (env.QUOTER_LOG_LEVEL ?? 'info') as Level;
  const log = createLogger({ level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info', scope: 'quoter' });
  const explicit = argument('--config') ?? env.QUOTER_CONFIG;
  const configPath = explicit ? resolve(ROOT, explicit) : (await Bun.file(join(ROOT, 'config/quoter.yaml')).exists()) ? join(ROOT, 'config/quoter.yaml') : join(ROOT, 'config/example.yaml');
  const { settings, warnings } = await loadSettings(configPath);
  if (!resolve(settings.metrics.dir).startsWith(ROOT)) settings.metrics.dir = join(ROOT, settings.metrics.dir);
  const egress = new EgressPool({ proxies: parseEgressList(env.QUOTER_EGRESS_PROXIES), allowDirect: settings.egress.allowDirect, timeoutMs: settings.egress.timeoutMs, log: log.child('egress') });
  const rest = new RestClient(egress, log.child('rest'));
  return { env, settings, warnings, log, egress, rest, clock: new Clock(rest), configPath };
}

async function prepare(ctx: Context): Promise<Instrument> {
  const { log, settings, egress, rest, clock } = ctx;
  log.info('config', { path: ctx.configPath, mode: settings.mode, instrument: settings.instrument, levels: settings.levels });
  for (const warning of ctx.warnings) log.warn('config', { warning });
  const probe = await egress.probe(REST_BASE, settings.egress.select === 'fastest');
  log.info('egress probe', { routes: probe, selected: egress.describe() });
  if (!probe.some((route) => route.ok)) throw new Error('No egress route reaches the Perps API');
  const sync = await clock.sync();
  log.info('clock', sync);
  const rows = await rest.getPublic<unknown[]>('/v1/info/instruments');
  const instrument = findInstrument(rows, settings.instrument, `${REST_BASE}/v1/info/instruments`, clock.nowMs());
  const book = await rest.getPublic<{ bids: [string, string][]; asks: [string, string][] }>('/v1/info/book', { instrument_id: instrument.id, depth: 10 });
  const mid = book.bids[0] && book.asks[0] ? new D(book.bids[0][0]).plus(book.asks[0][0]).div(2) : null;
  const check = checkAgainstInstrument(settings, instrument, mid);
  log.info('instrument', { id: instrument.id, symbol: instrument.symbol, category: instrument.category, priceDecimals: instrument.priceDecimals, quantityDecimals: instrument.quantityDecimals, minNotional: instrument.minNotional.toFixed(), maxOrderCount: instrument.maxOrderCount, maxLeverage: instrument.maxLeverage, mid: mid?.toFixed() ?? null });
  for (const warning of check.warnings) log.warn('instrument check', { warning });
  if (check.errors.length) throw new Error(check.errors.join('; '));
  return instrument;
}

async function credentialsFor(ctx: Context): Promise<Credentials> {
  const credentials = await obtainCredentials(ctx.env, ctx.rest, ctx.clock, ctx.settings.credentials.proxyTtlHours, ctx.log.child('credentials'));
  delete process.env.PERPS_OWNER_PRIVATE_KEY; delete ctx.env.PERPS_OWNER_PRIVATE_KEY;
  return credentials;
}

async function runBot(ctx: Context, instrument: Instrument, credentials: Credentials | null): Promise<number> {
  const bot = new QuoterBot({ settings: ctx.settings, instrument, egress: ctx.egress, rest: ctx.rest, clock: ctx.clock, log: ctx.log.child(credentials ? 'live' : 'dry'), credentials, stopFile: join(ROOT, 'STOP') });
  const stop = (signal: string) => { void bot.stop(signal); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  try { await bot.start(); }
  catch (error) { ctx.log.error('startup failed', { error: errorText(error) }); await bot.stop('startup failure'); return 1; }
  const reason = await bot.done;
  ctx.log.info('stopped', { reason, metrics: bot.metrics.summary() });
  return reason.startsWith('risk halt') || reason === 'startup failure' ? 2 : 0;
}

async function probeCommand(ctx: Context): Promise<number> {
  const instrument = await prepare(ctx);
  const socket = new ManagedSocket('probe', ctx.egress, ctx.log.child('probe'), {
    onOpen: async (s) => { await s.request({ req: 'sub', chs: [`bbo::${instrument.id}`] }); },
    onFrame: (frame) => { if (frame.ch === `bbo::${instrument.id}`) { ctx.log.info('public stream ok', { route: ctx.egress.describe(), url: WS_URL, bbo: frame.data, sq: frame.sq }); received = true; } },
  }, { url: WS_URL });
  let received = false;
  socket.start();
  const until = Date.now() + 15_000;
  while (!received && Date.now() < until) await Bun.sleep(100);
  socket.stop();
  if (!received) { ctx.log.error('no public stream frame within 15 s'); return 1; }
  return 0;
}

async function statusCommand(ctx: Context): Promise<number> {
  const instrument = await prepare(ctx);
  const credentials = await credentialsFor(ctx);
  const auth = credentials.auth, q = { instrument_id: instrument.id };
  const [open, portfolio, limits, autoCancel, stats] = await Promise.all([
    ctx.rest.getPrivate<unknown[]>('/v1/account/open-orders', auth, q), ctx.rest.getPrivate<unknown>('/v1/account/portfolio', auth),
    ctx.rest.getPrivate<unknown>('/v1/account/limits', auth), ctx.rest.getPrivate<unknown>('/v1/account/auto-cancel', auth), ctx.rest.getPrivate<unknown>('/v1/account/stats', auth),
  ]);
  ctx.log.info('status', { instrument: instrument.symbol, openOrders: open, portfolio, limits, autoCancel, stats, credentialExpires: new Date(credentials.expiresAt).toISOString() });
  return 0;
}

async function cancelAllCommand(ctx: Context): Promise<number> {
  const instrument = await prepare(ctx);
  const credentials = await credentialsFor(ctx);
  const request = await signOperation({ type: 'cancelAll', args: { iid: instrument.id } }, credentials.signer, ctx.clock.nowMs());
  const outcome = await ctx.rest.write(request);
  ctx.log.info('cancelAll', { instrument: instrument.symbol, ...outcome });
  const open = await ctx.rest.getPrivate<unknown[]>('/v1/account/open-orders', credentials.auth, { instrument_id: instrument.id });
  ctx.log.info('open orders after cancelAll', { count: Array.isArray(open) ? open.length : null });
  return outcome.kind === 'ok' ? 0 : 1;
}

async function main(): Promise<number> {
  const command = Bun.argv[2];
  if (!command || command === '--help' || command === 'help') { console.log(USAGE); return 0; }
  const ctx = await context();
  switch (command) {
    case 'probe': return probeCommand(ctx);
    case 'dry-run': { const instrument = await prepare(ctx); return runBot(ctx, instrument, null); }
    case 'status': return statusCommand(ctx);
    case 'cancel-all':
      if (!Bun.argv.includes('--live')) throw new Error('cancel-all sends a signed operation; pass --live to confirm');
      return cancelAllCommand(ctx);
    case 'run': {
      if (!Bun.argv.includes('--live') || ctx.settings.mode !== 'live') throw new Error('Live quoting needs both `mode: live` in the config and the --live flag. Use dry-run otherwise.');
      assertOrderPlacementAllowed({ country: ctx.settings.operator.jurisdiction, region: ctx.settings.operator.region });
      const instrument = await prepare(ctx);
      return runBot(ctx, instrument, await credentialsFor(ctx));
    }
    default: console.log(USAGE); return 1;
  }
}

main().then((code) => process.exit(code), (error) => { createLogger().error('fatal', { error: errorText(error) }); process.exit(1); });
