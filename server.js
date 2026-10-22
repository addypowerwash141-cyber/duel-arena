const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---- Tuning (env-overridable so tests can run fast) ----
const CFG = {
  reactionMinMs: parseInt(process.env.REACTION_MIN_MS || "1400", 10),
  reactionVarMs: parseInt(process.env.REACTION_VAR_MS || "2600", 10),
  goWindowMs: parseInt(process.env.GO_WINDOW_MS || "4000", 10),
  tapRaceMs: parseInt(process.env.TAP_RACE_MS || "10000", 10),
  memoryShowMs: parseInt(process.env.MEMORY_SHOW_MS || "420", 10),
  memoryInputMs: parseInt(process.env.MEMORY_INPUT_MS || "30000", 10),
  roundPauseMs: parseInt(process.env.ROUND_PAUSE_MS || "2600", 10),
  matchPauseMs: parseInt(process.env.MATCH_PAUSE_MS || "3500", 10),
};
const ANTE = 50;
const START_COINS = 1000; // client-side balance default (localStorage)
const SEATS = 8;
const BOT_NAMES = ["BOT Volt", "BOT Nova", "BOT Rex", "BOT Ivy", "BOT Jax", "BOT Luna", "BOT Onyx", "BOT Zara"];
const GAMES = ["reaction", "taprace", "memory"]; // round 1, 2, 3 of every duel
const GAME_NAMES = { reaction: "⚡ Reaction Rush", taprace: "👆 Tap Race", memory: "🧠 Memory Sequence" };

// ---- State ----
// session: { id, name, ws, room }
// room: { code, quick, hostId, phase: lobby|tournament|finished, members:[session],
//         entrants:[{id,name,isBot,session|null,botBrain}], bracket, pot, currentGame, lastStage, dead }
// entrant.botBrain = true when the entrant is a bot OR its human disconnected (bot takeover)
const rooms = new Map();
const sessions = new Map();

function send(session, obj) {
  if (session && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(obj));
  }
}
function broadcast(room, obj) {
  for (const s of room.members) send(s, obj);
}
function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Lobby / room management ----
function lobbyState(room) {
  return {
    type: "room",
    code: room.code,
    quick: room.quick,
    phase: room.phase,
    hostId: room.hostId,
    players: room.members.map((s) => ({ id: s.id, name: s.name })),
    seats: SEATS,
  };
}
function broadcastLobby(room) {
  broadcast(room, lobbyState(room));
}
function bracketSnapshot(room) {
  if (!room.bracket) return null;
  return room.bracket.order.map((id) => {
    const m = room.bracket.matches[id];
    return {
      id,
      label: m.label,
      p1: m.p1 ? { id: m.p1.id, name: m.p1.name, isBot: m.p1.isBot } : null,
      p2: m.p2 ? { id: m.p2.id, name: m.p2.name, isBot: m.p2.isBot } : null,
      wins: { p1: m.wins.p1, p2: m.wins.p2 },
      winner: m.winner ? m.winner.id : null,
      live: room.bracket.liveMatchId === id,
    };
  });
}
function createRoom(session, quick) {
  const room = {
    code: makeCode(),
    quick: !!quick,
    hostId: session.id,
    phase: "lobby",
    members: [session],
    entrants: [],
    bracket: null,
    pot: 0,
    currentGame: null,
    lastStage: null,
    dead: false,
    quickTimer: null,
  };
  rooms.set(room.code, room);
  session.room = room;
  return room;
}
function joinRoom(session, room) {
  if (!room.members.includes(session)) room.members.push(session);
  session.room = room;
  if (room.phase !== "lobby") {
    // late joiner: spectate the running tournament
    send(session, { type: "snapshot", code: room.code, phase: room.phase, bracket: bracketSnapshot(room), pot: room.pot });
    if (room.lastStage) send(session, room.lastStage);
  } else {
    broadcastLobby(room);
    maybeQuickStart(room);
  }
}
function leaveRoom(session) {
  const room = session.room;
  if (!room) return;
  session.room = null;
  room.members = room.members.filter((s) => s !== session);
  // if they were an entrant in a running tournament, a bot takes over their seat
  for (const e of room.entrants) {
    if (e.session === session) {
      e.session = null;
      e.botBrain = true;
    }
  }
  if (room.members.length === 0) {
    room.dead = true;
    if (room.quickTimer) clearTimeout(room.quickTimer);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === session.id) room.hostId = room.members[0].id;
  if (room.phase === "lobby") broadcastLobby(room);
}
function maybeQuickStart(room) {
  if (!room.quick || room.phase !== "lobby" || room.quickTimer) return;
  const wait = room.members.length >= 2 ? 5000 : 20000;
  room.quickTimer = setTimeout(() => {
    room.quickTimer = null;
    if (room.phase === "lobby" && room.members.length >= 1 && !room.dead) startTournament(room);
  }, wait);
}

