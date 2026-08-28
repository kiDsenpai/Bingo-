-- Bingo online database
-- Run this in the Supabase SQL Editor after creating your project.
-- Do not paste service-role keys into the frontend.

create extension if not exists pgcrypto;

create or replace function public.generate_bingo_uid()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  n int;
begin
  loop
    candidate := 'BNG-';
    for n in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where bingo_uid = candidate);
  end loop;
  return candidate;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique,
  display_name text not null default 'Bingo Player',
  email text,
  photo_url text,
  bingo_uid text not null unique,
  created_at timestamptz not null default now(),
  games_played integer not null default 0 check (games_played >= 0),
  games_won integer not null default 0 check (games_won >= 0),
  games_lost integer not null default 0 check (games_lost >= 0),
  current_win_streak integer not null default 0 check (current_win_streak >= 0),
  highest_win_streak integer not null default 0 check (highest_win_streak >= 0),
  welcome_email_sent_at timestamptz,
  constraint username_format check (
    username is null or username ~ '^[a-z0-9_]{3,20}$'
  )
);

create unique index if not exists profiles_username_unique
  on public.profiles (username)
  where username is not null;

create index if not exists profiles_username_search
  on public.profiles (username);

create index if not exists profiles_bingo_uid_search
  on public.profiles (bingo_uid);

create or replace function public.profile_win_rate(games_played integer, games_won integer)
returns integer
language sql
immutable
as $$
  select case
    when games_played <= 0 then 0
    else round((games_won::numeric / games_played::numeric) * 100)::integer
  end;
$$;

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references public.profiles (id) on delete cascade,
  to_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_request_not_self check (from_id <> to_id)
);

create unique index if not exists friend_requests_pending_unique
  on public.friend_requests (from_id, to_id)
  where status = 'pending';

create table if not exists public.friendships (
  user_id uuid not null references public.profiles (id) on delete cascade,
  friend_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint friendship_not_self check (user_id <> friend_id)
);

create index if not exists friendships_friend_id on public.friendships (friend_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email, photo_url, bingo_uid)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      'Bingo Player'
    ),
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture'
    ),
    public.generate_bingo_uid()
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated' then
    new.id := old.id;
    new.bingo_uid := old.bingo_uid;
    if old.username is not null then
      new.username := old.username;
    end if;
    new.games_played := old.games_played;
    new.games_won := old.games_won;
    new.games_lost := old.games_lost;
    new.current_win_streak := old.current_win_streak;
    new.highest_win_streak := old.highest_win_streak;
    new.welcome_email_sent_at := old.welcome_email_sent_at;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_columns on public.profiles;
create trigger protect_profile_columns
  before update on public.profiles
  for each row execute function public.protect_profile_columns();

