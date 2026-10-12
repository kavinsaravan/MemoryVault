create type public.memory_origin as enum ('user_message', 'document', 'tool_output', 'model_summary');
create type public.memory_status as enum ('active', 'quarantined', 'rejected', 'revoked');

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  body text not null,
  sha256 text not null,
  created_at timestamptz not null default now()
);

create table public.ledger_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id text not null,
  prompt_id text,
  kind text not null check (kind in ('user_message', 'untrusted_read')),
  tool_use_id text,
  source_ref text,
  content text not null check (length(content) <= 20000),
  content_sha256 text not null,
  ts timestamptz not null default now()
);
create index ledger_events_session_idx on public.ledger_events (user_id, session_id, ts desc);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  key text not null check (key in ('report_recipients', 'report_format', 'cc')),
  value text not null,
  origin public.memory_origin not null,
  origin_ref text,
  status public.memory_status not null,
  derived_from uuid[] not null default '{}',
  session_id text not null,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint untrusted_memory_needs_confirmation check (
    status <> 'active' or origin in ('user_message', 'model_summary') or
    (confirmed_by is not null and confirmed_at is not null)
  ),
  constraint confirmation_fields_together check ((confirmed_by is null) = (confirmed_at is null))
);
create index memories_user_status_idx on public.memories (user_id, status, key);

-- A summary can be active only when every declared parent is active and belongs
-- to the same user. The app also applies WG-03 for tainted turns.
create function public.check_summary_parents() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.origin = 'model_summary' and new.status = 'active' then
    if cardinality(new.derived_from) = 0 or exists (
      select 1 from unnest(new.derived_from) as parent_id
      left join public.memories parent on parent.id = parent_id
      where parent.id is null or parent.user_id <> new.user_id or parent.status <> 'active'
    ) then
      raise exception 'active summary requires active same-user parents';
    end if;
  end if;
  return new;
end;
$$;
create trigger check_summary_parents_before_write before insert or update on public.memories
for each row execute function public.check_summary_parents();

create table public.memory_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  memory_id uuid references public.memories(id),
  session_id text not null,
  event text not null check (event in
    ('proposed', 'quarantined', 'accepted', 'approved', 'rejected', 'revoked',
     'injected', 'withheld', 'applied_in_action')),
  deciding_rule text,
  steps jsonb,
  agent_claim text,
  tool_use_id text,
  ts timestamptz not null default now()
);
create index memory_events_memory_idx on public.memory_events (memory_id, ts);

create table public.share_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id text not null,
  tool_use_id text,
  requested_recipients text[] not null,
  sent_recipients text[] not null,
  blocked_recipients text[] not null default '{}',
  decision text not null check (decision in ('allowed', 'blocked')),
  deciding_rule text,
  memory_ids uuid[] not null default '{}',
  gates_enabled boolean not null,
  ts timestamptz not null default now()
);
create index share_attempts_user_ts_idx on public.share_attempts (user_id, ts desc);

-- Deliberately vulnerable data is isolated from the protected memories table.
-- Only the demo runner can opt into this separate baseline path.
create table public.demo_baseline_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  key text not null,
  value text not null,
  session_id text not null,
  created_at timestamptz not null default now()
);

alter table public.documents enable row level security;
alter table public.ledger_events enable row level security;
alter table public.memories enable row level security;
alter table public.memory_events enable row level security;
alter table public.share_attempts enable row level security;
alter table public.demo_baseline_memories enable row level security;

revoke all on public.documents, public.ledger_events, public.memories,
  public.memory_events, public.share_attempts, public.demo_baseline_memories from anon, authenticated;
grant select on public.documents, public.ledger_events, public.memories,
  public.memory_events, public.share_attempts to authenticated;
grant all on public.documents, public.ledger_events, public.memories,
  public.memory_events, public.share_attempts, public.demo_baseline_memories to service_role;

