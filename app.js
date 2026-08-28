import {
  checkUsernameAvailability,
  claimUsername,
  fetchProfileWithRetry,
  withTimeout,
  loadFriendRequests,
  loadNotifications,
  markNotificationRead,
  createFriendGame,
  inviteFriendToGame,
  respondGameInvitation,
  loadGamePlayers,
  startFriendGame,
  loadGameIdForPlayer,
  loadFriends,
  respondFriendRequest,
  searchPlayers,
  sendFriendRequest,
  signInWithGoogle,
  signOut,
  subscribeToAuth,
  subscribeToSocialChanges,
  setPresence,
} from './account.js';
import { isSupabaseConfigured } from './supabase-client.js';

const STORAGE_KEY = 'bingo-bot-mode-v1';
const LETTERS = ['B', 'I', 'N', 'G', 'O'];
const modeViewElement = document.querySelector('#mode-view');
const gameViewElement = document.querySelector('#game-view');
const playersGridElement = document.querySelector('#players-grid');
const statusLabelElement = document.querySelector('#status-label');
const modeMessageElement = document.querySelector('#mode-message');
const calledCountElement = document.querySelector('#called-count');
const currentCallElement = document.querySelector('#current-call');
const callLabelElement = document.querySelector('#call-label');
const callMessageElement = document.querySelector('#call-message');
const turnLabelElement = document.querySelector('#turn-label');
const turnBannerElement = document.querySelector('#player-turn-banner');
const winOverlayElement = document.querySelector('#win-overlay');
const profileViewElement = document.querySelector('#profile-view');
const authViewElement = document.querySelector('#auth-view');
const usernameViewElement = document.querySelector('#username-view');
const authMessageElement = document.querySelector('#auth-message');
const usernameMessageElement = document.querySelector('#username-message');
const navButtons = document.querySelectorAll('.nav-button');
const appShellElement = document.querySelector('.app-shell');
const accountLoadingElement = document.querySelector('#account-loading');

let activeView = 'home';
let isProfileLoading = false;
let auth = { configured: isSupabaseConfigured, loading: false, user: null, profile: null, error: null };
let friends = [];
let friendRequests = [];
let notifications = [];
let socialLoading = false;
let socialCleanup = () => {};
let presenceTimer = null;
let lobbyFriends = [];
let lobbyOpen = false;
let lobbyGameId = null;
let lobbyPlayerRows = [];

let game = createModeGame();
let botTimer = null;

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function createBoard() {
  return shuffle(Array.from({ length: 25 }, (_, index) => index + 1));
}

function createModeGame() {
  return { mode: null, phase: 'mode', called: [], currentCall: null, lastCaller: null, turn: 'human', winner: null, players: [createPlayer('YOU'), createPlayer('BOT')] };
}

function createPlayer(name) {
  return { name, board: createBoard(), selected: [], completedLines: [] };
}

function getLines() {
  const lines = [];
  for (let row = 0; row < 5; row += 1) lines.push(Array.from({ length: 5 }, (_, column) => row * 5 + column));
  for (let column = 0; column < 5; column += 1) lines.push(Array.from({ length: 5 }, (_, row) => row * 5 + column));
  lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
  return lines;
}

function findCompletedLines(selected) {
  const selectedSet = new Set(selected);
  return getLines().map((line, index) => ({ line, index })).filter(({ line }) => line.every((cell) => selectedSet.has(cell)));
}

function loadGame() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.mode === 'bot' && saved.players?.length === 2 && saved.players.every((player) => Array.isArray(player.board) && player.board.length === 25)) return saved;
  } catch (error) {
    localStorage.removeItem(STORAGE_KEY);
  }
  return null;
}

function saveGame() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
}

function needsUsername() {
  return Boolean(auth.user && auth.profile && !auth.profile.username);
}

function isSignedIn() {
  return Boolean(auth.user && auth.profile?.username);
}