// ---- Tournament engine ----
function startTournament(room) {
  if (room.phase === "tournament") return;
  if (room.quickTimer) { clearTimeout(room.quickTimer); room.quickTimer = null; }
  room.phase = "tournament";
  const entrants = room.members.map((s) => ({ id: s.id, name: s.name, isBot: false, session: s, botBrain: false }));
  const usedNames = new Set(entrants.map((e) => e.name));
  let bi = 0;
  while (entrants.length < SEATS) {
    let name = BOT_NAMES[bi++ % BOT_NAMES.length];
    if (usedNames.has(name)) name = name + " " + bi;
    usedNames.add(name);
    entrants.push({ id: "bot-" + room.code + "-" + entrants.length, name, isBot: true, session: null, botBrain: true });
  }
  room.entrants = entrants;
  room.pot = ANTE * entrants.length;
  shuffle(entrants);

  const mk = (id, label) => ({ id, label, p1: null, p2: null, wins: { p1: 0, p2: 0 }, winner: null });
  const matches = {
    QF1: mk("QF1", "Quarter-final 1"),
    QF2: mk("QF2", "Quarter-final 2"),
    QF3: mk("QF3", "Quarter-final 3"),
    QF4: mk("QF4", "Quarter-final 4"),
    SF1: mk("SF1", "Semi-final 1"),
    SF2: mk("SF2", "Semi-final 2"),
    F: mk("F", "🏆 FINAL"),
  };
  matches.QF1.p1 = entrants[0]; matches.QF1.p2 = entrants[1];
  matches.QF2.p1 = entrants[2]; matches.QF2.p2 = entrants[3];
  matches.QF3.p1 = entrants[4]; matches.QF3.p2 = entrants[5];
  matches.QF4.p1 = entrants[6]; matches.QF4.p2 = entrants[7];
  room.bracket = { matches, order: ["QF1", "QF2", "QF3", "QF4", "SF1", "SF2", "F"], liveMatchId: null };

  broadcast(room, {
    type: "tournamentStart",
    code: room.code,
    ante: ANTE,
    pot: room.pot,
    bracket: bracketSnapshot(room),
  });
  runTournament(room).catch((err) => console.error("tournament error", err));
}

async function runTournament(room) {
  const M = room.bracket.matches;
  const feed = { QF1: ["SF1", "p1"], QF2: ["SF1", "p2"], QF3: ["SF2", "p1"], QF4: ["SF2", "p2"], SF1: ["F", "p1"], SF2: ["F", "p2"] };
  for (const id of room.bracket.order) {
    if (room.dead) return;
    const match = M[id];
    room.bracket.liveMatchId = id;
    const winner = await runMatch(room, match);
    if (room.dead) return;
    match.winner = winner;
    if (feed[id]) M[feed[id][0]][feed[id][1]] = winner;
    broadcast(room, {
      type: "matchEnd",
      matchId: id,
      label: match.label,
      winnerId: winner.id,
      winnerName: winner.name,
      score: `${match.wins.p1}-${match.wins.p2}`,
      bracket: bracketSnapshot(room),
    });
    if (id !== "F") await sleep(CFG.matchPauseMs);
  }
  room.bracket.liveMatchId = null;
  room.phase = "finished";
  const champ = M.F.winner;
  broadcast(room, {
    type: "champion",
    championId: champ.id,
    championName: champ.name,
    pot: room.pot,
    bracket: bracketSnapshot(room),
  });
}

