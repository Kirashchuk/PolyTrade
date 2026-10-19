import { describe, expect, test } from 'bun:test';
import { assertOrderPlacementAllowed } from '../src/compliance.ts';
import { parseSettings } from '../src/config.ts';
import { EgressPool, parseEgressList } from '../src/egress.ts';
import { loadEnv } from '../src/env.ts';
import { createLogger, redact } from '../src/log.ts';
import { RestClient } from '../src/rest.ts';
import { silentLog } from './fixtures.ts';

describe('egress proxies', () => {
  test('parses labelled host:port:user:pass and URL forms; credentials never reach logs', () => {
    const list = parseEgressList('de1=198.51.100.7:43757:USERX1:PASSWORD9, http://u2:p%40ss2@203.0.113.9:8080\n198.51.100.8:3128');
    expect(list.map((p) => p.label)).toEqual(['de1', 'proxy2', 'proxy3']);
    expect(list[0]!.url).toBe('http://USERX1:PASSWORD9@198.51.100.7:43757');
    expect(list[2]!.url).toBe('http://198.51.100.8:3128');
    const lines: string[] = [];
    createLogger({ sink: (l) => lines.push(l) }).info('x', { url: list[0]!.url, raw: 'de1=198.51.100.7:43757:USERX1:PASSWORD9' });
    expect(lines[0]).not.toContain('PASSWORD9');
    expect(lines[0]).not.toContain('USERX1');
    expect(redact('{"secret":"abc","sig":"0x12"}')).toBe('{"secret":"<redacted>","sig":"<redacted>"}');
    expect(() => parseEgressList('bad')).toThrow();
    expect(() => parseEgressList('a=1.2.3.4:99999')).toThrow();
  });

  const pool = (fetchImpl: typeof fetch) => new EgressPool({ proxies: parseEgressList('a=192.0.2.1:1000,b=192.0.2.2:1000'), allowDirect: false, timeoutMs: 1_000, log: silentLog(), fetch: fetchImpl });

  test('reads fail over to the next proxy; every request carries the proxy option', async () => {
    const seen: string[] = [];
    const egress = pool((async (_url: string, init: RequestInit & { proxy?: string }) => { seen.push(init.proxy!); if (seen.length === 1) throw new Error('ECONNRESET'); return new Response('{"time":1}'); }) as unknown as typeof fetch);
    const rest = new RestClient(egress, silentLog());
    expect(await rest.getPublic<{ time: number }>('/v1/info/time')).toEqual({ time: 1 });
    expect(seen).toEqual(['http://192.0.2.1:1000', 'http://192.0.2.2:1000']);
  });

  test('signed writes get exactly one attempt and classify outcomes', async () => {
    const cases: [() => Response | never, string][] = [
      [() => { throw new Error('timeout'); }, 'indeterminate'],
      [() => new Response('{"status":"err","error":"service_unavailable"}', { status: 503 }), 'indeterminate'],
      [() => new Response('{"status":"err","error":"internal_error"}', { status: 500 }), 'indeterminate'],
      [() => new Response('not json', { status: 200 }), 'indeterminate'],
      [() => new Response('[{"status":"err","error":"invalid signature"}]', { status: 400 }), 'rejected'],
      [() => new Response('{"status":"err","error":"rate_limited"}', { status: 429 }), 'rejected'],
      [() => new Response('[{"status":"ok","oid":1}]', { status: 200 }), 'ok'],
    ];
    for (const [respond, kind] of cases) {
      let calls = 0;
      const rest = new RestClient(pool((async () => { calls++; return respond(); }) as unknown as typeof fetch), silentLog());
      const outcome = await rest.sendOnce('POST', '/v1/trade/orders', '{}');
      expect(outcome.kind).toBe(kind as typeof outcome.kind);
      expect(calls).toBe(1);
    }
    const rejected = await new RestClient(pool((async () => new Response('[{"status":"err","error":"invalid signature"}]', { status: 400 })) as unknown as typeof fetch), silentLog()).sendOnce('POST', '/x', '{}');
    expect(rejected.kind === 'rejected' && rejected.error).toBe('invalid signature');
  });

  test('without proxies and without direct egress the pool refuses to start', () => {
    expect(() => new EgressPool({ proxies: [], allowDirect: false, timeoutMs: 1_000, log: silentLog() })).toThrow('QUOTER_EGRESS_PROXIES');
  });
});

describe('jurisdiction gate (official restricted list)', () => {
  test('restricted countries and regions are blocked; the proxy location is irrelevant', () => {
    for (const country of ['US', 'ca', 'CU', 'IR', 'KP', 'SY']) expect(() => assertOrderPlacementAllowed({ country, region: '' })).toThrow('not permitted');
    for (const region of ['UA-43', 'UA-40', 'UA-14', 'UA-09']) expect(() => assertOrderPlacementAllowed({ country: 'UA', region })).toThrow('not permitted');
    expect(() => assertOrderPlacementAllowed({ country: '', region: '' })).toThrow('jurisdiction');
    expect(() => assertOrderPlacementAllowed({ country: 'UA', region: '' })).toThrow('region');
    expect(() => assertOrderPlacementAllowed({ country: 'DE', region: 'UA-30' })).toThrow('belong');
    expect(() => assertOrderPlacementAllowed({ country: 'UA', region: 'UA-30' })).not.toThrow();
    expect(() => assertOrderPlacementAllowed({ country: 'PL', region: '' })).not.toThrow();
  });
});

describe('configuration', () => {
  const base = { instrument: 'PLTR-USD', levels: [{ band: 1, bps: 3.5, size_usd: 1000 }] };
  test('levels must sit strictly inside their band; unknown keys are rejected', () => {
    expect(() => parseSettings({ ...base, levels: [{ band: 1, bps: 5, size_usd: 1000 }] })).toThrow('outside band 1');
    expect(() => parseSettings({ ...base, levels: [{ band: 2, bps: 4, size_usd: 1000 }] })).toThrow('outside band 2');
    expect(() => parseSettings({ ...base, typo: 1 })).toThrow('unknown key');
    expect(() => parseSettings({ ...base, deadman: { timeout_s: 30, rearm_every_s: 20 } })).toThrow('half');
    expect(parseSettings({ ...base, levels: [{ band: 1, bps: 3, size_usd: 120_000 }] }).warnings.some((w) => w.includes('cap'))).toBe(true);
    expect(parseSettings(base).settings.mode).toBe('dry_run');
  });
  test('the env file accepts only non-wallet keys', async () => {
    const dir = `${import.meta.dir}/.tmp-env`;
    await Bun.write(`${dir}/ok.env`, 'QUOTER_EGRESS_PROXIES=a=192.0.2.1:1\n# comment\n');
    expect(loadEnv(`${dir}/ok.env`, {}).QUOTER_EGRESS_PROXIES).toBe('a=192.0.2.1:1');
    expect(loadEnv(`${dir}/ok.env`, { QUOTER_EGRESS_PROXIES: 'shell' }).QUOTER_EGRESS_PROXIES).toBe('shell');
    await Bun.write(`${dir}/bad.env`, 'PERPS_OWNER_PRIVATE_KEY=0xabc\n');
    expect(() => loadEnv(`${dir}/bad.env`, {})).toThrow('must not be stored in a file');
    await Bun.write(`${dir}/other.env`, 'FOO=1\n');
    expect(() => loadEnv(`${dir}/other.env`, {})).toThrow('unsupported key');
    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
  });
});
