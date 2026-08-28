import { isSupabaseConfigured, supabase } from './supabase-client.js';

const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

export function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

export function usernameError(value) {
  const username = normalizeUsername(value);
  if (!username) return 'Enter a username.';
  if (!USERNAME_PATTERN.test(username)) return 'Use 3–20 letters, numbers, or underscores.';
  return '';
}

function mapProfile(row) {
  if (!row) return null;
  const gamesPlayed = row.games_played ?? 0;
  const gamesWon = row.games_won ?? 0;
  return {
    id: row.id,
    username: row.username || '',
    displayName: row.display_name || 'Bingo Player',
    email: row.email || '',
    photoURL: row.photo_url || '',
    uid: row.bingo_uid,
    createdAt: row.created_at,
    stats: {
      gamesPlayed,
      wins: gamesWon,
      losses: row.games_lost ?? 0,
      winRate: gamesPlayed ? Math.round((gamesWon / gamesPlayed) * 100) : 0,
      currentWinStreak: row.current_win_streak ?? 0,
      highestWinStreak: row.highest_win_streak ?? 0,
    },
  };
}

function functionError(error, fallback) {
  const message = error?.message || fallback;
  if (message.includes('already taken')) return 'That username is already taken.';
  if (message.includes('already set')) return 'Your username is already saved.';
  if (message.includes('already friends')) return 'You are already friends.';
  if (message.includes('already sent')) return 'Request already sent.';
  if (message.includes('yourself')) return 'You cannot send a request to yourself.';
  return message;
}

export async function fetchProfile() {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) return { user: null, profile: null };

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, email, photo_url, bingo_uid, created_at, games_played, games_won, games_lost, current_win_streak, highest_win_streak')
    .eq('id', user.id)
    .maybeSingle();

  if (error) throw error;

  if (data) {
    const displayName = user.user_metadata?.full_name || user.user_metadata?.name || data.display_name;
    const photoURL = user.user_metadata?.avatar_url || user.user_metadata?.picture || data.photo_url;
    const email = user.email || data.email;
    if (displayName !== data.display_name || photoURL !== data.photo_url || email !== data.email) {
      await supabase
        .from('profiles')
        .update({ display_name: displayName, photo_url: photoURL, email })
        .eq('id', user.id);
      data.display_name = displayName;
      data.photo_url = photoURL;
      data.email = email;
    }
  }

  return { user, profile: mapProfile(data) };
}

export async function signInWithGoogle() {
  if (!isSupabaseConfigured) {
    throw new Error('Add your Supabase project URL and anon key to config.js first.');
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams: { access_type: 'offline', prompt: 'select_account' },
    },
  });

  if (error) throw error;
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function checkUsernameAvailability(value) {
  const error = usernameError(value);
  if (error) return { available: false, message: error };
  const username = normalizeUsername(value);
  const { data, error: requestError } = await supabase.rpc('username_available', {
    p_username: username,
  });
  if (requestError) throw requestError;
  return {
    available: Boolean(data),
    message: data ? `@${username} is available.` : 'That username is already taken.',
  };
}

export async function claimUsername(value) {
  const error = usernameError(value);
  if (error) throw new Error(error);
  const { data, error: requestError } = await supabase.rpc('claim_username', {
    p_username: normalizeUsername(value),
  });
  if (requestError) throw new Error(functionError(requestError, 'Could not save username.'));
  const profile = mapProfile(Array.isArray(data) ? data[0] : data);
  try {
    const { error: emailError } = await supabase.functions.invoke('send-welcome-email');
    if (emailError) console.warn('Welcome email was not sent yet.', emailError);
  } catch (emailError) {
    console.warn('Welcome email was not sent yet.', emailError);
  }
  return profile;
}

export async function searchPlayers(query) {
  const cleaned = query.trim();
  if (cleaned.length < 2) return [];
  const { data, error } = await supabase.rpc('search_players', { p_query: cleaned });
  if (error) throw error;
  return data || [];
}

export async function sendFriendRequest(targetId) {
  const { error } = await supabase.rpc('send_friend_request', { p_target_id: targetId });
  if (error) throw new Error(functionError(error, 'Could not send request.'));
}

export async function respondFriendRequest(requestId, accept) {
  const { error } = await supabase.rpc('respond_friend_request', {
    p_request_id: requestId,
    p_accept: accept,
  });
  if (error) throw new Error(functionError(error, 'Could not update request.'));
}

export async function loadFriends() {
  const { data, error } = await supabase.rpc('list_friends');
  if (error) throw error;
  return data || [];
}

export async function loadFriendRequests() {
  const { data, error } = await supabase.rpc('list_friend_requests');
  if (error) throw error;
  return data || [];
}

async function fetchProfileWithRetry() {
  let last = await fetchProfile();
  for (let attempt = 0; attempt < 8 && last.user && !last.profile; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await fetchProfile();
  }
  return last;
}

export function subscribeToAuth(onChange) {
  if (!supabase) {
    onChange({ configured: false, loading: false, user: null, profile: null });
    return () => {};
  }

  let cancelled = false;

  const emit = async (showLoading = false) => {
    if (showLoading && !cancelled) onChange({ configured: true, loading: true, user: null, profile: null });
    try {
      const next = await fetchProfileWithRetry();
      if (!cancelled) onChange({ configured: true, loading: false, ...next });
    } catch (error) {
      if (!cancelled) onChange({ configured: true, loading: false, user: null, profile: null, error });
    }
  };

  emit(true);

  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
    emit(event === 'SIGNED_IN' || event === 'SIGNED_OUT');
  });

  return () => {
    cancelled = true;
    data.subscription.unsubscribe();
  };
}
