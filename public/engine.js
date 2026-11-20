(function (global) {
  'use strict';

  const BOARD_SIZE = 7;
  const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const DIRS = [
    { dr: -1, dc: 0, name: '上', key: 'top' },
    { dr: 1, dc: 0, name: '下', key: 'bottom' },
    { dr: 0, dc: -1, name: '左', key: 'left' },
    { dr: 0, dc: 1, name: '右', key: 'right' }
  ];

  function create2D(rows, cols, fillVal) {
    return Array.from({ length: rows }, () => Array(cols).fill(fillVal));
  }

  function coordLabel(r, c) {
    return `${COLS[c]}${r + 1}`;
  }

  class WallGoEngine {
    constructor(config = {}) {
      this.reset(config);
    }

    reset(config = {}) {
      this.ruleVariant = config.ruleVariant === 'classic' ? 'classic' : 'v2';
      this.numPlayers = config.numPlayers === 3 ? 3 : 2;
      this.gameMode = config.gameMode === 'online'
        ? 'online'
        : (config.gameMode === 'local' ? 'local' : 'ai');
      this.aiLevel = config.aiLevel || 'medium';
      this.aiSkill = Number.isFinite(config.aiSkill) ? config.aiSkill : null;
      this.aiRank = Number.isInteger(config.aiRank) ? config.aiRank : null;
      this.openingStyle = config.openingStyle || 'classic';
      this.timerEnabled = Boolean(config.timerEnabled);
      this._simMode = false;

      const names = ['玩家 1', '玩家 2', '玩家 3'];
      const shorts = ['P1', 'P2', 'P3'];
      const onlineSeats = Array.isArray(config.onlineSeats) ? config.onlineSeats : null;

      this.players = Array.from({ length: this.numPlayers }, (_, i) => {
        const seatInfo = onlineSeats && onlineSeats[i] ? onlineSeats[i] : null;
        const rawNick = seatInfo && seatInfo.nickname ? String(seatInfo.nickname) : '';
        const nickname = rawNick.replace(/[<>&"']/g, '').trim().slice(0, 14);
        return {
          id: i,
          name: nickname || names[i],
          colorName: names[i],
          short: shorts[i],
          isAI: this.gameMode === 'online'
            ? Boolean(seatInfo && seatInfo.isAI)
            : (this.gameMode === 'ai' && i > 0),
          hammers: this.numPlayers === 3 ? 1 : 0,
          hammerDeclined: false
        };
      });

      // Internal walls:
      // hWalls[r][c] (r: 0..5, c: 0..6) lies between (r,c) and (r+1,c)
      // vWalls[r][c] (r: 0..6, c: 0..5) lies between (r,c) and (r,c+1)
      this.hWalls = create2D(BOARD_SIZE - 1, BOARD_SIZE, false);
      this.vWalls = create2D(BOARD_SIZE, BOARD_SIZE - 1, false);
      this.hWallOwner = create2D(BOARD_SIZE - 1, BOARD_SIZE, -1);
      this.vWallOwner = create2D(BOARD_SIZE, BOARD_SIZE - 1, -1);

      this.pieces = []; // { id, player, r, c, shape: 'square' | 'circle' | 'classic' }
      this.nextPieceId = 1;

      this.turnNumber = 1;
      this.firstPlayer = (Number.isInteger(config.firstPlayer) && config.firstPlayer >= 0 && config.firstPlayer < this.numPlayers)
        ? config.firstPlayer
        : Math.floor(Math.random() * this.numPlayers);
      this.currentPlayer = this.firstPlayer;
      this.phase = 'placement'; // 'placement' | 'play' | 'gameover'
      this.hammerOnlyEndgame = false;

      this.lastMoveFrom = null;
      this.lastBuiltWall = null;
      this.logs = [];
      this.actionHistory = [];
      this.initialConfig = {
        ruleVariant: this.ruleVariant,
        numPlayers: this.numPlayers,
        gameMode: this.gameMode,
        aiLevel: this.aiLevel,
        openingStyle: this.openingStyle,
        firstPlayer: this.firstPlayer,
        timerEnabled: false,
        onlineSeats: this.players.map(p => ({
          nickname: p.name.includes('·') ? p.name.split('·').slice(1).join('·') : '',
          isAI: p.isAI
        }))
      };
      this.result = null;

      const isV2 = this.ruleVariant === 'v2';
      const rot = (idx) => (this.firstPlayer + idx) % this.numPlayers;

      // Setup placement queue ({ player, shape }) & pre-placed pieces (snake draft starting from random firstPlayer!)
      if (this.numPlayers === 2) {
        if (this.openingStyle === 'classic') {
          this._addPiece(0, 1, 1, isV2 ? 'square' : 'classic');
          this._addPiece(0, 5, 5, isV2 ? 'circle' : 'classic');
          this._addPiece(1, 1, 5, isV2 ? 'square' : 'classic');
          this._addPiece(1, 5, 1, isV2 ? 'circle' : 'classic');
          this.placementQueue = isV2
            ? [
                { player: rot(0), shape: 'square' },
                { player: rot(1), shape: 'square' },
                { player: rot(1), shape: 'circle' },
                { player: rot(0), shape: 'circle' }
              ]
            : [
                { player: rot(0), shape: 'classic' },
                { player: rot(1), shape: 'classic' },
                { player: rot(1), shape: 'classic' },
                { player: rot(0), shape: 'classic' }
              ];
          this.addLog(
            -1,
            isV2
              ? '牆壁圍棋 Ⅱ 標準開局：雙方預置 1 方 1 圓，請依序放置剩餘的 ■ 方形棋與 ● 圓形棋。'
              : '牆壁圍棋 Ⅰ 標準開局：雙方各有 2 顆預置棋，請依序放置剩餘 2 顆棋子。'
          );
        } else {
          this.placementQueue = isV2
            ? [
                { player: rot(0), shape: 'square' },
                { player: rot(1), shape: 'square' },
                { player: rot(1), shape: 'circle' },
                { player: rot(0), shape: 'circle' },
                { player: rot(0), shape: 'square' },
                { player: rot(1), shape: 'square' },
                { player: rot(1), shape: 'circle' },
                { player: rot(0), shape: 'circle' }
              ]
            : [rot(0), rot(1), rot(1), rot(0), rot(0), rot(1), rot(1), rot(0)].map(player => ({ player, shape: 'classic' }));
          this.addLog(
            -1,
            isV2
              ? '牆壁圍棋 Ⅱ 自由落子開局：雙方各放 2 顆 ■ 方形棋與 2 顆 ● 圓形棋。'
              : '全自由落子開局：請依序放置各 4 顆棋子。'
          );
        }
      } else {
        this.placementQueue = isV2
          ? [
              { player: rot(0), shape: 'square' },
              { player: rot(1), shape: 'square' },
              { player: rot(2), shape: 'square' },
              { player: rot(2), shape: 'circle' },
              { player: rot(1), shape: 'circle' },
              { player: rot(0), shape: 'circle' }
            ]
          : [rot(0), rot(1), rot(2), rot(2), rot(1), rot(0)].map(player => ({ player, shape: 'classic' }));
        this.addLog(
          -1,
          isV2
            ? '牆壁圍棋 Ⅱ 三人牢獄戰！每人擁有 1 顆 ■ 方形棋、1 顆 ● 圓形棋與 1 次破牆鐵鎚 🔨。'
            : '三人牢獄戰開始！每人各有 2 顆棋與 1 次破牆鐵鎚 🔨。'
        );
      }

      this.currentPlayer = this.placementQueue[0].player;
      this.addLog(-1, `🎲 隨機決定先手：由 <strong>${this.players[this.firstPlayer].name}</strong> 優先行動！`);
    }

    clone() {
      const copy = Object.create(WallGoEngine.prototype);
      copy.loadSnapshot(this.serialize());
      return copy;
    }

    // Ultra-fast lightweight clone for AI Alpha-Beta tree search (no JSON.parse, no logs/history copy)
    fastClone() {
      const copy = Object.create(WallGoEngine.prototype);
      copy._simMode = true;
      copy.ruleVariant = this.ruleVariant;
      copy.numPlayers = this.numPlayers;
      copy.gameMode = this.gameMode;
      copy.aiLevel = this.aiLevel;
      copy.aiSkill = this.aiSkill;
      copy.aiRank = this.aiRank;
      copy.openingStyle = this.openingStyle;
      copy.timerEnabled = false;
      copy.players = this.players.map(p => ({
        id: p.id, name: p.name, colorName: p.colorName, short: p.short,
        isAI: p.isAI, hammers: p.hammers, hammerDeclined: p.hammerDeclined
      }));
      copy.hWalls = this.hWalls.map(row => row.slice());
      copy.vWalls = this.vWalls.map(row => row.slice());
      copy.hWallOwner = this.hWallOwner.map(row => row.slice());
      copy.vWallOwner = this.vWallOwner.map(row => row.slice());
      copy.pieces = this.pieces.map(pc => ({
        id: pc.id, player: pc.player, r: pc.r, c: pc.c, shape: pc.shape
      }));
      copy.nextPieceId = this.nextPieceId;
      copy.turnNumber = this.turnNumber;
      copy.firstPlayer = this.firstPlayer;
      copy.currentPlayer = this.currentPlayer;
      copy.phase = this.phase;
      copy.hammerOnlyEndgame = this.hammerOnlyEndgame;
      copy.placementQueue = this.placementQueue.length ? this.placementQueue.slice() : [];
      copy.lastMoveFrom = null;
      copy.lastBuiltWall = null;
      copy.logs = [];
      copy.actionHistory = [];
      copy.initialConfig = null;
      copy.result = null;
      return copy;
    }

    serialize() {
      return {
        ruleVariant: this.ruleVariant,
        numPlayers: this.numPlayers,
        gameMode: this.gameMode,
        aiLevel: this.aiLevel,
        openingStyle: this.openingStyle,
        timerEnabled: this.timerEnabled,
        players: this.players.map(p => ({ ...p })),
        hWalls: this.hWalls.map(row => row.slice()),
        vWalls: this.vWalls.map(row => row.slice()),
        hWallOwner: this.hWallOwner.map(row => row.slice()),
        vWallOwner: this.vWallOwner.map(row => row.slice()),
        pieces: this.pieces.map(pc => ({ ...pc })),
        nextPieceId: this.nextPieceId,
        turnNumber: this.turnNumber,
        firstPlayer: this.firstPlayer,
        currentPlayer: this.currentPlayer,
        phase: this.phase,
        hammerOnlyEndgame: this.hammerOnlyEndgame,
        placementQueue: this.placementQueue.map(item => ({ ...item })),
        lastMoveFrom: this.lastMoveFrom ? { ...this.lastMoveFrom } : null,
        lastBuiltWall: this.lastBuiltWall ? { ...this.lastBuiltWall } : null,
        logs: this.logs.map(l => ({ ...l })),
        actionHistory: this.actionHistory.map(a => JSON.parse(JSON.stringify(a))),
        initialConfig: this.initialConfig ? JSON.parse(JSON.stringify(this.initialConfig)) : null,
        result: this.result ? JSON.parse(JSON.stringify(this.result)) : null
      };
    }

    loadSnapshot(data) {
      this.ruleVariant = data.ruleVariant;
      this.numPlayers = data.numPlayers;
      this.gameMode = data.gameMode;
      this.aiLevel = data.aiLevel;
      this.openingStyle = data.openingStyle;
      this.timerEnabled = Boolean(data.timerEnabled);
      this.players = data.players.map(p => ({ ...p }));
      this.hWalls = data.hWalls.map(row => row.slice());
      this.vWalls = data.vWalls.map(row => row.slice());
      this.hWallOwner = data.hWallOwner.map(row => row.slice());
      this.vWallOwner = data.vWallOwner.map(row => row.slice());
      this.pieces = data.pieces.map(pc => ({ ...pc }));
      this.nextPieceId = data.nextPieceId;
      this.turnNumber = data.turnNumber;
      this.firstPlayer = Number.isInteger(data.firstPlayer) ? data.firstPlayer : 0;
      this.currentPlayer = data.currentPlayer;
      this.phase = data.phase;
      this.hammerOnlyEndgame = data.hammerOnlyEndgame;
      this.placementQueue = data.placementQueue.map(item => ({ ...item }));
      this.lastMoveFrom = data.lastMoveFrom ? { ...data.lastMoveFrom } : null;
      this.lastBuiltWall = data.lastBuiltWall ? { ...data.lastBuiltWall } : null;
      this.logs = data.logs.map(l => ({ ...l }));
      this.actionHistory = Array.isArray(data.actionHistory) ? data.actionHistory.map(a => JSON.parse(JSON.stringify(a))) : [];
      this.initialConfig = data.initialConfig ? JSON.parse(JSON.stringify(data.initialConfig)) : null;
      this.result = data.result ? JSON.parse(JSON.stringify(data.result)) : null;
    }

    applyRecordedStep(step) {
      if (!step) return false;
      if (step.kind === 'place') return this.placeInitialPiece(step.r, step.c);
      if (step.kind === 'move') return this.applyAction(step.pieceId, step.toR, step.toC, step.wall);
      if (step.kind === 'hammer') return this.useHammer(step.wallType, step.r, step.c);
      if (step.kind === 'declineHammer') return this.declineEndgameHammer();
      return false;
    }

    getCurrentPlacement() {
      return this.phase === 'placement' && this.placementQueue.length > 0
        ? this.placementQueue[0]
        : null;
    }

    addLog(player, text) {
      if (this._simMode) return;
      this.logs.unshift({ player, text, turn: this.turnNumber });
      if (this.logs.length > 120) this.logs.pop();
    }

    _addPiece(player, r, c, shape = 'classic') {
      const piece = { id: this.nextPieceId++, player, r, c, shape };
      this.pieces.push(piece);
      return piece;
    }

    getPieceAt(r, c) {
      return this.pieces.find(p => p.r === r && p.c === c) || null;
    }

    getPieceById(id) {
      return this.pieces.find(p => p.id === id) || null;
    }

    getPlayerPieces(playerId) {
      return this.pieces.filter(p => p.player === playerId);
    }

    isInside(r, c) {
      return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
    }

    hasWallBetween(r1, c1, r2, c2) {
      if (!this.isInside(r1, c1) || !this.isInside(r2, c2)) return true;
      if (r2 === r1 - 1 && c2 === c1) return this.hWalls[r1 - 1][c1];
      if (r2 === r1 + 1 && c2 === c1) return this.hWalls[r1][c1];
      if (c2 === c1 - 1 && r2 === r1) return this.vWalls[r1][c1 - 1];
      if (c2 === c1 + 1 && r2 === r1) return this.vWalls[r1][c1];
      return true;
    }

    // Returns open internal wall slots around cell (r, c)
    getOpenEdges(r, c) {
      const edges = [];
      if (r > 0 && !this.hWalls[r - 1][c]) {
        edges.push({ type: 'h', r: r - 1, c, dir: 'top', label: '上' });
      }
      if (r < BOARD_SIZE - 1 && !this.hWalls[r][c]) {
        edges.push({ type: 'h', r, c, dir: 'bottom', label: '下' });
      }
      if (c > 0 && !this.vWalls[r][c - 1]) {
        edges.push({ type: 'v', r, c: c - 1, dir: 'left', label: '左' });
      }
      if (c < BOARD_SIZE - 1 && !this.vWalls[r][c]) {
        edges.push({ type: 'v', r, c, dir: 'right', label: '右' });
      }
      return edges;
    }

    // Placement Phase Action
    placeInitialPiece(r, c) {
      if (this.phase !== 'placement') return false;
      if (!this.isInside(r, c) || this.getPieceAt(r, c)) return false;

      const currentSlot = this.placementQueue[0];
      if (!currentSlot) return false;
      const { player, shape } = currentSlot;

      this._addPiece(player, r, c, shape);
      const shapeTag = shape === 'square' ? ' ■方形棋' : shape === 'circle' ? ' ●圓形棋' : '';
      this.addLog(player, `<strong>${this.players[player].name}</strong> 放置${shapeTag}於 ${coordLabel(r, c)}`);
      this.actionHistory.push({
        kind: 'place',
        player,
        r,
        c,
        desc: `${this.players[player].name} 佈子${shapeTag}於 ${coordLabel(r, c)}`
      });
      this.placementQueue.shift();

      if (this.placementQueue.length === 0) {
        this.phase = 'play';
        this.currentPlayer = Number.isInteger(this.firstPlayer) ? this.firstPlayer : 0;
        this.turnNumber = 1;
        this.addLog(-1, `開局佈子完成！由 <strong>${this.players[this.currentPlayer].name}</strong> 率先展開領地爭奪戰。`);

        // Edge-case safeguard: if any player already has zero legal moves immediately after placement, end the game.
        const immobileAtStart = [];
        for (let p = 0; p < this.numPlayers; p++) {
          if (!this.hasAnyLegalMove(p) && this.getBreakableWalls(p, false).length === 0) {
            immobileAtStart.push(this.players[p]);
          }
        }
        if (immobileAtStart.length > 0) {
          const names = immobileAtStart.map(pl => pl.name).join('、');
          this.addLog(-1, `${names} 所有棋子均無法移動，依規則遊戲立即結束並結算領地！`);
          this._finishGame(this.analyzeTerritories(), {
            endReason: 'immobile',
            immobilePlayers: immobileAtStart.map(pl => ({ player: pl.id, name: pl.name }))
          });
        }
      } else {
        this.currentPlayer = this.placementQueue[0].player;
      }
      return true;
    }

    // Valid move destinations for a specific piece (MUST move at least 1 step; staying put is forbidden):
    // - 'classic': 1..2 orthogonal steps (straight or turn)
    // - 'square' (■ 方形棋): 1 or 2 steps in a STRAIGHT line (no turning)
    // - 'circle' (● 圓形棋): 1 step, or 1 step + 90° turn 1 step (L-shape, no straight 2 steps)
    // All valid destinations must have >= 1 open internal edge to build a wall.
    getValidDestinations(pieceId) {
      const piece = this.getPieceById(pieceId);
      if (!piece) return [];

      const destMap = new Map();
      const register = (r, c, dist, path) => {
        const key = `${r},${c}`;
        if (!destMap.has(key) || dist < destMap.get(key).dist) {
          destMap.set(key, { r, c, dist, path });
        }
      };

      // Distance 1 & Distance 2 (must leave origin square)
      for (const d1 of DIRS) {
        const r1 = piece.r + d1.dr;
        const c1 = piece.c + d1.dc;
        if (!this.isInside(r1, c1)) continue;
        if (this.hasWallBetween(piece.r, piece.c, r1, c1)) continue;
        if (this.getPieceAt(r1, c1)) continue;

        register(r1, c1, 1, [{ r: piece.r, c: piece.c }, { r: r1, c: c1 }]);

        // Step 2 based on piece shape
        for (const d2 of DIRS) {
          // Never step straight back to origin
          if (d2.dr === -d1.dr && d2.dc === -d1.dc) continue;

          const isStraight = (d2.dr === d1.dr && d2.dc === d1.dc);
          const isTurn = (d1.dr * d2.dr + d1.dc * d2.dc === 0);

          if (piece.shape === 'square' && !isStraight) continue;
          if (piece.shape === 'circle' && !isTurn) continue;

          const r2 = r1 + d2.dr;
          const c2 = c1 + d2.dc;
          if (!this.isInside(r2, c2)) continue;
          if (this.hasWallBetween(r1, c1, r2, c2)) continue;
          if (this.getPieceAt(r2, c2)) continue;

          register(r2, c2, 2, [{ r: piece.r, c: piece.c }, { r: r1, c: c1 }, { r: r2, c: c2 }]);
        }
      }

      const results = [];
      for (const dest of destMap.values()) {
        if (this.getOpenEdges(dest.r, dest.c).length > 0) {
          results.push(dest);
        }
      }
      return results;
    }

    // Fast early-exit check: whether playerId has at least one legal move+wall action
    hasAnyLegalMove(playerId) {
      const myPieces = this.getPlayerPieces(playerId);
      for (const piece of myPieces) {
        if (this.getValidDestinations(piece.id).length > 0) {
          return true;
        }
      }
      return false;
    }

    // All legal (pieceId, toR, toC, wall) tuples for playerId
    getAllLegalActions(playerId) {
      const actions = [];
      const myPieces = this.getPlayerPieces(playerId);
      for (const piece of myPieces) {
        const dests = this.getValidDestinations(piece.id);
        for (const dest of dests) {
          const edges = this.getOpenEdges(dest.r, dest.c);
          for (const wall of edges) {
            actions.push({
              pieceId: piece.id,
              fromR: piece.r,
              fromC: piece.c,
              toR: dest.r,
              toC: dest.c,
              dist: dest.dist,
              wall
            });
          }
        }
      }
      return actions;
    }

    // Hammer breakable walls adjacent to playerId's pieces
    getBreakableWalls(playerId, onlyCrossComponent = false) {
      const playerObj = this.players[playerId];
      if (!playerObj || playerObj.hammers <= 0) return [];

      const analysis = onlyCrossComponent ? this.analyzeTerritories() : null;
      const seen = new Set();
      const walls = [];

      for (const pc of this.getPlayerPieces(playerId)) {
        const candidates = [];
        if (pc.r > 0 && this.hWalls[pc.r - 1][pc.c]) {
          candidates.push({ type: 'h', r: pc.r - 1, c: pc.c, a: [pc.r, pc.c], b: [pc.r - 1, pc.c] });
        }
        if (pc.r < BOARD_SIZE - 1 && this.hWalls[pc.r][pc.c]) {
          candidates.push({ type: 'h', r: pc.r, c: pc.c, a: [pc.r, pc.c], b: [pc.r + 1, pc.c] });
        }
        if (pc.c > 0 && this.vWalls[pc.r][pc.c - 1]) {
          candidates.push({ type: 'v', r: pc.r, c: pc.c - 1, a: [pc.r, pc.c], b: [pc.r, pc.c - 1] });
        }
        if (pc.c < BOARD_SIZE - 1 && this.vWalls[pc.r][pc.c]) {
          candidates.push({ type: 'v', r: pc.r, c: pc.c, a: [pc.r, pc.c], b: [pc.r, pc.c + 1] });
        }

        for (const w of candidates) {
          const key = `${w.type}-${w.r}-${w.c}`;
          if (seen.has(key)) continue;

          if (onlyCrossComponent && analysis) {
            const compA = analysis.cellCompId[w.a[0]][w.a[1]];
            const compB = analysis.cellCompId[w.b[0]][w.b[1]];
            if (compA === compB) continue;
            // Only useful if the adjacent component isn't already purely mine
            const otherComp = analysis.components[compB];
            if (otherComp.status === 'owned' && otherComp.owner === playerId) continue;
          }

          seen.add(key);
          walls.push({ type: w.type, r: w.r, c: w.c });
        }
      }

      return walls;
    }

    // Use hammer (3P mode) — destroys wall, keeps current player's turn active
    useHammer(wallType, wr, wc) {
      if (this.phase !== 'play') return false;
      const p = this.currentPlayer;
      const breakable = this.getBreakableWalls(p, false);
      const valid = breakable.some(w => w.type === wallType && w.r === wr && w.c === wc);
      if (!valid) return false;

      if (wallType === 'h') {
        this.hWalls[wr][wc] = false;
        this.hWallOwner[wr][wc] = -1;
      } else {
        this.vWalls[wr][wc] = false;
        this.vWallOwner[wr][wc] = -1;
      }

      this.players[p].hammers -= 1;
      // Reset hammer declines because board topology just reopened!
      this.players.forEach(pl => { pl.hammerDeclined = false; });
      this.hammerOnlyEndgame = false;

      const wallDesc = wallType === 'h'
        ? `${coordLabel(wr, wc)}/${coordLabel(wr + 1, wc)}`
        : `${coordLabel(wr, wc)}/${coordLabel(wr, wc + 1)}`;
      this.addLog(p, `<strong>${this.players[p].name}</strong> 使用 🔨 破牆鐵鎚擊碎 ${wallDesc} 之間的牆壁！`);
      this.actionHistory.push({
        kind: 'hammer',
        player: p,
        wallType,
        r: wr,
        c: wc,
        desc: `${this.players[p].name} 🔨 破牆 ${wallDesc}`
      });
      return true;
    }

    declineEndgameHammer() {
      if (this.phase !== 'play' || !this.hammerOnlyEndgame) return false;
      const p = this.currentPlayer;
      this.players[p].hammerDeclined = true;
      this.addLog(p, `<strong>${this.players[p].name}</strong> 放棄破牆，準備結算領地。`);
      this.actionHistory.push({
        kind: 'declineHammer',
        player: p,
        desc: `${this.players[p].name} 放棄破牆並進入結算`
      });
      this._advanceTurnAndCheckEnd();
      return true;
    }

    // Commit a full turn: move piece to (toR, toC) and build wall
    applyAction(pieceId, toR, toC, wall) {
      if (this.phase !== 'play') return false;
      const piece = this.getPieceById(pieceId);
      if (!piece || piece.player !== this.currentPlayer) return false;

      const validDests = this.getValidDestinations(pieceId);
      const dest = validDests.find(d => d.r === toR && d.c === toC);
      if (!dest) return false;

      const openEdges = this.getOpenEdges(toR, toC);
      const chosenEdge = openEdges.find(e => e.type === wall.type && e.r === wall.r && e.c === wall.c);
      if (!chosenEdge) return false;

      const fromR = piece.r;
      const fromC = piece.c;
      const p = this.currentPlayer;

      // Apply move
      piece.r = toR;
      piece.c = toC;
      this.lastMoveFrom = { r: fromR, c: fromC };

      // Apply wall
      if (chosenEdge.type === 'h') {
        this.hWalls[chosenEdge.r][chosenEdge.c] = true;
        this.hWallOwner[chosenEdge.r][chosenEdge.c] = p;
      } else {
        this.vWalls[chosenEdge.r][chosenEdge.c] = true;
        this.vWallOwner[chosenEdge.r][chosenEdge.c] = p;
      }
      this.lastBuiltWall = { type: chosenEdge.type, r: chosenEdge.r, c: chosenEdge.c };

      const shapeIcon = piece.shape === 'square' ? '■ ' : piece.shape === 'circle' ? '● ' : '';
      const moveText = (fromR === toR && fromC === toC)
        ? `${shapeIcon}於 ${coordLabel(toR, toC)} 原地築${chosenEdge.label}牆`
        : `${shapeIcon}${coordLabel(fromR, fromC)} → ${coordLabel(toR, toC)} 並築${chosenEdge.label}牆`;
      this.addLog(p, `<strong>${this.players[p].name}</strong> ${moveText}`);
      this.actionHistory.push({
        kind: 'move',
        player: p,
        pieceId,
        toR,
        toC,
        wall: { type: chosenEdge.type, r: chosenEdge.r, c: chosenEdge.c, label: chosenEdge.label },
        desc: `${this.players[p].name} ${moveText}`
      });

      this._advanceTurnAndCheckEnd();
      return true;
    }

    _advanceTurnAndCheckEnd() {
      const analysis = this.analyzeTerritories();

      // Case 1: All territories are fully separated (no contested regions remain)
      if (analysis.contestedCount === 0) {
        // In 3P, check if any player still has a hammer that can break into another component
        let nextHammerPlayer = -1;
        for (let offset = 1; offset <= this.numPlayers; offset++) {
          const cand = (this.currentPlayer + offset) % this.numPlayers;
          if (!this.players[cand].hammerDeclined && this.getBreakableWalls(cand, true).length > 0) {
            nextHammerPlayer = cand;
            break;
          }
        }

        if (nextHammerPlayer !== -1) {
          this.hammerOnlyEndgame = true;
          this.currentPlayer = nextHammerPlayer;
          this.turnNumber += 1;
          return;
        }

        this._finishGame(analysis);
        return;
      }

      // Case 2: If ANY player's pieces are completely unable to move (and have no usable 3P hammer),
      // the match ends immediately and scores are settled.
      this.hammerOnlyEndgame = false;
      const immobilePlayers = [];
      for (let p = 0; p < this.numPlayers; p++) {
        const hasMove = this.hasAnyLegalMove(p);
        const hasHammer = this.getBreakableWalls(p, false).length > 0;
        if (!hasMove && !hasHammer) {
          immobilePlayers.push(this.players[p]);
        }
      }
      if (immobilePlayers.length > 0) {
        const immobileNames = immobilePlayers.map(pl => pl.name).join('、');
        this.addLog(-1, `${immobileNames} 所有棋子均無法移動，依規則遊戲立即結束並結算領地！`);
        this._finishGame(analysis, {
          endReason: 'immobile',
          immobilePlayers: immobilePlayers.map(pl => ({ player: pl.id, name: pl.name }))
        });
        return;
      }

      // Case 3: Every player still has at least one legal move (or usable hammer); advance to next player
      this.currentPlayer = (this.currentPlayer + 1) % this.numPlayers;
      this.turnNumber += 1;
    }

    _finishGame(analysis, meta = null) {
      this.phase = 'gameover';
      this.hammerOnlyEndgame = false;

      const scores = analysis.lockedScores.slice();
      const largest = analysis.largestTerritory.slice();

      // Official fallback if mixed deadlock ever occurred: 1 pt per piece standing inside contested zone
      for (const comp of analysis.components) {
        if (comp.status === 'contested') {
          for (const pc of comp.pieces) {
            scores[pc.player] += 1;
            largest[pc.player] = Math.max(largest[pc.player], 1);
          }
        }
      }

      const rankings = this.players.map(p => ({
        player: p.id,
        name: p.name,
        isAI: p.isAI,
        score: scores[p.id],
        largest: largest[p.id]
      }));

      rankings.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.largest - a.largest;
      });

      const top = rankings[0];
      const winners = rankings.filter(r => r.score === top.score && r.largest === top.largest);

      this.result = {
        rankings,
        winners,
        isDraw: winners.length > 1,
        endReason: (meta && meta.endReason) ? meta.endReason : 'separated',
        immobilePlayers: (meta && Array.isArray(meta.immobilePlayers)) ? meta.immobilePlayers : []
      };

      if (this.result.isDraw) {
        this.addLog(-1, `對局結束！${winners.map(w => w.name).join('與')}平手（${top.score} 分）。`);
      } else {
        this.addLog(-1, `對局結束！恭喜 ${top.name} 以 ${top.score} 分奪得勝利！`);
      }
    }

    // Flood-fill connected regions & Voronoi potential estimation
    analyzeTerritories() {
      const cellCompId = create2D(BOARD_SIZE, BOARD_SIZE, -1);
      const cellOwner = create2D(BOARD_SIZE, BOARD_SIZE, -1); // 0..2 owned, -2 neutral, -1 contested
      const components = [];
      const lockedScores = Array(this.numPlayers).fill(0);
      const largestTerritory = Array(this.numPlayers).fill(0);
      let contestedCount = 0;

      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          if (cellCompId[r][c] !== -1) continue;

          const compId = components.length;
          const cells = [];
          const compPieces = [];
          const playerSet = new Set();
          const stack = [[r, c]];
          cellCompId[r][c] = compId;

          while (stack.length > 0) {
            const [cr, cc] = stack.pop();
            cells.push([cr, cc]);
            const pc = this.getPieceAt(cr, cc);
            if (pc) {
              compPieces.push(pc);
              playerSet.add(pc.player);
            }
            for (const d of DIRS) {
              const nr = cr + d.dr;
              const nc = cc + d.dc;
              if (!this.isInside(nr, nc) || cellCompId[nr][nc] !== -1) continue;
              if (this.hasWallBetween(cr, cc, nr, nc)) continue;
              cellCompId[nr][nc] = compId;
              stack.push([nr, nc]);
            }
          }

          let status = 'neutral';
          let owner = -2;
          if (playerSet.size === 1) {
            status = 'owned';
            owner = Array.from(playerSet)[0];
            lockedScores[owner] += cells.length;
            if (cells.length > largestTerritory[owner]) {
              largestTerritory[owner] = cells.length;
            }
          } else if (playerSet.size >= 2) {
            status = 'contested';
            owner = -1;
            contestedCount += 1;
          }

          for (const [cr, cc] of cells) {
            cellOwner[cr][cc] = owner;
          }

          components.push({
            id: compId,
            cells,
            pieces: compPieces,
            players: playerSet,
            status,
            owner
          });
        }
      }

      // Potential score via multi-source BFS (Voronoi territory estimate)
      const potentialScores = lockedScores.slice();
      if (contestedCount > 0 && this.pieces.length > 0) {
        const distByPlayer = Array.from({ length: this.numPlayers }, () =>
          create2D(BOARD_SIZE, BOARD_SIZE, 999)
        );

        for (let p = 0; p < this.numPlayers; p++) {
          const q = [];
          for (const pc of this.getPlayerPieces(p)) {
            distByPlayer[p][pc.r][pc.c] = 0;
            q.push([pc.r, pc.c]);
          }
          let head = 0;
          while (head < q.length) {
            const [cr, cc] = q[head++];
            const cd = distByPlayer[p][cr][cc];
            for (const d of DIRS) {
              const nr = cr + d.dr;
              const nc = cc + d.dc;
              if (!this.isInside(nr, nc)) continue;
              if (this.hasWallBetween(cr, cc, nr, nc)) continue;
              if (distByPlayer[p][nr][nc] > cd + 1) {
                distByPlayer[p][nr][nc] = cd + 1;
                q.push([nr, nc]);
              }
            }
          }
        }

        for (let r = 0; r < BOARD_SIZE; r++) {
          for (let c = 0; c < BOARD_SIZE; c++) {
            if (cellOwner[r][c] !== -1) continue;
            let bestP = -1;
            let bestD = 999;
            let tied = false;
            for (let p = 0; p < this.numPlayers; p++) {
              const d = distByPlayer[p][r][c];
              if (d < bestD) {
                bestD = d;
                bestP = p;
                tied = false;
              } else if (d === bestD && d < 999) {
                tied = true;
              }
            }
            if (!tied && bestP !== -1) {
              potentialScores[bestP] += 1;
            }
          }
        }
      }

      return {
        cellCompId,
        cellOwner,
        components,
        lockedScores,
        largestTerritory,
        potentialScores,
        contestedCount
      };
    }
  }

  global.WallGoEngine = WallGoEngine;
  global.WALLGO_CONST = { BOARD_SIZE, COLS, DIRS, coordLabel };
})(window);
