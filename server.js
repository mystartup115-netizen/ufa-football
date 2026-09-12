const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// Serve landing page by default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve auction room page directly
app.get('/auction', (req, res) => {
  res.sendFile(path.join(__dirname, 'auction.html'));
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Load JSON databases
let rawManagers = [];
let rawPlayers = [];
try {
  rawManagers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'managers.json'), 'utf-8'));
  rawPlayers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'players.json'), 'utf-8'));
} catch (e) {
  console.error("Error reading JSON files:", e);
}

// Active room state
const rooms = {};

// Slabs: <50 (+2), 50-100 (+5), >100 (+10)
function getSlabIncrement(price) {
  if (price < 50) return 2;
  if (price <= 100) return 5;
  return 10;
}

// Fisher-Yates pure randomizer
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Normalize roles across forwards, midfielders, defenders, gks
function normalizePlayer(p) {
  const pos = (p.position || '').toUpperCase();
  const pri = (p.primary || '').toUpperCase();
  let role = 'forward';

  if (p.category === 'manager') {
    role = 'manager';
  } else if (pos === 'GK' || pri === 'GK') {
    role = 'goalkeeper';
  } else if (['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(pos) || pri === 'DEF') {
    role = 'defender';
  } else if (['CM', 'CDM', 'CAM', 'LM', 'RM'].includes(pos) || pri === 'MID') {
    role = 'midfielder';
  } else {
    role = 'forward';
  }

  return { ...p, primaryRole: role };
}

// Sanitizer for socket emits
function sanitizeRoom(room) {
  const { timerInterval, interstitialInterval, ...clean } = room;
  return clean;
}

process.on('uncaughtException', (err) => {
  console.error('Server exception caught:', err);
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // 1. CREATE ROOM
  socket.on('create_room', ({ roomCode, password, adminTeamName, maxTeams, startingBudget, categoryFilter }) => {
    try {
      const CODE_REGEX = /^[a-zA-Z0-9]{12}$/;
      const PASS_REGEX = /^[a-zA-Z0-9]{8}$/;

      if (!CODE_REGEX.test(roomCode)) return socket.emit('error_msg', 'Room Code must be 12 alphanumeric characters.');
      if (!PASS_REGEX.test(password)) return socket.emit('error_msg', 'Password must be 8 alphanumeric characters.');
      if (rooms[roomCode]) return socket.emit('error_msg', 'Room already exists with this code.');

      const initialBudget = startingBudget || 500;
      const roomCapacity = [4, 5, 6].includes(maxTeams) ? maxTeams : 4;

      rooms[roomCode] = {
        code: roomCode,
        password: password,
        adminSocketId: socket.id,
        budget: initialBudget,
        maxTeams: roomCapacity,
        categoryFilter: categoryFilter || 'mixed',
        teams: [
          { id: socket.id, name: adminTeamName || 'Host FC', purse: initialBudget, manager: null, squad: [], isHost: true }
        ],
        pool: [],
        currentIndex: 0,
        currentBid: 0,
        highestBidder: null,
        passedTeamIds: [],
        timer: 12,
        timerInterval: null,
        interstitialTimer: 3,
        interstitialInterval: null,
        isPaused: false,
        status: 'LOBBY'
      };

      socket.join(roomCode);
      socket.emit('room_joined', { room: sanitizeRoom(rooms[roomCode]), myTeamId: socket.id });
      console.log(`Room [${roomCode}] created by Host ${socket.id}`);
    } catch (err) {
      console.error(err);
    }
  });

  // 2. JOIN ROOM
  socket.on('join_room', ({ roomCode, password, teamName }) => {
    try {
      const room = rooms[roomCode];
      if (!room) return socket.emit('error_msg', 'Room not found.');
      if (room.password !== password) return socket.emit('error_msg', 'Invalid password.');
      if (room.teams.length >= room.maxTeams) return socket.emit('error_msg', `Room full (Max ${room.maxTeams} Clubs).`);
      if (room.status !== 'LOBBY') return socket.emit('error_msg', 'Auction is already live.');

      const newTeam = {
        id: socket.id,
        name: teamName || `Club ${room.teams.length + 1}`,
        purse: room.budget,
        manager: null,
        squad: [],
        isHost: false
      };

      room.teams.push(newTeam);
      socket.join(roomCode);

      socket.emit('room_joined', { room: sanitizeRoom(room), myTeamId: socket.id });
      io.to(roomCode).emit('room_state_updated', sanitizeRoom(room));
    } catch (err) {
      console.error(err);
    }
  });

  // 3. START AUCTION (With mathematical pool sizing & sequential position ordering)
  socket.on('start_auction', ({ roomCode }) => {
    try {
      const room = rooms[roomCode];
      if (!room || room.adminSocketId !== socket.id) return;

      const n = room.teams.length; // Number of clubs

      // Sizing requirements
      const targetMgrCount = n + 2;       // 1n + 2
      const targetMidCount = (3 * n) + 5; // 3n + 5
      const targetFwdCount = (4 * n) + 5; // 4n + 5
      const targetGkCount  = n + 2;       // 1n + 2
      const targetDefCount = (3 * n) + 3; // 3n + 3

      // Normalize lists
      const normManagers = rawManagers.map(m => ({ ...m, primaryRole: 'manager' }));
      const normPlayers = rawPlayers.map(p => normalizePlayer(p));

      // Category filter application
      let candidatePlayers = normPlayers;
      if (room.categoryFilter && room.categoryFilter !== 'mixed') {
        candidatePlayers = normPlayers.filter(p => p.category.toLowerCase().trim() === room.categoryFilter.toLowerCase().trim());
      }

      // Role bins
      const mgrList = shuffleArray(normManagers).slice(0, targetMgrCount);
      const midList = shuffleArray(candidatePlayers.filter(p => p.primaryRole === 'midfielder')).slice(0, targetMidCount);
      const fwdList = shuffleArray(candidatePlayers.filter(p => p.primaryRole === 'forward')).slice(0, targetFwdCount);
      const gkList  = shuffleArray(candidatePlayers.filter(p => p.primaryRole === 'goalkeeper')).slice(0, targetGkCount);
      const defList = shuffleArray(candidatePlayers.filter(p => p.primaryRole === 'defender')).slice(0, targetDefCount);

      // Flow: MANAGER -> MIDFIELDER -> FORWARD -> GK -> DEFENDER
      room.pool = [...mgrList, ...midList, ...fwdList, ...gkList, ...defList];

      if (room.pool.length === 0) {
        return socket.emit('error_msg', 'Player pool is empty. Please verify your JSON files.');
      }

      room.status = 'LIVE';
      room.currentIndex = 0;
      room.currentBid = room.pool[0].baseprice;
      room.highestBidder = null;
      room.passedTeamIds = [];

      io.to(roomCode).emit('room_state_updated', sanitizeRoom(room));
      startBiddingClock(roomCode);
      console.log(`Auction started in [${roomCode}] with ${room.pool.length} lots for ${n} clubs.`);
    } catch (err) {
      console.error(err);
    }
  });

  // 4. RAISE BID (With strict role limits)
  socket.on('raise_bid', ({ roomCode }) => {
    try {
      const room = rooms[roomCode];
      if (!room || room.status !== 'LIVE' || room.isPaused) return;

      const team = room.teams.find(t => t.id === socket.id);
      if (!team) return;

      const currentItem = room.pool[room.currentIndex];
      if (!currentItem) return;

      // ROLE QUOTA ENFORCEMENT:
      // Max: 1 Manager, 3 Mid, 4 Fwd, 1 GK, 3 Def
      if (currentItem.primaryRole === 'manager' && team.manager) {
        return socket.emit('error_msg', 'Club limit reached: You can only draft 1 Manager!');
      }

      const fwdCount = team.squad.filter(p => p.primaryRole === 'forward').length;
      if (currentItem.primaryRole === 'forward' && fwdCount >= 4) {
        return socket.emit('error_msg', 'Club limit reached: You cannot buy more than 4 Forwards!');
      }

      const midCount = team.squad.filter(p => p.primaryRole === 'midfielder').length;
      if (currentItem.primaryRole === 'midfielder' && midCount >= 3) {
        return socket.emit('error_msg', 'Club limit reached: You cannot buy more than 3 Midfielders!');
      }

      const defCount = team.squad.filter(p => p.primaryRole === 'defender').length;
      if (currentItem.primaryRole === 'defender' && defCount >= 3) {
        return socket.emit('error_msg', 'Club limit reached: You cannot buy more than 3 Defenders!');
      }

      const gkCount = team.squad.filter(p => p.primaryRole === 'goalkeeper').length;
      if (currentItem.primaryRole === 'goalkeeper' && gkCount >= 1) {
        return socket.emit('error_msg', 'Club limit reached: You cannot buy more than 1 Goalkeeper!');
      }

      const slab = getSlabIncrement(room.currentBid);
      const nextBid = !room.highestBidder ? currentItem.baseprice : room.currentBid + slab;

      if (room.highestBidder && room.highestBidder.id === team.id) {
        return socket.emit('error_msg', 'You already hold the highest bid!');
      }
      if (team.purse < nextBid) {
        return socket.emit('error_msg', 'Insufficient coins for this bid!');
      }

      room.currentBid = nextBid;
      room.highestBidder = team;
      room.passedTeamIds = [];

      // Reset bidding clock back to 12s on fresh bid
      startBiddingClock(roomCode);

      io.to(roomCode).emit('bid_placed', { 
        room: sanitizeRoom(room), 
        log: `⚡ <strong>${team.name}</strong> bids <strong>${room.currentBid} Coins</strong>!` 
      });
    } catch (err) {
      console.error(err);
    }
  });

  // 5. PASS BID
  socket.on('pass_bid', ({ roomCode }) => {
    try {
      const room = rooms[roomCode];
      if (!room || room.status !== 'LIVE' || room.isPaused) return;

      const team = room.teams.find(t => t.id === socket.id);
      if (!team || room.passedTeamIds.includes(team.id)) return;

      if (room.highestBidder && room.highestBidder.id === team.id) {
        return socket.emit('error_msg', 'The highest bidder cannot pass!');
      }

      room.passedTeamIds.push(team.id);

      const nonLeaders = room.highestBidder ? room.teams.length - 1 : room.teams.length;
      if (room.passedTeamIds.length >= nonLeaders) {
        concludeLot(roomCode);
      } else {
        io.to(roomCode).emit('bid_placed', { 
          room: sanitizeRoom(room), 
          log: `🏳️ <strong>${team.name}</strong> passed.` 
        });
      }
    } catch (err) {
      console.error(err);
    }
  });

  // 6. HOST CONTROLS: PAUSE / RESUME
  socket.on('host_toggle_pause', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.adminSocketId !== socket.id) return;

    room.isPaused = !room.isPaused;
    io.to(roomCode).emit('pause_state_changed', { isPaused: room.isPaused });
  });

  // 7. HOST CONTROLS: KICK PLAYER
  socket.on('host_kick_player', ({ roomCode, targetTeamId }) => {
    const room = rooms[roomCode];
    if (!room || room.adminSocketId !== socket.id) return;
    if (targetTeamId === room.adminSocketId) return;

    const idx = room.teams.findIndex(t => t.id === targetTeamId);
    if (idx !== -1) {
      const kicked = room.teams.splice(idx, 1)[0];
      io.to(targetTeamId).emit('you_were_kicked');
      io.to(roomCode).emit('room_state_updated', sanitizeRoom(room));
      io.to(roomCode).emit('bid_placed', {
        room: sanitizeRoom(room),
        log: `👢 Host removed <strong>${kicked.name}</strong> from the auction.`
      });
    }
  });

  // 8. HOST CONTROLS: CLOSE ROOM
  socket.on('host_close_room', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.adminSocketId !== socket.id) return;

    clearInterval(room.timerInterval);
    clearInterval(room.interstitialInterval);
    io.to(roomCode).emit('room_closed');
    delete rooms[roomCode];
  });

  // 9. DISCONNECT
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.teams.findIndex(t => t.id === socket.id);
      if (idx !== -1) {
        if (room.status === 'LOBBY') {
          room.teams.splice(idx, 1);
          if (room.teams.length === 0) {
            clearInterval(room.timerInterval);
            clearInterval(room.interstitialInterval);
            delete rooms[code];
          } else {
            io.to(code).emit('room_state_updated', sanitizeRoom(room));
          }
        }
        break;
      }
    }
  });
});

