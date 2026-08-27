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
const winOverlayElement = document.querySelector('#win-overlay');
const profileViewElement = document.querySelector('#profile-view');
const authViewElement = document.querySelector('#auth-view');
const usernameViewElement = document.querySelector('#username-view');
const navButtons = document.querySelectorAll('.nav-button');
const ACCOUNT_KEY = 'bingo-account-v1';
const DIRECTORY_KEY = 'bingo-directory-v1';
let activeView = 'play';
let account = loadAccount();

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

function render() {
  const isAccountView = activeView === 'profile';
  modeViewElement.hidden = isAccountView || activeView !== 'play' || game.phase === 'game';
  gameViewElement.hidden = isAccountView || activeView !== 'play' || game.phase !== 'game';
  profileViewElement.hidden = !isAccountView || !account;
  authViewElement.hidden = !isAccountView || Boolean(account);
  usernameViewElement.hidden = !isAccountView || !account || Boolean(account.username);
  if (activeView === 'play' && game.phase === 'game') renderGame();
  if (account?.username) renderProfile();
  navButtons.forEach((button) => button.classList.toggle('active', button.dataset.view === activeView));
  statusLabelElement.textContent = isAccountView ? account ? `@${account.username || 'new account'}` : 'Sign in to continue' : game.phase === 'mode' ? 'Choose a game mode' : game.winner ? `${game.winner} wins` : game.turn === 'bot' ? 'Bot is thinking' : 'Your turn';
}

function loadAccount() {
  try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY)); } catch (error) { localStorage.removeItem(ACCOUNT_KEY); return null; }
}

function saveAccount() { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); }

function getDirectory() {
  try { return JSON.parse(localStorage.getItem(DIRECTORY_KEY)) || []; } catch (error) { return []; }
}

function saveDirectory(directory) { localStorage.setItem(DIRECTORY_KEY, JSON.stringify(directory)); }

