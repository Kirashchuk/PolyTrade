import { expect,test } from 'bun:test';
import { parseStreamBook,parseStreamTrades } from '../src/shared/public-stream';
test('WS depth requires an attested fresh horizon and full valid sorted book',()=>{
  const now=Date.now();const frame={ch:'book::6',sq:10,ts:now,ets:now,data:{b:[['100','2']],a:[['101','3']]}};
  expect(parseStreamBook(frame,6,now)?.asks[0].price).toBe('101');
  expect(parseStreamBook({...frame,ets:0},6,now)).toBeNull();
  expect(parseStreamBook({...frame,ets:now-15000},6,now)).toBeNull();
  expect(parseStreamBook({...frame,data:{b:[['102','2']],a:[['101','3']]}},6,now)).toBeNull();
  expect(parseStreamBook(frame,7,now)).toBeNull();
});
test('trade batches exclude settlement and malformed or wrong-market trades',()=>{
  const value={tid:1,iid:6,side:'long',p:'101',qty:'1',ts:Date.now(),settlement:false};
  expect(parseStreamTrades({ch:'trades::6',data:[value,{...value,tid:2,settlement:true},{...value,iid:7},{...value,qty:'oops'}]},6)).toHaveLength(1);
});
