(function (global) {
  'use strict';

  const STORAGE_KEY = 'wallgo_esports_records_v2_pin';
  const LEGACY_KEYS = ['wallgo_esports_records_v1'];
  const SEASON_MODEL = 'server_txt_pin_v5';
  const MAX_HISTORY = 5;

  // 9 fixed AI ladder pros (#1 & #2 are elite grandmasters; #3-#4 strong; #5-#9 smoothly descending)
  const SEED_AI_PROS = [
    { id: 'r_kyu',   name: 'KyuMaster',      isAI: true, rp: 1790, wins: 48, losses: 11, draws: 2, aiLevel: 'hard',   skill: 0.96, lastDelta: 0 },
    { id: 'r_orbit', name: '幽影壁壘',        isAI: true, rp: 1645, wins: 39, losses: 14, draws: 3, aiLevel: 'hard',   skill: 0.89, lastDelta: 0 },
    { id: 'r_seok',  name: '絕境圍城',        isAI: true, rp: 1530, wins: 34, losses: 16, draws: 2, aiLevel: 'hard',   skill: 0.80, lastDelta: 0 },
    { id: 'r_hyun',  name: 'HyunGyu_Pro',    isAI: true, rp: 1445, wins: 29, losses: 16, draws: 1, aiLevel: 'hard',   skill: 0.74, lastDelta: 0 },
    { id: 'r_nova',  name: '赤藍策士',        isAI: true, rp: 1350, wins: 25, losses: 17, draws: 2, aiLevel: 'medium', skill: 0.64, lastDelta: 0 },
    { id: 'r_tin',   name: 'Tinno_99',       isAI: true, rp: 1270, wins: 21, losses: 16, draws: 1, aiLevel: 'medium', skill: 0.56, lastDelta: 0 },
    { id: 'r_zen',   name: '深藍封鎖線',      isAI: true, rp: 1165, wins: 16, losses: 15, draws: 2, aiLevel: 'medium', skill: 0.48, lastDelta: 0 },
    { id: 'r_kuro',  name: '黑曜棋手',        isAI: true, rp: 1085, wins: 12, losses: 14, draws: 1, aiLevel: 'easy',   skill: 0.40, lastDelta: 0 },
    { id: 'r_rook',  name: '新手試煉者',      isAI: true, rp: 980,  wins: 7,  losses: 13, draws: 0, aiLevel: 'easy',   skill: 0.32, lastDelta: 0 }
  ];

  function cleanName(raw) {
    return String(raw || '').replace(/\s*\(\d+\)\s*$/, '').replace(/[<>&"']/g, '').trim().slice(0, 14);
  }

  function normKey(name) {
    return cleanName(name).toLowerCase();
  }

  function getTier(rp) {
    if (rp >= 1750) return { name: '宗師', cls: 'tier-gm' };
    if (rp >= 1580) return { name: '大師', cls: 'tier-master' };
    if (rp >= 1420) return { name: '鑽石', cls: 'tier-diamond' };
    if (rp >= 1280) return { name: '白金', cls: 'tier-plat' };
    if (rp >= 1140) return { name: '黃金', cls: 'tier-gold' };
    if (rp >= 1000) return { name: '白銀', cls: 'tier-silver' };
    return { name: '青銅', cls: 'tier-bronze' };
  }

  function createDefaultData() {
    return {
      seasonModel: SEASON_MODEL,
      profile: {
        nickname: '',
        registered: false,
        rp: 1200,
        lastDelta: 0
      },
      buckets: {
        solo: { wins: 0, losses: 0, draws: 0, history: [] },
        friends: { wins: 0, losses: 0, draws: 0, history: [] },
        ranked: { wins: 0, losses: 0, draws: 0, history: [] }
      },
      shared: {
        version: 1,
        updatedAt: Date.now(),
        registeredIds: [],
        entries: SEED_AI_PROS.map(a => ({ ...a }))
      },
      localPins: {}
    };
  }

  class WallGoStatsStore {
    constructor() {
      this.presenceMap = {}; // normKey(name) -> 'online' | 'queuing' | 'playing' | 'offline'
      this.data = this._load();
    }

    _load() {
      try {
        // Purge all legacy pre-PIN localStorage keys so old test IDs never linger
        for (const oldKey of LEGACY_KEYS) {
          try { global.localStorage.removeItem(oldKey); } catch (_) {}
        }
        const raw = global.localStorage.getItem(STORAGE_KEY);
        if (!raw) return createDefaultData();
        const parsed = JSON.parse(raw);
        const def = createDefaultData();

        const savedNick = (parsed.profile && typeof parsed.profile.nickname === 'string')
          ? cleanName(parsed.profile.nickname)
          : '';
        const isRegistered = Boolean(
          (parsed.profile && parsed.profile.registered === true && savedNick) ||
          (savedNick && savedNick !== '策略玩家')
        );

        let shared = def.shared;
        if (parsed.seasonModel === SEASON_MODEL && parsed.shared && Array.isArray(parsed.shared.entries)) {
          shared = {
            version: Number(parsed.shared.version) || 1,
            updatedAt: Number(parsed.shared.updatedAt) || Date.now(),
            registeredIds: Array.isArray(parsed.shared.registeredIds) ? parsed.shared.registeredIds.slice() : [],
            entries: parsed.shared.entries.map(e => ({ ...e }))
          };
          // Ensure all 9 fixed AI pros exist
          for (const seed of SEED_AI_PROS) {
            if (!shared.entries.some(e => e.id === seed.id)) {
              shared.entries.push({ ...seed });
            }
          }
        } else if (Array.isArray(parsed.rivals)) {
          // Migrate prior v3 data while preserving registered ID & solo/friends history
          shared.entries = SEED_AI_PROS.map(a => ({ ...a }));
        }

        const out = {
          seasonModel: SEASON_MODEL,
          profile: {
            nickname: isRegistered ? savedNick : '',
            registered: isRegistered,
            rp: Number.isFinite(parsed.profile && parsed.profile.rp) ? parsed.profile.rp : 1200,
            lastDelta: Number(parsed.profile && parsed.profile.lastDelta) || 0
          },
          buckets: {
            solo: this._normalizeBucket(parsed.buckets && parsed.buckets.solo),
            friends: this._normalizeBucket(parsed.buckets && parsed.buckets.friends),
            ranked: this._normalizeBucket(parsed.buckets && parsed.buckets.ranked)
          },
          shared,
          localPins: (parsed.localPins && typeof parsed.localPins === 'object') ? { ...parsed.localPins } : {}
        };

        if (isRegistered) {
          this._ensureRegisteredIdIn(out.shared, savedNick);
        }
        return out;
      } catch (_) {
        return createDefaultData();
      }
    }

    _normalizeBucket(b) {
      if (!b || typeof b !== 'object') return { wins: 0, losses: 0, draws: 0, history: [] };
      return {
        wins: Number(b.wins) || 0,
        losses: Number(b.losses) || 0,
        draws: Number(b.draws) || 0,
        history: Array.isArray(b.history) ? b.history.slice(0, MAX_HISTORY) : []
      };
    }

    _ensureRegisteredIdIn(shared, name) {
      const c = cleanName(name);
      if (!c) return;
      const k = normKey(c);
      if (!shared.registeredIds.some(x => normKey(x) === k)) {
        shared.registeredIds.push(c);
      }
    }

    _save() {
      try {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      } catch (_) {}
    }

    // ==================== ID REGISTRY & DEDUPLICATION ====================
    hasRegisteredId() {
      return Boolean(this.data.profile.registered && this.data.profile.nickname);
    }

    getNickname() {
      return this.data.profile.nickname || '策略玩家';
    }

    isIdTaken(rawName) {
      const c = cleanName(rawName);
      if (!c) return false;
      const k = normKey(c);
      // Allow self if already registered with this exact ID
      if (this.hasRegisteredId() && normKey(this.data.profile.nickname) === k) return false;
      // Block collision with any fixed AI pro name
      if (SEED_AI_PROS.some(a => normKey(a.name) === k)) return true;
      // Block collision with any previously registered human ID in the shared registry
      if (this.data.shared.registeredIds.some(id => normKey(id) === k)) return true;
      if (this.data.shared.entries.some(e => normKey(e.name) === k)) return true;
      return false;
    }

    setNickname(name, opts = {}) {
      if (this.hasRegisteredId() && !opts.forceApproved) return this.data.profile.nickname;
      const clean = cleanName(name);
      if (!clean) return '';
      if (!opts.forceApproved && this.isIdTaken(clean)) return '';
      this.data.profile.nickname = clean;
      this.data.profile.registered = true;
      this._ensureRegisteredIdIn(this.data.shared, clean);
      this._save();
      return clean;
    }

    logoutLocalSession() {
      this.data.profile.nickname = '';
      this.data.profile.registered = false;
      this.data.profile.rp = 1200;
      this.data.profile.lastDelta = 0;
      this.data.buckets.ranked = { wins: 0, losses: 0, draws: 0, history: [] };
      this._save();
    }

    localAuthenticate(rawName, rawPin) {
      const clean = cleanName(rawName);
      const pin = String(rawPin || '').trim();
      if (!clean) return { ok: false, reason: '請輸入玩家 ID（請勿只輸入特殊符號）' };
      if (!/^\d{4}$/.test(pin)) return { ok: false, reason: '請設定或輸入 4 位數字密碼（例如 1234）' };
      const k = normKey(clean);
      if (SEED_AI_PROS.some(a => normKey(a.name) === k)) {
        return { ok: false, reason: '此 ID 與天梯固定 AI 選手重複，請換一個稱號！' };
      }
      if (!this.data.localPins) this.data.localPins = {};
      const existingPin = this.data.localPins[k];
      if (existingPin) {
        if (existingPin !== pin) {
          return { ok: false, reason: `ID「${clean}」已被註冊！請輸入正確的 4 位數密碼，或換一個新 ID。` };
        }
        this.setNickname(clean, { forceApproved: true });
        this.ensureHumanOnLadder(clean, 1200);
        this._syncLocalProfileFromShared();
        this._save();
        return { ok: true, mode: 'login', name: clean };
      }
      if (this.isIdTaken(clean)) {
        return { ok: false, reason: `ID「${clean}」已被其他玩家使用，請換一個稱號！` };
      }
      this.data.localPins[k] = pin;
      this.setNickname(clean, { forceApproved: true });
      this.ensureHumanOnLadder(clean, 1200);
      this._save();
      return { ok: true, mode: 'register', name: clean };
    }

    applyServerLogin({ name, shared, presenceMap, myHistory }) {
      const clean = cleanName(name);
      if (!clean) return false;
      this.data.profile.nickname = clean;
      this.data.profile.registered = true;
      this.applyAuthoritativeServerState({ shared, presenceMap, myHistory });
      return true;
    }

    applyAuthoritativeServerState({ shared, presenceMap, myHistory }) {
      if (shared && Array.isArray(shared.entries)) {
        this.data.shared = {
          version: Number(shared.version) || 1,
          updatedAt: Number(shared.updatedAt) || Date.now(),
          registeredIds: Array.isArray(shared.registeredIds) ? shared.registeredIds.slice() : [],
          entries: shared.entries.map(e => ({ ...e }))
        };
        for (const seed of SEED_AI_PROS) {
          if (!this.data.shared.entries.some(e => e.id === seed.id)) {
            this.data.shared.entries.push({ ...seed });
          }
        }
      }
      if (presenceMap && typeof presenceMap === 'object') {
        this.setPresenceMap(presenceMap);
      }
      if (Array.isArray(myHistory)) {
        this.data.buckets.ranked.history = myHistory.slice(0, MAX_HISTORY);
      }
      this._syncLocalProfileFromShared();
      this._save();
    }

    _syncLocalProfileFromShared() {
      if (!this.hasRegisteredId()) return;
      const myEntry = this.data.shared.entries.find(
        e => e.isAI === false && normKey(e.name) === normKey(this.data.profile.nickname)
      );
      if (myEntry) {
        this.data.profile.rp = myEntry.rp;
        this.data.profile.lastDelta = myEntry.lastDelta || 0;
        this.data.buckets.ranked.wins = myEntry.wins;
        this.data.buckets.ranked.losses = myEntry.losses;
        this.data.buckets.ranked.draws = myEntry.draws || 0;
      }
    }

    registerExternalId(rawName) {
      const clean = cleanName(rawName);
      if (!clean) return { ok: false, reason: 'ID 不可為空' };
      const k = normKey(clean);
      if (SEED_AI_PROS.some(a => normKey(a.name) === k)) {
        return { ok: false, reason: '此 ID 與天梯 AI 選手重複' };
      }
      if (this.data.shared.registeredIds.some(id => normKey(id) === k)) {
        return { ok: false, reason: '此 ID 已被其他玩家使用，請換一個名稱' };
      }
      this.data.shared.registeredIds.push(clean);
      this.data.shared.version += 1;
      this.data.shared.updatedAt = Date.now();
      this._save();
      return { ok: true, name: clean };
    }

    // ==================== SHARED GLOBAL LEADERBOARD & PRESENCE ====================
    ensureHumanOnLadder(rawName, initialRp = 1200) {
      const clean = cleanName(rawName);
      if (!clean) return null;
      const k = normKey(clean);
      this._ensureRegisteredIdIn(this.data.shared, clean);
      let entry = this.data.shared.entries.find(e => e.isAI === false && normKey(e.name) === k);
      if (!entry) {
        entry = {
          id: 'human_' + k,
          name: clean,
          isAI: false,
          rp: Number.isFinite(initialRp) && initialRp >= 800 ? initialRp : 1200,
          wins: 0,
          losses: 0,
          draws: 0,
          lastDelta: 0
        };
        this.data.shared.entries.push(entry);
        this.data.shared.version += 1;
        this.data.shared.updatedAt = Date.now();
        this._save();
      }
      return entry;
    }

    setPresenceMap(mapObj) {
      this.presenceMap = {};
      if (mapObj && typeof mapObj === 'object') {
        for (const [name, status] of Object.entries(mapObj)) {
          this.presenceMap[normKey(name)] = status;
        }
      }
    }

    getPresence(name) {
      return this.presenceMap[normKey(name)] || 'offline';
    }

    getOnlineHumanCount() {
      let c = 0;
      for (const st of Object.values(this.presenceMap)) {
        if (st === 'online' || st === 'queuing' || st === 'playing') c++;
      }
      return Math.max(1, c);
    }

    exportSharedState() {
      return JSON.parse(JSON.stringify(this.data.shared));
    }

    importSharedState(incoming) {
      if (!incoming || !Array.isArray(incoming.entries)) return false;
      // Union registeredIds so we never lose any registered ID across failovers
      const idMap = new Map();
      for (const id of this.data.shared.registeredIds) idMap.set(normKey(id), id);
      if (Array.isArray(incoming.registeredIds)) {
        for (const id of incoming.registeredIds) idMap.set(normKey(id), id);
      }

      const incomingVer = Number(incoming.version) || 1;
      const incomingAt = Number(incoming.updatedAt) || 0;
      const localVer = Number(this.data.shared.version) || 1;
      const localAt = Number(this.data.shared.updatedAt) || 0;

      // Accept incoming entries if version is >= local (or newer timestamp)
      if (incomingVer > localVer || (incomingVer === localVer && incomingAt >= localAt)) {
        this.data.shared.entries = incoming.entries.map(e => ({ ...e }));
        this.data.shared.version = incomingVer;
        this.data.shared.updatedAt = Math.max(incomingAt, Date.now());
      }
      this.data.shared.registeredIds = Array.from(idMap.values());

      // Sync local profile RP / ranked W-L from authoritative shared entry if present
      if (this.hasRegisteredId()) {
        const myEntry = this.data.shared.entries.find(e => e.isAI === false && normKey(e.name) === normKey(this.data.profile.nickname));
        if (myEntry) {
          this.data.profile.rp = myEntry.rp;
          this.data.profile.lastDelta = myEntry.lastDelta || 0;
          this.data.buckets.ranked.wins = myEntry.wins;
          this.data.buckets.ranked.losses = myEntry.losses;
          this.data.buckets.ranked.draws = myEntry.draws || 0;
        }
      }
      this._save();
      return true;
    }

    getRP() {
      if (this.hasRegisteredId()) {
        const me = this.data.shared.entries.find(e => e.isAI === false && normKey(e.name) === normKey(this.data.profile.nickname));
        if (me) return me.rp;
      }
      return this.data.profile.rp;
    }

    getTierInfo(rp = this.getRP()) {
      return getTier(rp);
    }

    getBucket(category) {
      const key = category === 'ranked' ? 'ranked' : (category === 'friends' ? 'friends' : 'solo');
      return this.data.buckets[key];
    }

    getMatchById(category, id) {
      const b = this.getBucket(category);
      return b.history.find(m => m.id === id) || null;
    }

    pickRankedChallenger() {
      const myRp = this.getRP();
      const aiPros = this.data.shared.entries.filter(e => e.isAI !== false);
      // Rank all 9 AI pros by current RP (1 = strongest #1 Boss .. 9 = rookie)
      const byStrength = aiPros.slice().sort((a, b) => b.rp - a.rp || (b.skill || 0) - (a.skill || 0));
      const rankMap = new Map();
      byStrength.forEach((a, i) => rankMap.set(a.id, i + 1));

      const sorted = aiPros.slice().sort((a, b) => Math.abs(a.rp - myRp) - Math.abs(b.rp - myRp));
      const pool = sorted.slice(0, 3);
      const picked = pool[Math.floor(Math.random() * pool.length)];
      const seed = SEED_AI_PROS.find(s => s.id === picked.id);
      return {
        ...picked,
        skill: seed ? seed.skill : (picked.skill || 0.55),
        aiRank: rankMap.get(picked.id) || 5
      };
    }

    getLeaderboard() {
      const myKey = this.hasRegisteredId() ? normKey(this.data.profile.nickname) : '';
      const list = this.data.shared.entries.map(e => {
        const isMe = Boolean(myKey && e.isAI === false && normKey(e.name) === myKey);
        return {
          ...e,
          isMe,
          presence: e.isAI === false ? this.getPresence(e.name) : 'ai'
        };
      });

      // Ensure local player appears on the board even before first lobby sync
      if (myKey && !list.some(x => x.isMe)) {
        const rk = this.data.buckets.ranked;
        list.push({
          id: 'human_' + myKey,
          name: this.getNickname(),
          isAI: false,
          isMe: true,
          rp: this.data.profile.rp,
          wins: rk.wins,
          losses: rk.losses,
          draws: rk.draws,
          lastDelta: this.data.profile.lastDelta || 0,
          presence: this.getPresence(this.getNickname())
        });
      }

      list.sort((a, b) => b.rp - a.rp || b.wins - a.wins || a.losses - b.losses);
      return list.map((entry, idx) => ({
        ...entry,
        rank: idx + 1,
        tier: getTier(entry.rp)
      }));
    }

    getMyRank() {
      const lb = this.getLeaderboard();
      const me = lb.find(x => x.isMe);
      return me ? me.rank : lb.length;
    }

    // ==================== AUTHORITATIVE SHARED RANKED MATCH UPDATE ====================
    // Called whenever ANY human finishes a ranked match (vs AI OR vs Human).
    // Updates both participants + simulates 1 round for all idle fixed AI pros by their skill!
    applyGlobalRankedMatch({ playerAName, playerBName, bIsAI = false, rivalId = null, outcomeForA }) {
      // outcomeForA: 'win' | 'loss' | 'draw'
      const entryA = this.ensureHumanOnLadder(playerAName, 1200);
      let entryB = null;
      if (bIsAI && rivalId) {
        entryB = this.data.shared.entries.find(e => e.id === rivalId);
      }
      if (!entryB && bIsAI) {
        entryB = this.data.shared.entries.find(e => e.isAI !== false && normKey(e.name) === normKey(playerBName));
      }
      if (!entryB && !bIsAI) {
        entryB = this.ensureHumanOnLadder(playerBName, 1200);
      }
      if (!entryA || !entryB) return { rpDeltaA: 0, rpDeltaB: 0 };

      // Clear previous round's deltas on idle humans
      for (const e of this.data.shared.entries) {
        if (e.isAI === false && e !== entryA && e !== entryB) e.lastDelta = 0;
      }

      const expectedA = 1 / (1 + Math.pow(10, (entryB.rp - entryA.rp) / 400));
      const actualA = outcomeForA === 'win' ? 1 : (outcomeForA === 'draw' ? 0.5 : 0);
      let deltaA = Math.round(34 * (actualA - expectedA));
      if (outcomeForA === 'win' && deltaA < 12) deltaA = 12;
      if (outcomeForA === 'loss' && deltaA > -10) deltaA = -10;

      entryA.rp = Math.max(800, entryA.rp + deltaA);
      entryB.rp = Math.max(800, entryB.rp - deltaA);
      entryA.lastDelta = deltaA;
      entryB.lastDelta = -deltaA;

      if (outcomeForA === 'win') {
        entryA.wins += 1;
        entryB.losses += 1;
      } else if (outcomeForA === 'loss') {
        entryA.losses += 1;
        entryB.wins += 1;
      } else {
        entryA.draws = (entryA.draws || 0) + 1;
        entryB.draws = (entryB.draws || 0) + 1;
      }

      // Evolve ALL idle fixed AI pros by their AI strength!
      this._simulateIdleAIPros(bIsAI ? entryB.id : null);

      this.data.shared.version += 1;
      this.data.shared.updatedAt = Date.now();

      // Sync local profile if we were A or B
      if (this.hasRegisteredId()) {
        const myK = normKey(this.data.profile.nickname);
        const me = this.data.shared.entries.find(e => e.isAI === false && normKey(e.name) === myK);
        if (me) {
          this.data.profile.rp = me.rp;
          this.data.profile.lastDelta = me.lastDelta;
          this.data.buckets.ranked.wins = me.wins;
          this.data.buckets.ranked.losses = me.losses;
          this.data.buckets.ranked.draws = me.draws || 0;
        }
      }

      this._save();
      return {
        rpDeltaA: deltaA,
        rpDeltaB: -deltaA,
        newRpA: entryA.rp,
        newRpB: entryB.rp,
        shared: this.exportSharedState()
      };
    }

    _simulateIdleAIPros(excludeAiId) {
      const idleAIs = this.data.shared.entries.filter(e => e.isAI !== false && e.id !== excludeAiId);
      for (let i = idleAIs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idleAIs[i], idleAIs[j]] = [idleAIs[j], idleAIs[i]];
      }
      for (let i = 0; i + 1 < idleAIs.length; i += 2) {
        const a = idleAIs[i];
        const b = idleAIs[i + 1];
        const sa = Number.isFinite(a.skill) ? a.skill : 0.55;
        const sb = Number.isFinite(b.skill) ? b.skill : 0.55;
        const winProbA = 0.5 + (sa - sb) * 0.72;
        const roll = Math.random();
        let actualA = 0;
        if (roll < 0.06) {
          actualA = 0.5;
          a.draws = (a.draws || 0) + 1;
          b.draws = (b.draws || 0) + 1;
        } else if (Math.random() < Math.max(0.18, Math.min(0.82, winProbA))) {
          actualA = 1;
          a.wins += 1;
          b.losses += 1;
        } else {
          actualA = 0;
          b.wins += 1;
          a.losses += 1;
        }
        const expectedA = 1 / (1 + Math.pow(10, (b.rp - a.rp) / 400));
        let deltaA = Math.round(34 * (actualA - expectedA));
        if (actualA === 1 && deltaA < 12) deltaA = 12;
        if (actualA === 0 && deltaA > -10) deltaA = -10;
        a.rp = Math.max(800, a.rp + deltaA);
        b.rp = Math.max(800, b.rp - deltaA);
        a.lastDelta = deltaA;
        b.lastDelta = -deltaA;
      }
      if (idleAIs.length % 2 === 1) {
        const solo = idleAIs[idleAIs.length - 1];
        const s = Number.isFinite(solo.skill) ? solo.skill : 0.55;
        const won = Math.random() < s;
        const delta = won ? Math.round(14 + Math.random() * 10) : -Math.round(12 + Math.random() * 9);
        solo.rp = Math.max(800, solo.rp + delta);
        solo.lastDelta = delta;
        if (won) solo.wins += 1;
        else solo.losses += 1;
      }
    }

    recordAbandonedLoss(category) {
      const key = category === 'ranked' ? 'ranked' : (category === 'friends' ? 'friends' : 'solo');
      if (key !== 'ranked') {
        this.data.buckets[key].losses += 1;
        this._save();
      }
    }

    // Record local match replay (and for solo/friends also update local W/L/D; for ranked, RP/ladder handled by applyGlobalRankedMatch)
    recordLocalReplay({ category, engine, mySeat = 0, opponentName = '', rpDelta = 0 }) {
      if (!engine || !engine.result) return null;
      const key = category === 'ranked' ? 'ranked' : (category === 'friends' ? 'friends' : 'solo');
      const bucket = this.data.buckets[key];
      const res = engine.result;

      let outcome = 'loss';
      if (res.isDraw) outcome = 'draw';
      else if (res.winners.some(w => w.player === mySeat)) outcome = 'win';

      if (key !== 'ranked') {
        if (outcome === 'win') bucket.wins += 1;
        else if (outcome === 'loss') bucket.losses += 1;
        else bucket.draws += 1;
      }

      const scoresBySeat = engine.players.map(p => {
        const r = res.rankings.find(x => x.player === p.id);
        return r ? r.score : 0;
      });
      const oppPlayer = engine.players.find(p => p.id !== mySeat);
      const record = {
        id: 'm_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        timestamp: Date.now(),
        category: key,
        ruleVariant: engine.ruleVariant,
        numPlayers: engine.numPlayers,
        openingStyle: engine.openingStyle,
        aiLevel: engine.aiLevel,
        mySeat,
        outcome,
        rpDelta,
        opponentName: cleanName(opponentName || (oppPlayer ? oppPlayer.name : '對手')),
        scores: scoresBySeat,
        players: engine.players.map(p => ({ id: p.id, name: p.name, short: p.short, isAI: p.isAI })),
        initialConfig: engine.initialConfig ? JSON.parse(JSON.stringify(engine.initialConfig)) : null,
        steps: Array.isArray(engine.actionHistory) ? JSON.parse(JSON.stringify(engine.actionHistory)) : []
      };

      bucket.history.unshift(record);
      if (bucket.history.length > MAX_HISTORY) bucket.history = bucket.history.slice(0, MAX_HISTORY);
      this._save();
      return { record, outcome, rpDelta, newRp: this.getRP() };
    }
  }

  global.WallGoStats = new WallGoStatsStore();
})(window);
