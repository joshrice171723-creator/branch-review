import test from 'node:test';
import assert from 'node:assert/strict';
import {expiredPreviewCookies} from '../proxy.mjs';
test('old review cookies expire while current, prepared and unrelated sessions survive',()=>{
 const previews=[{runtime:'original',sha:'a'.repeat(40)},{runtime:'changed',sha:'b'.repeat(40)},{runtime:'standby',sha:'c'.repeat(40)}];
 const active=previews.map(p=>`br_${p.runtime}_${p.sha.slice(0,12)}_session=value`).join('; ');
 assert.deepEqual(expiredPreviewCookies(active+'; br_original_dddddddddddd_session=old; unrelated=keep',previews),['br_original_dddddddddddd_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax']);
 assert.deepEqual(expiredPreviewCookies(undefined,previews),[]);
});
