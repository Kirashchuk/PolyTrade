import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { registerSecret, type Logger } from './log.ts';
import type { Clock, PrivateAuth, RestClient } from './rest.ts';
import { createProxyTypedData, proxySigner, randomSalt, type ProxySigner } from './signer.ts';

/** Polymarket Perps proxy credential. Held in process memory only; never written to disk or logs. */
export interface Credentials { auth: PrivateAuth; signer: ProxySigner; expiresAt: number; owner: Address | null; origin: 'registered' | 'environment'; }

const KEY = /^0x[0-9a-fA-F]{64}$/;

/**
 * Two sources, both from the process environment (never from files):
 * 1. PERPS_PROXY_PRIVATE_KEY + PERPS_PROXY_SECRET + PERPS_PROXY_EXPIRES_AT: an already registered proxy.
 * 2. PERPS_OWNER_PRIVATE_KEY: register a fresh expiring proxy once at startup, then drop the owner key.
 */
export async function obtainCredentials(env: Record<string, string | undefined>, rest: RestClient, clock: Clock, ttlHours: number, log: Logger): Promise<Credentials> {
  const proxyKey = env.PERPS_PROXY_PRIVATE_KEY, secret = env.PERPS_PROXY_SECRET, expires = env.PERPS_PROXY_EXPIRES_AT;
  if (proxyKey || secret) {
    if (!proxyKey || !KEY.test(proxyKey) || !secret || !expires || !/^\d{13}$/.test(expires)) throw new Error('PERPS_PROXY_PRIVATE_KEY (0x + 64 hex), PERPS_PROXY_SECRET and PERPS_PROXY_EXPIRES_AT (unix ms) must be set together');
    registerSecret(proxyKey); registerSecret(secret);
    const signer = proxySigner(proxyKey as Hex);
    const expiresAt = Number(expires);
    if (expiresAt <= clock.nowMs()) throw new Error('The supplied Polymarket proxy credential has expired');
    return { auth: { proxy: signer.address, secret }, signer, expiresAt, owner: null, origin: 'environment' };
  }
  const ownerKey = env.PERPS_OWNER_PRIVATE_KEY;
  if (!ownerKey) throw new Error('No Polymarket credentials: export PERPS_OWNER_PRIVATE_KEY, or PERPS_PROXY_PRIVATE_KEY + PERPS_PROXY_SECRET + PERPS_PROXY_EXPIRES_AT');
  if (!KEY.test(ownerKey)) throw new Error('PERPS_OWNER_PRIVATE_KEY must be 0x + 64 hex characters');
  registerSecret(ownerKey);
  const owner = privateKeyToAccount(ownerKey as Hex);
  const proxyPrivate = generatePrivateKey();
  registerSecret(proxyPrivate);
  const signer = proxySigner(proxyPrivate);
  const ts = clock.nowMs(), salt = randomSalt(), expiresAt = ts + Math.round(ttlHours * 3_600_000);
  const sig = await owner.signTypedData(createProxyTypedData(signer.address, expiresAt, salt, ts));
  const body = JSON.stringify({ op: { type: 'createProxy', args: { owner: getAddress(owner.address), proxy: signer.address, expiry: expiresAt } }, sig, salt, ts, label: 'polytrade-quoter' });
  const outcome = await rest.sendOnce('POST', '/v1/account/proxy', body);
  if (outcome.kind !== 'ok') throw new Error(`Proxy registration ${outcome.kind}: ${outcome.error}. Not retried; check the account's proxies before starting again.`);
  const value = outcome.body as { secret?: unknown };
  if (typeof value.secret !== 'string' || !value.secret) throw new Error('Proxy registration returned no secret');
  registerSecret(value.secret);
  log.info('registered Polymarket proxy credential (memory only)', { proxy: signer.address, owner: owner.address, expiresAt: new Date(expiresAt).toISOString() });
  return { auth: { proxy: signer.address, secret: value.secret }, signer, expiresAt, owner: owner.address, origin: 'registered' };
}