create or replace function public.claim_username(p_username text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned text;
  result public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  cleaned := lower(trim(p_username));
  cleaned := regexp_replace(cleaned, '^@+', '');

  if cleaned !~ '^[a-z0-9_]{3,20}$' then
    raise exception 'Username must be 3–20 letters, numbers, or underscores';
  end if;

  update public.profiles
  set username = cleaned
  where id = auth.uid()
    and username is null
  returning * into result;

  if not found then
    select * into result from public.profiles where id = auth.uid();
    if result.username is not null then
      raise exception 'Username already set';
    end if;
    raise exception 'Profile not found';
  end if;

  return result;
exception
  when unique_violation then
    raise exception 'That username is already taken';
end;
$$;

create or replace function public.username_available(p_username text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cleaned text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  cleaned := lower(trim(p_username));
  cleaned := regexp_replace(cleaned, '^@+', '');

  if cleaned !~ '^[a-z0-9_]{3,20}$' then
    return false;
  end if;

  return not exists (
    select 1 from public.profiles
    where username = cleaned
      and id <> auth.uid()
  );
end;
$$;

create or replace function public.search_players(p_query text)
returns table (
  id uuid,
  username text,
  display_name text,
  photo_url text,
  bingo_uid text,
  relationship text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cleaned text;
  uid_query text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  cleaned := lower(trim(p_query));
  cleaned := regexp_replace(cleaned, '^@+', '');
  uid_query := upper(cleaned);

  if length(cleaned) < 2 then
    return;
  end if;

  return query
  select
    p.id,
    p.username,
    p.display_name,
    p.photo_url,
    p.bingo_uid,
    case
      when exists (
        select 1 from public.friendships AS friendship
          where (friendship.user_id = auth.uid() and friendship.friend_id = p.id)
            or (friendship.friend_id = auth.uid() and friendship.user_id = p.id)
      ) then 'friends'
      when exists (
        select 1 from public.friend_requests r
        where r.from_id = auth.uid() and r.to_id = p.id and r.status = 'pending'
      ) then 'outgoing'
      when exists (
        select 1 from public.friend_requests r
        where r.to_id = auth.uid() and r.from_id = p.id and r.status = 'pending'
      ) then 'incoming'
      else 'none'
    end as relationship
  from public.profiles p
  where p.id <> auth.uid()
    and p.username is not null
    and (
      p.username ilike '%' || cleaned || '%'
      or p.bingo_uid = uid_query
      or p.bingo_uid ilike uid_query || '%'
    )
  order by
    case when p.bingo_uid = uid_query then 0 when p.username = cleaned then 1 else 2 end,
    p.username
  limit 20;
end;
$$;

create or replace function public.send_friend_request(p_target_id uuid)
returns public.friend_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.friend_requests;
  reverse_request public.friend_requests;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  if p_target_id = auth.uid() then
    raise exception 'You cannot send a request to yourself';
  end if;

  if not exists (select 1 from public.profiles where id = p_target_id and username is not null) then
    raise exception 'Player not found';
  end if;

  if exists (
    select 1 from public.friendships AS friendship
    where friendship.user_id = auth.uid() and friendship.friend_id = p_target_id
  ) then
    raise exception 'You are already friends';
  end if;

  select * into reverse_request
  from public.friend_requests
  where from_id = p_target_id
    and to_id = auth.uid()
    and status = 'pending';

  if found then
    update public.friend_requests
    set status = 'accepted', responded_at = now()
    where id = reverse_request.id
    returning * into result;

    insert into public.friendships (user_id, friend_id)
    values (auth.uid(), p_target_id), (p_target_id, auth.uid())
    on conflict do nothing;

    return result;
  end if;

  if exists (
    select 1 from public.friend_requests
    where from_id = auth.uid()
      and to_id = p_target_id
      and status = 'pending'
  ) then
    raise exception 'Request already sent';
  end if;

  insert into public.friend_requests (from_id, to_id, status)
  values (auth.uid(), p_target_id, 'pending')
  returning * into result;

  return result;
end;
$$;

create or replace function public.respond_friend_request(p_request_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request public.friend_requests;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into request
  from public.friend_requests
  where id = p_request_id
    and to_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Request not found';
  end if;

  if p_accept then
    update public.friend_requests
    set status = 'accepted', responded_at = now()
    where id = request.id;

    insert into public.friendships (user_id, friend_id)
    values (request.to_id, request.from_id), (request.from_id, request.to_id)
    on conflict do nothing;
  else
    update public.friend_requests
    set status = 'declined', responded_at = now()
    where id = request.id;
  end if;
end;
$$;

create or replace function public.list_friends()
returns table (
  id uuid,
  username text,
  display_name text,
  photo_url text,
  bingo_uid text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.display_name, p.photo_url, p.bingo_uid
  from public.friendships AS friendship
  join public.profiles AS p on p.id = case when friendship.user_id = auth.uid() then friendship.friend_id else friendship.user_id end
  where friendship.user_id = auth.uid() or friendship.friend_id = auth.uid()
  group by p.id, p.username, p.display_name, p.photo_url, p.bingo_uid
  order by p.username;
$$;

create or replace function public.list_friend_requests()
returns table (
  request_id uuid,
  id uuid,
  username text,
  display_name text,
  photo_url text,
  bingo_uid text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id as request_id, p.id, p.username, p.display_name, p.photo_url, p.bingo_uid, r.created_at
  from public.friend_requests r
  join public.profiles p on p.id = r.from_id
  where r.to_id = auth.uid()
    and r.status = 'pending'
  order by r.created_at desc;
$$;

alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;

drop policy if exists "authenticated users can read profiles" on public.profiles;
create policy "authenticated users can read profiles"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "users can update own contact fields" on public.profiles;
create policy "users can update own contact fields"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "users can read own friend requests" on public.friend_requests;
create policy "users can read own friend requests"
  on public.friend_requests for select
  to authenticated
  using (from_id = auth.uid() or to_id = auth.uid());

drop policy if exists "users can read own friendships" on public.friendships;
create policy "users can read own friendships"
  on public.friendships for select
  to authenticated
  using (user_id = auth.uid());

grant usage on schema public to anon, authenticated;
grant select on public.profiles to authenticated;
grant update on public.profiles to authenticated;
grant select on public.friend_requests to authenticated;
grant select on public.friendships to authenticated;

grant execute on function public.claim_username(text) to authenticated;
grant execute on function public.username_available(text) to authenticated;
grant execute on function public.search_players(text) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.list_friends() to authenticated;
grant execute on function public.list_friend_requests() to authenticated;
grant execute on function public.profile_win_rate(integer, integer) to authenticated, anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.profiles';
    execute 'alter publication supabase_realtime add table public.friend_requests';
    execute 'alter publication supabase_realtime add table public.friendships';
  end if;
exception
  when duplicate_object then
    null;
end;
$$;
