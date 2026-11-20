(function (global) {
  'use strict';

  const API_CANDIDATES = ['/api/wallgo', 'api.php'];

  class WallGoLobbyHub {
    constructor(stats, handlers = {}) {
      this.stats = stats;
      this.handlers = handlers;

      this.apiUrl = API_CANDIDATES[0];
      this.apiResolved = false;

      this.clientId = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
      this.mode = 'detecting'; // 'detecting' | 'server' | 'local'
      this.myName = stats.hasRegisteredId() ? stats.getNickname() : '';
      this.myStatus = 'offline'; // 'offline' | 'online' | 'queuing' | 'playing'
      this.myAnnounced = false;
      this.onlineCount = 1;
      this.lastEventId = 0;

      this.pollTimer = null;
      this.inFlightHeartbeat = false;
      this.destroyed = false;

      this._onUnload = () => this._sendOfflineBeacon();
      global.addEventListener('beforeunload', this._onUnload);
      global.addEventListener('pagehide', this._onUnload);
    }

    _emit(name, payload) {
      if (this.handlers && typeof this.handlers[name] === 'function') {
        this.handlers[name](payload);
      }
    }

    _isHttpOrigin() {
      try {
        return global.location && (global.location.protocol === 'http:' || global.location.protocol === 'https:');
      } catch (_) {
        return false;
      }
    }

    start() {
      this.destroyed = false;
      if (!this._isHttpOrigin()) {
        this.mode = 'local';
        this._updateLocalOnlyPresence();
        return;
      }
      this.refreshStateFromServer();
    }

    destroy() {
      this.destroyed = true;
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
      global.removeEventListener('beforeunload', this._onUnload);
      global.removeEventListener('pagehide', this._onUnload);
    }

    // ==================== HTTP API HELPERS ====================
    async _apiGetFrom(url, action, params = {}) {
      const qs = new URLSearchParams({ action, _t: String(Date.now()), ...params });
      const res = await fetch(`${url}?${qs.toString()}`, {
        method: 'GET',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error('HTTP_' + res.status);
      const text = await res.text();
      if (!text || text.trim()[0] !== '{') throw new Error('NON_JSON_RESPONSE');
      return JSON.parse(text);
    }

    async _apiPostTo(url, action, payload = {}) {
      const res = await fetch(`${url}?action=${encodeURIComponent(action)}&_t=${Date.now()}`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('HTTP_' + res.status);
      const text = await res.text();
      if (!text || text.trim()[0] !== '{') throw new Error('NON_JSON_RESPONSE');
      return JSON.parse(text);
    }

    async _apiGet(action, params = {}) {
      return this._apiGetFrom(this.apiUrl, action, params);
    }

    async _apiPost(action, payload = {}) {
      return this._apiPostTo(this.apiUrl, action, payload);
    }

    _applyServerPayload(data) {
      if (!data || typeof data !== 'object') return;
      if (data.shared) {
        this.stats.applyAuthoritativeServerState({
          shared: data.shared,
          presenceMap: data.presenceMap || {},
          myHistory: Array.isArray(data.myHistory) ? data.myHistory : undefined
        });
      }
      if (Number.isFinite(Number(data.onlineCount))) {
        this.onlineCount = Math.max(1, Number(data.onlineCount));
      }
      if (Number.isFinite(Number(data.latestEventId)) && Number(data.latestEventId) > this.lastEventId) {
        this.lastEventId = Number(data.latestEventId);
      }

      // Emit join toast for other players
      if (Array.isArray(data.events) && data.events.length) {
        const myNorm = (this.myName || '').trim().toLowerCase();
        for (const ev of data.events) {
          if (ev && ev.type === 'user_joined' && ev.name) {
            if (String(ev.name).trim().toLowerCase() !== myNorm) {
              this._emit('onUserJoined', { name: ev.name });
            }
          }
        }
      }

      this._emit('onLobbySync', {
        onlineCount: this.onlineCount,
        presenceMap: data.presenceMap || {}
      });

      if (data.matched && data.matched.matchCode) {
        this.myStatus = 'playing';
        this._emit('onQueueMatched', data.matched);
      }

      if (data.forfeitNotice && data.forfeitNotice.leftName) {
        this._emit('onOpponentForfeitNotice', data.forfeitNotice);
      }
    }

    // ==================== INITIAL LOAD & POLLING ====================
    async refreshStateFromServer() {
      if (!this._isHttpOrigin()) {
        this.mode = 'local';
        this._updateLocalOnlyPresence();
        return false;
      }
      const currentName = this.stats.hasRegisteredId() ? this.stats.getNickname() : '';
      const candidates = this.apiResolved ? [this.apiUrl] : API_CANDIDATES;
      let data = null;

      for (const candidate of candidates) {
        try {
          const res = await this._apiGetFrom(candidate, 'state', currentName ? { name: currentName } : {});
          if (res && res.ok) {
            this.apiUrl = candidate;
            this.apiResolved = true;
            data = res;
            break;
          }
        } catch (_) {
          // Try next endpoint candidate (/api/wallgo -> api.php)
        }
      }

      if (data && data.ok) {
        this.mode = 'server';
        // If server database was reset and no longer contains our cached ID,
        // automatically clear the stale local session so the user re-registers cleanly!
        if (currentName && data.shared && Array.isArray(data.shared.registeredIds)) {
          const normCur = currentName.trim().toLowerCase();
          const existsOnServer = data.shared.registeredIds.some(
            id => String(id || '').trim().toLowerCase() === normCur
          );
          if (!existsOnServer) {
            this.stats.logoutLocalSession();
            this.myName = '';
            this.myStatus = 'offline';
          } else {
            this.myName = currentName;
          }
        } else {
          this.myName = currentName;
        }
        this._applyServerPayload(data);
        // If the page restored directly into Ranked Lobby on reload, immediately send presence heartbeat!
        if (this.myName && this.myStatus !== 'offline') {
          this._sendHeartbeat(false);
        } else {
          this._schedulePoll();
        }
        return true;
      }

      // Server API not available (e.g. pure static host) -> local fallback
      if (this.mode === 'detecting') {
        this.mode = 'local';
        this._updateLocalOnlyPresence();
      }
      return false;
    }

    _schedulePoll() {
      clearTimeout(this.pollTimer);
      if (this.destroyed || this.mode !== 'server') return;
      const delay = (this.myStatus === 'queuing') ? 2000
        : (this.myStatus === 'playing') ? 2500
        : (this.myStatus === 'online') ? 3000
        : 8000;
      this.pollTimer = setTimeout(() => {
        this._sendHeartbeat(false);
      }, delay);
    }

    async _sendHeartbeat(justLoggedIn = false) {
      if (this.destroyed || this.mode !== 'server') return;
      if (this.inFlightHeartbeat && !justLoggedIn) {
        this._schedulePoll();
        return;
      }
      this.inFlightHeartbeat = true;
      try {
        const data = await this._apiPost('heartbeat', {
          clientId: this.clientId,
          name: this.myName || (this.stats.hasRegisteredId() ? this.stats.getNickname() : ''),
          status: this.myStatus,
          justLoggedIn: Boolean(justLoggedIn),
          sinceEventId: this.lastEventId
        });
        if (data && data.ok) {
          this._applyServerPayload(data);
        }
      } catch (_) {
        // Transient network hiccup: keep retrying on next poll tick
      } finally {
        this.inFlightHeartbeat = false;
        this._schedulePoll();
      }
    }

    _sendOfflineBeacon() {
      if (this.mode !== 'server' || !this.myName || this.myStatus === 'offline') return;
      const payload = JSON.stringify({
        clientId: this.clientId,
        name: this.myName,
        status: 'offline',
        justLoggedIn: false,
        sinceEventId: this.lastEventId
      });
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
          navigator.sendBeacon(`${this.apiUrl}?action=heartbeat`, blob);
        }
      } catch (_) {}
    }

    // ==================== AUTHENTICATION (ID + 4-DIGIT PIN) ====================
    async authenticate(rawName, rawPin, callback) {
      const clean = String(rawName || '').replace(/[<>&"']/g, '').trim().slice(0, 14);
      const pin = String(rawPin || '').trim();
      if (!clean) {
        callback({ ok: false, reason: '請先輸入你的玩家 ID（請勿只輸入特殊符號）' });
        return;
      }
      if (!/^\d{4}$/.test(pin)) {
        callback({ ok: false, reason: '請設定或輸入 4 位數字密碼（例如 1234）' });
        return;
      }

      if (this._isHttpOrigin() && this.mode !== 'local') {
        const candidates = this.apiResolved ? [this.apiUrl] : API_CANDIDATES;
        for (const candidate of candidates) {
          try {
            const data = await this._apiPostTo(candidate, 'auth', { name: clean, pin });
            if (data && data.ok) {
              this.apiUrl = candidate;
              this.apiResolved = true;
              this.mode = 'server';
              this.myName = data.name || clean;
              this.stats.applyServerLogin({
                name: this.myName,
                shared: data.shared,
                presenceMap: data.presenceMap || {},
                myHistory: Array.isArray(data.myHistory) ? data.myHistory : []
              });
              if (Number.isFinite(Number(data.onlineCount))) {
                this.onlineCount = Math.max(1, Number(data.onlineCount));
              }
              if (Number.isFinite(Number(data.latestEventId))) {
                this.lastEventId = Number(data.latestEventId);
              }
              this._emit('onLobbySync', { onlineCount: this.onlineCount, presenceMap: data.presenceMap || {} });
              this._schedulePoll();
              callback({ ok: true, mode: data.mode || 'login', name: this.myName });
              return;
            }
            if (data && data.ok === false) {
              this.apiUrl = candidate;
              this.apiResolved = true;
              this.mode = 'server';
              callback({ ok: false, code: data.code || 'auth_failed', reason: data.reason || '登入失敗，請檢查 ID 與密碼' });
              return;
            }
          } catch (_) {
            // Try next API candidate
          }
        }
        // If no server API exists, fall back to local mode
        this.mode = 'local';
      }

      const localRes = this.stats.localAuthenticate(clean, pin);
      if (localRes.ok) {
        this.myName = localRes.name;
        this._updateLocalOnlyPresence();
      }
      callback(localRes);
    }

    // ==================== PRESENCE & MATCHMAKING ====================
    announceLobbyLogin(name, opts = {}) {
      this.myName = name || this.stats.getNickname();
      const firstAnnounce = !this.myAnnounced && !opts.silent;
      this.myAnnounced = true;
      this.myStatus = 'online';
      this.stats.ensureHumanOnLadder(this.myName, this.stats.getRP());

      if (this.mode === 'server') {
        this._sendHeartbeat(firstAnnounce);
      } else {
        this._updateLocalOnlyPresence();
      }
    }

    setMyStatus(status) {
      this.myStatus = status || 'offline';
      if (this.myStatus === 'offline') {
        this.myAnnounced = false;
      }
      if (this.mode === 'server') {
        this._sendHeartbeat(false);
      } else {
        this._updateLocalOnlyPresence();
      }
    }

    // ==================== RANKED MATCH REPORTING ====================
    reportRankedMatch(payload) {
      // payload: { matchId, playerAName, playerBName, bIsAI, rivalId, outcomeForA, replayRecord }
      if (this.mode === 'server' || (this.mode === 'detecting' && this._isHttpOrigin())) {
        this._apiPost('report_match', payload).then((data) => {
          if (data && data.ok) {
            this.mode = 'server';
            this._applyServerPayload(data);
            this._emit('onMatchAck', data);
          }
        }).catch(() => {
          // Fallback local calculation if network dropped at match end
          const fallback = this.stats.applyGlobalRankedMatch(payload);
          this._emit('onMatchAck', fallback);
          this._emit('onLobbySync', { onlineCount: this.onlineCount });
        });
        return null;
      }

      const res = this.stats.applyGlobalRankedMatch(payload);
      this._emit('onLobbySync', { onlineCount: this.onlineCount });
      return res;
    }

    reportRankedMatchBeacon(payload) {
      if (this.mode !== 'server' || !payload) return false;
      try {
        if (navigator.sendBeacon) {
          let bodyStr = JSON.stringify(payload);
          // Keep sendBeacon safely under browser 64KB cap if match had many steps
          if (bodyStr.length > 48000 && payload.replayRecord) {
            const slim = { ...payload, replayRecord: { ...payload.replayRecord, steps: [] } };
            bodyStr = JSON.stringify(slim);
          }
          const blob = new Blob([bodyStr], { type: 'text/plain;charset=UTF-8' });
          return navigator.sendBeacon(`${this.apiUrl}?action=report_match`, blob);
        }
      } catch (_) {}
      return false;
    }

    saveServerReplay(name, record) {
      if (this.mode !== 'server' || !name || !record) return;
      this._apiPost('save_replay', { name, record }).then((data) => {
        if (data && data.ok) this._applyServerPayload(data);
      }).catch(() => {});
    }

    _updateLocalOnlyPresence() {
      const map = {};
      if (this.myName && this.myStatus !== 'offline') map[this.myName] = this.myStatus;
      this.stats.setPresenceMap(map);
      this.onlineCount = 1;
      this._emit('onLobbySync', { onlineCount: 1, presenceMap: map });
    }
  }

  global.WallGoLobbyHub = WallGoLobbyHub;
})(window);
