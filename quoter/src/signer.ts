import { encode } from '@msgpack/msgpack';
import { keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Official Perps signing (https://docs.polymarket.com/perps/trading, /perps/authenticated-sessions):
 * MessagePack-encode the compact operation, keccak256 it and sign EIP-712 `Op` with the proxy key.
 * The JSON body must carry exactly the fields the compact form was built from.
 */
export const DOMAIN = { name: 'Polymarket', version: '1', chainId: 137 } as const;
export const OP_TYPES = { Op: [{ name: 'data', type: 'bytes32' }, { name: 'salt', type: 'uint64' }, { name: 'ts', type: 'uint64' }] } as const;
export const CREATE_PROXY_TYPES = { CreateProxy: [{ name: 'addr', type: 'address' }, { name: 'exp', type: 'uint64' }, { name: 'salt', type: 'uint64' }, { name: 'ts', type: 'uint64' }] } as const;

/** Post-only GTC limit order. `ro` is omitted (not false) unless set, matching the documented compact form. */
export interface CreateOrderArgs { iid: number; buy: boolean; p: string; qty: string; tif: 'gtc' | 'ioc' | 'fok'; po?: boolean; ro?: true; c: string; }
export interface ModifyArgs { coid: string; p: string; qty: string; }
export type Operation =
  | { type: 'createOrders'; args: CreateOrderArgs[] }
  | { type: 'modifyOrdersCOID'; args: ModifyArgs[] }
  | { type: 'cancelOrdersCOID'; args: string[] }
  | { type: 'cancelAll'; args: { iid?: number } }
  | { type: 'autoCancel'; args: { time: number } }
  | { type: 'updateLeverage'; args: { iid: number; lev: number; cross: boolean } };
export interface SignedRequest { op: Operation; sig: Hex; salt: number; ts: number; }

const COID = /^[0-9a-f]{32}$/;
const dropUndefined = (values: readonly unknown[]): unknown[] => values.filter((value) => value !== undefined);

export function compactOperation(op: Operation): unknown[] {
  switch (op.type) {
    case 'createOrders':
      return [op.type, op.args.map((o) => dropUndefined([o.iid, o.buy, o.p, o.qty, o.tif, o.po ?? false, o.ro, o.c, undefined]))];
    case 'modifyOrdersCOID':
      return [op.type, op.args.map((m) => [m.coid, m.p, m.qty])];
    case 'cancelOrdersCOID':
      return [op.type, [...op.args]];
    case 'cancelAll':
      return [op.type, op.args.iid === undefined ? [] : [op.args.iid]];
    case 'autoCancel':
      return [op.type, [op.args.time]];
    case 'updateLeverage':
      return [op.type, [op.args.iid, op.args.lev, op.args.cross]];
  }
}

export function validateOperation(op: Operation): void {
  const exact = /^(0|[1-9]\d*)(\.\d+)?$/;
  if (op.type === 'createOrders') {
    if (!op.args.length) throw new Error('createOrders needs at least one order');
    for (const o of op.args) {
      if (!Number.isSafeInteger(o.iid) || o.iid < 0 || !exact.test(o.p) || !exact.test(o.qty) || !COID.test(o.c) || /^0+$/.test(o.c)) throw new Error('Invalid createOrders item');
      if (o.po && o.tif !== 'gtc') throw new Error('Post-only is valid only for GTC');
    }
  }
  if (op.type === 'modifyOrdersCOID') for (const m of op.args) if (!COID.test(m.coid) || !exact.test(m.p) || !exact.test(m.qty)) throw new Error('Invalid modifyOrdersCOID item');
  if (op.type === 'cancelOrdersCOID') for (const c of op.args) if (!COID.test(c)) throw new Error('Invalid client order id');
  if (op.type === 'autoCancel' && (!Number.isSafeInteger(op.args.time) || op.args.time < 0)) throw new Error('Invalid auto-cancel time');
}

export const operationHash = (op: Operation): Hex => keccak256(encode(compactOperation(op)));

/** Uniform 53-bit salt: a JSON-safe integer inside uint64. */
export function randomSalt(): number {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return (hi! & 0x1f_ffff) * 2 ** 32 + lo!;
}
export const newClientOrderId = (): string => {
  let id = '';
  do id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'); while (/^0+$/.test(id));
  return id;
};

export interface ProxySigner { address: Address; signTypedData: ReturnType<typeof privateKeyToAccount>['signTypedData']; }
export const proxySigner = (privateKey: Hex): ProxySigner => {
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, signTypedData: account.signTypedData };
};

export async function signOperation(op: Operation, signer: Pick<ProxySigner, 'signTypedData'>, ts: number, salt = randomSalt()): Promise<SignedRequest> {
  validateOperation(op);
  const sig = await signer.signTypedData({ domain: DOMAIN, types: OP_TYPES, primaryType: 'Op', message: { data: operationHash(op), salt: BigInt(salt), ts: BigInt(ts) } });
  return { op, sig, salt, ts };
}

/** JSON body for a signed request; the structured args are exactly the signed ones. */
export function requestBody(request: SignedRequest): string {
  const { op } = request;
  const args = op.type === 'createOrders' ? op.args.map((o) => ({ iid: o.iid, buy: o.buy, p: o.p, qty: o.qty, tif: o.tif, po: o.po ?? false, ...(o.ro ? { ro: true } : {}), c: o.c })) : op.args;
  return JSON.stringify({ op: { type: op.type, args }, sig: request.sig, salt: request.salt, ts: request.ts });
}

export const createProxyTypedData = (proxy: Address, expiry: number, salt: number, ts: number) => ({
  domain: DOMAIN, types: CREATE_PROXY_TYPES, primaryType: 'CreateProxy' as const,
  message: { addr: proxy, exp: BigInt(expiry), salt: BigInt(salt), ts: BigInt(ts) },
});

/** REST route for each signed operation. */
export const ROUTES: Record<Operation['type'], { method: 'POST' | 'PATCH' | 'DELETE'; path: string }> = {
  createOrders: { method: 'POST', path: '/v1/trade/orders' },
  modifyOrdersCOID: { method: 'PATCH', path: '/v1/trade/orders-coid' },
  cancelOrdersCOID: { method: 'DELETE', path: '/v1/trade/orders-coid' },
  cancelAll: { method: 'DELETE', path: '/v1/trade/orders/all' },
  autoCancel: { method: 'PATCH', path: '/v1/trade/auto-cancel' },
  updateLeverage: { method: 'PATCH', path: '/v1/trade/leverage' },
};
