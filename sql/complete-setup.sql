-- Complete Supabase Setup Script for Online Multiplayer Bingo
-- Run this script in your Supabase SQL Editor (SQL Editor -> New query -> Paste & Run)

create extension if not exists pgcrypto;

-- 1. Helper function for unique Bingo UIDs
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

-- 2. Core Tables
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

create index if not exists profiles_username_search on public.profiles (username);
create index if not exists profiles_bingo_uid_search on public.profiles (bingo_uid);

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

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  sender_id uuid references public.profiles (id) on delete set null,
  type text not null check (type in ('friend_request', 'friend_accepted', 'game_invitation', 'game_invitation_accepted', 'game_invitation_declined')),
  title text not null,
  message text not null,
  related_id uuid,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id, is_read) where is_read = false;

create table if not exists public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'lobby' check (status in ('lobby', 'waiting', 'active', 'finished', 'cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists public.game_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.game_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'joined', 'declined', 'removed')),
  joined_at timestamptz,
  unique (game_id, user_id)
);

create index if not exists game_players_user_idx on public.game_players (user_id, status);

create table if not exists public.user_presence (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  status text not null default 'offline' check (status in ('online', 'playing', 'offline')),
  last_seen_at timestamptz not null default now()
);
create index if not exists user_presence_status_idx on public.user_presence (status, last_seen_at desc);

-- 3. Triggers & Functions

-- Auto-create profile on user signup
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
  )
  on conflict (id) do update set
    display_name = excluded.display_name,
    email = excluded.email,
    photo_url = excluded.photo_url;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Protect profile columns (ALLOW username initialization when null)
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
    -- Only freeze username if it was ALREADY set previously
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

-- Claim username
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

-- Check username availability
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

-- Search players
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

-- Friend requests & friendships
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
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_target_id = auth.uid() then raise exception 'You cannot send a request to yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_target_id and username is not null) then raise exception 'Player not found'; end if;

  if exists (
    select 1 from public.friendships AS friendship
    where friendship.user_id = auth.uid() and friendship.friend_id = p_target_id
  ) then
    raise exception 'You are already friends';
  end if;

  select * into reverse_request
  from public.friend_requests
  where from_id = p_target_id and to_id = auth.uid() and status = 'pending';

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
    where from_id = auth.uid() and to_id = p_target_id and status = 'pending'
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
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into request from public.friend_requests where id = p_request_id and to_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Request not found'; end if;

  if p_accept then
    update public.friend_requests set status = 'accepted', responded_at = now() where id = request.id;
    insert into public.friendships (user_id, friend_id)
    values (request.to_id, request.from_id), (request.from_id, request.to_id)
    on conflict do nothing;
  else
    update public.friend_requests set status = 'declined', responded_at = now() where id = request.id;
  end if;
end;
$$;

create or replace function public.list_friends()
returns table (id uuid, username text, display_name text, photo_url text, bingo_uid text)
language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.display_name, p.photo_url, p.bingo_uid
  from public.friendships AS f
  join public.profiles AS p on p.id = case when f.user_id = auth.uid() then f.friend_id else f.user_id end
  where f.user_id = auth.uid() or f.friend_id = auth.uid()
  group by p.id, p.username, p.display_name, p.photo_url, p.bingo_uid
  order by p.username;
$$;

