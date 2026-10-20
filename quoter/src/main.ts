import { join, resolve } from 'node:path';
import { QuoterBot } from './bot.ts';
import { assertOrderPlacementAllowed } from './compliance.ts';
import { loadSettings, profileFor, type Settings } from './config.ts';
import { obtainCredentials, type Credentials } from './credentials.ts';
import { EgressPool, parseEgressList } from './egress.ts';
import { loadEnv } from './env.ts';
import { findInstrument, type Instrument } from './instruments.ts';
import { createLogger, errorText, type Level, type Logger } from './log.ts';
import { Clock, REST_BASE, RestClient, WS_URL } from './rest.ts';
import { signOperation } from './signer.ts';
import { ManagedSocket } from './socket.ts';
import { startDashboard, type DashboardHandle } from './dashboard/server.ts';

const ROOT = resolve(import.meta.dir, '..');
const USAGE = `Polymarket Perps liquidity quoter

  bun src/main.ts probe                    egress routes, server time, instruments, public stream (read-only)
  bun src/main.ts dry-run                  live public data, simulated ladders and reward metrics, no writes
  bun src/main.ts status                   private account state for the selected instruments (read-only)
  bun src/main.ts run --live               quote with real orders (config mode: live + jurisdiction gate)
  bun src/main.ts cancel-all --live        cancel every open order on the selected instruments

Options:
  --config <path>        default config/quoter.yaml, falling back to config/example.yaml
  --from-config          ignore the instrument selection saved from the dashboard (data/selection.json)
  --instrument <symbol>  limit status / cancel-all to one instrument`;

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

interface Selection { instruments: Instrument[]; source: 'config' | 'dashboard'; }
const selectionFile = (ctx: Context) => join(ctx.settings.metrics.dir, 'selection.json');

/** Symbols to quote: the selection saved from the dashboard, unless --from-config or none was saved. */
async function selectedSymbols(ctx: Context): Promise<{ symbols: string[]; source: 'config' | 'dashboard' }> {
  const file = Bun.file(selectionFile(ctx));
  if (!Bun.argv.includes('--from-config') && await file.exists()) {
    try {
      const saved = await file.json() as { instruments?: unknown };
      if (Array.isArray(saved.instruments) && saved.instruments.length && saved.instruments.every((x) => typeof x === 'string')) {
        ctx.log.info('instrument selection restored from the dashboard', { file: selectionFile(ctx), instruments: saved.instruments, hint: 'pass --from-config to use the config list' });
        return { symbols: saved.instruments as string[], source: 'dashboard' };
      }
    } catch (error) { ctx.log.warn('saved instrument selection unreadable; using config', { error: errorText(error) }); }
  }
  return { symbols: ctx.settings.instruments.map((i) => i.symbol), source: 'config' };
}

async function prepare(ctx: Context): Promise<Selection> {
  const { log, settings, egress, rest, clock } = ctx;
  for (const warning of ctx.warnings) log.warn('config', { warning });
  const probe = await egress.probe(REST_BASE, settings.egress.select === 'fastest');
  log.info('egress probe', { routes: probe, selected: egress.describe() });
  if (!probe.some((route) => route.ok)) throw new Error('No egress route reaches the Perps API');
  const sync = await clock.sync();
  log.info('clock', sync);
  const rows = await rest.getPublic<unknown[]>('/v1/info/instruments');
  const { symbols, source } = await selectedSymbols(ctx);
  const only = argument('--instrument');
  const instruments: Instrument[] = [];
  for (const symbol of only ? [only] : symbols) {
    try { instruments.push(findInstrument(rows, symbol, `${REST_BASE}/v1/info/instruments`, clock.nowMs())); }
    catch (error) { log.error('instrument skipped', { symbol, error: errorText(error) }); }
  }
  if (!instruments.length) throw new Error(`None of the selected instruments is listed: ${symbols.join(', ')}`);
  log.info('config', { path: ctx.configPath, mode: settings.mode, source, instruments: instruments.map((i) => ({ id: i.id, symbol: i.symbol, category: i.category, levels: profileFor(settings, i.symbol).levels })) });
  return { instruments, source };
}

async function credentialsFor(ctx: Context): Promise<Credentials> {
  const credentials = await obtainCredentials(ctx.env, ctx.rest, ctx.clock, ctx.settings.credentials.proxyTtlHours, ctx.log.child('credentials'));
  delete process.env.PERPS_OWNER_PRIVATE_KEY; delete ctx.env.PERPS_OWNER_PRIVATE_KEY;
  return credentials;
}

