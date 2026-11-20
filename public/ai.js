(function (global) {
  'use strict';

  const { BOARD_SIZE } = global.WALLGO_CONST;

  // 9-Tier AI Strength Profiles:
  // #1 (KyuMaster): Final Boss (3-ply Alpha-Beta + 4-ply Endgame + Voronoi Counter-Placement + 0 noise)
  // #2 (幽影壁壘 / Solo GM): Grandmaster (3-ply Alpha-Beta + Counter-Placement)
  // #3-#4: Strong Master / Diamond (2-ply Alpha-Beta + 3-ply Endgame for #3)
  // #5-#9: Smoothly descending strength curve from tactical 2-ply down to friendly rookie 1-ply
  const RANK_PROFILES = {
    1: { name: 'god',     depth: 3, endgameDepth: 4, endgameContested: 24, beams: [20, 14, 10, 8], timeBudgetMs: 620, noise: 0.00, placeNoise: 0.12, useSimPlacement: true,  trapWeight: 1.48, chokeWeight: 1.42, pickPool: 1 },
    2: { name: 'gm',      depth: 3, endgameDepth: 3, endgameContested: 20, beams: [16, 11,  8, 6], timeBudgetMs: 460, noise: 0.05, placeNoise: 0.35, useSimPlacement: true,  trapWeight: 1.32, chokeWeight: 1.28, pickPool: 1 },
    3: { name: 'master',  depth: 2, endgameDepth: 3, endgameContested: 16, beams: [16, 13,  8, 6], timeBudgetMs: 320, noise: 0.20, placeNoise: 0.70, useSimPlacement: true,  trapWeight: 1.15, chokeWeight: 1.15, pickPool: 1 },
    4: { name: 'diamond', depth: 2, endgameDepth: 2, endgameContested: 12, beams: [14, 11,  6, 4], timeBudgetMs: 240, noise: 0.55, placeNoise: 1.20, useSimPlacement: true,  trapWeight: 1.00, chokeWeight: 1.00, pickPool: 1 },
    5: { name: 'plat',    depth: 2, endgameDepth: 2, endgameContested:  0, beams: [ 9,  8,  4, 4], timeBudgetMs: 170, noise: 1.60, placeNoise: 2.20, useSimPlacement: false, trapWeight: 0.85, chokeWeight: 0.85, pickPool: 1 },
    6: { name: 'gold',    depth: 1, endgameDepth: 1, endgameContested:  0, beams: [12,  6,  4, 4], timeBudgetMs: 110, noise: 3.00, placeNoise: 3.80, useSimPlacement: false, trapWeight: 0.68, chokeWeight: 0.68, pickPool: 2 },
    7: { name: 'silver',  depth: 1, endgameDepth: 1, endgameContested:  0, beams: [12,  6,  4, 4], timeBudgetMs:  90, noise: 5.50, placeNoise: 6.20, useSimPlacement: false, trapWeight: 0.50, chokeWeight: 0.50, pickPool: 3 },
    8: { name: 'bronze',  depth: 1, endgameDepth: 1, endgameContested:  0, beams: [12,  6,  4, 4], timeBudgetMs:  70, noise: 9.00, placeNoise: 9.50, useSimPlacement: false, trapWeight: 0.35, chokeWeight: 0.35, pickPool: 5 },
    9: { name: 'rookie',  depth: 1, endgameDepth: 1, endgameContested:  0, beams: [12,  6,  4, 4], timeBudgetMs:  55, noise: 14.5, placeNoise: 14.5, useSimPlacement: false, trapWeight: 0.20, chokeWeight: 0.20, pickPool: 8 }
  };

  function resolveAIProfile(engine) {
    if (Number.isInteger(engine.aiRank) && engine.aiRank >= 1 && engine.aiRank <= 9) {
      return RANK_PROFILES[engine.aiRank];
    }
    if (Number.isFinite(engine.aiSkill)) {
      const s = engine.aiSkill;
      if (s >= 0.93) return RANK_PROFILES[1];
      if (s >= 0.85) return RANK_PROFILES[2];
      if (s >= 0.77) return RANK_PROFILES[3];
      if (s >= 0.70) return RANK_PROFILES[4];
      if (s >= 0.60) return RANK_PROFILES[5];
      if (s >= 0.52) return RANK_PROFILES[6];
      if (s >= 0.44) return RANK_PROFILES[7];
      if (s >= 0.36) return RANK_PROFILES[8];
      return RANK_PROFILES[9];
    }
    const lvl = engine.aiLevel || 'medium';
    if (lvl === 'god') return RANK_PROFILES[1];
    if (lvl === 'gm') return RANK_PROFILES[2];
    if (lvl === 'hard') return RANK_PROFILES[3];
    if (lvl === 'easy') return RANK_PROFILES[8];
    return RANK_PROFILES[5];
  }

  function cloneForSim(engine) {
    return typeof engine.fastClone === 'function' ? engine.fastClone() : engine.clone();
  }

  // Fast state signature for per-move Transposition Table
  function boardStateKey(engine) {
    let h = String(engine.currentPlayer) + '|';
    for (let i = 0; i < engine.pieces.length; i++) {
      const p = engine.pieces[i];
      h += p.player + '' + p.r + '' + p.c + ',';
    }
    h += '|';
    for (let r = 0; r < BOARD_SIZE - 1; r++) {
      let rowBits = 0;
      const row = engine.hWalls[r];
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (row[c]) rowBits |= (1 << c);
      }
      h += rowBits.toString(36);
    }
    h += '|';
    for (let r = 0; r < BOARD_SIZE; r++) {
      let rowBits = 0;
      const row = engine.vWalls[r];
      for (let c = 0; c < BOARD_SIZE - 1; c++) {
        if (row[c]) rowBits |= (1 << c);
      }
      h += rowBits.toString(36);
    }
    return h;
  }

  // Choke-point & wall-seam heuristic: walls that bridge TWO existing walls/borders seal regions!
  function wallChokeScore(engine, wall, playerId) {
    const { type, r, c } = wall;
    let endA = false;
    let endB = false;
    let touch = 0;

    if (type === 'h') {
      // Left vertex: (r+1, c); Right vertex: (r+1, c+1)
      if (c === 0) { endA = true; touch += 1.3; }
      else {
        if (engine.hWalls[r][c - 1]) { endA = true; touch += 1.1; }
        if (engine.vWalls[r][c - 1] || engine.vWalls[r + 1][c - 1]) { endA = true; touch += 1.1; }
      }
      if (c === BOARD_SIZE - 1) { endB = true; touch += 1.3; }
      else {
        if (engine.hWalls[r][c + 1]) { endB = true; touch += 1.1; }
        if (engine.vWalls[r][c] || engine.vWalls[r + 1][c]) { endB = true; touch += 1.1; }
      }
    } else {
      // Top vertex: (r, c+1); Bottom vertex: (r+1, c+1)
      if (r === 0) { endA = true; touch += 1.3; }
      else {
        if (engine.vWalls[r - 1][c]) { endA = true; touch += 1.1; }
        if (engine.hWalls[r - 1][c] || engine.hWalls[r - 1][c + 1]) { endA = true; touch += 1.1; }
      }
      if (r === BOARD_SIZE - 1) { endB = true; touch += 1.3; }
      else {
        if (engine.vWalls[r + 1][c]) { endB = true; touch += 1.1; }
        if (engine.hWalls[r][c] || engine.hWalls[r][c + 1]) { endB = true; touch += 1.1; }
      }
    }

    // Bridging BOTH ends closes a seam or seals off a territory!
    if (endA && endB) touch += 4.2;

    // Bonus for building directly against an enemy piece to box them in
    if (playerId !== undefined) {
      let adjEnemy = false;
      if (type === 'h') {
        const pTop = engine.getPieceAt(r, c);
        const pBot = engine.getPieceAt(r + 1, c);
        if ((pTop && pTop.player !== playerId) || (pBot && pBot.player !== playerId)) adjEnemy = true;
      } else {
        const pLeft = engine.getPieceAt(r, c);
        const pRight = engine.getPieceAt(r, c + 1);
        if ((pLeft && pLeft.player !== playerId) || (pRight && pRight.player !== playerId)) adjEnemy = true;
      }
      if (adjEnemy) touch += 1.25;
    }

    return touch;
  }

  function evaluateState(engine, playerId, profile) {
    const analysis = engine.analyzeTerritories();
    const trapW = profile ? profile.trapWeight : 1.0;

    if (engine.phase === 'gameover' && engine.result) {
      const me = engine.result.rankings.find(r => r.player === playerId);
      const bestOpp = engine.result.rankings.find(r => r.player !== playerId);
      const myScore = me ? me.score : 0;
      const oppScore = bestOpp ? bestOpp.score : 0;
      const diff = myScore - oppScore;
      const largestDiff = (me ? me.largest : 0) - (bestOpp ? bestOpp.largest : 0);
      const isWinner = engine.result.winners.some(w => w.player === playerId);
      return (isWinner ? (engine.result.isDraw ? 450 : 15000) : -15000) + diff * 180 + largestDiff * 18;
    }

    const myLocked = analysis.lockedScores[playerId];
    const myPot = analysis.potentialScores[playerId];
    const myLargest = analysis.largestTerritory[playerId] || 0;

    let maxOppLocked = -1;
    let maxOppPot = -1;
    let maxOppLargest = 0;
    let avgOppPot = 0;
    const oppCount = engine.numPlayers - 1;

    for (let p = 0; p < engine.numPlayers; p++) {
      if (p === playerId) continue;
      if (analysis.lockedScores[p] > maxOppLocked) maxOppLocked = analysis.lockedScores[p];
      if (analysis.potentialScores[p] > maxOppPot) maxOppPot = analysis.potentialScores[p];
      if ((analysis.largestTerritory[p] || 0) > maxOppLargest) maxOppLargest = analysis.largestTerritory[p] || 0;
      avgOppPot += analysis.potentialScores[p];
    }
    avgOppPot /= Math.max(1, oppCount);

    let score = 0;
    // 1. Locked territory & largest-region tiebreaker
    score += (myLocked - maxOppLocked) * 32;
    score += (myLargest - maxOppLargest) * 2.4;

    // 2. Voronoi potential territory differential
    score += (myPot - maxOppPot) * 14.5;
    if (oppCount > 1) {
      score += (myPot - avgOppPot) * 4.5;
    }

    // 3. Mobility, trap detection, self-escape & duplicate-pocket penalty
    let myFreedom = 0;
    let oppFreedom = 0;
    let myCenter = 0;
    let oppCenter = 0;
    const myOwnedCompCounts = new Map();

    for (let i = 0; i < engine.pieces.length; i++) {
      const pc = engine.pieces[i];
      const compId = analysis.cellCompId[pc.r][pc.c];
      const comp = analysis.components[compId];
      const openEdges = engine.getOpenEdges(pc.r, pc.c).length;
      const isContested = comp.status === 'contested';
      const reachCount = isContested ? engine.getValidDestinations(pc.id).length : 0;
      const centerBonus = (3 - Math.abs(pc.r - 3)) + (3 - Math.abs(pc.c - 3));

      if (pc.player === playerId) {
        if (isContested) {
          myFreedom += openEdges * 1.15 + reachCount * 0.85;
          myCenter += centerBonus;
          // Danger: about to get sealed into a 1-cell coffin next move!
          if (openEdges <= 1) score -= 15 * trapW;
          else if (reachCount <= 1) score -= 9 * trapW;
          // Shape-specific positional bonus in Wall Go II
          if (pc.shape === 'square' && openEdges >= 3) myFreedom += 0.9;
          if (pc.shape === 'circle' && reachCount >= 5) myFreedom += 0.9;
        } else if (comp.status === 'owned') {
          const sz = comp.cells.length;
          if (sz <= 1) score -= 24 * trapW;
          else if (sz === 2) score -= 14 * trapW;
          else if (sz === 3) score -= 5 * trapW;
          // Penalize wasting 2+ own pieces locked inside the SAME owned pocket
          const prevCnt = myOwnedCompCounts.get(compId) || 0;
          if (prevCnt >= 1) score -= 9 * trapW;
          myOwnedCompCounts.set(compId, prevCnt + 1);
        }
      } else {
        if (isContested) {
          oppFreedom += openEdges * 1.1 + reachCount * 0.8;
          oppCenter += centerBonus;
          // Great: opponent piece has only 1 exit left in contested area (prime trap target!)
          if (openEdges <= 1) score += 13 * trapW;
          else if (reachCount <= 1) score += 8 * trapW;
        } else if (comp.status === 'owned') {
          const sz = comp.cells.length;
          if (sz <= 1) score += 26 * trapW;
          else if (sz === 2) score += 17 * trapW;
          else if (sz === 3) score += 9 * trapW;
        }
      }
    }

    score += (myFreedom - oppFreedom) * 1.65;
    score += (myCenter - oppCenter * 0.65) * 0.7;

    // 4. Neutral dead-cell awareness (hurts whoever is trailing)
    let neutralCount = 0;
    for (let i = 0; i < analysis.components.length; i++) {
      if (analysis.components[i].status === 'neutral') {
        neutralCount += analysis.components[i].cells.length;
      }
    }
    score -= neutralCount * (myLocked >= maxOppLocked ? 0.15 : 0.55);

    return score;
  }

  // ==================== OPENING PLACEMENT AI ====================
  function choosePlacement(engine, playerId) {
    const profile = resolveAIProfile(engine);
    const candidates = [];
    const myPieces = engine.getPlayerPieces(playerId);
    const oppPieces = engine.pieces.filter(p => p.player !== playerId);
    const currentSlot = engine.getCurrentPlacement();
    const placingShape = currentSlot ? currentSlot.shape : 'classic';

    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (engine.getPieceAt(r, c)) continue;

        let score = 0;
        const distCenter = Math.abs(r - 3) + Math.abs(c - 3);
        score += (6 - distCenter) * 3.4;
        if (r === 0 || r === 6 || c === 0 || c === 6) score -= 10.5;
        if ((r === 0 || r === 6) && (c === 0 || c === 6)) score -= 8;

        // Wall Go II shape-specific placement
        if (placingShape === 'square') {
          if (r >= 2 && r <= 4 && c >= 2 && c <= 4) score += 4.2;
        } else if (placingShape === 'circle') {
          if (r >= 1 && r <= 5 && c >= 1 && c <= 5) score += 2.8;
          // Circle loves slightly off-center diagonal hubs (2,2 / 2,4 / 4,2 / 4,4)
          if ((r === 2 || r === 4) && (c === 2 || c === 4)) score += 3.2;
        }

        // Spread away from own pieces so each claims a distinct rich quadrant
        for (let i = 0; i < myPieces.length; i++) {
          const mp = myPieces[i];
          const d = Math.abs(r - mp.r) + Math.abs(c - mp.c);
          if (d <= 1) score -= 22;
          else if (d === 2) score -= 7.5;
          else if (d >= 3 && d <= 5) score += 6.5;
          if (placingShape !== 'classic' && mp.shape !== placingShape && (d === 3 || d === 4)) {
            score += 3.0;
          }
        }

        // Counter-position against opponent pieces
        for (let i = 0; i < oppPieces.length; i++) {
          const op = oppPieces[i];
          const d = Math.abs(r - op.r) + Math.abs(c - op.c);
          if (d === 1) score -= 2.5;
          else if (d === 2) score += 5.5;
          else if (d === 3) score += 4.5;
        }

        // Elite Ranks #1-#4: actually simulate placing here and evaluate true Voronoi territory!
        if (profile.useSimPlacement) {
          const sim = cloneForSim(engine);
          sim.placeInitialPiece(r, c);
          const ana = sim.analyzeTerritories();
          const myPot = ana.potentialScores[playerId] || 0;
          let maxOppPot = 0;
          for (let p = 0; p < sim.numPlayers; p++) {
            if (p !== playerId && (ana.potentialScores[p] || 0) > maxOppPot) {
              maxOppPot = ana.potentialScores[p] || 0;
            }
          }
          score += (myPot - maxOppPot) * 3.8;
        }

        score += (Math.random() - 0.5) * profile.placeNoise;
        candidates.push({ r, c, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  // ==================== 1-PLY SCORING & MOVE ORDERING ====================
  function scoreActions1Ply(engine, playerId, profile, addNoise = true) {
    const actions = engine.getAllLegalActions(playerId);
    const scored = [];
    const chokeW = profile ? profile.chokeWeight : 1.0;
    const noiseAmp = (addNoise && profile) ? profile.noise : 0;

    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];
      const sim = cloneForSim(engine);
      sim.applyAction(act.pieceId, act.toR, act.toC, act.wall);
      let sc = evaluateState(sim, playerId, profile);
      sc += wallChokeScore(engine, act.wall, playerId) * 2.2 * chokeW;
      if (noiseAmp > 0) {
        sc += (Math.random() - 0.5) * noiseAmp;
      } else {
        sc += (Math.random() - 0.5) * 0.04;
      }
      scored.push({ act, score: sc, sim });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  // Fast heuristic pre-pruner for deeper plies (avoids simulating 90 weak walls at ply 2/3)
  function quickOrderActions(engine, actions, moverId, maxCount) {
    if (actions.length <= maxCount) return actions;
    const tagged = [];
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const center = (3 - Math.abs(a.toR - 3)) + (3 - Math.abs(a.toC - 3));
      const wScore = wallChokeScore(engine, a.wall, moverId) * 3.1 + center * 0.45;
      tagged.push({ a, w: wScore });
    }
    tagged.sort((x, y) => y.w - x.w);
    const out = [];
    for (let i = 0; i < maxCount; i++) out.push(tagged[i].a);
    return out;
  }

  // ==================== ALPHA-BETA MINIMAX WITH TRANSPOSITION TABLE ====================
  function alphaBeta(sim, depth, plyIdx, alpha, beta, myId, profile, deadline, tt) {
    if (sim.phase === 'gameover') {
      // Slight depth preference: win faster, lose slower!
      const base = evaluateState(sim, myId, profile);
      return base > 0 ? base + depth * 12 : base - depth * 12;
    }
    if (depth <= 0 || performance.now() >= deadline) {
      return evaluateState(sim, myId, profile);
    }

    const key = boardStateKey(sim) + '@' + depth;
    const cached = tt.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const mover = sim.currentPlayer;
    const isMax = (mover === myId);
    const legal = sim.getAllLegalActions(mover);

    if (legal.length === 0) {
      const val = evaluateState(sim, myId, profile);
      if (tt.size < 6500) tt.set(key, val);
      return val;
    }

    const beamWidth = profile.beams[Math.min(plyIdx, profile.beams.length - 1)] || 8;
    // Order & cap child moves by fast 1-ply eval on pre-filtered candidates
    const preList = quickOrderActions(sim, legal, mover, Math.max(beamWidth * 2, 22));
    const ordered = [];
    for (let i = 0; i < preList.length; i++) {
      const act = preList[i];
      const nextSim = cloneForSim(sim);
      nextSim.applyAction(act.pieceId, act.toR, act.toC, act.wall);
      const quickVal = evaluateState(nextSim, mover, profile) + wallChokeScore(sim, act.wall, mover) * 1.8;
      ordered.push({ nextSim, quickVal });
      if (performance.now() >= deadline) break;
    }
    ordered.sort((a, b) => b.quickVal - a.quickVal);

    const limit = Math.min(beamWidth, ordered.length);
    let bestVal = isMax ? -Infinity : Infinity;

    for (let i = 0; i < limit; i++) {
      const childVal = alphaBeta(
        ordered[i].nextSim,
        depth - 1,
        plyIdx + 1,
        alpha,
        beta,
        myId,
        profile,
        deadline,
        tt
      );

      if (isMax) {
        if (childVal > bestVal) bestVal = childVal;
        if (bestVal > alpha) alpha = bestVal;
      } else {
        if (childVal < bestVal) bestVal = childVal;
        if (bestVal < beta) beta = bestVal;
      }

      if (beta <= alpha || performance.now() >= deadline) {
        break;
      }
    }

    if (tt.size < 6500 && performance.now() < deadline) {
      tt.set(key, bestVal);
    }
    return bestVal;
  }

  // ==================== MAIN ACTION SELECTOR ====================
  function choosePlayAction(engine, playerId) {
    const profile = resolveAIProfile(engine);

    // 1. Handle hammer-only endgame phase (3P)
    if (engine.hammerOnlyEndgame) {
      const baseScore = evaluateState(engine, playerId, profile);
      const breakable = engine.getBreakableWalls(playerId, true);
      let bestHammer = null;
      let bestGain = 14;

      for (let i = 0; i < breakable.length; i++) {
        const w = breakable[i];
        const simH = cloneForSim(engine);
        simH.useHammer(w.type, w.r, w.c);
        const followUps = scoreActions1Ply(simH, playerId, profile, false);
        if (followUps.length > 0) {
          const gain = followUps[0].score - baseScore;
          if (gain > bestGain) {
            bestGain = gain;
            bestHammer = { type: 'hammer', wall: w };
          }
        }
      }
      return bestHammer || { type: 'decline_hammer' };
    }

    // 2. Get 1-ply ranked legal actions
    const ranked = scoreActions1Ply(engine, playerId, profile, profile.depth <= 1);
    if (ranked.length === 0) {
      const breakable = engine.getBreakableWalls(playerId, false);
      if (breakable.length > 0) {
        return { type: 'hammer', wall: breakable[0] };
      }
      return null;
    }

    // 3. Proactive Hammer usage in 3P mode (Ranks #1-#6)
    if (engine.players[playerId].hammers > 0 && profile.pickPool <= 2) {
      const bestNormalScore = ranked[0].score;
      const breakable = engine.getBreakableWalls(playerId, true);
      let bestHammer = null;
      let bestHammerScore = bestNormalScore + 48;

      for (let i = 0; i < breakable.length; i++) {
        const w = breakable[i];
        const simH = cloneForSim(engine);
        simH.useHammer(w.type, w.r, w.c);
        const followUps = scoreActions1Ply(simH, playerId, profile, false);
        if (followUps.length > 0 && followUps[0].score > bestHammerScore) {
          bestHammerScore = followUps[0].score;
          bestHammer = w;
        }
      }
      if (bestHammer) {
        return { type: 'hammer', wall: bestHammer };
      }
    }

    // 4. Lower Ranks (#6-#9): Smoothly descending 1-ply weighted selection
    if (profile.depth <= 1) {
      const poolSize = Math.min(profile.pickPool || 1, ranked.length);
      if (poolSize <= 1) {
        return { type: 'move', action: ranked[0].act };
      }
      // Weighted bias toward stronger moves in pool (higher rank picks #1 more often)
      let totalW = 0;
      const weights = [];
      for (let i = 0; i < poolSize; i++) {
        const w = Math.pow(poolSize - i, 1.35);
        weights.push(w);
        totalW += w;
      }
      let roll = Math.random() * totalW;
      for (let i = 0; i < poolSize; i++) {
        roll -= weights[i];
        if (roll <= 0) {
          return { type: 'move', action: ranked[i].act };
        }
      }
      return { type: 'move', action: ranked[0].act };
    }

    // 5. Top Ranks (#1-#5): True Alpha-Beta Minimax + Endgame Depth Boost!
    const rootAnalysis = engine.analyzeTerritories();
    const isEndgame = engine.numPlayers === 2 &&
      (rootAnalysis.contestedCount <= profile.endgameContested || ranked.length <= 26);
    const targetDepth = isEndgame ? Math.max(profile.depth, profile.endgameDepth) : profile.depth;
    const rootBeam = Math.min(profile.beams[0] || 14, ranked.length);
    const deadline = performance.now() + profile.timeBudgetMs;
    const tt = new Map();

    let bestAct = ranked[0].act;
    let bestVal = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;

    for (let i = 0; i < rootBeam; i++) {
      const cand = ranked[i];
      let val;
      if (cand.sim.phase === 'gameover') {
        val = evaluateState(cand.sim, playerId, profile) + targetDepth * 12;
      } else {
        val = alphaBeta(
          cand.sim,
          targetDepth - 1,
          1,
          alpha,
          beta,
          playerId,
          profile,
          deadline,
          tt
        );
        // Tiny tie-breaker from wall seam positioning
        val += wallChokeScore(engine, cand.act.wall, playerId) * 0.9 * profile.chokeWeight;
        if (profile.noise > 0) {
          val += (Math.random() - 0.5) * profile.noise;
        }
      }

      if (val > bestVal) {
        bestVal = val;
        bestAct = cand.act;
      }
      if (bestVal > alpha) {
        alpha = bestVal;
      }
      if (i >= 4 && performance.now() >= deadline) {
        break;
      }
    }

    return { type: 'move', action: bestAct };
  }

  global.WallGoAI = {
    choosePlacement,
    choosePlayAction
  };
})(window);