function render() {
  appShellElement.hidden = isProfileLoading;
  accountLoadingElement.hidden = !isProfileLoading;
  if (isProfileLoading) return;
  const setupRequired = needsUsername();
  const showProfile = !setupRequired && activeView === 'profile' && isSignedIn();
  const showAuth = !setupRequired && activeView === 'profile' && !isSignedIn();
  const showGame = !setupRequired && activeView === 'play' && game.phase === 'game';
  const showModes = !setupRequired && activeView === 'home' && !showGame;

  modeViewElement.hidden = !showModes;
  gameViewElement.hidden = !showGame;
  profileViewElement.hidden = !showProfile;
  authViewElement.hidden = !showAuth;
  usernameViewElement.hidden = !setupRequired;
  document.querySelector('.hero').hidden = showGame || setupRequired || showProfile;

  navButtons.forEach((button) => button.classList.toggle('active', button.dataset.view === activeView));

  if (showGame) renderGame();
  if (showProfile) renderProfile();
  renderHomeFriends();
  renderInbox();
  renderLobby();
  renderAuthCopy();
  statusLabelElement.textContent = statusText(setupRequired, showGame);
}

function statusText(setupRequired, showGame) {
  if (auth.loading) return 'Checking account';
  if (setupRequired) return 'Choose a username';
  if (activeView === 'profile' && !isSignedIn()) return 'Sign in to continue';
  if (isSignedIn() && (activeView === 'home' || activeView === 'profile')) return `@${auth.profile.username}`;
  if (showGame) return game.winner ? `${game.winner} wins` : game.turn === 'bot' ? 'Bot is thinking' : 'Your turn';
  return 'Choose a game mode';
}

function renderAuthCopy() {
  if (!auth.configured) {
    authMessageElement.textContent = 'Add your Supabase project URL and anon key to config.js, then set up Google in the Supabase dashboard.';
    return;
  }
  if (auth.loading) {
    authMessageElement.textContent = 'Checking your session...';
    return;
  }
  if (auth.error) {
    authMessageElement.textContent = auth.error.message || 'Could not load your account.';
    return;
  }
  authMessageElement.textContent = 'Sign in with Google to create your Bingo account.';
}

