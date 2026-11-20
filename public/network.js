(function (global) {
  'use strict';

  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const PEER_PREFIX = 'wallgo-dp-';
  const RANKED_SLOT_PREFIX = 'wallgo-dp-ranked-slot-';
  const RANKED_SLOT_COUNT = 6;
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  function generateRoomCode(len = 6) {
    let out = '';
    for (let i = 0; i < len; i++) {
      out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return out;
  }

  function sanitizeCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }

  function sanitizeName(raw, fallback) {
    const clean = String(raw || '').trim().slice(0, 14);
    return clean || fallback;
  }

  class WallGoNetwork {
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.role = 'offline'; // 'offline' | 'host' | 'guest'
      this.roomCode = null;
      this.mySeat = -1;
      this.roomConfig = null;
      this.seats = []; // [{ seat, colorName, nickname, connected, isHost, isAI }]
      this.matchStarted = false;

      this.peer = null;
      this.hostConn = null; // Guest -> Host connection
      this.guestConns = new Map(); // Host: seat -> DataConnection
      this.peerLastSeen = new Map(); // Host: seat -> lastHeardMs
      this.hostLastSeen = 0; // Guest: lastHeardMs from Host
      this.keepaliveTimer = null;
    }

    _startMatchKeepalive() {
      this._stopMatchKeepalive();
      const now = Date.now();
      this.hostLastSeen = now;
      this.peerLastSeen.clear();
      for (const seat of this.guestConns.keys()) {
        this.peerLastSeen.set(seat, now);
      }

      this.keepaliveTimer = setInterval(() => {
        if (!this.matchStarted || !this.isOnline()) {
          this._stopMatchKeepalive();
          return;
        }
        const t = Date.now();
        if (this.isHost()) {
          for (const [seat, conn] of Array.from(this.guestConns.entries())) {
            const last = this.peerLastSeen.get(seat) || t;
            if ((t - last) >= 3800 || !conn || !conn.open) {
              this.guestConns.delete(seat);
              this.peerLastSeen.delete(seat);
              const slot = this.seats[seat];
              const leftName = (slot && slot.nickname) || `玩家 ${seat + 1}`;
              if (slot) slot.connected = false;
              try { if (conn) conn.close(); } catch (_) {}
              this._emit('onOpponentLeft', { seat, name: leftName, explicit: false });
            } else {
              this._send(conn, { type: 'ping', t });
            }
          }
        } else if (this.role === 'guest') {
          if ((t - this.hostLastSeen) >= 3800 || !this.hostConn || !this.hostConn.open) {
            const hostName = (this.seats[0] && this.seats[0].nickname) || '對手';
            const savedSeat = this.mySeat;
            const savedRoom = this.roomCode;
            this.matchStarted = false;
            this._stopMatchKeepalive();
            // IMPORTANT: emit onOpponentLeft BEFORE disconnect(true) so mySeat & seats remain intact!
            this._emit('onOpponentLeft', { seat: 0, mySeat: savedSeat, roomCode: savedRoom, name: hostName, explicit: false });
            this.disconnect(true);
          } else {
            this._send(this.hostConn, { type: 'ping', t });
          }
        }
      }, 1200);
    }

    _stopMatchKeepalive() {
      if (this.keepaliveTimer) {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
      }
      this.peerLastSeen.clear();
    }

    isOnline() {
      return this.role !== 'offline';
    }

    isHost() {
      return this.role === 'host';
    }

    isPeerJSAvailable() {
      return typeof global.Peer === 'function';
    }

    _emit(name, payload) {
      if (this.handlers && typeof this.handlers[name] === 'function') {
        this.handlers[name](payload);
      }
    }

    disconnect(silent = false) {
      this._stopMatchKeepalive();
      if (this.hostConn) {
        try { this.hostConn.close(); } catch (_) {}
        this.hostConn = null;
      }
      for (const conn of this.guestConns.values()) {
        try { conn.close(); } catch (_) {}
      }
      this.guestConns.clear();
      if (this.peer) {
        try { this.peer.destroy(); } catch (_) {}
        this.peer = null;
      }

      const wasOnline = this.role !== 'offline';
      this.role = 'offline';
      this.roomCode = null;
      this.mySeat = -1;
      this.roomConfig = null;
      this.seats = [];
      this.matchStarted = false;

      if (wasOnline && !silent) {
        this._emit('onDisconnected', { reason: '已離開線上房間' });
      }
    }

    // ==================== HOST FLOW ====================
    createRoom(options) {
      if (!this.isPeerJSAvailable()) {
        this._emit('onError', '無法載入連線模組（PeerJS），請確認網路連線正常後重新整理頁面。');
        return;
      }

      this.disconnect(true);

      const numPlayers = options.numPlayers === 3 ? 3 : 2;
      const colorNames = ['紅方', '藍方', '金方'];
      const hostName = sanitizeName(options.hostName, '房主');

      this.role = 'host';
      this.mySeat = 0;
      this.matchStarted = false;
      this.roomConfig = {
        ruleVariant: options.ruleVariant === 'classic' ? 'classic' : 'v2',
        numPlayers,
        openingStyle: options.openingStyle || 'classic',
        aiLevel: options.aiLevel || 'medium',
        timerEnabled: Boolean(options.timerEnabled),
        matchCategory: options.matchCategory === 'ranked' ? 'ranked' : 'friends'
      };

      this.seats = Array.from({ length: numPlayers }, (_, idx) => ({
        seat: idx,
        colorName: colorNames[idx],
        nickname: idx === 0 ? hostName : '',
        connected: idx === 0,
        isHost: idx === 0,
        isAI: false
      }));

      this._openHostPeerWithRetry(0, options.fixedCode || null);
    }

    _openHostPeerWithRetry(attempt, fixedCode = null) {
      if (attempt > 4) {
        this.disconnect(true);
        this._emit('onError', '建立房間失敗，請稍後再試。');
        return;
      }

      const code = fixedCode ? sanitizeCode(fixedCode) : generateRoomCode(6);
      const peerId = PEER_PREFIX + code;
      this.roomCode = code;

      this._emit('onStatus', '正在連線至配對伺服器並建立房間…');

      const peer = new global.Peer(peerId, {
        config: { iceServers: ICE_SERVERS }
      });
      this.peer = peer;

      peer.on('open', () => {
        if (this.peer !== peer) return;
        this._emit('onRoomReady', {
          role: 'host',
          roomCode: this.roomCode,
          mySeat: 0,
          roomConfig: this.roomConfig,
          seats: this._cloneSeats()
        });
      });

      peer.on('connection', (conn) => {
        if (this.peer !== peer) return;
        this._handleIncomingGuest(conn);
      });

      peer.on('error', (err) => {
        if (this.peer !== peer) return;
        if (err && err.type === 'unavailable-id') {
          try { peer.destroy(); } catch (_) {}
          this._openHostPeerWithRetry(attempt + 1);
          return;
        }
        this._emit('onError', `連線錯誤：${err ? (err.message || err.type) : '未知錯誤'}`);
      });

      peer.on('disconnected', () => {
        if (this.peer !== peer) return;
        // Try silent reconnect to signaling server (existing P2P channels stay alive)
        try { peer.reconnect(); } catch (_) {}
      });
    }

    _handleIncomingGuest(conn) {
      let assignedSeat = -1;

      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'join') {
          if (this.matchStarted) {
            this._send(conn, { type: 'error', message: '此房間已經開始對局，無法中途加入。' });
            setTimeout(() => { try { conn.close(); } catch (_) {} }, 250);
            return;
          }

          // Find first free non-host seat
          const freeSlot = this.seats.find(s => s.seat > 0 && !s.connected);
          if (!freeSlot) {
            this._send(conn, { type: 'error', message: '房間已滿！' });
            setTimeout(() => { try { conn.close(); } catch (_) {} }, 250);
            return;
          }

          assignedSeat = freeSlot.seat;
          freeSlot.connected = true;
          freeSlot.isAI = false;
          freeSlot.nickname = sanitizeName(msg.name, `玩家 ${assignedSeat + 1}`);
          this.guestConns.set(assignedSeat, conn);

          this._send(conn, {
            type: 'welcome',
            roomCode: this.roomCode,
            seat: assignedSeat,
            roomConfig: this.roomConfig,
            seats: this._cloneSeats()
          });

          this._broadcast({
            type: 'roster',
            seats: this._cloneSeats(),
            roomConfig: this.roomConfig
          });

          this._emit('onRosterUpdate', {
            seats: this._cloneSeats(),
            event: `${freeSlot.colorName}（${freeSlot.nickname}）已加入房間！`
          });
          return;
        }

        if (assignedSeat === -1) return;
        this.peerLastSeen.set(assignedSeat, Date.now());

        if (msg.type === 'ping') {
          this._send(conn, { type: 'pong', t: msg.t || Date.now() });
          return;
        }
        if (msg.type === 'pong') {
          return;
        }

        if (msg.type === 'forfeit') {
          const slot = this.seats[assignedSeat];
          const leftName = (slot && slot.nickname) || msg.name || `玩家 ${assignedSeat + 1}`;
          if (slot) slot.connected = false;
          this.guestConns.delete(assignedSeat);
          if (this.matchStarted) {
            this._emit('onOpponentLeft', { seat: assignedSeat, name: leftName, explicit: true });
          }
          try { conn.close(); } catch (_) {}
          return;
        }

        if (msg.type === 'action') {
          this._emit('onRemoteAction', { seat: assignedSeat, action: msg.action });
        } else if (msg.type === 'chat') {
          const text = String(msg.text || '').trim().slice(0, 80);
          if (!text) return;
          const sender = this.seats[assignedSeat];
          const chatPacket = {
            type: 'chat',
            seat: assignedSeat,
            name: sender ? `${sender.colorName}·${sender.nickname}` : `玩家 ${assignedSeat + 1}`,
            text
          };
          this._broadcast(chatPacket);
          this._emit('onChat', chatPacket);
        }
      });

      const onDrop = () => {
        if (assignedSeat === -1) return;
        const currentConn = this.guestConns.get(assignedSeat);
        if (currentConn !== conn) return;

        const wasConnected = this.guestConns.has(assignedSeat);
        this.guestConns.delete(assignedSeat);
        const slot = this.seats[assignedSeat];
        const droppedName = slot ? `${slot.colorName}（${slot.nickname}）` : `席位 ${assignedSeat + 1}`;
        const rawLeftName = (slot && slot.nickname) || `玩家 ${assignedSeat + 1}`;
        if (slot) {
          slot.connected = false;
          if (!this.matchStarted) slot.nickname = '';
        }

        if (this.matchStarted && wasConnected) {
          this._emit('onOpponentLeft', { seat: assignedSeat, name: rawLeftName, explicit: false });
          return;
        }

        this._broadcast({
          type: 'roster',
          seats: this._cloneSeats(),
          roomConfig: this.roomConfig,
          notice: `${droppedName} 已離線`
        });

        this._emit('onRosterUpdate', {
          seats: this._cloneSeats(),
          event: `${droppedName} 已離線`,
          disconnectedSeat: assignedSeat
        });
      };

      conn.on('close', onDrop);
      conn.on('error', onDrop);
    }

    // Host starts or restarts the match, filling any unfilled seats with AI if allowed
    hostStartMatch(initialSnapshot) {
      if (!this.isHost()) return;
      this.matchStarted = true;
      for (const s of this.seats) {
        if (!s.connected) {
          s.isAI = true;
          s.nickname = 'AI 補位';
        }
      }
      this._broadcast({
        type: 'start',
        seats: this._cloneSeats(),
        roomConfig: this.roomConfig,
        snapshot: initialSnapshot
      });
      this._startMatchKeepalive();
    }

    broadcastState(snapshot, meta = {}) {
      if (!this.isHost()) return;
      this._broadcast({
        type: 'state',
        snapshot,
        sound: meta.sound || null,
        toast: meta.toast || null,
        previewMove: meta.previewMove || null
      });
    }

    // ==================== PUBLIC RANKED QUEUE (HUMAN-FIRST MULTI-SLOT LOBBY) ====================
    enterRankedQueue({ nickname, rp = 1200, onMatched, onQueueWaiting, onQueueFallback }) {
      if (!this.isPeerJSAvailable()) {
        if (onQueueFallback) onQueueFallback('offline');
        return;
      }

      this.disconnect(true);
      const cleanName = sanitizeName(nickname, '策略玩家');
      const displayWithRp = `${cleanName} (${rp})`;
      let settled = false;

      // Phase 1: Scan all 6 public lobby slots simultaneously for any WAITING real human!
      const probePeer = new global.Peer(undefined, { config: { iceServers: ICE_SERVERS } });
      this.peer = probePeer;
      this.role = 'guest';
      this.roomCode = 'RANKED';
      const probeConns = [];

      const cleanupUnusedProbes = (keepConn) => {
        for (const c of probeConns) {
          if (c !== keepConn) {
            try { c.close(); } catch (_) {}
          }
        }
      };

      const switchToWaitAsHost = () => {
        if (settled || this.peer !== probePeer) return;
        settled = true;
        cleanupUnusedProbes(null);
        this._claimOpenRankedSlot(1, cleanName, displayWithRp, rp, onMatched, onQueueWaiting, onQueueFallback);
      };

      // Give PeerJS 2.2s to find an already-waiting human across all 6 slots; if none, become waiting Host!
      const probeTimeout = setTimeout(switchToWaitAsHost, 2200);

      probePeer.on('open', () => {
        if (settled || this.peer !== probePeer) return;
        for (let slot = 1; slot <= RANKED_SLOT_COUNT; slot++) {
          const targetId = RANKED_SLOT_PREFIX + String(slot).padStart(2, '0');
          const conn = probePeer.connect(targetId, { reliable: true });
          probeConns.push(conn);

          conn.on('open', () => {
            if (settled || this.peer !== probePeer) {
              try { conn.close(); } catch (_) {}
              return;
            }
            this._send(conn, { type: 'join', name: displayWithRp, rp });
          });

          conn.on('data', (msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'welcome' && !settled && this.peer === probePeer) {
              settled = true;
              clearTimeout(probeTimeout);
              cleanupUnusedProbes(conn);
              this.hostConn = conn;
              this.mySeat = msg.seat;
              this.roomCode = 'RANKED';
              this.roomConfig = msg.roomConfig;
              this.seats = msg.seats;
              if (onMatched) onMatched({ role: 'guest', seats: this._cloneSeats() });
              return;
            }
            if (msg.type === 'error' && !settled) {
              try { conn.close(); } catch (_) {}
              return;
            }
            if (conn !== this.hostConn) return;
            if (msg.type === 'start') {
              this.matchStarted = true;
              this.seats = msg.seats;
              this.roomConfig = msg.roomConfig;
              this._emit('onMatchStart', { seats: this._cloneSeats(), roomConfig: this.roomConfig, snapshot: msg.snapshot });
              return;
            }
            if (msg.type === 'state') {
              this._emit('onStateSync', msg);
              return;
            }
            if (msg.type === 'chat') {
              this._emit('onChat', msg);
            }
          });

          conn.on('close', () => {
            if (settled && conn === this.hostConn && this.peer === probePeer) {
              this.disconnect(true);
              this._emit('onDisconnected', { reason: '積分對手已離線' });
            }
          });
        }
      });

      probePeer.on('error', (err) => {
        // 'peer-unavailable' is normal for empty slots — ignore so remaining slots/timeout continue!
        if (err && err.type === 'peer-unavailable') return;
        clearTimeout(probeTimeout);
        switchToWaitAsHost();
      });
    }

    // Phase 2: Claim the first open public slot (01..06) and wait for a real human challenger!
    _claimOpenRankedSlot(slotNum, cleanName, displayWithRp, rp, onMatched, onQueueWaiting, onQueueFallback) {
      if (slotNum > RANKED_SLOT_COUNT) {
        this.disconnect(true);
        if (onQueueFallback) onQueueFallback('full');
        return;
      }

      this.disconnect(true);
      this.role = 'host';
      this.mySeat = 0;
      this.roomCode = 'RANKED';
      this.matchStarted = false;
      this.roomConfig = {
        ruleVariant: 'v2',
        numPlayers: 2,
        openingStyle: 'classic',
        aiLevel: 'medium',
        timerEnabled: true,
        matchCategory: 'ranked'
      };
      this.seats = [
        { seat: 0, colorName: '玩家 1', nickname: displayWithRp, rp, connected: true, isHost: true, isAI: false },
        { seat: 1, colorName: '玩家 2', nickname: '', rp: 1200, connected: false, isHost: false, isAI: false }
      ];

      const slotId = RANKED_SLOT_PREFIX + String(slotNum).padStart(2, '0');
      const hostPeer = new global.Peer(slotId, { config: { iceServers: ICE_SERVERS } });
      this.peer = hostPeer;

      hostPeer.on('open', () => {
        if (this.peer !== hostPeer) return;
        if (onQueueWaiting) onQueueWaiting(slotNum);
      });

      hostPeer.on('connection', (conn) => {
        if (this.peer !== hostPeer) return;
        if (this.matchStarted || this.seats[1].connected) {
          conn.on('open', () => {
            this._send(conn, { type: 'error', message: '此排隊席位已配對中' });
            setTimeout(() => { try { conn.close(); } catch (_) {} }, 150);
          });
          return;
        }
        this._handleIncomingGuest(conn);
        conn.on('data', (msg) => {
          if (msg && msg.type === 'join' && !this.matchStarted) {
            const seatsSnap = this._cloneSeats();
            if (seatsSnap[1] && !seatsSnap[1].nickname && msg.name) {
              seatsSnap[1].nickname = sanitizeName(msg.name, '挑戰者');
            }
            if (onMatched) onMatched({ role: 'host', seats: seatsSnap, opponentRp: Number(msg.rp) || 1200 });
          }
        });
      });

      hostPeer.on('error', (err) => {
        if (this.peer !== hostPeer) return;
        if (err && err.type === 'unavailable-id') {
          // This slot is already occupied by an active match -> try next slot!
          this._claimOpenRankedSlot(slotNum + 1, cleanName, displayWithRp, rp, onMatched, onQueueWaiting, onQueueFallback);
          return;
        }
        this.disconnect(true);
        if (onQueueFallback) onQueueFallback('error');
      });
    }

    // ==================== GUEST FLOW ====================
    joinRoom(rawCode, guestName, options = {}) {
      if (!this.isPeerJSAvailable()) {
        this._emit('onError', '無法載入連線模組（PeerJS），請確認網路連線正常後重新整理頁面。');
        return;
      }

      const code = sanitizeCode(rawCode);
      if (code.length < 4) {
        this._emit('onError', '請輸入正確的 6 碼房間代碼。');
        return;
      }

      const maxRetries = Number(options.maxRetries) || 0;
      const retryDelayMs = Number(options.retryDelayMs) || 1000;
      const attempt = Number(options._attempt) || 0;

      this.disconnect(true);
      this.role = 'guest';
      this.roomCode = code;
      const cleanName = sanitizeName(guestName, '挑戰者');

      this._emit('onStatus', attempt > 0 ? `正在重試連線對手（第 ${attempt + 1} 次）…` : `正在連線至房間 ${code}…`);

      const peer = new global.Peer(undefined, {
        config: { iceServers: ICE_SERVERS }
      });
      this.peer = peer;

      let handshakeDone = false;
      let retrying = false;
      const scheduleRetryOrError = (errMsg, allowRetry) => {
        if (retrying || handshakeDone || this.peer !== peer) return;
        clearTimeout(connectTimeout);
        if (allowRetry && attempt < maxRetries) {
          retrying = true;
          try { peer.destroy(); } catch (_) {}
          if (this.peer === peer) this.peer = null;
          setTimeout(() => {
            if (this.role === 'guest' && this.roomCode === code && !this.matchStarted) {
              this.joinRoom(code, cleanName, {
                maxRetries,
                retryDelayMs,
                _attempt: attempt + 1
              });
            }
          }, retryDelayMs);
          return;
        }
        this.disconnect(true);
        this._emit('onError', errMsg);
      };

      const connectTimeout = setTimeout(() => {
        if (!handshakeDone && this.peer === peer) {
          scheduleRetryOrError(
            `連線逾時：找不到房間「${code}」或網路防火牆阻擋，請確認房號是否正確。`,
            attempt < maxRetries
          );
        }
      }, maxRetries > 0 ? 4500 : 12000);

      peer.on('open', () => {
        if (this.peer !== peer) return;
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
        this.hostConn = conn;

        conn.on('open', () => {
          this._send(conn, { type: 'join', name: cleanName });
        });

        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          this.hostLastSeen = Date.now();

          if (msg.type === 'ping') {
            this._send(conn, { type: 'pong', t: msg.t || Date.now() });
            return;
          }
          if (msg.type === 'pong') {
            return;
          }

          if (msg.type === 'error') {
            clearTimeout(connectTimeout);
            this.disconnect(true);
            this._emit('onError', msg.message || '無法加入房間');
            return;
          }

          if (msg.type === 'welcome') {
            handshakeDone = true;
            clearTimeout(connectTimeout);
            this.mySeat = msg.seat;
            this.roomCode = msg.roomCode;
            this.roomConfig = msg.roomConfig;
            this.seats = msg.seats;
            this._emit('onRoomReady', {
              role: 'guest',
              roomCode: this.roomCode,
              mySeat: this.mySeat,
              roomConfig: this.roomConfig,
              seats: this._cloneSeats()
            });
            return;
          }

          if (msg.type === 'roster') {
            this.seats = msg.seats;
            if (msg.roomConfig) this.roomConfig = msg.roomConfig;
            this._emit('onRosterUpdate', {
              seats: this._cloneSeats(),
              event: msg.notice || null
            });
            return;
          }

          if (msg.type === 'start') {
            this.matchStarted = true;
            this.seats = msg.seats;
            this.roomConfig = msg.roomConfig;
            this._startMatchKeepalive();
            this._emit('onMatchStart', {
              seats: this._cloneSeats(),
              roomConfig: this.roomConfig,
              snapshot: msg.snapshot
            });
            return;
          }

          if (msg.type === 'state') {
            this._emit('onStateSync', msg);
            return;
          }

          if (msg.type === 'forfeit') {
            const hostName = (this.seats[0] && this.seats[0].nickname) || msg.name || '對手';
            const wasStarted = this.matchStarted;
            this.matchStarted = false;
            if (wasStarted) {
              this._emit('onOpponentLeft', { seat: msg.seat ?? 0, name: hostName, explicit: true });
            }
            return;
          }

          if (msg.type === 'chat') {
            this._emit('onChat', msg);
          }
        });

        conn.on('close', () => {
          clearTimeout(connectTimeout);
          if (this.peer !== peer) return;
          if (!handshakeDone) {
            scheduleRetryOrError('與房主的連線已中斷', true);
            return;
          }
          if (this.matchStarted) {
            const hostName = (this.seats[0] && this.seats[0].nickname) || '對手';
            const savedSeat = this.mySeat;
            const savedRoom = this.roomCode;
            this.matchStarted = false;
            this._stopMatchKeepalive();
            this._emit('onOpponentLeft', { seat: 0, mySeat: savedSeat, roomCode: savedRoom, name: hostName, explicit: false });
            this.disconnect(true);
            return;
          }
          this.disconnect(true);
          this._emit('onDisconnected', { reason: '與房主的連線已中斷' });
        });

        conn.on('error', () => {
          clearTimeout(connectTimeout);
          if (this.peer !== peer) return;
          scheduleRetryOrError('與房主連線發生錯誤，請確認房號並重試。', !handshakeDone);
        });
      });

      peer.on('error', (err) => {
        clearTimeout(connectTimeout);
        if (this.peer !== peer) return;
        const isUnavailable = Boolean(err && err.type === 'peer-unavailable');
        const msg = isUnavailable
          ? `找不到房間「${code}」，請確認房主已建立房間且房號正確。`
          : `連線失敗：${err ? (err.message || err.type) : '未知錯誤'}`;
        scheduleRetryOrError(msg, isUnavailable || !handshakeDone);
      });
    }

    // Guest sends action intent to Host
    sendAction(action) {
      if (this.role !== 'guest' || !this.hostConn) return false;
      return this._send(this.hostConn, { type: 'action', action });
    }

    // Either Host or Guest explicitly notifies opponent of mid-match forfeit/leave
    sendForfeit(name = '') {
      if (!this.isOnline()) return false;
      const packet = {
        type: 'forfeit',
        seat: this.mySeat,
        name: sanitizeName(name, '對手')
      };
      if (this.isHost()) {
        this._broadcast(packet);
        return true;
      }
      if (this.hostConn) {
        return this._send(this.hostConn, packet);
      }
      return false;
    }

    // Either Host or Guest sends room chat
    sendChat(rawText) {
      const text = String(rawText || '').trim().slice(0, 80);
      if (!text || !this.isOnline()) return false;

      if (this.isHost()) {
        const me = this.seats[0];
        const packet = {
          type: 'chat',
          seat: 0,
          name: me ? `${me.colorName}·${me.nickname}` : '紅方·房主',
          text
        };
        this._broadcast(packet);
        this._emit('onChat', packet);
        return true;
      } else if (this.hostConn) {
        return this._send(this.hostConn, { type: 'chat', text });
      }
      return false;
    }

    _send(conn, data) {
      try {
        if (conn && conn.open) {
          conn.send(data);
          return true;
        }
      } catch (_) {}
      return false;
    }

    _broadcast(data) {
      for (const conn of this.guestConns.values()) {
        this._send(conn, data);
      }
    }

    _cloneSeats() {
      return this.seats.map(s => ({ ...s }));
    }

    getInviteUrl() {
      if (!this.roomCode) return '';
      if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
        const url = new URL(window.location.href);
        url.searchParams.set('room', this.roomCode);
        return url.toString();
      }
      return '';
    }
  }

  global.WallGoNetwork = WallGoNetwork;
})(window);
