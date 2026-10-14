-- Preserve audit history; containment changes trust, never deletes evidence.
alter table public.memory_events drop constraint memory_events_event_check;
alter table public.memory_events add constraint memory_events_event_check check (event in
 ('proposed','quarantined','accepted','approved','rejected','revoked','injected','withheld','recalled_by_tool','applied_in_action','blocked_in_action'));
alter table public.memory_events add column action_id uuid references public.share_attempts(id);
alter table public.share_attempts add column considered_memory_ids uuid[] not null default '{}';
create index memories_lineage_idx on public.memories using gin (derived_from);

create function public.lock_and_check_lineage() returns trigger
language plpgsql set search_path = '' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
 if new.status = 'active' and exists (
   select 1 from unnest(new.derived_from) p
   left join public.memories m on m.id=p
   where m.id is null or m.user_id<>new.user_id or m.status<>'active' or p=new.id
 ) then raise exception 'active memory requires active same-user parents'; end if;
 if tg_op='UPDATE' and (new.user_id<>old.user_id or new.derived_from<>old.derived_from
   or new.value<>old.value or new.key<>old.key or new.origin<>old.origin
   or new.origin_ref is distinct from old.origin_ref) then
   raise exception 'memory content and provenance are immutable; create a new revision';
 end if;
 return new;
end;
$$;
create trigger a_lock_and_check_lineage before insert or update on public.memories
 for each row execute function public.lock_and_check_lineage();

create function public.contain_descendants() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if pg_trigger_depth()=1 and old.status is distinct from new.status
   and (new.status='revoked' or (old.status='active' and new.status<>'active')) then
   with recursive descendants(id) as (
     select m.id from public.memories m where m.user_id=new.user_id and new.id=any(m.derived_from)
     union
     select m.id from public.memories m join descendants d on d.id=any(m.derived_from)
       where m.user_id=new.user_id
   ), changed as (
     update public.memories set status='revoked', is_shared=false
       where user_id=new.user_id and id in (select id from descendants)
       and status in ('active','quarantined') returning *
   ) insert into public.memory_events(user_id,memory_id,session_id,event,deciding_rule,steps)
     select user_id,id,session_id,'revoked','LINEAGE-REVOKED',
       jsonb_build_array(jsonb_build_object('rule','LINEAGE-REVOKED','matched',true,'evidence',new.id)) from changed;
 end if;
 return new;
end;
$$;
create trigger contain_descendants_after_update after update of status on public.memories
 for each row execute function public.contain_descendants();

create function public.revoke_memory(p_id uuid) returns public.memories
language plpgsql security definer set search_path = '' as $$
declare result public.memories;
begin
 if auth.uid() is null then raise exception 'authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
 update public.memories set status='revoked', is_shared=false
   where id=p_id and user_id=auth.uid() and status in ('active','quarantined') returning * into result;
 if result.id is null then raise exception 'memory not found or already inactive'; end if;
 insert into public.memory_events(user_id,memory_id,session_id,event,deciding_rule)
   values(result.user_id,result.id,result.session_id,'revoked','HUMAN-CONTAINMENT');
 return result;
end;
$$;
revoke all on function public.revoke_memory(uuid) from public,anon,service_role;
grant execute on function public.revoke_memory(uuid) to authenticated;

create function public.inspect_memory(p_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
 with recursive ancestors(id) as (
   select id from public.memories where id=p_id and user_id=auth.uid()
   union
   select parent.id from public.memories parent join public.memories child on parent.id=any(child.derived_from)
     join ancestors a on a.id=child.id where parent.user_id=auth.uid()
 ), descendants(id) as (
   select id from public.memories where id=p_id and user_id=auth.uid()
   union
   select child.id from public.memories child join descendants d on d.id=any(child.derived_from)
     where child.user_id=auth.uid()
 ), related as (select id from ancestors union select id from descendants)
 select jsonb_build_object(
   'memories',coalesce((select jsonb_agg(m order by m.created_at) from public.memories m where m.id in (select id from related)),'[]'::jsonb),
   'events',coalesce((select jsonb_agg(e order by e.ts,e.id) from public.memory_events e where e.memory_id in (select id from related)),'[]'::jsonb),
   'sources',coalesce((select jsonb_agg(l order by l.ts) from public.ledger_events l where l.id::text in (select m.origin_ref from public.memories m where m.id in (select id from related))),'[]'::jsonb),
   'actions',coalesce((select jsonb_agg(s order by s.ts) from public.share_attempts s where s.memory_ids && array(select id from related) or s.considered_memory_ids && array(select id from related)),'[]'::jsonb));
$$;
revoke all on function public.inspect_memory(uuid) from public,anon,service_role;
grant execute on function public.inspect_memory(uuid) to authenticated;