function renderHomeFriends() {
  const panel = document.querySelector('#home-friends-panel');
  const list = document.querySelector('#home-friends-list');
  panel.hidden = activeView !== 'home';
  if (!isSignedIn()) { list.innerHTML = '<p class="empty-state">Sign in to see your friends.</p>'; return; }
  const counts = friends.reduce((result, friend) => { const status = friend.presence_status || 'offline'; result[status] += 1; return result; }, { online: 0, playing: 0, offline: 0 });
  document.querySelector('#home-online-count').textContent = counts.online;
  document.querySelector('#home-playing-count').textContent = counts.playing;
  document.querySelector('#home-offline-count').textContent = counts.offline;
  list.innerHTML = friends.length ? friends.map((friend) => `<div class="home-friend-row"><span class="presence-dot presence-${friend.presence_status || 'offline'}"></span><div><strong>${escapeHtml(friend.display_name)}</strong><span>@${escapeHtml(friend.username)}</span></div><button class="text-button call-friend" data-id="${friend.id}" type="button" ${friend.presence_status === 'online' ? '' : 'disabled'}>CALL</button></div>`).join('') : '<p class="empty-state">No friends yet.</p>';
  list.querySelectorAll('.call-friend').forEach((button) => button.addEventListener('click', () => inviteFriend(button.dataset.id)));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function avatarMarkup(name, photoURL) {
  if (photoURL) return `<img src="${escapeHtml(photoURL)}" alt="" width="72" height="72">`;
  return escapeHtml((name || 'B').slice(0, 1).toUpperCase());
}

function renderProfile() {
  const account = auth.profile;
  const avatar = document.querySelector('#profile-avatar');
  avatar.innerHTML = avatarMarkup(account.displayName, account.photoURL);
  avatar.classList.toggle('has-photo', Boolean(account.photoURL));
  document.querySelector('#profile-display-name').textContent = account.displayName;
  document.querySelector('#profile-username').textContent = `@${account.username}`;
  document.querySelector('#profile-uid').textContent = account.uid;
  const stats = account.stats;
  document.querySelector('#stat-played').textContent = stats.gamesPlayed;
  document.querySelector('#stat-wins').textContent = stats.wins;
  document.querySelector('#stat-losses').textContent = stats.losses;
  document.querySelector('#stat-rate').textContent = `${stats.winRate}%`;
  document.querySelector('#stat-current').textContent = stats.currentWinStreak;
  document.querySelector('#stat-highest').textContent = stats.highestWinStreak;
  document.querySelector('#friend-count').textContent = friends.length;
  document.querySelector('#request-count').textContent = friendRequests.length;
  document.querySelector('#friends-list').innerHTML = friends.length
    ? friends.map((friend) => socialRow(friend, `<button class="text-button play-friend" type="button">PLAY</button>`)).join('')
    : '<p class="empty-state">No friends yet. Search by username or UID.</p>';
  document.querySelector('#requests-list').innerHTML = friendRequests.length
    ? friendRequests.map((request) => socialRow(request, `<button class="text-button accept-request" data-id="${request.request_id}" type="button">ACCEPT</button><button class="text-button decline-request" data-id="${request.request_id}" type="button">DECLINE</button>`)).join('')
    : '<p class="empty-state">No pending requests.</p>';
  document.querySelectorAll('.play-friend').forEach((button) => button.addEventListener('click', () => inviteFriend(button.dataset.id)));
  document.querySelectorAll('.accept-request').forEach((button) => button.addEventListener('click', () => handleRequest(button.dataset.id, true, button)));
  document.querySelectorAll('.decline-request').forEach((button) => button.addEventListener('click', () => handleRequest(button.dataset.id, false, button)));
}

function renderInbox() {
  const unread = notifications.filter((notification) => !notification.is_read).length;
  const badge = document.querySelector('#inbox-badge');
  badge.hidden = unread === 0;
  badge.textContent = unread;
  const list = document.querySelector('#notification-list');
  list.innerHTML = notifications.length ? notifications.map((notification) => `<article class="notification-item${notification.is_read ? '' : ' unread'}"><div><strong>${escapeHtml(notification.title)}</strong><p>${escapeHtml(notification.message)}</p><small>${new Date(notification.created_at).toLocaleString()}</small></div>${notification.type === 'friend_request' ? '<div class="notification-actions"><button class="text-button accept-request" data-id="' + notification.related_id + '" type="button">ACCEPT</button><button class="text-button decline-request" data-id="' + notification.related_id + '" type="button">DECLINE</button></div>' : ''}${notification.type === 'game_invitation' ? '<div class="notification-actions"><button class="text-button accept-game" data-id="' + notification.related_id + '" type="button">ACCEPT</button><button class="text-button decline-game" data-id="' + notification.related_id + '" type="button">DECLINE</button></div>' : ''}<button class="text-button read-notification" data-id="${notification.id}" type="button">${notification.is_read ? 'READ' : 'MARK READ'}</button></article>`).join('') : '<p class="empty-state">No notifications yet.</p>';
  list.querySelectorAll('.read-notification').forEach((button) => button.addEventListener('click', async () => { try { await markNotificationRead(button.dataset.id); } catch (error) { return; } notifications = notifications.map((item) => item.id === button.dataset.id ? { ...item, is_read: true } : item); renderInbox(); }));
  list.querySelectorAll('.accept-request').forEach((button) => button.addEventListener('click', () => handleRequest(button.dataset.id, true, button)));
  list.querySelectorAll('.decline-request').forEach((button) => button.addEventListener('click', () => handleRequest(button.dataset.id, false, button)));
  list.querySelectorAll('.accept-game').forEach((button) => button.addEventListener('click', async () => { await respondGameInvitation(button.dataset.id, true); document.querySelector('#inbox-panel').hidden = true; openLobbyForInvitation(button.dataset.id); }));
  list.querySelectorAll('.decline-game').forEach((button) => button.addEventListener('click', async () => { await respondGameInvitation(button.dataset.id, false); await refreshSocial(); }));
}

function renderLobby() {
  const panel = document.querySelector('#friend-lobby');
  panel.hidden = !lobbyOpen;
  document.querySelector('#lobby-player-count').textContent = `${lobbyFriends.length + 1} / 10`;
  const joinedPlayers = lobbyPlayerRows.filter((player) => player.status === 'joined').length;
  document.querySelector('#start-lobby-button').disabled = lobbyGameId ? joinedPlayers < 2 : lobbyFriends.length === 0;
  document.querySelector('#lobby-friends').innerHTML = friends.length ? friends.map((friend) => { const selected = lobbyGameId ? lobbyPlayerRows.some((item) => item.user_id === friend.id && item.status !== 'declined') : lobbyFriends.some((item) => item.id === friend.id); return socialRow(friend, `<button class="text-button lobby-toggle" data-id="${friend.id}" type="button" ${selected ? 'disabled' : ''}>${selected ? 'INVITED' : '+ ADD'}</button>`); }).join('') : '<p class="empty-state">No friends available.</p>';
  document.querySelector('#lobby-selected').innerHTML = lobbyPlayerRows.length ? lobbyPlayerRows.map((player) => `<div class="selected-player">${escapeHtml(player.display_name)} <span>${escapeHtml(player.status)}</span></div>`).join('') : `<div class="selected-player">YOU <span>HOST</span></div>${lobbyFriends.map((friend) => `<div class="selected-player">${escapeHtml(friend.display_name)} <span>INVITED</span></div>`).join('')}`;
  document.querySelectorAll('.lobby-toggle').forEach((button) => button.addEventListener('click', () => lobbyGameId ? inviteLobbyFriend(button.dataset.id, button) : toggleLobbyFriend(button.dataset.id)));
  document.querySelectorAll('.lobby-remove').forEach((button) => button.addEventListener('click', () => toggleLobbyFriend(button.dataset.id)));
}

function showInvitation(notification) {
  const popup = document.querySelector('#invitation-popup');
  document.querySelector('#invitation-title').textContent = notification.title;
  document.querySelector('#invitation-message').textContent = notification.message;
  popup.dataset.playerId = notification.related_id || '';
  popup.hidden = false;
}

function openLobby(selectedFriends = []) { lobbyGameId = null; lobbyPlayerRows = []; lobbyFriends = selectedFriends; lobbyOpen = true; renderLobby(); }
async function openLobbyForInvitation(playerId) { try { await openLobbyByGameId(await fetchGameId(playerId)); } catch (error) { document.querySelector('#call-message').textContent = error.message || 'Could not open the game lobby.'; } }
async function openLobbyByGameId(gameId) { lobbyGameId = gameId; lobbyPlayerRows = await loadGamePlayers(gameId); lobbyOpen = true; renderLobby(); }
function closeLobby() { lobbyOpen = false; lobbyGameId = null; lobbyPlayerRows = []; renderLobby(); }
function toggleLobbyFriend(id) { const friend = friends.find((item) => item.id === id); if (!friend) return; lobbyFriends = lobbyFriends.some((item) => item.id === id) ? lobbyFriends.filter((item) => item.id !== id) : [...lobbyFriends, friend]; renderLobby(); }

async function fetchGameId(playerId) { return loadGameIdForPlayer(playerId); }

async function inviteFriend(friendId) { try { await createFriendGame([friendId]); modeMessageElement.textContent = 'Game invitation sent. Waiting for your friend to join.'; } catch (error) { modeMessageElement.textContent = error.message || 'Could not send game invitation.'; } }

async function startFriendLobbyGame() {
  const button = document.querySelector('#start-lobby-button'); button.disabled = true;
  try { if (!lobbyGameId) throw new Error('Wait for a friend to join before starting.'); await startFriendGame(lobbyGameId); await setPresence('playing'); document.querySelector('#lobby-message').textContent = 'Game started for the joined players.'; }
  catch (error) { document.querySelector('#lobby-message').textContent = error.message || 'Could not create game lobby.'; button.disabled = false; }
}

async function inviteLobbyFriend(friendId, button) { button.disabled = true; try { await inviteFriendToGame(lobbyGameId, friendId); button.textContent = 'INVITED'; await refreshLobby(); } catch (error) { button.disabled = false; button.textContent = 'ERROR'; } }

async function refreshLobby() {
  if (!lobbyGameId) return;
  try { lobbyPlayerRows = await loadGamePlayers(lobbyGameId); renderLobby(); } catch (error) { document.querySelector('#lobby-message').textContent = error.message || 'Could not refresh lobby.'; }
}

function socialRow(person, actions) {
  const photo = person.photo_url
    ? `<img src="${escapeHtml(person.photo_url)}" alt="">`
    : escapeHtml((person.display_name || 'B').slice(0, 1).toUpperCase());
  return `<div class="social-row"><span class="mini-avatar${person.photo_url ? ' has-photo' : ''}">${photo}</span><div><strong>${escapeHtml(person.display_name)}</strong><span>@${escapeHtml(person.username)}</span></div>${actions}</div>`;
}

function relationshipLabel(relationship) {
  if (relationship === 'friends') return 'FRIENDS';
  if (relationship === 'outgoing') return 'SENT';
  if (relationship === 'incoming') return 'ACCEPT IN REQUESTS';
  return 'SEND REQUEST';
}

function setupSocialSubscription(userId) {
  if (!userId || socialCleanup.userId === userId) return;
  if (typeof socialCleanup === 'function') socialCleanup();
  const cleanupFn = subscribeToSocialChanges(userId, async () => {
    try {
      [friends, friendRequests, notifications] = await Promise.all([loadFriends(), loadFriendRequests(), loadNotifications()]);
      await refreshLobby();
      const invitation = notifications.find((notification) => notification.type === 'game_invitation' && !notification.is_read);
      if (invitation) showInvitation(invitation);
      const joined = notifications.find((notification) => notification.type === 'game_invitation_accepted' && !notification.is_read);
      if (joined && joined.related_id) openLobbyByGameId(joined.related_id);
    } catch (err) {
      console.warn('Realtime update warning:', err);
    } finally {
      render();
    }
  });
  socialCleanup = () => {
    if (typeof cleanupFn === 'function') cleanupFn();
    socialCleanup.userId = null;
  };
  socialCleanup.userId = userId;
}

async function refreshSocial() {
  if (!isSignedIn()) {
    friends = [];
    friendRequests = [];
    notifications = [];
    return;
  }
  socialLoading = true;
  try {
    [friends, friendRequests, notifications] = await Promise.all([loadFriends(), loadFriendRequests(), loadNotifications()]);
    const invitation = notifications.find((notification) => notification.type === 'game_invitation' && !notification.is_read);
    if (invitation) showInvitation(invitation);
  } catch (error) {
    console.warn('Refresh social error:', error);
  } finally {
    socialLoading = false;
    setupSocialSubscription(auth.user.id);
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(() => setPresence('online').catch(() => {}), 60000);
    if (activeView === 'profile') render();
  }
}

async function handleRequest(requestId, accept, button) {
  button.disabled = true;
  try {
    await respondFriendRequest(requestId, accept);
    await refreshSocial();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'ERROR';
  }
}

async function searchFriends(query) {
  const target = document.querySelector('#search-results');
  if (query.length < 2) {
    target.innerHTML = '<p class="empty-state">Enter a username or Bingo UID.</p>';
    return;
  }
  target.innerHTML = '<p class="empty-state">Searching...</p>';
  try {
    const results = await searchPlayers(query);
    target.innerHTML = results.length
      ? results.map((user) => {
        const disabled = user.relationship !== 'none';
        return `<div class="search-result">${socialRow(user, `<button class="text-button send-request" data-id="${user.id}" type="button" ${disabled ? 'disabled' : ''}>${relationshipLabel(user.relationship)}</button>`)}</div>`;
      }).join('')
      : '<p class="empty-state">No player found.</p>';
    target.querySelectorAll('.send-request').forEach((button) => button.addEventListener('click', () => sendRequest(button.dataset.id, button)));
  } catch (error) {
    target.innerHTML = `<p class="empty-state">${error.message || 'Search failed.'}</p>`;
  }
}

async function sendRequest(id, button) {
  button.disabled = true;
  try {
    await sendFriendRequest(id);
    button.textContent = 'SENT';
    await refreshSocial();
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message === 'You are already friends' ? 'FRIENDS' : 'ERROR';
  }
}

function renderGame() {
  const botThinking = game.turn === 'bot' && !game.winner;
  const botChose = game.lastCaller === 'bot' && !botThinking;
  currentCallElement.textContent = game.currentCall || '--';
  calledCountElement.textContent = `${game.called.length} / 25 called`;
  turnLabelElement.textContent = game.winner ? `${game.winner} wins` : botThinking ? 'Bot turn' : 'Your turn';
  turnBannerElement.textContent = game.winner ? `${game.winner === 'YOU' ? 'YOU WIN' : 'BOT WINS'}` : botThinking ? 'WAIT' : 'YOUR MOVE';
  callLabelElement.textContent = botThinking ? 'BOT IS THINKING...' : botChose ? `BOT CHOSE: ${game.currentCall}` : 'YOUR MOVE';
  callMessageElement.textContent = game.winner ? 'The board is locked.' : botThinking ? 'BOT IS THINKING...' : botChose ? `The bot played ${game.currentCall}.` : 'Choose any available number.';
  playersGridElement.innerHTML = '';
  playersGridElement.append(createPlayerCard(game.players[0], 0));
}

function createPlayerCard(player, playerIndex) {
  const wrapper = document.createElement('article');
  wrapper.className = `player-card bot-solo${playerIndex === 0 && game.turn === 'human' && !game.winner ? ' active-player' : ''}`;
  const lines = Math.min(player.completedLines.length, 5);
  const letters = document.createElement('div');
  letters.className = 'bingo-letters';
  letters.setAttribute('aria-label', `${player.name} BINGO progress`);
  LETTERS.forEach((letter, index) => {
    const item = document.createElement('span');
    item.textContent = letter;
    item.className = index < lines ? 'scratched' : '';
    letters.append(item);
  });
  const board = document.createElement('div');
  board.className = 'bingo-board';
  player.board.forEach((value, cellIndex) => {
    const cell = document.createElement('button');
    const selected = player.selected.includes(cellIndex);
    cell.className = `grid-cell${selected ? ' marked' : ''}`;
    cell.type = 'button';
    cell.textContent = value;
    cell.disabled = Boolean(game.winner) || game.turn !== 'human' || selected;
    cell.setAttribute('role', 'gridcell');
    cell.setAttribute('aria-label', `Number ${value}${selected ? ', selected' : ''}`);
    cell.setAttribute('aria-pressed', selected);
    if (playerIndex === 0) cell.addEventListener('click', () => humanSelect(value));
    board.append(cell);
  });
  const meta = document.createElement('div');
  meta.className = 'board-meta';
  meta.innerHTML = `<span>${player.selected.length} / 25 marked</span><span class="line-count">${lines} lines</span>`;
  wrapper.append(letters, board, meta);
  return wrapper;
}

function startBotMode() {
  if (botTimer) clearTimeout(botTimer);
  botTimer = null;
  game = { mode: 'bot', phase: 'game', called: [], currentCall: null, lastCaller: null, turn: 'human', winner: null, players: [createPlayer('YOU'), createPlayer('BOT')] };
  activeView = 'play';
  winOverlayElement.hidden = true;
  saveGame();
  render();
}

function humanSelect(number) {
  if (game.phase !== 'game' || game.turn !== 'human' || game.winner || game.called.includes(number)) return;
  takeNumber(number, 'human');
  if (!game.winner) {
    game.turn = 'bot';
    saveGame();
    render();
    botTimer = setTimeout(botSelect, 1000);
  }
}

function takeNumber(number, caller) {
  game.currentCall = number;
  game.lastCaller = caller;
  game.called.push(number);
  game.players.forEach((player) => {
    const index = player.board.indexOf(number);
    if (index !== -1 && !player.selected.includes(index)) player.selected.push(index);
    player.completedLines = findCompletedLines(player.selected).map(({ index: lineIndex }) => lineIndex);
  });
  const winner = caller === 'human'
    ? game.players[0].completedLines.length >= 5 ? 'YOU' : game.players[1].completedLines.length >= 5 ? 'BOT' : null
    : game.players[1].completedLines.length >= 5 ? 'BOT' : game.players[0].completedLines.length >= 5 ? 'YOU' : null;
  if (winner) {
    game.winner = winner;
    game.phase = 'game';
    saveGame();
    render();
    showWin();
    return;
  }
  game.turn = caller === 'human' ? 'bot' : 'human';
  saveGame();
  render();
}

function scoreBotChoice(number) {
  const bot = game.players[1];
  const human = game.players[0];
  const botIndex = bot.board.indexOf(number);
  const humanIndex = human.board.indexOf(number);
  const scoreLines = (player, index, opponentIndex) => getLines().reduce((total, line) => {
    if (!line.includes(index)) return total;
    const marked = line.filter((cell) => player.selected.includes(cell)).length;
    const opponentMarked = line.filter((cell) => human.selected.includes(cell)).length;
    const multiLineBonus = line.includes(opponentIndex) ? 4 : 0;
    return total + (marked === 4 ? 900 : marked === 3 ? 150 : marked === 2 ? 40 : 8) + multiLineBonus + opponentMarked * 5;
  }, 0);
  const botLines = botIndex === -1 ? 0 : scoreLines(bot, botIndex, humanIndex);
  const blockHuman = humanIndex === -1 ? 0 : getLines().filter((line) => line.includes(humanIndex)).reduce((total, line) => total + (line.filter((cell) => human.selected.includes(cell)).length === 4 ? 420 : 0), 0);
  return botLines + blockHuman;
}

function botSelect() {
  botTimer = null;
  if (game.winner || game.turn !== 'bot') return;
  const available = Array.from({ length: 25 }, (_, index) => index + 1).filter((number) => !game.called.includes(number));
  const scored = available.map((number) => ({ number, score: scoreBotChoice(number) })).sort((left, right) => right.score - left.score);
  const candidates = scored.slice(0, Math.min(4, scored.length));
  const totalWeight = candidates.reduce((total, candidate, index) => total + candidates.length - index, 0);
  let choice = Math.random() * totalWeight;
  for (const [index, candidate] of candidates.entries()) {
    choice -= candidates.length - index;
    if (choice <= 0) {
      takeNumber(candidate.number, 'bot');
      return;
    }
  }
  takeNumber(candidates[0].number, 'bot');
}

function showWin() {
  document.querySelector('#win-message').textContent = game.winner === 'YOU' ? 'BINGO! YOU WIN!' : 'BINGO! BOT WINS!';
  winOverlayElement.hidden = false;
  document.querySelector('#play-again-button').focus();
}

function backToModes() {
  if (botTimer) clearTimeout(botTimer);
  botTimer = null;
  game = createModeGame();
  activeView = 'home';
  winOverlayElement.hidden = true;
  modeMessageElement.textContent = 'Choose a mode to begin.';
  render();
}

function setHint(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle('hint-error', isError);
  element.classList.toggle('hint-ok', !isError && /available/.test(text));
}

function resetTerminalAnimation() {
  if (!accountLoadingElement) return;
  const lines = accountLoadingElement.querySelectorAll('.terminal-line');
  lines.forEach((line) => {
    line.style.animation = 'none';
    void line.offsetWidth;
    line.style.animation = '';
  });
}

async function navigateToProfile() {
  if (needsUsername()) {
    activeView = 'profile';
    render();
    return;
  }

  isProfileLoading = true;
  render();
  resetTerminalAnimation();

  const minAnimationPromise = new Promise((resolve) => setTimeout(resolve, 450));

  try {
    const profilePromise = withTimeout(fetchProfileWithRetry(), 5000);
    const [profileState] = await Promise.all([profilePromise, minAnimationPromise]);
    auth = { configured: true, loading: false, ...profileState };
    if (isSignedIn()) {
      await refreshSocial();
      await setPresence('online');
    }
  } catch (error) {
    console.warn('Profile navigation error:', error);
    auth = { ...auth, error };
  } finally {
    isProfileLoading = false;
    activeView = 'profile';
    render();
  }
}

document.querySelector('#bot-mode-button').addEventListener('click', startBotMode);
document.querySelector('#online-mode-button').addEventListener('click', () => { modeMessageElement.textContent = 'PLAY ONLINE is coming soon.'; });
document.querySelector('#friend-mode-button').addEventListener('click', async () => {
  if (!isSignedIn()) {
    await navigateToProfile();
    return;
  }
  openLobby();
});
document.querySelector('#new-game-button').addEventListener('click', startBotMode);
document.querySelector('#back-mode-button').addEventListener('click', backToModes);
document.querySelector('#play-again-button').addEventListener('click', startBotMode);
document.querySelector('#overlay-mode-button').addEventListener('click', backToModes);
document.querySelector('#inbox-button').addEventListener('click', () => { const panel = document.querySelector('#inbox-panel'); panel.hidden = !panel.hidden; document.querySelector('#inbox-button').setAttribute('aria-expanded', String(!panel.hidden)); });
document.querySelector('#close-inbox-button').addEventListener('click', () => { document.querySelector('#inbox-panel').hidden = true; document.querySelector('#inbox-button').setAttribute('aria-expanded', 'false'); });
document.querySelector('#close-lobby-button').addEventListener('click', closeLobby);
document.querySelector('#cancel-lobby-button').addEventListener('click', closeLobby);
document.querySelector('#start-lobby-button').addEventListener('click', startFriendLobbyGame);
document.querySelector('#home-friends-refresh').addEventListener('click', refreshSocial);
document.querySelector('#join-invitation-button').addEventListener('click', async () => { const popup = document.querySelector('#invitation-popup'); await respondGameInvitation(popup.dataset.playerId, true); popup.hidden = true; openLobby(); });
document.querySelector('#decline-invitation-button').addEventListener('click', async () => { const popup = document.querySelector('#invitation-popup'); await respondGameInvitation(popup.dataset.playerId, false); popup.hidden = true; });

navButtons.forEach((button) => button.addEventListener('click', async () => {
  if (needsUsername()) return;
  const view = button.dataset.view;
  if (view === 'profile') {
    await navigateToProfile();
  } else {
    activeView = view;
    if (activeView === 'home') game.phase = 'mode';
    render();
  }
}));

document.querySelector('#google-signin-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  authMessageElement.textContent = 'Redirecting to Google...';
  
  const resetTimer = setTimeout(() => {
    button.disabled = false;
    authMessageElement.textContent = 'Redirect taking longer than expected. Please check popup blockers or Supabase Auth settings.';
  }, 5000);

  try {
    await signInWithGoogle();
  } catch (error) {
    clearTimeout(resetTimer);
    button.disabled = false;
    authMessageElement.textContent = error.message || 'Google sign-in failed.';
  }
});

