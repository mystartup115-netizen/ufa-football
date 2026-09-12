// ====================================================
// UFA — CLIENT ENGINE (Optimized 3-2-1, Phase Ads & Fixed Stage)
// ====================================================

const socket = io();

let currentRoom = null;
let myTeamId = null;
let currentAuthMode = 'create';

// Tracks role transitions for 5s interstitial ad trigger
let lastSeenPhase = null;
let isShowingPhaseBreak = false;

const DEFAULT_BOT_DP = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='%2394a3b8'><circle cx='50' cy='50' r='50' fill='%23f1f5f9'/><path d='M50 46a16 16 0 1 0 0-32 16 16 0 0 0 0 32zm0 8c-18.7 0-35 11.7-35 28v2h70v-2c0-16.3-16.3-28-35-28z'/></svg>";

const ROOM_CODE_REGEX = /^[a-zA-Z0-9]{12}$/;
const PASSWORD_REGEX = /^[a-zA-Z0-9]{8}$/;

// --- 1. AUTH & CONFIG ---
function toggleAuthTab(mode) {
  currentAuthMode = mode;
  const createBtn = document.getElementById('tab-create-btn');
  const joinBtn = document.getElementById('tab-join-btn');
  const hostSettings = document.getElementById('host-settings-section');
  const submitBtn = document.getElementById('auth-submit-btn');
  const genBtn = document.getElementById('btn-gen-code');

  if (mode === 'create') {
    createBtn.classList.add('active');
    joinBtn.classList.remove('active');
    hostSettings.style.display = 'block';
    genBtn.style.display = 'inline-block';
    submitBtn.textContent = 'Create & Host Room';
  } else {
    joinBtn.classList.add('active');
    createBtn.classList.remove('active');
    hostSettings.style.display = 'none';
    genBtn.style.display = 'none';
    submitBtn.textContent = 'Join Room';
  }
}

