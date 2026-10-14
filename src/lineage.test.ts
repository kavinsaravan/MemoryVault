import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
test("migration enforces cascading revocation, RLS, and lineage invariants", async () => {
const db=new PGlite();
try {
await db.exec(`create role anon; create role authenticated; create role service_role;
create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,service_role; grant execute on function auth.uid() to authenticated,service_role;`);
const dir=new URL('../supabase/migrations/', import.meta.url).pathname;
for(const name of (await readdir(dir)).sort()) await db.exec(await readFile(`${dir}/${name}`,'utf8'));
const owner='00000000-0000-0000-0000-000000000001', outsider='00000000-0000-0000-0000-000000000002';
const root='10000000-0000-0000-0000-000000000001', child='10000000-0000-0000-0000-000000000002', grandchild='10000000-0000-0000-0000-000000000003', other='10000000-0000-0000-0000-000000000004';
await db.exec(`insert into public.memories(id,user_id,key,value,origin,status,derived_from,session_id,is_shared) values
('${root}','${owner}','project_context','Root','user_message','active','{}','s1',true),
('${child}','${owner}','personal_preference','Child','model_summary','active','{${root}}','s2',true),
('${grandchild}','${owner}','writing_tone','concise','model_summary','active','{${child}}','s3',true),
('${other}','${outsider}','project_context','Other','user_message','active','{}','other',true);
set role authenticated; set request.jwt.claim.sub='${outsider}';`);
await assert.rejects(db.query(`select public.revoke_memory('${root}')`));
assert.equal((await db.query<{data:{memories:unknown[]}}>(`select public.inspect_memory('${root}') as data`)).rows[0]!.data.memories.length,0);
await db.exec(`set request.jwt.claim.sub='${owner}'`);
assert.equal((await db.query<{data:{memories:unknown[]}}>(`select public.inspect_memory('${root}') as data`)).rows[0]!.data.memories.length,3);
await db.query(`select public.revoke_memory('${root}')`);
const state=(await db.query<{id:string;status:string;is_shared:boolean}>('select id,status,is_shared from public.memories order by id')).rows;
assert.equal(state.length,3);assert.ok(state.every(m=>m.status==='revoked'&&!m.is_shared));
const events=(await db.query<{memory_id:string;event:string}>(`select memory_id,event from public.memory_events`)).rows;
assert.equal(events.length,3);assert.equal(new Set(events.map(e=>e.memory_id)).size,3);
await db.exec('reset role');
assert.equal((await db.query<{status:string}>(`select status from public.memories where id='${other}'`)).rows[0]!.status,'active');
await assert.rejects(db.query(`insert into public.memories(user_id,key,value,origin,status,derived_from,session_id) values('${owner}','project_context','Illegal','user_message','active','{${root}}','bad')`));

// A held parent and held descendants must also be contained.
await db.exec(`insert into public.memories(id,user_id,key,value,origin,status,derived_from,session_id) values
 ('20000000-0000-0000-0000-000000000001','${owner}','project_context','Held root','document','quarantined','{}','held'),
 ('20000000-0000-0000-0000-000000000002','${owner}','personal_preference','Held child','model_summary','quarantined','{20000000-0000-0000-0000-000000000001}','held');
 set role authenticated; set request.jwt.claim.sub='${owner}';
 select public.revoke_memory('20000000-0000-0000-0000-000000000001'); reset role;`);
assert.equal((await db.query<{status:string}>("select status from public.memories where id='20000000-0000-0000-0000-000000000002'")).rows[0]!.status,'revoked');
// Preference replacement uses the same containment trigger.
await db.exec(`insert into public.memories(id,user_id,key,value,origin,status,derived_from,session_id) values
 ('30000000-0000-0000-0000-000000000001','${owner}','project_context','Old context','user_message','active','{}','replace'),
 ('30000000-0000-0000-0000-000000000002','${owner}','personal_preference','Derived context','model_summary','active','{30000000-0000-0000-0000-000000000001}','replace');`);
await db.query(`select public.propose_memory('${owner}','project_context','New context','user_message',null,'active','{}','replace','WG-01','[]',null)`);
assert.equal((await db.query<{status:string}>("select status from public.memories where id='30000000-0000-0000-0000-000000000002'")).rows[0]!.status,'revoked');
 } finally { await db.close(); }
});