async function runMatch(room, match) {
  for (let round = 1; round <= 3; round++) {
    if (match.wins.p1 >= 2 || match.wins.p2 >= 2) break;
    const game = GAMES[round - 1];
    const stage = {
      type: "matchStart",
      matchId: match.id,
      label: match.label,
      round,
      game,
      gameName: GAME_NAMES[game],
      p1: { id: match.p1.id, name: match.p1.name, isBot: match.p1.isBot },
      p2: { id: match.p2.id, name: match.p2.name, isBot: match.p2.isBot },
      wins: { p1: match.wins.p1, p2: match.wins.p2 },
      bracket: bracketSnapshot(room),
    };
    room.lastStage = stage;
    broadcast(room, stage);
    await sleep(1200);

    let winner;
    if (game === "reaction") winner = await playReaction(room, match);
    else if (game === "taprace") winner = await playTapRace(room, match);
    else winner = await playMemory(room, match);

    if (winner === match.p1) match.wins.p1++;
    else match.wins.p2++;
    broadcast(room, {
      type: "roundEnd",
      matchId: match.id,
      round,
      game,
      winnerId: winner.id,
      winnerName: winner.name,
      wins: { p1: match.wins.p1, p2: match.wins.p2 },
      bracket: bracketSnapshot(room),
    });
    if (match.wins.p1 < 2 && match.wins.p2 < 2) await sleep(CFG.roundPauseMs);
  }
  return match.wins.p1 > match.wins.p2 ? match.p1 : match.p2;
}

// Route a human's action into the currently running game of their room.
function routeAct(session, msg) {
  const room = session.room;
  if (!room || !room.currentGame) return;
  const entrant = room.entrants.find((e) => e.session === session);
  if (!entrant) return; // spectators can't act
  room.currentGame.handle(entrant, msg);
}

// ---- Mini-game 1: Reaction Rush ----
function playReaction(room, match) {
  return new Promise((resolve) => {
    const { p1, p2 } = match;
    let done = false;
    let phase = "lockout"; // brief lockout so stray taps from the last round don't foul
    let goAt = 0;
    const timers = [];
    const finish = (winner, info) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      room.currentGame = null;
      broadcast(room, { type: "game", game: "reaction", phase: "result", winnerId: winner.id, ...info });
      resolve(winner);
    };
    const botTap = (bot) => {
      const delay = 200 + Math.random() * 340; // bots react in 200–540ms: beatable
      timers.push(setTimeout(() => {
        if (done || phase !== "go") return;
        finish(bot, { times: { [bot.id]: Math.round(delay) }, note: `${bot.name} reacted in ${Math.round(delay)}ms` });
      }, delay));
    };
    room.currentGame = {
      handle(entrant, msg) {
        if (done || msg.act !== "tap") return;
        if (phase === "ready") {
          // tapped too soon = foul, opponent wins the round
          const other = entrant === p1 ? p2 : p1;
          broadcast(room, { type: "game", game: "reaction", phase: "foul", playerId: entrant.id });
          finish(other, { foul: entrant.id, note: `${entrant.name} jumped the gun!` });
        } else if (phase === "go") {
          const ms = Date.now() - goAt;
          finish(entrant, { times: { [entrant.id]: ms }, note: `${entrant.name} reacted in ${ms}ms` });
        }
      },
    };
    timers.push(setTimeout(() => { phase = "ready"; }, 350));
    broadcast(room, { type: "game", game: "reaction", phase: "ready" });
    const wait = CFG.reactionMinMs + Math.random() * CFG.reactionVarMs;
    timers.push(setTimeout(() => {
      if (done) return;
      phase = "go";
      goAt = Date.now();
      broadcast(room, { type: "game", game: "reaction", phase: "go" });
      if (p1.botBrain) botTap(p1);
      if (p2.botBrain) botTap(p2);
      timers.push(setTimeout(() => {
        // nobody tapped: coin flip so the duel never stalls
        finish(Math.random() < 0.5 ? p1 : p2, { note: "Too slow — coin flip decides it!" });
      }, CFG.goWindowMs));
    }, wait));
  });
}