document.querySelector('#check-username-button').addEventListener('click', async () => {
  const value = document.querySelector('#username-input').value;
  try {
    const result = await checkUsernameAvailability(value);
    setHint(usernameMessageElement, result.message, !result.available);
  } catch (error) {
    setHint(usernameMessageElement, error.message || 'Could not check username.', true);
  }
});

document.querySelector('#username-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const value = new FormData(event.currentTarget).get('username');
  button.disabled = true;
  try {
    const profile = await claimUsername(value);
    auth = { ...auth, profile, loading: false };
    activeView = 'profile';
    await refreshSocial();
    render();
  } catch (error) {
    setHint(usernameMessageElement, error.message || 'Could not save username.', true);
    button.disabled = false;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  if (isSignedIn()) { try { await setPresence('offline'); } catch (error) { console.warn('Presence unavailable.', error); } }
  await signOut();
  socialCleanup();
  socialCleanup = () => {};
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  friends = [];
  friendRequests = [];
  notifications = [];
  activeView = 'home';
});

document.querySelector('#copy-uid-button').addEventListener('click', async (event) => {
  if (!auth.profile?.uid) return;
  await navigator.clipboard?.writeText(auth.profile.uid);
  event.currentTarget.textContent = 'COPIED';
  setTimeout(() => { event.currentTarget.textContent = 'COPY'; }, 1600);
});

document.querySelector('#friend-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  searchFriends(document.querySelector('#friend-search').value.trim());
});

subscribeToAuth(async (next) => {
  auth = next;
  render();
  try {
    if (isSignedIn()) await refreshSocial();
    else {
      friends = [];
      friendRequests = [];
    }
    if (isSignedIn()) await setPresence('online');
  } catch (error) {
    auth = { ...auth, error };
    console.warn('Account setup failed.', error);
  } finally {
    render();
  }
});

render();

export { createBoard, findCompletedLines, getLines, scoreBotChoice };
