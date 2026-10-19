import { describe, expect, test } from 'bun:test';
import { encode } from '@msgpack/msgpack';
import { keccak256, recoverTypedDataAddress } from 'viem';
import { compactOperation, DOMAIN, newClientOrderId, OP_TYPES, operationHash, randomSalt, requestBody, signOperation, proxySigner, validateOperation } from '../src/signer.ts';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const; // public test key (Hardhat #1)
const COID = '7f9e4a2b6c8d0e1f1234567890abcdef';

describe('compact operations match the official documentation', () => {
  test('createOrders: undefined entries are dropped, po defaults to false', () => {
    // Literal from docs.polymarket.com/perps/trading → Place Orders → Create the Operation Hash.
    const documented = ['createOrders', [[1, true, '65000', '0.01', 'ioc', false, undefined, COID, undefined].filter((v) => v !== undefined)]];
    const op = { type: 'createOrders' as const, args: [{ iid: 1, buy: true, p: '65000', qty: '0.01', tif: 'ioc' as const, c: COID }] };
    expect(compactOperation(op)).toEqual(documented);
    expect(operationHash(op)).toBe(keccak256(encode(documented)));
  });
  test('post-only GTC carries po=true; ro appears only when set', () => {
    expect(compactOperation({ type: 'createOrders', args: [{ iid: 45, buy: false, p: '195.84', qty: '5.1', tif: 'gtc', po: true, c: COID }] }))
      .toEqual(['createOrders', [[45, false, '195.84', '5.1', 'gtc', true, COID]]]);
    expect(compactOperation({ type: 'createOrders', args: [{ iid: 45, buy: false, p: '195.84', qty: '5.1', tif: 'ioc', ro: true, c: COID }] }))
      .toEqual(['createOrders', [[45, false, '195.84', '5.1', 'ioc', false, true, COID]]]);
  });
  test('modify, cancel, cancelAll, autoCancel and leverage forms', () => {
    expect(compactOperation({ type: 'modifyOrdersCOID', args: [{ coid: COID, p: '100.25', qty: '7' }] })).toEqual(['modifyOrdersCOID', [[COID, '100.25', '7']]]);
    expect(compactOperation({ type: 'cancelOrdersCOID', args: [COID] })).toEqual(['cancelOrdersCOID', [COID]]);
    expect(compactOperation({ type: 'cancelAll', args: {} })).toEqual(['cancelAll', []]);
    expect(compactOperation({ type: 'cancelAll', args: { iid: 1 } })).toEqual(['cancelAll', [1]]);
    expect(compactOperation({ type: 'autoCancel', args: { time: 1767000130000 } })).toEqual(['autoCancel', [1767000130000]]);
    expect(compactOperation({ type: 'updateLeverage', args: { iid: 1, lev: 5, cross: false } })).toEqual(['updateLeverage', [1, 5, false]]);
  });
});

describe('signing', () => {
  test('EIP-712 Op signature recovers to the proxy address and the body carries the signed values', async () => {
    const signer = proxySigner(KEY);
    const op = { type: 'modifyOrdersCOID' as const, args: [{ coid: COID, p: '195.7', qty: '5.1101' }] };
    const request = await signOperation(op, signer, 1_792_424_000_000, 123_456_789);
    expect(request.sig).toMatch(/^0x[0-9a-f]{130}$/);
    const recovered = await recoverTypedDataAddress({ domain: DOMAIN, types: OP_TYPES, primaryType: 'Op', message: { data: operationHash(op), salt: 123_456_789n, ts: 1_792_424_000_000n }, signature: request.sig });
    expect(recovered).toBe(signer.address);
    const body = JSON.parse(requestBody(request));
    expect(body).toEqual({ op: { type: 'modifyOrdersCOID', args: [{ coid: COID, p: '195.7', qty: '5.1101' }] }, sig: request.sig, salt: 123_456_789, ts: 1_792_424_000_000 });
  });
  test('createOrders body mirrors the compact fields', async () => {
    const request = await signOperation({ type: 'createOrders', args: [{ iid: 45, buy: true, p: '195.69', qty: '5.1101', tif: 'gtc', po: true, c: COID }] }, proxySigner(KEY), 1);
    expect(JSON.parse(requestBody(request)).op.args).toEqual([{ iid: 45, buy: true, p: '195.69', qty: '5.1101', tif: 'gtc', po: true, c: COID }]);
  });
  test('salt is a JSON-safe integer; client order ids are 32 lowercase hex, never all zeros', () => {
    for (let i = 0; i < 200; i++) {
      const salt = randomSalt();
      expect(Number.isSafeInteger(salt) && salt >= 0).toBe(true);
      expect(JSON.parse(JSON.stringify({ salt })).salt).toBe(salt);
      expect(newClientOrderId()).toMatch(/^(?!0{32})[0-9a-f]{32}$/);
    }
  });
  test('invalid operations are refused before signing', () => {
    expect(() => validateOperation({ type: 'createOrders', args: [{ iid: 1, buy: true, p: '1e3', qty: '1', tif: 'gtc', po: true, c: COID }] })).toThrow();
    expect(() => validateOperation({ type: 'createOrders', args: [{ iid: 1, buy: true, p: '100', qty: '1', tif: 'ioc', po: true, c: COID }] })).toThrow('Post-only');
    expect(() => validateOperation({ type: 'cancelOrdersCOID', args: ['0'.repeat(31)] })).toThrow();
  });
});