// --- 12-SECOND BIDDING CLOCK ---
function startBiddingClock(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  clearInterval(room.timerInterval);
  room.timer = 12; // EXACTLY 12s
  io.to(roomCode).emit('timer_tick', room.timer);

  room.timerInterval = setInterval(() => {
    if (room.isPaused) return;

    room.timer--;
    io.to(roomCode).emit('timer_tick', room.timer);

    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      concludeLot(roomCode);
    }
  }, 1000);
}

// --- CONCLUDE LOT & TRIGGER 3-2-1 BOOM INTERVAL ---
function concludeLot(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  clearInterval(room.timerInterval);
  const item = room.pool[room.currentIndex];
  let logMsg = '';

  if (room.highestBidder) {
    const winner = room.teams.find(t => t.id === room.highestBidder.id);
    if (winner) {
      winner.purse -= room.currentBid;
      if (item.primaryRole === 'manager') {
        winner.manager = item.name;
        logMsg = `👔 <strong>APPOINTED:</strong> ${item.name} appointed to ${winner.name} for ${room.currentBid} Coins!`;
      } else {
        winner.squad.push({ ...item, boughtFor: room.currentBid });
        logMsg = `🔨 <strong>SOLD:</strong> ${item.name} transferred to ${winner.name} for ${room.currentBid} Coins!`;
      }
    }
  } else {
    logMsg = `❌ <strong>UNSOLD:</strong> Hammer fell with no bids for ${item.name}.`;
  }

  room.currentIndex++;

  // Complete auction check
  if (room.currentIndex >= room.pool.length) {
    room.status = 'FINISHED';
    io.to(roomCode).emit('auction_finished', { room: sanitizeRoom(room), log: logMsg });
    return;
  }

  // Next lot staging
  room.currentBid = room.pool[room.currentIndex].baseprice;
  room.highestBidder = null;
  room.passedTeamIds = [];

  io.to(roomCode).emit('lot_concluded', { room: sanitizeRoom(room), log: logMsg });

  // START 3-2-1 BOOM SUSPENSE TRANSITION
  startInterstitialInterval(roomCode);
}

// --- 3-SECOND INTERSTITIAL REVEAL ENGINE ---
function startInterstitialInterval(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  clearInterval(room.interstitialInterval);
  room.interstitialTimer = 3;

  io.to(roomCode).emit('interstitial_tick', room.interstitialTimer);

  room.interstitialInterval = setInterval(() => {
    if (room.isPaused) return;

    room.interstitialTimer--;
    io.to(roomCode).emit('interstitial_tick', room.interstitialTimer);

    if (room.interstitialTimer <= 0) {
      clearInterval(room.interstitialInterval);
      // Reveal new player and kick off the 12s clock
      io.to(roomCode).emit('room_state_updated', sanitizeRoom(room));
      startBiddingClock(roomCode);
    }
  }, 1000);
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`UFA Engine running on port ${PORT}`);
});