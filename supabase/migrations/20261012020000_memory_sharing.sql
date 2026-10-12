-- Owner-controlled sharing. Grants target verified Auth email addresses.
alter table public.memories add column is_shared boolean not null default false;

create table public.memory_shares (
  owner_id uuid not null,
  recipient_email text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, recipient_email),
  constraint recipient_email_normalized check (recipient_email = lower(btrim(recipient_email)))
);
create index memory_shares_email_idx on public.memory_shares (recipient_email);
alter table public.memory_shares enable row level security;
revoke all on public.memory_shares from public, anon, authenticated;
grant select on public.memory_shares to authenticated;
grant all on public.memory_shares to service_role;
create policy "owners list share grants" on public.memory_shares for select to authenticated
  using (owner_id = (select auth.uid()));

create function public.set_memory_shared(p_id uuid, p_shared boolean) returns public.memories
language plpgsql security definer set search_path = '' as $$
declare result public.memories;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  update public.memories set is_shared = p_shared
    where id = p_id and user_id = auth.uid() and status = 'active'
    returning * into result;
  if result.id is null then raise exception 'active memory not found'; end if;
  return result;
end;
$$;

create function public.grant_memory_access(p_email text) returns public.memory_shares
language plpgsql security definer set search_path = '' as $$
declare normalized text := lower(btrim(p_email)); result public.memory_shares;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if normalized !~ '^[^[:space:]@,<>]+@[^[:space:]@,<>]+\.[^[:space:]@,<>]+$' or length(normalized) > 254 then
    raise exception 'invalid recipient email';
  end if;
  if exists (select 1 from auth.users where id = auth.uid() and lower(email) = normalized) then
    raise exception 'cannot share with yourself';
  end if;
  insert into public.memory_shares (owner_id, recipient_email)
    values (auth.uid(), normalized)
    on conflict (owner_id, recipient_email) do update set created_at = excluded.created_at
    returning * into result;
  return result;
end;
$$;

create function public.revoke_memory_access(p_email text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  delete from public.memory_shares
    where owner_id = auth.uid() and recipient_email = lower(btrim(p_email));
  return found;
end;
$$;

create function public.list_shared_memories()
returns table (id uuid, owner_id uuid, owner_email text, key text, value text, created_at timestamptz)
language sql security definer set search_path = '' as $$
  select m.id, m.user_id, owner.email::text, m.key, m.value, m.created_at
  from auth.users recipient
  join public.memory_shares s on s.recipient_email = lower(recipient.email)
  join public.memories m on m.user_id = s.owner_id
  join auth.users owner on owner.id = m.user_id
  where recipient.id = auth.uid()
    and recipient.email_confirmed_at is not null
    and m.status = 'active'
    and m.is_shared = true
  order by m.created_at desc;
$$;

revoke all on function public.set_memory_shared(uuid,boolean) from public, anon, service_role;
revoke all on function public.grant_memory_access(text) from public, anon, service_role;
revoke all on function public.revoke_memory_access(text) from public, anon, service_role;
revoke all on function public.list_shared_memories() from public, anon, service_role;
grant execute on function public.set_memory_shared(uuid,boolean) to authenticated;
grant execute on function public.grant_memory_access(text) to authenticated;
grant execute on function public.revoke_memory_access(text) to authenticated;
grant execute on function public.list_shared_memories() to authenticated;