// ---- Mini-game 2: Tap Race ----
function playTapRace(room, match) {
  return new Promise((resolve) => {
    const { p1, p2 } = match;
    const counts = { [p1.id]: 0, [p2.id]: 0 };
    const lastTap = { [p1.id]: 0, [p2.id]: 0 };
    let done = false;
    let racing = false;
    let suddenDeathTarget = null;
    const timers = [];
    const intervals = [];
    const finish = (winner, note) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      intervals.forEach(clearInterval);
      room.currentGame = null;
      broadcast(room, { type: "game", game: "taprace", phase: "result", winnerId: winner.id, counts, note });
      resolve(winner);
    };
    const addTap = (entrant) => {
      if (!racing || done) return;
      counts[entrant.id]++;
      if (suddenDeathTarget !== null && counts[entrant.id] >= suddenDeathTarget) {
        finish(entrant, "Sudden-death sprint!");
      }
    };
    room.currentGame = {
      handle(entrant, msg) {
        if (msg.act !== "tap") return;
        const now = Date.now();
        if (now - lastTap[entrant.id] < 40) return; // anti-cheat: max 25 taps/sec counted
        lastTap[entrant.id] = now;
        addTap(entrant);
      },
    };
    broadcast(room, { type: "game", game: "taprace", phase: "countdown", durationMs: CFG.tapRaceMs });
    timers.push(setTimeout(() => {
      racing = true;
      const endsAt = Date.now() + CFG.tapRaceMs;
      broadcast(room, { type: "game", game: "taprace", phase: "go", endsAt });
      for (const bot of [p1, p2]) {
        if (!bot.botBrain) continue;
        const iv = setInterval(() => {
          addTap(bot);
          // bots vary their pace a little as they go
          if (Math.random() < 0.05) { /* keep it simple */ }
        }, 95 + Math.random() * 75);
        intervals.push(iv);
      }
      const scoreIv = setInterval(() => {
        broadcast(room, { type: "game", game: "taprace", phase: "scores", counts });
      }, 200);
      intervals.push(scoreIv);
      timers.push(setTimeout(() => {
        racing = false;
        intervals.forEach(clearInterval);
        if (counts[p1.id] !== counts[p2.id]) {
          const w = counts[p1.id] > counts[p2.id] ? p1 : p2;
          finish(w, `${counts[w.id]} taps!`);
        } else {
          // tie → sudden death: first to +10 taps wins
          suddenDeathTarget = counts[p1.id] + 10;
          racing = true;
          broadcast(room, { type: "game", game: "taprace", phase: "suddenDeath", counts, target: suddenDeathTarget });
          for (const bot of [p1, p2]) {
            if (!bot.botBrain) continue;
            const iv = setInterval(() => addTap(bot), 95 + Math.random() * 75);
            intervals.push(iv);
          }
          const sdScore = setInterval(() => broadcast(room, { type: "game", game: "taprace", phase: "scores", counts }), 200);
          intervals.push(sdScore);
          timers.push(setTimeout(() => finish(Math.random() < 0.5 ? p1 : p2, "Dead heat — coin flip!"), 15000));
        }
      }, CFG.tapRaceMs));
    }, 900));
  });
}