async function runBot(ctx: Context, selection: Selection, credentials: Credentials | null): Promise<number> {
  const bot = new QuoterBot({
    settings: ctx.settings, instruments: selection.instruments, egress: ctx.egress, rest: ctx.rest, clock: ctx.clock, log: ctx.log,
    credentials, stopFile: join(ROOT, 'STOP'), selectionFile: selectionFile(ctx), selectionSource: selection.source,
  });
  let dashboard: DashboardHandle | null = null;
  if (ctx.settings.dashboard.enabled) {
    try { dashboard = await startDashboard({ port: ctx.settings.dashboard.port, source: bot, log: ctx.log.child('dashboard') }); }
    catch (error) { ctx.log.error('dashboard failed to start; quoting continues without it', { error: errorText(error) }); }
  }
  const stop = (signal: string) => { void bot.stop(signal); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  try { await bot.start(); }
  catch (error) { ctx.log.error('startup failed', { error: errorText(error) }); await bot.stop('startup failure'); dashboard?.stop(); return 1; }
  const reason = await bot.done;
  await Bun.sleep(1_500); // let the panel show the final state
  dashboard?.stop();
  ctx.log.info('stopped', { reason, metrics: bot.quoted().map((q) => q.metrics.summary()) });
  return reason.startsWith('risk halt') || reason === 'startup failure' ? 2 : 0;
}

async function probeCommand(ctx: Context): Promise<number> {
  const { instruments } = await prepare(ctx);
  const waiting = new Set(instruments.map((i) => i.id));
  const socket = new ManagedSocket('probe', ctx.egress, ctx.log.child('probe'), {
    onOpen: async (s) => { await s.request({ req: 'sub', chs: instruments.map((i) => `bbo::${i.id}`) }); },
    onFrame: (frame) => {
      const id = Number(frame.ch?.split('::')[1]);
      if (frame.ch?.startsWith('bbo::') && waiting.delete(id)) ctx.log.info('public stream ok', { instrument: instruments.find((i) => i.id === id)?.symbol, route: ctx.egress.describe(), url: WS_URL, bbo: frame.data });
    },
  }, { url: WS_URL });
  socket.start();
  const until = Date.now() + 20_000;
  while (waiting.size && Date.now() < until) await Bun.sleep(100);
  socket.stop();
  if (waiting.size) { ctx.log.error('no public stream frame within 20 s', { instruments: [...waiting] }); return 1; }
  return 0;
}

async function statusCommand(ctx: Context): Promise<number> {
  const { instruments } = await prepare(ctx);
  const credentials = await credentialsFor(ctx);
  const auth = credentials.auth;
  const [portfolio, limits, autoCancel, stats] = await Promise.all([
    ctx.rest.getPrivate<unknown>('/v1/account/portfolio', auth), ctx.rest.getPrivate<unknown>('/v1/account/limits', auth),
    ctx.rest.getPrivate<unknown>('/v1/account/auto-cancel', auth), ctx.rest.getPrivate<unknown>('/v1/account/stats', auth),
  ]);
  const openOrders = Object.fromEntries(await Promise.all(instruments.map(async (i) => [i.symbol, await ctx.rest.getPrivate<unknown[]>('/v1/account/open-orders', auth, { instrument_id: i.id })] as const)));
  ctx.log.info('status', { instruments: instruments.map((i) => i.symbol), openOrders, portfolio, limits, autoCancel, stats, credentialExpires: new Date(credentials.expiresAt).toISOString() });
  return 0;
}

async function cancelAllCommand(ctx: Context): Promise<number> {
  const { instruments } = await prepare(ctx);
  const credentials = await credentialsFor(ctx);
  let failures = 0;
  for (const instrument of instruments) {
    const request = await signOperation({ type: 'cancelAll', args: { iid: instrument.id } }, credentials.signer, ctx.clock.nowMs());
    const outcome = await ctx.rest.write(request);
    ctx.log.info('cancelAll', { instrument: instrument.symbol, ...outcome });
    const open = await ctx.rest.getPrivate<unknown[]>('/v1/account/open-orders', credentials.auth, { instrument_id: instrument.id });
    ctx.log.info('open orders after cancelAll', { instrument: instrument.symbol, count: Array.isArray(open) ? open.length : null });
    if (outcome.kind !== 'ok') failures++;
  }
  return failures ? 1 : 0;
}

async function main(): Promise<number> {
  const command = Bun.argv[2];
  if (!command || command === '--help' || command === 'help') { console.log(USAGE); return 0; }
  const ctx = await context();
  switch (command) {
    case 'probe': return probeCommand(ctx);
    case 'dry-run': return runBot(ctx, await prepare(ctx), null);
    case 'status': return statusCommand(ctx);
    case 'cancel-all':
      if (!Bun.argv.includes('--live')) throw new Error('cancel-all sends a signed operation; pass --live to confirm');
      return cancelAllCommand(ctx);
    case 'run': {
      if (!Bun.argv.includes('--live') || ctx.settings.mode !== 'live') throw new Error('Live quoting needs both `mode: live` in the config and the --live flag. Use dry-run otherwise.');
      assertOrderPlacementAllowed({ country: ctx.settings.operator.jurisdiction, region: ctx.settings.operator.region });
      const selection = await prepare(ctx);
      return runBot(ctx, selection, await credentialsFor(ctx));
    }
    default: console.log(USAGE); return 1;
  }
}

main().then((code) => process.exit(code), (error) => { createLogger().error('fatal', { error: errorText(error) }); process.exit(1); });