create policy "read own documents" on public.documents for select to authenticated using (user_id = (select auth.uid()));
create policy "read own ledger" on public.ledger_events for select to authenticated using (user_id = (select auth.uid()));
create policy "read own memories" on public.memories for select to authenticated using (user_id = (select auth.uid()));
create policy "read own memory events" on public.memory_events for select to authenticated using (user_id = (select auth.uid()));
create policy "read own share attempts" on public.share_attempts for select to authenticated using (user_id = (select auth.uid()));

create function public.propose_memory(
  p_user_id uuid, p_key text, p_value text, p_origin public.memory_origin,
  p_origin_ref text, p_status public.memory_status, p_derived_from uuid[],
  p_session_id text, p_deciding_rule text, p_steps jsonb, p_agent_claim text
) returns public.memories
language plpgsql security definer set search_path = '' as $$
declare
  result public.memories;
  previous public.memories;
begin
  if p_status = 'active' then
    for previous in
      update public.memories set status = 'revoked'
       where user_id = p_user_id and key = p_key and status = 'active'
       returning *
    loop
      insert into public.memory_events (user_id, memory_id, session_id, event, deciding_rule)
        values (p_user_id, previous.id, p_session_id, 'revoked', 'PREFERENCE-UPDATE');
    end loop;
  end if;
  insert into public.memories (user_id, key, value, origin, origin_ref, status, derived_from, session_id)
    values (p_user_id, p_key, p_value, p_origin, p_origin_ref, p_status, p_derived_from, p_session_id)
    returning * into result;
  insert into public.memory_events (user_id, memory_id, session_id, event, deciding_rule, steps, agent_claim)
    values (p_user_id, result.id, p_session_id,
      case when p_status = 'active' then 'accepted' when p_status = 'rejected' then 'rejected' else 'quarantined' end,
      p_deciding_rule, p_steps, p_agent_claim);
  return result;
end;
$$;

revoke all on function public.propose_memory(uuid,text,text,public.memory_origin,text,public.memory_status,uuid[],text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.propose_memory(uuid,text,text,public.memory_origin,text,public.memory_status,uuid[],text,text,jsonb,text) to service_role;

-- Ref: Supabase database functions and RLS docs. Approval requires an Auth JWT
-- from the human dashboard; the MCP server exposes no approval operation.
create function public.approve_memory(p_id uuid) returns public.memories
language plpgsql security definer set search_path = '' as $$
declare
  result public.memories;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  for result in
    update public.memories set status = 'revoked'
     where user_id = auth.uid() and status = 'active'
       and key = (select key from public.memories where id = p_id and user_id = auth.uid() and status = 'quarantined')
     returning *
  loop
    insert into public.memory_events (user_id, memory_id, session_id, event, deciding_rule)
      values (result.user_id, result.id, result.session_id, 'revoked', 'PREFERENCE-UPDATE');
  end loop;
  update public.memories
     set status = 'active', confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_id and user_id = auth.uid() and status = 'quarantined'
   returning * into result;
  if result.id is null then raise exception 'memory not found or not quarantined'; end if;
  insert into public.memory_events (user_id, memory_id, session_id, event, deciding_rule)
    values (result.user_id, result.id, result.session_id, 'approved', 'PR-01');
  return result;
end;
$$;

create function public.reject_memory(p_id uuid) returns public.memories
language plpgsql security definer set search_path = '' as $$
declare
  result public.memories;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  update public.memories set status = 'rejected'
   where id = p_id and user_id = auth.uid() and status = 'quarantined'
   returning * into result;
  if result.id is null then raise exception 'memory not found or not quarantined'; end if;
  insert into public.memory_events (user_id, memory_id, session_id, event, deciding_rule)
    values (result.user_id, result.id, result.session_id, 'rejected', 'PR-01');
  return result;
end;
$$;

revoke all on function public.approve_memory(uuid) from public, anon, service_role;
revoke all on function public.reject_memory(uuid) from public, anon, service_role;
grant execute on function public.approve_memory(uuid) to authenticated;
grant execute on function public.reject_memory(uuid) to authenticated;