function updateCharCount(inputId, countId, targetLen) {
  const val = document.getElementById(inputId).value;
  const counter = document.getElementById(countId);
  counter.textContent = `${val.length}/${targetLen}`;
  if (val.length === targetLen) {
    counter.classList.add('valid');
  } else {
    counter.classList.remove('valid');
  }
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function autoGenerateCredentials() {
  const code = generateRandomString(12);
  const pass = generateRandomString(8);

  document.getElementById('inp-room-code').value = code;
  document.getElementById('inp-room-pass').value = pass;

  updateCharCount('inp-room-code', 'code-count', 12);
  updateCharCount('inp-room-pass', 'pass-count', 8);
}

function handleAuthSubmit() {
  const roomCode = document.getElementById('inp-room-code').value.trim();
  const password = document.getElementById('inp-room-pass').value.trim();
  const teamName = document.getElementById('inp-team-name').value.trim();

  if (!ROOM_CODE_REGEX.test(roomCode)) {
    alert("❌ Invalid Room Code!\nMust be exactly 12 alphanumeric characters.");
    return;
  }
  if (!PASSWORD_REGEX.test(password)) {
    alert("❌ Invalid Password!\nMust be exactly 8 alphanumeric characters.");
    return;
  }
  if (!teamName) {
    alert("❌ Please enter your Club Name!");
    return;
  }

  if (currentAuthMode === 'create') {
    const maxTeams = parseInt(document.getElementById('cfg-max-teams').value, 10);
    const budget = parseInt(document.getElementById('cfg-budget').value, 10);
    const category = document.getElementById('cfg-category').value;

    socket.emit('create_room', {
      roomCode,
      password,
      adminTeamName: teamName,
      maxTeams,
      startingBudget: budget,
      categoryFilter: category
    });
  } else {
    socket.emit('join_room', { roomCode, password, teamName });
  }
}

// --- 2. HOST CONTROLS ---
function handleStartAuction(e) {
  if (e) e.preventDefault();
  if (!currentRoom) return;
  socket.emit('start_auction', { roomCode: currentRoom.code });
}

function handleTogglePause(e) {
  if (e) e.preventDefault();
  if (!currentRoom) return;
  socket.emit('host_toggle_pause', { roomCode: currentRoom.code });
}

function handleCloseRoom(e) {
  if (e) e.preventDefault();
  if (!currentRoom) return;
  if (confirm("Are you sure you want to shut down this auction room? All players will be disconnected.")) {
    socket.emit('host_close_room', { roomCode: currentRoom.code });
  }
}

function handleKickTeam(teamId) {
  if (!currentRoom) return;
  if (confirm("Kick this club from the auction floor?")) {
    socket.emit('host_kick_player', { roomCode: currentRoom.code, targetTeamId: teamId });
  }
}

// --- 3. BIDDING EMISSIONS ---
function emitRaiseBid(e) {
  if (e) e.preventDefault();
  if (!currentRoom || isShowingPhaseBreak) return;
  socket.emit('raise_bid', { roomCode: currentRoom.code });
}

function emitPassBid(e) {
  if (e) e.preventDefault();
  if (!currentRoom || isShowingPhaseBreak) return;
  socket.emit('pass_bid', { roomCode: currentRoom.code });
}

// --- 4. SOCKET EVENT LISTENERS ---
socket.on('room_joined', ({ room, myTeamId: id }) => {
  currentRoom = room;
  myTeamId = id;

  const authModal = document.getElementById('room-auth-modal');
  if (authModal) authModal.classList.remove('active');

  const myTeam = room.teams.find(t => t.id === myTeamId);
  const clubDisplay = document.getElementById('my-club-display');
  if (clubDisplay) clubDisplay.textContent = myTeam ? myTeam.name : 'Connected';

  renderRoomState(room);
  logEvent(`Joined Room <strong>${room.code}</strong> as <strong>${myTeam ? myTeam.name : 'Manager'}</strong>`, 'system');
});

socket.on('room_state_updated', (room) => {
  currentRoom = room;
  renderRoomState(room);
});

socket.on('bid_placed', ({ room, log }) => {
  currentRoom = room;
  renderRoomState(room);
  logEvent(log, 'bid');
});

socket.on('lot_concluded', ({ room, log }) => {
  currentRoom = room;
  renderRoomState(room);
  logEvent(log, 'sold');
});

// 12s Hammer countdown tick
socket.on('timer_tick', (timeLeft) => {
  const timerEl = document.getElementById('timer');
  const timerBox = document.getElementById('timer-box');
  const timerLabel = document.getElementById('timer-label');
  
  if (timerEl) timerEl.textContent = timeLeft;
  if (timerLabel) timerLabel.textContent = "HAMMER IN";

  if (timerBox) {
    if (timeLeft <= 4) timerBox.classList.add('urgent');
    else timerBox.classList.remove('urgent');
  }
});

// 35% FASTER CLEAN 3-2-1 TRANSITION (NO VIOLET, NO BOOM WORD)
socket.on('interstitial_tick', (secondsLeft) => {
  const overlay = document.getElementById('interstitial-overlay');
  const textEl = document.getElementById('countdown-boom-text');
  const subEl = document.getElementById('boom-sub-text');
  const timerLabel = document.getElementById('timer-label');
  const timerEl = document.getElementById('timer');

  if (timerLabel) timerLabel.textContent = "NEXT LOT";
  if (timerEl) timerEl.textContent = secondsLeft;

  if (overlay) overlay.classList.add('active');

  // Remove existing color classes
  textEl.classList.remove('digit-3', 'digit-2', 'digit-1');

  if (secondsLeft === 3) {
    textEl.textContent = "3";
    textEl.classList.add('digit-3'); // Red
    if (subEl) subEl.textContent = "STAND BY...";
  } else if (secondsLeft === 2) {
    textEl.textContent = "2";
    textEl.classList.add('digit-2'); // Yellow
    if (subEl) subEl.textContent = "PREPARING CARD...";
  } else if (secondsLeft === 1) {
    textEl.textContent = "1";
    textEl.classList.add('digit-1'); // Green
    if (subEl) subEl.textContent = "LAUNCHING LOT";
  } else {
    // 0s: Dismiss immediately, no BOOM display
    if (overlay) overlay.classList.remove('active');
  }
});

socket.on('pause_state_changed', ({ isPaused }) => {
  const timerBox = document.getElementById('timer-box');
  const pauseBtn = document.getElementById('host-pause-btn');
  if (isPaused) {
    if (timerBox) timerBox.classList.add('paused');
    if (pauseBtn) pauseBtn.textContent = "▶ Resume";
    logEvent("⏸ Host has paused the auction clock.", "pass");
  } else {
    if (timerBox) timerBox.classList.remove('paused');
    if (pauseBtn) pauseBtn.textContent = "⏸ Pause";
    logEvent("▶ Auction clock resumed!", "system");
  }
});

socket.on('room_closed', () => {
  alert("The host closed this auction room.");
  window.location.reload();
});

socket.on('you_were_kicked', () => {
  alert("You were removed from the room by the host.");
  window.location.reload();
});

socket.on('auction_finished', ({ room, log }) => {
  currentRoom = room;
  renderRoomState(room);
  logEvent(log, 'sold');
  alert("🎉 AUCTION COMPLETE! All positions filled.");
  openAnalysisModal();
});

socket.on('error_msg', (msg) => {
  alert(msg);
});

// --- 5. RENDER CURRENT ROOM STATE ---
function renderRoomState(room) {
  const isHost = room.adminSocketId === myTeamId;
  const hostStartBtn = document.getElementById('host-start-btn');
  const hostLiveControls = document.getElementById('host-live-controls');

  const lobbyView = document.getElementById('lobby-stage-view');
  const liveView = document.getElementById('live-stage-view');

  // 1. Toggle between Lobby Stage (With 2 Ads) & Live Auction Floor
  if (room.status === 'LOBBY') {
    if (lobbyView) lobbyView.style.display = 'flex';
    if (liveView) liveView.style.display = 'none';

    if (hostStartBtn) hostStartBtn.style.display = isHost ? 'inline-block' : 'none';
    if (hostLiveControls) hostLiveControls.style.display = 'none';

    const phaseEl = document.getElementById('phase-indicator');
    if (phaseEl) phaseEl.textContent = `LOBBY: WAITING FOR HOST (${room.teams.length}/${room.maxTeams})`;

    const lobbyTitle = document.getElementById('lobby-wait-title');
    if (lobbyTitle) {
      lobbyTitle.textContent = isHost 
        ? `You are Host (${room.teams.length}/${room.maxTeams} Clubs Connected)` 
        : `Waiting for host to commence (${room.teams.length}/${room.maxTeams})`;
    }

    renderTeams(room, isHost);
    return;
  }

  // 2. Status is LIVE: Hide Lobby Ads, Show Player Auction Card & Controls
  if (lobbyView) lobbyView.style.display = 'none';
  if (liveView) liveView.style.display = 'flex';

  if (hostStartBtn) hostStartBtn.style.display = 'none';
  if (hostLiveControls) hostLiveControls.style.display = isHost ? 'flex' : 'none';

  const countEl = document.getElementById('connected-count');
  if (countEl) countEl.textContent = `${room.teams.length}/${room.maxTeams} Joined`;

  const item = room.pool[room.currentIndex];
  if (!item) return;

  // 3. 5-Second Static Ad Check across Phase Transitions (After Managers, After Midfielders)
  checkPhaseTransitionAd(item.primaryRole);

  const isManager = item.category === 'manager';
  const phaseIndicator = document.getElementById('phase-indicator');
  if (phaseIndicator) {
    phaseIndicator.textContent = `PHASE: ${item.primaryRole.toUpperCase()} DRAFT`;
    phaseIndicator.style.color = isManager ? '#7e22ce' : '#0284c7';
  }

  // Card updates
  document.getElementById('lot-index').textContent = `LOT ${room.currentIndex + 1} OF ${room.pool.length}`;
  document.getElementById('card-ovr').textContent = item.overall;
  document.getElementById('card-pos').textContent = isManager ? 'MGR' : item.position;
  document.getElementById('card-name').textContent = item.name;
  document.getElementById('card-nat').textContent = item.nationality;
  document.getElementById('card-pri').textContent = isManager ? (item.preferredFormation || 'TAC') : item.primary;
  document.getElementById('base-price').textContent = item.baseprice;
  document.getElementById('current-bid').textContent = room.currentBid;
  document.getElementById('bid-leader').textContent = room.highestBidder ? room.highestBidder.name : 'None';
  document.getElementById('card-image').src = DEFAULT_BOT_DP;

  // Category Tag
  const catBadge = document.getElementById('card-category');
  catBadge.textContent = item.category;
  catBadge.className = 'category-tag';
  const c = item.category.toLowerCase().trim();
  if (c === 'icons') catBadge.classList.add('tag-icons');
  else if (c === 'hearts') catBadge.classList.add('tag-hearts');
  else if (c === 'young gen') catBadge.classList.add('tag-young-gen');
  else if (c === 'manager') catBadge.classList.add('tag-manager');
  else catBadge.classList.add('tag-normal');

  // Stats Grid
  const statsGrid = document.getElementById('stats-grid');
  const isGK = item.primary === 'GK' || item.position === 'GK';

  if (isManager) {
    statsGrid.innerHTML = `
      <div class="stat-item"><span class="stat-label">ATTACKING</span><span class="stat-val">${item.attributes.attacking}</span></div>
      <div class="stat-item"><span class="stat-label">TACTICS</span><span class="stat-val">${item.attributes.tactics}</span></div>
      <div class="stat-item"><span class="stat-label">DISCIPLINE</span><span class="stat-val">${item.attributes.discipline}</span></div>
      <div class="stat-item"><span class="stat-label">ADAPTABILITY</span><span class="stat-val">${item.attributes.adaptability}</span></div>
      <div class="stat-item"><span class="stat-label">MOTIVATION</span><span class="stat-val">${item.attributes.motivation}</span></div>
      <div class="stat-item"><span class="stat-label">DEFENSE</span><span class="stat-val">${item.attributes.defense}</span></div>
    `;
  } else if (isGK) {
    statsGrid.innerHTML = `
      <div class="stat-item"><span class="stat-label">DIVING</span><span class="stat-val">${item.attributes.diving}</span></div>
      <div class="stat-item"><span class="stat-label">HANDLING</span><span class="stat-val">${item.attributes.handling}</span></div>
      <div class="stat-item"><span class="stat-label">KICKING</span><span class="stat-val">${item.attributes.kicking}</span></div>
      <div class="stat-item"><span class="stat-label">REFLEXES</span><span class="stat-val">${item.attributes.reflexes}</span></div>
      <div class="stat-item"><span class="stat-label">SPEED</span><span class="stat-val">${item.attributes.speed}</span></div>
      <div class="stat-item"><span class="stat-label">POSITIONING</span><span class="stat-val">${item.attributes.positioning}</span></div>
    `;
  } else {
    statsGrid.innerHTML = `
      <div class="stat-item"><span class="stat-label">PACE</span><span class="stat-val">${item.attributes.pace}</span></div>
      <div class="stat-item"><span class="stat-label">SHOOTING</span><span class="stat-val">${item.attributes.shooting}</span></div>
      <div class="stat-item"><span class="stat-label">PASSING</span><span class="stat-val">${item.attributes.passing}</span></div>
      <div class="stat-item"><span class="stat-label">DRIBBLING</span><span class="stat-val">${item.attributes.dribbling}</span></div>
      <div class="stat-item"><span class="stat-label">DEFENDING</span><span class="stat-val">${item.attributes.defending}</span></div>
      <div class="stat-item"><span class="stat-label">PHYSICAL</span><span class="stat-val">${item.attributes.physical}</span></div>
    `;
  }

  // Slab & Bidding buttons
  const slabInc = room.currentBid < 50 ? 2 : (room.currentBid <= 100 ? 5 : 10);
  const nextBid = !room.highestBidder ? item.baseprice : room.currentBid + slabInc;
  document.getElementById('next-bid-val').textContent = nextBid;
  document.getElementById('btn-bid-amount').textContent = room.highestBidder ? `+${slabInc}` : `Open @ ${nextBid}`;
  document.getElementById('pass-counter').textContent = `${room.passedTeamIds.length}/${room.teams.length}`;

  renderTeams(room, isHost);
}

// 5-SECOND TRANSITION AD HANDLER
function checkPhaseTransitionAd(newRole) {
  if (!lastSeenPhase) {
    lastSeenPhase = newRole;
    return;
  }

  // Detect: Manager -> Midfielder, or Midfielder -> Forward transition
  const isManagerDone = (lastSeenPhase === 'manager' && newRole === 'midfielder');
  const isMidfielderDone = (lastSeenPhase === 'midfielder' && newRole === 'forward');

  if ((isManagerDone || isMidfielderDone) && !isShowingPhaseBreak) {
    triggerPhaseBreakAd(isManagerDone ? "MANAGERS DRAFT COMPLETE" : "MIDFIELDERS DRAFT COMPLETE");
  }

  lastSeenPhase = newRole;
}

function triggerPhaseBreakAd(title) {
  isShowingPhaseBreak = true;
  const overlay = document.getElementById('phase-break-overlay');
  const titleEl = document.getElementById('phase-break-title');
  const countdownEl = document.getElementById('phase-ad-countdown');

  if (titleEl) titleEl.textContent = title;
  if (overlay) overlay.classList.add('active');

  let remaining = 5;
  if (countdownEl) countdownEl.textContent = remaining;

  const timer = setInterval(() => {
    remaining--;
    if (countdownEl) countdownEl.textContent = remaining;

    if (remaining <= 0) {
      clearInterval(timer);
      if (overlay) overlay.classList.remove('active');
      isShowingPhaseBreak = false;
    }
  }, 1000);
}

function renderTeams(room, isHost) {
  const container = document.getElementById('teams-list');
  container.innerHTML = room.teams.map(t => {
    const isLeader = room.highestBidder && room.highestBidder.id === t.id;
    const hasPassed = room.passedTeamIds.includes(t.id);
    const isMe = t.id === myTeamId;
    const canKick = isHost && !t.isHost;

    const m = t.manager ? 1 : 0;
    const fwd = t.squad.filter(p => p.primaryRole === 'forward').length;
    const mid = t.squad.filter(p => p.primaryRole === 'midfielder').length;
    const def = t.squad.filter(p => p.primaryRole === 'defender').length;
    const gk = t.squad.filter(p => p.primaryRole === 'goalkeeper').length;

    return `
      <div class="team-card ${isLeader ? 'is-leader' : ''} ${hasPassed ? 'has-passed' : ''}">
        <div class="team-meta">
          <div class="team-name-wrap">
            <span class="team-name">${t.name} ${isMe ? '(You)' : ''}</span>
            ${canKick ? `<button type="button" class="btn-kick" onclick="handleKickTeam('${t.id}')">Kick</button>` : ''}
          </div>
          <span class="team-purse">${t.purse} 🪙</span>
        </div>
        <div class="team-roster-count">
          👔 M: ${m}/1 | ⚡ F: ${fwd}/4 | 🎯 M: ${mid}/3 | 🛡️ D: ${def}/3 | 🧤 GK: ${gk}/1
        </div>
      </div>
    `;
  }).join('');
}

function logEvent(msg, type) {
  const stream = document.getElementById('log-stream');
  if (!stream) return;
  const item = document.createElement('div');
  item.className = `log-item ${type}`;
  item.innerHTML = msg;
  stream.prepend(item);
}

// --- 6. SQUAD MODAL OVERVIEW ---
function openAnalysisModal() {
  if (!currentRoom) return;
  const modal = document.getElementById('ai-modal');
  const container = document.getElementById('modal-body-content');
  modal.classList.add('active');

  container.innerHTML = currentRoom.teams.map(team => `
    <div class="ai-team-card">
      <div class="ai-team-head">
        <div>
          <h3 style="font-family: var(--font-display);">${team.name}</h3>
          <span class="hint">${team.manager ? 'Manager: ' + team.manager : 'No Manager'} • Purse: ${team.purse} Coins</span>
        </div>
        <div class="ai-score-badge">Total Squad: ${team.squad.length + (team.manager ? 1 : 0)}/12</div>
      </div>
      <div class="ai-roster-tags">
        ${team.manager ? `<span class="player-chip" style="border-color: #d8b4fe; color: #7e22ce;">👔 ${team.manager} (MGR)</span>` : ''}
        ${team.squad.length > 0 
          ? team.squad.map(p => `<span class="player-chip">${p.name} (${p.position}) - ${p.boughtFor}🪙</span>`).join('') 
          : '<span class="hint">No outfield players drafted yet.</span>'}
      </div>
    </div>
  `).join('');
}

function closeAnalysisModal() {
  document.getElementById('ai-modal').classList.remove('active');
}