// ---- Mini-game 3: Memory Sequence ----
function playMemory(room, match) {
  return new Promise((resolve) => {
    const { p1, p2 } = match;
    let done = false;
    const timers = [];
    const finish = (winner, note) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      room.currentGame = null;
      broadcast(room, { type: "game", game: "memory", phase: "result", winnerId: winner.id, note });
      resolve(winner);
    };
    let length = 3;
    let tieStreak = 0;

    const attempt = () => {
      if (done || room.dead) return;
      const seq = Array.from({ length }, () => Math.floor(Math.random() * 4));
      const progress = { [p1.id]: 0, [p2.id]: 0 };
      const state = { [p1.id]: "playing", [p2.id]: "playing" }; // playing|completed|failed
      const finishTime = {};
      broadcast(room, { type: "game", game: "memory", phase: "show", sequence: seq, length });
      const showMs = length * CFG.memoryShowMs + 700;

      const botAttempt = (bot) => {
        // bots get shakier as the sequence grows
        const failChance = Math.min(0.75, Math.max(0.08, (length - 2) * 0.13));
        const failAt = Math.random() < failChance ? Math.floor(Math.random() * length) : -1;
        for (let i = 0; i < length; i++) {
          timers.push(setTimeout(() => {
            if (done || state[bot.id] !== "playing") return;
            const color = failAt === i ? (seq[i] + 1 + Math.floor(Math.random() * 3)) % 4 : seq[i];
            press(bot, color);
          }, showMs + 350 + i * 330));
        }
      };
      const press = (entrant, color) => {
        if (done || state[entrant.id] !== "playing") return;
        if (color === seq[progress[entrant.id]]) {
          progress[entrant.id]++;
          broadcast(room, { type: "game", game: "memory", phase: "progress", playerId: entrant.id, ok: true, done: progress[entrant.id], length });
          if (progress[entrant.id] >= length) {
            state[entrant.id] = "completed";
            finishTime[entrant.id] = Date.now();
            checkEnd();
          }
        } else {
          state[entrant.id] = "failed";
          broadcast(room, { type: "game", game: "memory", phase: "progress", playerId: entrant.id, ok: false, done: progress[entrant.id], length });
          checkEnd();
        }
      };
      const checkEnd = () => {
        if (state[p1.id] === "playing" || state[p2.id] === "playing") return;
        timers.push(setTimeout(() => evaluate(), 500));
      };
      const evaluate = () => {
        if (done) return;
        const c1 = state[p1.id] === "completed";
        const c2 = state[p2.id] === "completed";
        if (c1 && !c2) return finish(p1, `${p1.name} nailed the sequence!`);
        if (c2 && !c1) return finish(p2, `${p2.name} nailed the sequence!`);
        if (c1 && c2) {
          if (length >= 10) {
            const w = finishTime[p1.id] <= finishTime[p2.id] ? p1 : p2;
            return finish(w, `${w.name} finished first at length ${length}!`);
          }
          length++;
          tieStreak = 0;
          broadcast(room, { type: "game", game: "memory", phase: "grow", length });
          timers.push(setTimeout(attempt, 900));
          return;
        }
        // both failed: whoever got further wins
        if (progress[p1.id] !== progress[p2.id]) {
          const w = progress[p1.id] > progress[p2.id] ? p1 : p2;
          return finish(w, `${w.name} remembered more (${progress[w.id]}/${length})`);
        }
        tieStreak++;
        if (tieStreak >= 3) return finish(Math.random() < 0.5 ? p1 : p2, "Dead even — coin flip!");
        broadcast(room, { type: "game", game: "memory", phase: "retry", length });
        timers.push(setTimeout(attempt, 900));
      };

      room.currentGame = {
        handle(entrant, msg) {
          if (msg.act !== "press") return;
          // only accept presses after the sequence has been shown
          if (Date.now() < inputOpensAt) return;
          press(entrant, msg.color | 0);
        },
      };
      const inputOpensAt = Date.now() + showMs;
      timers.push(setTimeout(() => {
        if (done) return;
        broadcast(room, { type: "game", game: "memory", phase: "input", length });
        if (p1.botBrain) botAttempt(p1);
        if (p2.botBrain) botAttempt(p2);
      }, showMs));
      // safety: if a human goes AFK forever, judge on progress after the input window
      timers.push(setTimeout(() => {
        if (done) return;
        for (const p of [p1, p2]) if (state[p.id] === "playing") state[p.id] = "failed";
        evaluate();
      }, showMs + CFG.memoryInputMs));
    };
    attempt();
  });
}

// ---- Connection handling ----
wss.on("connection", (ws) => {
  const id = Math.random().toString(36).slice(2, 9);
  const session = { id, name: "Player", ws, room: null };
  sessions.set(ws, session);
  ws.send(JSON.stringify({ type: "welcome", id, startCoins: START_COINS, ante: ANTE }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = sessions.get(ws);
    if (!s) return;

    if (msg.type === "create") {
      leaveRoom(s);
      s.name = cleanName(msg.name);
      const room = createRoom(s, false);
      send(s, { type: "created", code: room.code });
      broadcastLobby(room);
    } else if (msg.type === "quick") {
      leaveRoom(s);
      s.name = cleanName(msg.name);
      let room = [...rooms.values()].find((r) => r.quick && r.phase === "lobby" && r.members.length < SEATS);
      if (!room) room = createRoom(s, true);
      else joinRoom(s, room);
      if (room.members[0] === s && room.phase === "lobby") maybeQuickStart(room);
      if (s.room === room && room.phase === "lobby") broadcastLobby(room);
    } else if (msg.type === "join") {
      const room = rooms.get(String(msg.code || "").toUpperCase().trim());
      if (!room) { send(s, { type: "error", message: "Room not found. Check the code." }); return; }
      leaveRoom(s);
      s.name = cleanName(msg.name);
      joinRoom(s, room);
    } else if (msg.type === "start") {
      const room = s.room;
      if (room && room.phase === "lobby" && room.hostId === s.id) startTournament(room);
    } else if (msg.type === "act") {
      routeAct(s, msg);
    } else if (msg.type === "rematch") {
      const room = s.room;
      if (room && room.phase === "finished") {
        room.phase = "lobby";
        room.entrants = [];
        room.bracket = null;
        room.currentGame = null;
        room.lastStage = null;
        broadcastLobby(room);
        maybeQuickStart(room);
      }
    }
  });

  ws.on("close", () => {
    const s = sessions.get(ws);
    if (s) leaveRoom(s);
    sessions.delete(ws);
  });
});

function cleanName(n) {
  return String(n || "Player").slice(0, 16).trim() || "Player";
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Duel Arena live on port ${PORT}`));