function createAccount() {
  const uid = `BNG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  account = { id: crypto.randomUUID ? crypto.randomUUID() : uid, uid, displayName: 'Bingo Player', email: 'demo@example.com', photoURL: '', createdAt: new Date().toISOString(), username: '', stats: { gamesPlayed: 0, wins: 0, losses: 0, winRate: 0, currentWinStreak: 0, highestWinStreak: 0 }, friends: [], friendRequests: [] };
  saveAccount();
  if (!getDirectory().length) saveDirectory([{ uid: 'BNG-8F42K', username: 'dilip_123', displayName: 'Dilip', photoURL: '', friends: [], friendRequests: [] }, { uid: 'BNG-4A19P', username: 'rahul_bingo', displayName: 'Rahul', photoURL: '', friends: [], friendRequests: [] }]);
}

function renderProfile() {
  document.querySelector('#profile-display-name').textContent = account.displayName;
  document.querySelector('#profile-username').textContent = `@${account.username}`;
  document.querySelector('#profile-uid').textContent = account.uid;
  document.querySelector('#profile-avatar').textContent = account.displayName.slice(0, 1).toUpperCase();
  const stats = account.stats;
  document.querySelector('#stat-played').textContent = stats.gamesPlayed;
  document.querySelector('#stat-wins').textContent = stats.wins;
  document.querySelector('#stat-losses').textContent = stats.losses;
  document.querySelector('#stat-rate').textContent = `${stats.winRate}%`;
  document.querySelector('#stat-current').textContent = stats.currentWinStreak;
  document.querySelector('#stat-highest').textContent = stats.highestWinStreak;
  const directory = getDirectory();
  document.querySelector('#friend-count').textContent = account.friends.length;
  document.querySelector('#request-count').textContent = account.friendRequests.length;
  document.querySelector('#friends-list').innerHTML = account.friends.length ? account.friends.map((uid) => { const friend = directory.find((user) => user.uid === uid); return friend ? `<div class="social-row"><span class="mini-avatar">${friend.displayName[0]}</span><div><strong>${friend.displayName}</strong><span>@${friend.username}</span></div><button class="text-button play-friend" type="button">PLAY</button></div>` : ''; }).join('') : '<p class="empty-state">No friends yet.</p>';
  document.querySelector('#requests-list').innerHTML = account.friendRequests.length ? account.friendRequests.map((request) => `<div class="social-row"><span class="mini-avatar">${request.displayName[0]}</span><div><strong>${request.displayName}</strong><span>@${request.username}</span></div><button class="text-button accept-request" data-uid="${request.uid}" type="button">ACCEPT</button><button class="text-button decline-request" data-uid="${request.uid}" type="button">DECLINE</button></div>`).join('') : '<p class="empty-state">No pending requests.</p>';
  document.querySelectorAll('.play-friend').forEach((button) => button.addEventListener('click', () => { button.textContent = 'SOON'; }));
  document.querySelectorAll('.accept-request').forEach((button) => button.addEventListener('click', () => updateRequest(button.dataset.uid, true)));
  document.querySelectorAll('.decline-request').forEach((button) => button.addEventListener('click', () => updateRequest(button.dataset.uid, false)));
}

function updateRequest(uid, accept) {
  const request = account.friendRequests.find((item) => item.uid === uid);
  account.friendRequests = account.friendRequests.filter((item) => item.uid !== uid);
  if (accept && request && !account.friends.includes(uid)) account.friends.push(uid);
  saveAccount(); render();
}

function searchFriends(query) {
  const results = getDirectory().filter((user) => user.uid !== account.uid && (user.username.toLowerCase().includes(query) || user.uid.toLowerCase() === query));
  const target = document.querySelector('#search-results');
  target.innerHTML = results.length ? results.map((user) => `<div class="search-result"><span class="mini-avatar">${user.displayName[0]}</span><div><strong>${user.displayName}</strong><span>@${user.username}<br>UID: ${user.uid}</span></div><button class="text-button send-request" data-uid="${user.uid}" type="button">SEND REQUEST</button></div>`).join('') : '<p class="empty-state">No player found.</p>';
  target.querySelectorAll('.send-request').forEach((button) => button.addEventListener('click', () => sendRequest(button.dataset.uid, button)));
}

function sendRequest(uid, button) {
  const user = getDirectory().find((item) => item.uid === uid);
  if (!user || account.friends.includes(uid) || account.friendRequests.some((item) => item.uid === uid)) { button.textContent = account.friends.includes(uid) ? 'FRIENDS' : 'SENT'; return; }
  user.friendRequests = user.friendRequests || [];
  user.friendRequests.push({ uid: account.uid, username: account.username, displayName: account.displayName });
  const directory = getDirectory().filter((item) => item.uid !== uid); directory.push(user); saveDirectory(directory); button.textContent = 'SENT';
}

function renderGame() {
  currentCallElement.textContent = game.currentCall || '--';
  calledCountElement.textContent = `${game.called.length} / 25 called`;
  turnLabelElement.textContent = game.winner ? `${game.winner} wins` : game.turn === 'bot' ? 'Bot turn' : 'Your turn';
  callLabelElement.textContent = game.turn === 'bot' ? 'BOT IS THINKING...' : game.lastCaller === 'bot' ? `BOT CHOSE: ${game.currentCall}` : 'YOUR MOVE';
  callMessageElement.textContent = game.winner ? 'The board is locked.' : game.turn === 'bot' ? 'BOT IS THINKING...' : 'Choose any available number.';
  playersGridElement.innerHTML = '';
  playersGridElement.append(createPlayerCard(game.players[0], 0));
}

function createPlayerCard(player, playerIndex) {
  const wrapper = document.createElement('article');
  wrapper.className = `player-card${playerIndex === 0 && game.turn === 'human' && !game.winner ? ' active-player' : ''}`;
  const lines = Math.min(player.completedLines.length, 5);
  const head = document.createElement('div');
  head.className = 'player-card-head';
  const identity = document.createElement('div');
  identity.innerHTML = `<span class="section-number">${player.name}</span><strong>${player.selected.length} / 25 marked</strong>`;
  const lineCount = document.createElement('span');
  lineCount.className = 'line-count'; lineCount.textContent = `${lines} lines`;
  const letters = document.createElement('div');
  letters.className = 'bingo-letters'; letters.setAttribute('aria-label', `${player.name} BINGO progress`);
  LETTERS.forEach((letter, index) => { const item = document.createElement('span'); item.textContent = letter; item.className = index < lines ? 'scratched' : ''; letters.append(item); });
  head.append(identity, lineCount, letters);
  const board = document.createElement('div'); board.className = 'bingo-board';
  player.board.forEach((value, cellIndex) => {
    const cell = document.createElement('button');
    const selected = player.selected.includes(cellIndex);
    cell.className = `grid-cell${selected ? ' marked' : ''}`; cell.type = 'button'; cell.textContent = value; cell.disabled = Boolean(game.winner) || game.turn !== 'human' || selected; cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-label', `Number ${value}${selected ? ', selected' : ''}`); cell.setAttribute('aria-pressed', selected);
    if (playerIndex === 0) cell.addEventListener('click', () => humanSelect(value));
    board.append(cell);
  });
  wrapper.append(head, board); return wrapper;
}

function startBotMode() {
  if (botTimer) clearTimeout(botTimer);
  botTimer = null;
  game = { mode: 'bot', phase: 'game', called: [], currentCall: null, lastCaller: null, turn: 'human', winner: null, players: [createPlayer('YOU'), createPlayer('BOT')] };
  winOverlayElement.hidden = true; saveGame(); render();
}

function humanSelect(number) {
  if (game.phase !== 'game' || game.turn !== 'human' || game.winner || game.called.includes(number)) return;
  takeNumber(number, 'human');
  if (!game.winner) {
    game.turn = 'bot'; saveGame(); render();
    botTimer = setTimeout(botSelect, 1000);
  }
}

function takeNumber(number, caller) {
  game.currentCall = number; game.lastCaller = caller; game.called.push(number);
  game.players.forEach((player) => { const index = player.board.indexOf(number); if (index !== -1 && !player.selected.includes(index)) player.selected.push(index); player.completedLines = findCompletedLines(player.selected).map(({ index: lineIndex }) => lineIndex); });
  const winner = caller === 'human' ? game.players[0].completedLines.length >= 5 ? 'YOU' : game.players[1].completedLines.length >= 5 ? 'BOT' : null : game.players[1].completedLines.length >= 5 ? 'BOT' : game.players[0].completedLines.length >= 5 ? 'YOU' : null;
  if (winner) { game.winner = winner; game.phase = 'game'; saveGame(); render(); showWin(); return; }
  game.turn = caller === 'human' ? 'bot' : 'human'; saveGame(); render();
}

function scoreBotChoice(number) {
  const bot = game.players[1]; const human = game.players[0]; const botIndex = bot.board.indexOf(number); const humanIndex = human.board.indexOf(number);
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
  for (const [index, candidate] of candidates.entries()) { choice -= candidates.length - index; if (choice <= 0) { takeNumber(candidate.number, 'bot'); return; } }
  takeNumber(candidates[0].number, 'bot');
}

function showWin() {
  document.querySelector('#win-message').textContent = game.winner === 'YOU' ? 'BINGO! YOU WIN!' : 'BINGO! BOT WINS!';
  winOverlayElement.hidden = false;
  document.querySelector('#play-again-button').focus();
}

function backToModes() {
  if (botTimer) clearTimeout(botTimer); botTimer = null; game = createModeGame(); winOverlayElement.hidden = true; modeMessageElement.textContent = 'Choose a mode to begin.'; render();
}

document.querySelector('#bot-mode-button').addEventListener('click', startBotMode);
document.querySelector('#friend-mode-button').addEventListener('click', () => { modeMessageElement.textContent = 'PLAY WITH FRIEND is coming soon.'; });
document.querySelector('#new-game-button').addEventListener('click', startBotMode);
document.querySelector('#back-mode-button').addEventListener('click', backToModes);
document.querySelector('#play-again-button').addEventListener('click', startBotMode);
document.querySelector('#overlay-mode-button').addEventListener('click', backToModes);
navButtons.forEach((button) => button.addEventListener('click', () => { activeView = button.dataset.view; if (activeView === 'play' && game.phase !== 'game') game.phase = 'mode'; render(); }));
document.querySelector('#google-signin-button').addEventListener('click', () => { createAccount(); render(); });
document.querySelector('#username-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const username = new FormData(event.currentTarget).get('username').toString().trim().toLowerCase();
  const duplicate = getDirectory().some((user) => user.username === username);
  if (duplicate) { document.querySelector('#username-message').textContent = 'That username is already taken.'; return; }
  account.username = username; saveAccount();
  const directory = getDirectory().filter((user) => user.uid !== account.uid); directory.push({ uid: account.uid, username: account.username, displayName: account.displayName, photoURL: account.photoURL, friendRequests: account.friendRequests, friends: account.friends }); saveDirectory(directory); render();
});
document.querySelector('#logout-button').addEventListener('click', () => { account = null; activeView = 'home'; render(); });
document.querySelector('#copy-uid-button').addEventListener('click', async (event) => { await navigator.clipboard?.writeText(account.uid); event.currentTarget.textContent = 'COPIED'; });
document.querySelector('#friend-search-form').addEventListener('submit', (event) => { event.preventDefault(); searchFriends(document.querySelector('#friend-search').value.trim().toLowerCase()); });
render();

export { createBoard, findCompletedLines, getLines, scoreBotChoice };