create or replace function public.list_friend_requests()
returns table (request_id uuid, id uuid, username text, display_name text, photo_url text, bingo_uid text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id as request_id, p.id, p.username, p.display_name, p.photo_url, p.bingo_uid, r.created_at
  from public.friend_requests r
  join public.profiles p on p.id = r.from_id
  where r.to_id = auth.uid() and r.status = 'pending'
  order by r.created_at desc;
$$;

-- Presence & Social Lobby
create or replace function public.set_presence(p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_status not in ('online', 'playing', 'offline') then raise exception 'Invalid presence'; end if;
  insert into public.user_presence (user_id, status, last_seen_at) values (auth.uid(), p_status, now())
  on conflict (user_id) do update set status = excluded.status, last_seen_at = excluded.last_seen_at;
end;
$$;

create or replace function public.list_friends_with_presence()
returns table (id uuid, username text, display_name text, photo_url text, bingo_uid text, presence_status text)
language sql stable security definer set search_path = public as $$
  select p.id, p.username, p.display_name, p.photo_url, p.bingo_uid,
    case when coalesce(up.last_seen_at, now() - interval '1 day') < now() - interval '2 minutes' then 'offline' else coalesce(up.status, 'online') end
  from public.friendships f
  join public.profiles p on p.id = case when f.user_id = auth.uid() then f.friend_id else f.user_id end
  left join public.user_presence up on up.user_id = p.id
  where f.user_id = auth.uid() or f.friend_id = auth.uid()
  group by p.id, p.username, p.display_name, p.photo_url, p.bingo_uid, up.status, up.last_seen_at
  order by p.username;
$$;

create or replace function public.list_notifications()
returns table (id uuid, sender_id uuid, type text, title text, message text, related_id uuid, is_read boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select n.id, n.sender_id, n.type, n.title, n.message, n.related_id, n.is_read, n.created_at
  from public.notifications n where n.user_id = auth.uid() order by n.created_at desc limit 100;
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.notifications set is_read = true where id = p_notification_id and user_id = auth.uid();
end;
$$;

create or replace function public.create_game_session(p_friend_ids uuid[])
returns public.game_sessions language plpgsql security definer set search_path = public as $$
declare session_row public.game_sessions; invitee_id uuid; host_name text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(array_length(p_friend_ids, 1), 0) < 1 then raise exception 'Select at least one friend'; end if;
  if exists (select 1 from unnest(p_friend_ids) id where id = auth.uid()) then raise exception 'You cannot invite yourself'; end if;
  if exists (select 1 from unnest(p_friend_ids) AS requested_friend_id where not exists (select 1 from public.friendships AS friendship where friendship.user_id = auth.uid() and friendship.friend_id = requested_friend_id)) then raise exception 'You can only invite friends'; end if;
  insert into public.game_sessions (host_id) values (auth.uid()) returning * into session_row;
  insert into public.game_players (game_id, user_id, status) values (session_row.id, auth.uid(), 'joined');
  select display_name into host_name from public.profiles where id = auth.uid();
  foreach invitee_id in array p_friend_ids loop
    insert into public.game_players (game_id, user_id, status) values (session_row.id, invitee_id, 'invited') on conflict do nothing;
    insert into public.notifications (user_id, sender_id, type, title, message, related_id)
    values (invitee_id, auth.uid(), 'game_invitation', 'Bingo game invitation', coalesce(host_name, 'A Bingo player') || ' invited you to play Bingo.', (select player.id from public.game_players AS player where player.game_id = session_row.id and player.user_id = invitee_id));
  end loop;
  return session_row;
end;
$$;

create or replace function public.list_game_players(p_game_id uuid)
returns table (id uuid, user_id uuid, username text, display_name text, photo_url text, status text, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select gp.id, gp.user_id, p.username, p.display_name, p.photo_url, gp.status, gp.joined_at
  from public.game_players AS gp
  join public.profiles AS p on p.id = gp.user_id
  where gp.game_id = p_game_id
    and exists (select 1 from public.game_players AS viewer where viewer.game_id = p_game_id and viewer.user_id = auth.uid())
  order by gp.joined_at nulls last, p.username;
$$;

create or replace function public.start_game_session(p_game_id uuid)
returns public.game_sessions language plpgsql security definer set search_path = public as $$
declare result public.game_sessions;
begin
  update public.game_sessions AS session
  set status = 'active'
  where session.id = p_game_id
    and session.host_id = auth.uid()
    and (select count(*) from public.game_players AS player where player.game_id = p_game_id and player.status = 'joined') >= 2
  returning session.* into result;
  if not found then raise exception 'Only the host can start a lobby with at least two joined players'; end if;
  return result;
end;
$$;

create or replace function public.respond_game_invitation(p_game_player_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare player_row public.game_players; host_name text; me_name text;
begin
  select gp.* into player_row from public.game_players gp join public.game_sessions gs on gs.id = gp.game_id where gp.id = p_game_player_id and gp.user_id = auth.uid() and gp.status = 'invited';
  if not found then raise exception 'Invitation not found'; end if;
  update public.game_players set status = case when p_accept then 'joined' else 'declined' end, joined_at = case when p_accept then now() else null end where id = p_game_player_id;
  select display_name into host_name from public.profiles where id = (select host_id from public.game_sessions where id = player_row.game_id);
  select display_name into me_name from public.profiles where id = auth.uid();
  insert into public.notifications (user_id, sender_id, type, title, message, related_id)
  values ((select host_id from public.game_sessions where id = player_row.game_id), auth.uid(), case when p_accept then 'game_invitation_accepted' else 'game_invitation_declined' end, case when p_accept then 'Player joined your game' else 'Game invitation declined' end, coalesce(me_name, 'A Bingo player') || case when p_accept then ' joined your Bingo lobby.' else ' declined your Bingo invitation.' end, player_row.game_id);
end;
$$;

create or replace function public.game_id_for_player(p_game_player_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select gp.game_id
  from public.game_players AS gp
  where gp.id = p_game_player_id and gp.user_id = auth.uid();
$$;

create or replace function public.invite_friend_to_game(p_game_id uuid, p_friend_id uuid)
returns public.game_players language plpgsql security definer set search_path = public as $$
declare result public.game_players; host_name text;
begin
  if not exists (select 1 from public.game_sessions AS session where session.id = p_game_id and session.host_id = auth.uid() and session.status in ('lobby', 'waiting')) then raise exception 'Only the host can add players to this lobby'; end if;
  if not exists (select 1 from public.friendships AS friendship where (friendship.user_id = auth.uid() and friendship.friend_id = p_friend_id) or (friendship.friend_id = auth.uid() and friendship.user_id = p_friend_id)) then raise exception 'You can only invite friends'; end if;
  insert into public.game_players (game_id, user_id, status) values (p_game_id, p_friend_id, 'invited') on conflict (game_id, user_id) do update set status = 'invited' returning * into result;
  select display_name into host_name from public.profiles where id = auth.uid();
  insert into public.notifications (user_id, sender_id, type, title, message, related_id)
  values (p_friend_id, auth.uid(), 'game_invitation', 'Bingo game invitation', coalesce(host_name, 'A Bingo player') || ' invited you to play Bingo.', result.id);
  return result;
end;
$$;

-- 4. RLS Security Policies
alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.notifications enable row level security;
alter table public.game_sessions enable row level security;
alter table public.game_players enable row level security;
alter table public.user_presence enable row level security;

drop policy if exists "authenticated users can read profiles" on public.profiles;
create policy "authenticated users can read profiles" on public.profiles for select to authenticated using (true);

drop policy if exists "users can update own contact fields" on public.profiles;
create policy "users can update own contact fields" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "users can read own friend requests" on public.friend_requests;
create policy "users can read own friend requests" on public.friend_requests for select to authenticated using (from_id = auth.uid() or to_id = auth.uid());

drop policy if exists "users can read own friendships" on public.friendships;
create policy "users can read own friendships" on public.friendships for select to authenticated using (user_id = auth.uid());

drop policy if exists "users can read own notifications" on public.notifications;
create policy "users can read own notifications" on public.notifications for select to authenticated using (user_id = auth.uid());

drop policy if exists "users can read authorized games" on public.game_sessions;
create policy "users can read authorized games" on public.game_sessions for select to authenticated using (host_id = auth.uid() or exists (select 1 from public.game_players gp where gp.game_id = game_sessions.id and gp.user_id = auth.uid()));

drop policy if exists "users can read game player rows" on public.game_players;
create policy "users can read game player rows" on public.game_players for select to authenticated using (user_id = auth.uid() or exists (select 1 from public.game_sessions gs where gs.id = game_players.game_id and gs.host_id = auth.uid()));

drop policy if exists "authenticated users can read friend presence" on public.user_presence;
create policy "authenticated users can read friend presence" on public.user_presence for select to authenticated using (true);

drop policy if exists "users can insert own presence" on public.user_presence;
create policy "users can insert own presence" on public.user_presence for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "users can update own presence" on public.user_presence;
create policy "users can update own presence" on public.user_presence for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 5. Permissions
grant usage on schema public to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.friend_requests to authenticated;
grant select on public.friendships to authenticated;
grant select on public.notifications to authenticated;
grant select on public.game_sessions to authenticated;
grant select on public.game_players to authenticated;
grant select, insert, update on public.user_presence to authenticated;

grant execute on function public.claim_username(text) to authenticated;
grant execute on function public.username_available(text) to authenticated;
grant execute on function public.search_players(text) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.list_friends() to authenticated;
grant execute on function public.list_friend_requests() to authenticated;
grant execute on function public.list_notifications() to authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.create_game_session(uuid[]) to authenticated;
grant execute on function public.respond_game_invitation(uuid, boolean) to authenticated;
grant execute on function public.game_id_for_player(uuid) to authenticated;
grant execute on function public.invite_friend_to_game(uuid, uuid) to authenticated;
grant execute on function public.list_game_players(uuid) to authenticated;
grant execute on function public.start_game_session(uuid) to authenticated;
grant execute on function public.set_presence(text) to authenticated;
grant execute on function public.list_friends_with_presence() to authenticated;

-- 6. Realtime Subscriptions
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.profiles';
    execute 'alter publication supabase_realtime add table public.friend_requests';
    execute 'alter publication supabase_realtime add table public.friendships';
    execute 'alter publication supabase_realtime add table public.notifications';
    execute 'alter publication supabase_realtime add table public.game_sessions';
    execute 'alter publication supabase_realtime add table public.game_players';
    execute 'alter publication supabase_realtime add table public.user_presence';
  end if;
exception when duplicate_object then null; end $$;
