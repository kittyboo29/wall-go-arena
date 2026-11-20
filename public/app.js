(function (global) {
  'use strict';

  const { BOARD_SIZE, COLS } = global.WALLGO_CONST;
  const SoundFX = global.SoundFX;
  const Stats = global.WallGoStats;

  const PLAYER_COLORS = ['var(--p0)', 'var(--p1)', 'var(--p2)'];
  const THINK_TIME_MS = 90 * 1000;
  const WALL_TIME_MS = 30 * 1000;
  const HOST_GRACE_MS = WALL_TIME_MS + 3000;
  const ACTIVE_MATCH_KEY = 'wallgo_active_match_v1';

  class WallGoApp {
    constructor() {
      this.view = 'landing'; // 'landing' | 'arena'
      this.matchCategory = 'solo'; // 'solo' | 'friends' | 'ranked'
      this.currentRankedRival = null; // { id, name, rp, aiLevel } when quick-matched
      this.lastCompletedRecord = null;
      this.matchRecorded = false;

      this.config = {
        ruleVariant: 'v2',
        numPlayers: 2,
        gameMode: 'ai',
        aiLevel: 'medium',
        openingStyle: 'classic',
        timerEnabled: false
      };

      this.onlineConfig = {
        ruleVariant: 'v2',
        numPlayers: 2,
        openingStyle: 'classic',
        aiLevel: 'medium',
        timerEnabled: false,
        matchCategory: 'friends'
      };

      this.engine = new global.WallGoEngine(this.config);
      this.undoStack = [];

      // Local interactive sub-state
      this.selectedPieceId = null;
      this.validDests = [];
      this.pendingMove = null;
      this.hammerMode = false;

      // Turn Countdown Timer
      this.timerInterval = null;
      this.timerPhase = null;
      this.timerDeadline = 0;
      this.timerTotalMs = THINK_TIME_MS;
      this.savedThinkMs = THINK_TIME_MS;
      this.lastTickSec = -1;
      this.lastTurnKey = '';

      // AI scheduling
      this.aiBusy = false;
      this.aiToken = 0;
      this.aiPreviewPiecePos = null;
      this.prevLockedSum = 0;

      // Replay Theater state
      this.replay = {
        active: false,
        record: null,
        stepIndex: 0,
        playing: false,
        timer: null,
        speed: 1, // 0.5 | 1 | 2
        engine: null
      };

      // Ranked Lobby & Indefinite Queue state
      this.mmTimer = null;
      this.queueElapsedTimer = null;
      this.queueStartedAt = 0;
      this.isQueuingHuman = false;
      this.isConnectingMatch = false;
      this.matchConnectWatchdog = null;
      this.rankedP2PContext = null; // { role, matchCode, opponentName, opponentRp }
      this.pendingRankedAutoStart = false;
      this.replayReturnToLobby = false;
      this.pendingLeaveAction = null;
      this.allowUnloadOnce = false;
      this.activeOnlineRoomCode = '';
      this.myLocalSeat = 0;
      this.firstDrawActive = false;
      this.firstDrawTimers = [];

      this.pieceElements = new Map();
      this.toastTimer = null;
      this.calloutTimer = null;
      this.soulsTimer = null;
      this.lastAnnouncedTurn = '';
      this.confettiRaf = null;
      this.confettiWaveTimers = [];
      this.confettiParticles = [];

      this.hub = new global.WallGoLobbyHub(Stats, {
        onLobbySync: () => this._onGlobalLobbySync(),
        onUserJoined: ({ name }) => {
          SoundFX.select();
          this.showToast(`🟢 ${name} 已登入線上積分大廳！`);
          this._onGlobalLobbySync();
        },
        onQueueMatched: (info) => this._onGlobalQueueMatched(info),
        onOpponentForfeitNotice: (notice) => {
          if (this._isActiveMatchInProgress()) {
            this._onOpponentLeft({
              name: notice.leftName,
              explicit: true,
              serverSettled: true,
              rpDelta: notice.rpDelta,
              newRp: notice.newRp
            });
          } else {
            this._syncProfileUI();
            if (this.view === 'ranked_lobby') this._renderRankedLobbyView();
            const d = Number.isFinite(notice.rpDelta) ? `+${notice.rpDelta} RP` : '';
            this.showToast(`🏆 對手「${notice.leftName}」已離開前場對局，判定你直接獲勝！${d ? `（${d}）` : ''}`);
          }
        },
        onMatchAck: (res) => {
          this._onGlobalLobbySync();
          if (res && Number.isFinite(res.rpDeltaA)) {
            if (this.lastCompletedRecord) this.lastCompletedRecord.rpDelta = res.rpDeltaA;
            if (this.matchCategory === 'ranked' && this.el.modalGameover && !this.el.modalGameover.classList.contains('hidden')) {
              const d = res.rpDeltaA;
              const newRp = Number.isFinite(res.newRpA) ? res.newRpA : Stats.getRP();
              const tier = Stats.getTierInfo(newRp);
              this.el.rpDeltaBanner.classList.remove('hidden', 'pos', 'neg');
              this.el.rpDeltaBanner.classList.add(d >= 0 ? 'pos' : 'neg');
              this.el.rpDeltaBanner.textContent = `🏆 積分結算：${d >= 0 ? '+' : ''}${d} RP → 目前 ${newRp} RP（${tier.name} · 全服第 #${Stats.getMyRank()} 名）`;
            }
          }
        }
      });

      this.net = new global.WallGoNetwork({
        onStatus: (msg) => this._setOnlineStatus(msg, false),
        onError: (msg) => this._setOnlineStatus(msg, true),
        onRoomReady: (info) => this._onRoomReady(info),
        onRosterUpdate: (info) => this._onRosterUpdate(info),
        onMatchStart: (info) => this._onRemoteMatchStart(info),
        onRemoteAction: (info) => this._onRemoteAction(info),
        onStateSync: (msg) => this._onStateSync(msg),
        onChat: (msg) => this._appendChatMessage(msg),
        onOpponentLeft: (info) => this._onOpponentLeft(info),
        onDisconnected: (info) => this._onOnlineDisconnected(info)
      });

      this._cacheDOM();
      this._buildBoardSkeleton();
      this._bindEvents();
      this._syncProfileUI();
      this._syncSetupModalFromConfig();
      const hasInvite = this._checkInviteLink();
      if (!hasInvite) this._restoreRouteOnLoad();
      this.hub.start();
      this._resolveAbandonedMatchOnLoad();
      this.render();
    }

    _cacheDOM() {
      const $ = (id) => document.getElementById(id);
      this.el = {
        // Views
        viewLanding: $('view-landing'),
        viewRankedLobby: $('view-ranked-lobby'),
        viewArena: $('view-arena'),

        // Ranked Personal Profile Lobby elements
        btnRlBack: $('btn-rl-back'),
        btnRlRules: $('btn-rl-rules'),
        rlOnlineCount: $('rl-online-count'),
        rlPlayerName: $('rl-player-name'),
        rlTierBadge: $('rl-tier-badge'),
        rlRp: $('rl-rp'),
        rlRank: $('rl-rank'),
        rlWinrate: $('rl-winrate'),
        rlSegWin: $('rl-seg-win'),
        rlSegDraw: $('rl-seg-draw'),
        rlSegLoss: $('rl-seg-loss'),
        rlWins: $('rl-wins'),
        rlLosses: $('rl-losses'),
        rlDraws: $('rl-draws'),
        rlActionBtns: $('rl-action-btns'),
        btnRlVsAi: $('btn-rl-vs-ai'),
        btnRlQueueHuman: $('btn-rl-queue-human'),
        rlQueueBox: $('rl-queue-box'),
        rlQueueTitle: $('rl-queue-title'),
        rlQueueTimer: $('rl-queue-timer'),
        btnRlLeaveQueue: $('btn-rl-leave-queue'),
        rlRecentList: $('rl-recent-list'),
        rlLbCount: $('rl-lb-count'),
        rlLeaderboardList: $('rl-leaderboard-list'),

        // Landing screen
        landingStepEntry: $('landing-step-entry'),
        entryForm: $('entry-form'),
        entryNewWrap: $('entry-new-wrap'),
        entryCachedWrap: $('entry-cached-wrap'),
        entryCachedName: $('entry-cached-name'),
        btnSwitchAccount: $('btn-switch-account'),
        btnCachedEnter: $('btn-cached-enter'),
        landingNickname: $('landing-nickname'),
        landingPin: $('landing-pin'),
        btnLandingEnter: $('btn-landing-enter'),
        entryErrorMsg: $('entry-error-msg'),
        onlineIdDisplay: $('online-id-display'),
        landingTierBadge: $('landing-tier-badge'),
        landingRpVal: $('landing-rp-val'),
        btnLandingSound: $('btn-landing-sound'),
        btnLandingFs: $('btn-landing-fs'),
        btnMainBack: $('btn-main-back'),
        btnLandingRules: $('btn-landing-rules'),
        landingStepMain: $('landing-step-main'),
        landingStepOnline: $('landing-step-online'),
        landingStepSolo: $('landing-step-solo'),
        cardChooseOnline: $('card-choose-online'),
        cardChooseSolo: $('card-choose-solo'),
        btnOnlineBack: $('btn-online-back'),
        btnSoloBack: $('btn-solo-back'),
        onlineMyRankChip: $('online-my-rank-chip'),
        rankedCardRp: $('ranked-card-rp'),
        soloRecordChip: $('solo-record-chip'),
        btnStartRankedQuick: $('btn-start-ranked-quick'),
        btnFriendCreate: $('btn-friend-create'),
        btnFriendJoin: $('btn-friend-join'),
        soloGroupOpening: $('solo-group-opening'),
        btnSoloLaunch: $('btn-solo-launch'),

        // Arena top utility bar & MENU drawer
        btnArenaMenu: $('btn-arena-menu'),
        arenaMenuDrawer: $('arena-menu-drawer'),
        btnBackLanding: $('btn-back-landing'),
        modeTag: $('mode-tag'),
        onlinePill: $('online-pill'),
        onlinePillText: $('online-pill-text'),
        btnOnline: $('btn-online'),
        btnRules: $('btn-rules'),
        btnSound: $('btn-sound'),
        soundIcon: $('sound-icon'),
        btnBgm: $('btn-bgm'),
        bgmIcon: $('bgm-icon'),
        bgmLabel: $('bgm-label'),
        btnFullscreen: $('btn-fullscreen'),
        fsLabel: $('fs-label'),
        btnUndo: $('btn-undo'),
        btnNewGame: $('btn-new-game'),

        // 50/50 Red-Blue VS Banner
        vsBanner: $('vs-banner'),
        vsSide0: $('vs-side-0'),
        vsSide1: $('vs-side-1'),
        vsSide2: $('vs-side-2'),
        vsScore0: $('vs-score-0'),
        vsScore1: $('vs-score-1'),
        vsScore2: $('vs-score-2'),
        vsName0: $('vs-name-0'),
        vsName1: $('vs-name-1'),
        vsName2: $('vs-name-2'),
        vsTurnPill0: $('vs-turn-pill-0'),
        vsTurnPill1: $('vs-turn-pill-1'),
        vsTurnPill2: $('vs-turn-pill-2'),
        vsTurnCounter: $('vs-turn-counter'),
        turnTimer: $('turn-timer'),
        timerPhaseLabel: $('timer-phase-label'),
        timerClock: $('timer-clock'),
        turnBadge: $('turn-badge'),
        timerBarTrack: $('timer-bar-track'),
        timerBarFill: $('timer-bar-fill'),

        // Tactical Strip
        tacticalStrip: $('tactical-strip'),
        turnDot: $('turn-dot'),
        turnInstruction: $('turn-instruction'),
        btnCancelMove: $('btn-cancel-move'),
        btnHammer: $('btn-hammer'),
        hammerCount: $('hammer-count'),
        btnEndHammer: $('btn-end-hammer'),

        // Replay Theater Bar
        replayBar: $('replay-bar'),
        replayMatchTitle: $('replay-match-title'),
        replayStepCounter: $('replay-step-counter'),
        replayStepDesc: $('replay-step-desc'),
        replaySlider: $('replay-slider'),
        btnReplayExit: $('btn-replay-exit'),
        btnRpFirst: $('btn-rp-first'),
        btnRpPrev: $('btn-rp-prev'),
        btnRpPlay: $('btn-rp-play'),
        btnRpNext: $('btn-rp-next'),
        btnRpLast: $('btn-rp-last'),
        btnRpSpeed: $('btn-rp-speed'),

        // Board
        coordTop: $('coord-top'),
        coordLeft: $('coord-left'),
        cellsLayer: $('cells-layer'),
        wallsLayer: $('walls-layer'),
        piecesLayer: $('pieces-layer'),
        postgameLobbyBar: $('postgame-lobby-bar'),
        btnPostgameLobby: $('btn-postgame-lobby'),

        // Right Dashboard Panels
        arenaDashboard: $('arena-dashboard'),
        panelLeaderboard: $('panel-leaderboard'),
        lbMyTierChip: $('lb-my-tier-chip'),
        leaderboardList: $('leaderboard-list'),
        panelRecord: $('panel-record'),
        recordPanelTitle: $('record-panel-title'),
        recordWinrateChip: $('record-winrate-chip'),
        recordWldGrid: $('record-wld-grid'),
        statWinrate: $('stat-winrate'),
        ratioSegWin: $('ratio-seg-win'),
        ratioSegDraw: $('ratio-seg-draw'),
        ratioSegLoss: $('ratio-seg-loss'),
        statWins: $('stat-wins'),
        statLosses: $('stat-losses'),
        statDraws: $('stat-draws'),
        recentMatchesList: $('recent-matches-list'),

        panelChat: $('panel-chat'),
        chatMessages: $('chat-messages'),
        chatForm: $('chat-form'),
        chatInput: $('chat-input'),
        btnLeaveRoomMini: $('btn-leave-room-mini'),
        turnCounter: $('turn-counter'),
        moveLog: $('move-log'),

        // Modals
        modalSetup: $('modal-setup'),
        modalRules: $('modal-rules'),
        modalGameover: $('modal-gameover'),
        modalOnline: $('modal-online'),
        modalMatchmaking: $('modal-matchmaking'),
        modalLeaveWarn: $('modal-leave-warn'),
        leaveWarnSub: $('leave-warn-sub'),
        btnLeaveConfirm: $('btn-leave-confirm'),
        btnLeaveStay: $('btn-leave-stay'),
        mmTitle: $('mm-title'),
        mmSub: $('mm-sub'),
        btnMmInstantAi: $('btn-mm-instant-ai'),
        btnCancelMm: $('btn-cancel-mm'),

        groupAiLevel: $('group-ai-level'),
        groupOpening: $('group-opening'),
        desc2p: $('desc-2p'),
        desc3p: $('desc-3p'),
        btnStartMatch: $('btn-start-match'),
        btnPlayAgain: $('btn-play-again'),
        btnReplayThisMatch: $('btn-replay-this-match'),
        btnOnlineRematch: $('btn-online-rematch'),
        guestRematchWait: $('guest-rematch-wait'),
        winnerBanner: $('winner-banner'),
        rpDeltaBanner: $('rp-delta-banner'),
        finalScores: $('final-scores'),

        onlineKicker: $('online-kicker'),
        onlineTitle: $('online-title'),
        onlineEntryView: $('online-entry-view'),
        onlineLobbyView: $('online-lobby-view'),
        onlineTabCreate: $('online-tab-create'),
        onlineTabJoin: $('online-tab-join'),
        onlineGroupPlayers: $('online-group-players'),
        onlineGroupOpening: $('online-group-opening'),
        inputNickname: $('input-nickname'),
        inputRoomCode: $('input-room-code'),
        btnCreateRoom: $('btn-create-room'),
        btnJoinRoom: $('btn-join-room'),
        onlineStatusMsg: $('online-status-msg'),

        lobbyRoomCode: $('lobby-room-code'),
        lobbyRuleBadge: $('lobby-rule-badge'),
        lobbySeats: $('lobby-seats'),
        lobbyHint: $('lobby-hint'),
        btnCopyCode: $('btn-copy-code'),
        btnCopyLink: $('btn-copy-link'),
        btnLeaveRoom: $('btn-leave-room'),
        btnHostStart: $('btn-host-start'),

        urgentVignette: $('urgent-vignette'),
        turnCallout: $('turn-callout'),
        firstTurnOverlay: $('first-turn-overlay'),
        ftSplitBg: $('ft-split-bg'),
        ftHalf0: $('ft-half-0'),
        ftHalf1: $('ft-half-1'),
        ftHalf2: $('ft-half-2'),
        ftName0: $('ft-name-0'),
        ftName1: $('ft-name-1'),
        ftName2: $('ft-name-2'),
        ftBadge0: $('ft-badge-0'),
        ftBadge1: $('ft-badge-1'),
        ftBadge2: $('ft-badge-2'),
        ftSpinnerRotor: $('ft-spinner-rotor'),
        soulsOverlay: $('souls-overlay'),
        soulsSubtitle: $('souls-subtitle'),
        confettiCanvas: $('confetti-canvas'),
        toast: $('toast')
      };
    }

    _buildBoardSkeleton() {
      this.el.coordTop.innerHTML = COLS.map(c => `<span>${c}</span>`).join('');
      this.el.coordLeft.innerHTML = Array.from({ length: BOARD_SIZE }, (_, i) => `<span>${i + 1}</span>`).join('');

      this.cellEls = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE));
      this.el.cellsLayer.innerHTML = '';
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          const cell = document.createElement('div');
          cell.className = 'cell';
          cell.dataset.r = r;
          cell.dataset.c = c;
          cell.addEventListener('click', () => this._onCellClick(r, c));
          this.el.cellsLayer.appendChild(cell);
          this.cellEls[r][c] = cell;
        }
      }

      this.hWallEls = Array.from({ length: BOARD_SIZE - 1 }, () => Array(BOARD_SIZE));
      this.vWallEls = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE - 1));
      this.el.wallsLayer.innerHTML = '';

      for (let r = 0; r < BOARD_SIZE - 1; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          const slot = document.createElement('div');
          slot.className = 'wall-slot horizontal';
          slot.style.left = `calc(${c} * (var(--cell-size) + var(--gap-size)))`;
          slot.style.top = `calc(${r + 1} * var(--cell-size) + ${r} * var(--gap-size))`;
          slot.addEventListener('click', (e) => {
            e.stopPropagation();
            this._onWallClick('h', r, c);
          });
          this.el.wallsLayer.appendChild(slot);
          this.hWallEls[r][c] = slot;
        }
      }

      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE - 1; c++) {
          const slot = document.createElement('div');
          slot.className = 'wall-slot vertical';
          slot.style.left = `calc(${c + 1} * var(--cell-size) + ${c} * var(--gap-size))`;
          slot.style.top = `calc(${r} * (var(--cell-size) + var(--gap-size)))`;
          slot.addEventListener('click', (e) => {
            e.stopPropagation();
            this._onWallClick('v', r, c);
          });
          this.el.wallsLayer.appendChild(slot);
          this.vWallEls[r][c] = slot;
        }
      }
    }

    _bindSegmented(containerId, onSelect) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.querySelectorAll('.seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          SoundFX.select();
          onSelect(btn.dataset.value);
        });
      });
    }

    _bindEvents() {
      // Step 0 Entry: ID + 4-digit PIN (first time registers & binds PIN; any other browser logs in with same ID + PIN!)
      const showEntryError = (msg) => {
        if (this.el.entryErrorMsg) {
          this.el.entryErrorMsg.textContent = msg;
          this.el.entryErrorMsg.classList.remove('hidden');
        }
        this.showToast(msg);
      };
      const clearEntryError = () => {
        if (this.el.entryErrorMsg) this.el.entryErrorMsg.classList.add('hidden');
      };
      this.el.landingNickname.addEventListener('input', clearEntryError);
      this.el.landingPin.addEventListener('input', () => {
        this.el.landingPin.value = this.el.landingPin.value.replace(/\D/g, '').slice(0, 4);
        clearEntryError();
      });

      this.el.entryForm.addEventListener('submit', (e) => {
        e.preventDefault();
        clearEntryError();
        if (Stats.hasRegisteredId()) {
          this._syncProfileUI();
          SoundFX.select();
          this._showLandingStep('main');
          return;
        }
        const entered = this.el.landingNickname.value.trim();
        const pin = this.el.landingPin.value.trim();
        if (!entered) {
          showEntryError('請先輸入你的玩家 ID');
          this.el.landingNickname.focus();
          return;
        }
        if (!/^\d{4}$/.test(pin)) {
          showEntryError('請設定或輸入 4 位數字密碼（例如 1234）');
          this.el.landingPin.focus();
          this.el.landingPin.select();
          return;
        }

        this.el.btnLandingEnter.disabled = true;
        const onAuthDone = (res) => {
          this.el.btnLandingEnter.disabled = false;
          if (!res || !res.ok) {
            showEntryError(`⚠️ ${(res && res.reason) || '帳號或 4 位數密碼驗證失敗'}`);
            if (res && res.code === 'wrong_pin') {
              this.el.landingPin.focus();
              this.el.landingPin.select();
            } else {
              this.el.landingNickname.focus();
              this.el.landingNickname.select();
            }
            return;
          }
          clearEntryError();
          this.el.landingPin.value = '';
          this._syncProfileUI();
          SoundFX.select();
          this.showToast(res.mode === 'login' ? `🔓 歡迎回來，${res.name}！已同步雲端戰績` : `🎉 帳號「${res.name}」建立成功！`);
          this._showLandingStep('main');
        };

        try {
          if (this.hub && typeof this.hub.authenticate === 'function') {
            this.hub.authenticate(entered, pin, onAuthDone);
          } else {
            onAuthDone(Stats.localAuthenticate(entered, pin));
          }
        } catch (_) {
          this.el.btnLandingEnter.disabled = false;
          onAuthDone(Stats.localAuthenticate(entered, pin));
        }
      });

      this.el.btnSwitchAccount.addEventListener('click', () => {
        SoundFX.select();
        this.hub.setMyStatus('offline');
        Stats.logoutLocalSession();
        this.el.landingNickname.value = '';
        this.el.landingPin.value = '';
        clearEntryError();
        this._syncProfileUI();
        this.el.landingNickname.focus();
        this.showToast('已登出本機帳號，可輸入 ID 與 4 位數密碼切換登入');
      });

      this.el.btnCachedEnter.addEventListener('click', () => {
        SoundFX.select();
        if (this.hub && typeof this.hub.refreshStateFromServer === 'function') {
          this.hub.refreshStateFromServer();
        }
        this._showLandingStep('main');
      });

      // Step 1 -> Step 2 Landing navigation
      this.el.cardChooseOnline.addEventListener('click', () => {
        SoundFX.select();
        this._showLandingStep('online');
      });
      this.el.cardChooseSolo.addEventListener('click', () => {
        SoundFX.select();
        this._showLandingStep('solo');
      });
      this.el.btnMainBack.addEventListener('click', () => {
        SoundFX.select();
        this._showLandingStep('entry');
      });
      this.el.btnOnlineBack.addEventListener('click', () => {
        SoundFX.select();
        this._showLandingStep('main');
      });
      this.el.btnSoloBack.addEventListener('click', () => {
        SoundFX.select();
        this._showLandingStep('main');
      });

      // Solo Landing segmented options
      this._bindSegmented('solo-opt-variant', v => { this.config.ruleVariant = v; });
      this._bindSegmented('solo-opt-players', v => {
        this.config.numPlayers = Number(v);
        this.el.soloGroupOpening.classList.toggle('hidden', this.config.numPlayers === 3);
      });
      this._bindSegmented('solo-opt-ai', v => { this.config.aiLevel = v; });
      this._bindSegmented('solo-opt-opening', v => { this.config.openingStyle = v; });
      this._bindSegmented('solo-opt-timer', v => { this.config.timerEnabled = v === 'on'; });

      this.el.btnSoloLaunch.addEventListener('click', () => {
        Stats.setNickname(this.el.landingNickname.value);
        this.matchCategory = 'solo';
        this.currentRankedRival = null;
        this.config.gameMode = 'ai';
        this.config.aiSkill = null;
        this.config.aiRank = null;
        this.config.onlineSeats = [
          { nickname: Stats.getNickname(), isAI: false },
          { nickname: this._aiLabel(this.config.aiLevel), isAI: true },
          { nickname: '金方AI', isAI: true }
        ];
        this._enterArena();
        this.startNewMatch();
      });

      // Online Ranked Lobby Entry (Personal Profile Page FIRST!)
      this.el.btnStartRankedQuick.addEventListener('click', () => {
        SoundFX.select();
        this._enterRankedLobby();
      });
      this.el.btnRlBack.addEventListener('click', () => {
        SoundFX.select();
        this._leaveHumanQueue();
        this.hub.setMyStatus('offline');
        this._returnToLanding('online');
      });
      this.el.btnRlRules.addEventListener('click', () => this._openModal('modal-rules'));
      this.el.btnRlVsAi.addEventListener('click', () => {
        SoundFX.select();
        this._leaveHumanQueue();
        this._launchRankedAIMatchNow();
      });
      this.el.btnRlQueueHuman.addEventListener('click', () => {
        SoundFX.select();
        this._enterHumanQueue();
      });
      this.el.btnRlLeaveQueue.addEventListener('click', () => {
        SoundFX.select();
        this._leaveHumanQueue();
        this.showToast('已離開真人對戰排隊');
      });
      this.el.btnMmInstantAi.addEventListener('click', () => {
        this._closeModal('modal-matchmaking');
        this._launchRankedAIMatchNow();
      });
      this.el.btnCancelMm.addEventListener('click', () => {
        this._closeModal('modal-matchmaking');
      });

      // Online Friend Match Create / Join
      this.el.btnFriendCreate.addEventListener('click', () => {
        Stats.setNickname(this.el.landingNickname.value);
        this._openOnlineModal('create', 'friends');
      });
      this.el.btnFriendJoin.addEventListener('click', () => {
        Stats.setNickname(this.el.landingNickname.value);
        this._openOnlineModal('join', 'friends');
      });

      // Auto-start cerebral BGM on the very first user click/keydown (respects browser autoplay policy)
      const unlockBgm = () => {
        if (SoundFX.enabled && SoundFX.bgmEnabled && !SoundFX.bgmRunning && this.engine.phase !== 'gameover') {
          SoundFX.startBGM();
        }
        document.removeEventListener('pointerdown', unlockBgm);
        document.removeEventListener('keydown', unlockBgm);
      };
      document.addEventListener('pointerdown', unlockBgm, { once: true });
      document.addEventListener('keydown', unlockBgm, { once: true });

      // Sound, BGM & Fullscreen (both Landing & Arena)
      const toggleSound = () => {
        SoundFX.enabled = !SoundFX.enabled;
        if (!SoundFX.enabled) {
          SoundFX.stopBGM(false);
          SoundFX.stopMusic();
        } else if (SoundFX.bgmEnabled && this.engine.phase !== 'gameover') {
          SoundFX.startBGM();
        }
        this._syncSoundUI();
        if (SoundFX.enabled) SoundFX.select();
      };
      this.el.btnLandingSound.addEventListener('click', toggleSound);
      this.el.btnSound.addEventListener('click', toggleSound);

      this.el.btnBgm.addEventListener('click', () => {
        SoundFX.setBGMEnabled(!SoundFX.bgmEnabled);
        this._syncSoundUI();
        if (SoundFX.enabled) SoundFX.select();
      });

      const toggleFs = () => this._toggleFullscreen();
      this.el.btnLandingFs.addEventListener('click', toggleFs);
      this.el.btnFullscreen.addEventListener('click', toggleFs);
      document.addEventListener('fullscreenchange', () => this._syncFullscreenUI());
      document.addEventListener('webkitfullscreenchange', () => this._syncFullscreenUI());

      // Arena MENU Drawer toggle & auto-close
      const closeMenu = () => {
        this.el.arenaMenuDrawer.classList.add('hidden');
        this.el.btnArenaMenu.setAttribute('aria-expanded', 'false');
      };
      this.el.btnArenaMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = this.el.arenaMenuDrawer.classList.contains('hidden');
        this.el.arenaMenuDrawer.classList.toggle('hidden', !willOpen);
        this.el.btnArenaMenu.setAttribute('aria-expanded', String(willOpen));
        SoundFX.select();
      });
      this.el.arenaMenuDrawer.addEventListener('click', () => closeMenu());
      document.addEventListener('click', (e) => {
        if (!this.el.arenaMenuDrawer.classList.contains('hidden') &&
            !this.el.arenaMenuDrawer.contains(e.target) &&
            e.target !== this.el.btnArenaMenu) {
          closeMenu();
        }
      });

      // Arena Navigation & Utility
      this.el.btnBackLanding.addEventListener('click', () => {
        const action = this.matchCategory === 'ranked' ? 'back_ranked' : 'back_landing';
        if (this._isActiveMatchInProgress()) {
          this._promptLeaveWarning(action);
          return;
        }
        if (this.matchCategory === 'ranked') this._returnToRankedLobby();
        else this._returnToLanding();
      });
      this.el.btnPostgameLobby.addEventListener('click', () => {
        SoundFX.select();
        this._stopConfetti();
        if (this.matchCategory === 'ranked') {
          this._returnToRankedLobby();
        } else if (this.matchCategory === 'friends') {
          if (this.net.isOnline()) this.net.disconnect(true);
          this._returnToLanding('online');
        } else {
          this._returnToLanding('main');
        }
      });
      this.el.btnLandingRules.addEventListener('click', () => this._openModal('modal-rules'));
      this.el.btnRules.addEventListener('click', () => this._openModal('modal-rules'));
      this.el.btnOnline.addEventListener('click', () => this._openOnlineModal('create', 'friends'));
      this.el.onlinePill.addEventListener('click', () => this._openModal('modal-online'));
      this.el.btnUndo.addEventListener('click', () => this._undo());
      this.el.btnNewGame.addEventListener('click', () => {
        if (this.replay.active) this._exitReplay();
        if (this._isActiveMatchInProgress()) {
          this._promptLeaveWarning(this.matchCategory === 'ranked' ? 'back_ranked' : 'new_game');
          return;
        }
        if (this.matchCategory === 'ranked') {
          this._returnToRankedLobby();
          return;
        }
        if (this.net.isOnline()) {
          if (this.net.isHost()) {
            this._hostStartOnlineMatch();
          } else {
            this.showToast('線上對局由房主開啟下一局');
          }
          return;
        }
        this._syncSetupModalFromConfig();
        this._openModal('modal-setup');
      });

      // Setup Modal segmented controls (inside Arena)
      this._bindSegmented('opt-rule-variant', v => { this.config.ruleVariant = v; });
      this._bindSegmented('opt-player-count', v => {
        this.config.numPlayers = Number(v);
        this.el.groupOpening.classList.toggle('hidden', this.config.numPlayers === 3);
      });
      this._bindSegmented('opt-ai-level', v => { this.config.aiLevel = v; });
      this._bindSegmented('opt-opening', v => { this.config.openingStyle = v; });
      this._bindSegmented('opt-timer', v => { this.config.timerEnabled = v === 'on'; });

      this.el.btnStartMatch.addEventListener('click', () => {
        this._closeModal('modal-setup');
        this.matchCategory = 'solo';
        this.currentRankedRival = null;
        this.config.gameMode = 'ai';
        this.config.aiSkill = null;
        this.config.aiRank = null;
        this.config.onlineSeats = [
          { nickname: Stats.getNickname(), isAI: false },
          { nickname: this._aiLabel(this.config.aiLevel), isAI: true },
          { nickname: '金方AI', isAI: true }
        ];
        this.startNewMatch();
      });

      // Tactical Action Buttons
      this.el.btnCancelMove.addEventListener('click', () => {
        if (!this.pendingMove) return;
        this.pendingMove = null;
        this._resumeThinkTimerFromCancel();
        SoundFX.select();
        this.render();
      });
      this.el.btnHammer.addEventListener('click', () => {
        if (!this._isHumanTurn() || this.engine.phase !== 'play' || this.pendingMove) return;
        this.hammerMode = !this.hammerMode;
        this.selectedPieceId = null;
        this.validDests = [];
        SoundFX.select();
        this.render();
      });
      this.el.btnEndHammer.addEventListener('click', () => {
        if (!this._isHumanTurn() || !this.engine.hammerOnlyEndgame) return;
        this._dispatchHumanAction({ kind: 'declineHammer' });
      });

      // Replay Theater Controls
      this.el.btnReplayExit.addEventListener('click', () => this._exitReplay());
      this.el.btnRpFirst.addEventListener('click', () => this._seekReplay(0));
      this.el.btnRpPrev.addEventListener('click', () => this._seekReplay(this.replay.stepIndex - 1));
      this.el.btnRpNext.addEventListener('click', () => this._seekReplay(this.replay.stepIndex + 1));
      this.el.btnRpLast.addEventListener('click', () => {
        if (this.replay.record) this._seekReplay(this.replay.record.steps.length);
      });
      this.el.btnRpPlay.addEventListener('click', () => this._toggleReplayPlay());
      this.el.replaySlider.addEventListener('input', () => {
        this._stopReplayAuto();
        this._seekReplay(Number(this.el.replaySlider.value));
      });
      this.el.btnRpSpeed.addEventListener('click', () => {
        const speeds = [1, 2, 0.5];
        const nextIdx = (speeds.indexOf(this.replay.speed) + 1) % speeds.length;
        this.replay.speed = speeds[nextIdx];
        this.el.btnRpSpeed.textContent = `${this.replay.speed}×`;
        if (this.replay.playing) {
          this._stopReplayAuto();
          this._startReplayAuto();
        }
      });

      // Game Over Modal Buttons
      this.el.btnReplayThisMatch.addEventListener('click', () => {
        this._closeModal('modal-gameover');
        this._stopConfetti();
        if (this.lastCompletedRecord) {
          this._startReplay(this.lastCompletedRecord);
        }
      });
      this.el.btnPlayAgain.addEventListener('click', () => {
        this._closeModal('modal-gameover');
        this._stopConfetti();
        if (this.matchCategory === 'ranked') {
          // After Ranked match (vs AI or Human), always return to Ranked Personal Profile Lobby!
          this._returnToRankedLobby();
          return;
        }
        if (this.net.isOnline() || this.matchCategory === 'friends') {
          if (this.net.isOnline()) this.net.disconnect(true);
          this._updateOnlineControls();
          this._returnToLanding('online');
          return;
        }
        this.startNewMatch();
      });
      this.el.btnOnlineRematch.addEventListener('click', () => {
        if (!this.net.isOnline() || !this.net.isHost()) return;
        this._closeModal('modal-gameover');
        this._stopConfetti();
        this._hostStartOnlineMatch();
      });

      // Souls Defeat Overlay click
      this.el.soulsOverlay.addEventListener('click', () => {
        this._hideSoulsOverlay();
        if (this.engine.phase === 'gameover') this._showGameOverModal(false);
      });

      // Online Lobby Modal Events
      document.querySelectorAll('#online-tabs .online-tab').forEach(tab => {
        tab.addEventListener('click', () => this._switchOnlineTab(tab.dataset.tab));
      });
      this._bindSegmented('online-opt-variant', v => { this.onlineConfig.ruleVariant = v; });
      this._bindSegmented('online-opt-players', v => {
        this.onlineConfig.numPlayers = Number(v);
        this.el.onlineGroupOpening.classList.toggle('hidden', this.onlineConfig.numPlayers === 3);
      });
      this._bindSegmented('online-opt-opening', v => { this.onlineConfig.openingStyle = v; });
      this._bindSegmented('online-opt-timer', v => { this.onlineConfig.timerEnabled = v === 'on'; });

      this.el.btnCreateRoom.addEventListener('click', () => {
        const nick = this.el.inputNickname.value.trim() || Stats.getNickname();
        Stats.setNickname(nick);
        this._syncProfileUI();
        this.net.createRoom({
          ...this.onlineConfig,
          hostName: nick
        });
      });
      this.el.btnJoinRoom.addEventListener('click', () => {
        const nick = this.el.inputNickname.value.trim() || Stats.getNickname();
        Stats.setNickname(nick);
        this._syncProfileUI();
        this.net.joinRoom(this.el.inputRoomCode.value, nick);
      });
      this.el.btnCopyCode.addEventListener('click', () => {
        if (this.net.roomCode) this._copyText(this.net.roomCode, `已複製房號：${this.net.roomCode}`);
      });
      this.el.btnCopyLink.addEventListener('click', () => {
        const url = this.net.getInviteUrl();
        if (url) this._copyText(url, '已複製邀請連結，傳給好友即可一鍵進房！');
        else this._copyText(this.net.roomCode, `本機開啟中，已複製 6 碼房號：${this.net.roomCode}`);
      });
      this.el.btnLeaveRoom.addEventListener('click', () => {
        this.net.disconnect(false);
        this._closeModal('modal-online');
      });
      this.el.btnLeaveRoomMini.addEventListener('click', () => {
        if (this._isActiveMatchInProgress()) {
          this._promptLeaveWarning(this.matchCategory === 'ranked' ? 'back_ranked' : 'back_landing');
          return;
        }
        this.net.disconnect(false);
        this._returnToLanding();
      });
      this.el.btnHostStart.addEventListener('click', () => this._hostStartOnlineMatch());

      // Mid-Match Leave / Reload Warning Modal Buttons
      this.el.btnLeaveStay.addEventListener('click', () => {
        this.pendingLeaveAction = null;
        this._closeModal('modal-leave-warn');
        SoundFX.select();
      });
      this.el.btnLeaveConfirm.addEventListener('click', () => {
        this._confirmForfeitAndLeave();
      });

      // Chat & Quick Emotes
      this.el.chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = this.el.chatInput.value.trim();
        if (!text || !this.net.isOnline()) return;
        this.net.sendChat(text);
        this.el.chatInput.value = '';
      });
      document.querySelectorAll('#quick-emotes .emote-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (this.net.isOnline()) this.net.sendChat(btn.dataset.text);
        });
      });

      // Modal Closes
      document.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', () => this._closeModal(btn.dataset.close));
      });
      document.querySelectorAll('.modal-backdrop').forEach(bg => {
        bg.addEventListener('click', (e) => {
          if (e.target === bg && bg.id !== 'modal-matchmaking' && bg.id !== 'modal-leave-warn') {
            bg.classList.add('hidden');
          }
        });
      });

      // Browser toolbar refresh / tab close guard during active matches (Solo / Ranked / Friends)
      window.addEventListener('beforeunload', (e) => {
        if (this._isActiveMatchInProgress() && !this.allowUnloadOnce) {
          e.preventDefault();
          e.returnValue = '你將離開遊戲，離開遊戲算敗北！';
          return e.returnValue;
        }
      });
      window.addEventListener('pagehide', () => {
        if (this._isActiveMatchInProgress() && !this.allowUnloadOnce) {
          this._recordForfeitLossAndNotify(true);
        }
      });

      // Keyboard Shortcuts (F5/Ctrl+R = Mid-Match Leave Warning, F = Fullscreen, Z = Undo, Left/Right arrows in Replay)
      document.addEventListener('keydown', (e) => {
        // Intercept F5 or Ctrl+R / Cmd+R during any active match (Solo / Ranked / Friends)
        const isReloadKey = (e.key === 'F5') || ((e.key === 'r' || e.key === 'R') && (e.ctrlKey || e.metaKey));
        if (isReloadKey && this._isActiveMatchInProgress()) {
          e.preventDefault();
          this._promptLeaveWarning('reload');
          return;
        }
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          this._toggleFullscreen();
          return;
        }
        if (this.view === 'arena' && this.replay.active) {
          if (e.key === 'ArrowLeft') { e.preventDefault(); this._seekReplay(this.replay.stepIndex - 1); }
          if (e.key === 'ArrowRight') { e.preventDefault(); this._seekReplay(this.replay.stepIndex + 1); }
          if (e.key === ' ') { e.preventDefault(); this._toggleReplayPlay(); }
          return;
        }
        if (this.view === 'arena' && (e.key === 'z' || e.key === 'Z') && !this.net.isOnline()) {
          this._undo();
        }
      });
    }

    _aiLabel(level) {
      if (level === 'god') return '宗師魔王AI';
      if (level === 'gm') return '大師級AI';
      if (level === 'hard') return '魔鬼級AI';
      if (level === 'easy') return '新手AI';
      return '策略AI';
    }

    // ==================== LANDING & VIEW SWITCHING ====================
    _saveRoute(route) {
      try {
        sessionStorage.setItem('wallgo_last_route', route);
        const hashMap = {
          ranked_lobby: '#ranked-lobby',
          landing_online: '#online',
          landing_solo: '#solo',
          landing_main: '#main',
          landing_entry: ''
        };
        const targetHash = (route in hashMap) ? hashMap[route] : '';
        if (window.history && window.history.replaceState) {
          const base = window.location.pathname + window.location.search;
          window.history.replaceState(null, '', base + targetHash);
        }
      } catch (_) {}
    }

    _restoreRouteOnLoad() {
      if (!Stats.hasRegisteredId()) return;
      let route = '';
      try {
        const h = (window.location.hash || '').toLowerCase();
        if (h === '#ranked-lobby') route = 'ranked_lobby';
        else if (h === '#online') route = 'landing_online';
        else if (h === '#solo') route = 'landing_solo';
        else if (h === '#main') route = 'landing_main';
        else route = sessionStorage.getItem('wallgo_last_route') || '';
      } catch (_) {}

      if (route === 'ranked_lobby') {
        this._enterRankedLobby({ isReload: true });
      } else if (route === 'landing_online') {
        this._showLandingStep('online');
      } else if (route === 'landing_solo') {
        this._showLandingStep('solo');
      } else if (route === 'landing_main') {
        this._showLandingStep('main');
      }
    }

    _showLandingStep(step) {
      this.el.landingStepEntry.classList.toggle('hidden', step !== 'entry');
      this.el.landingStepMain.classList.toggle('hidden', step !== 'main');
      this.el.landingStepOnline.classList.toggle('hidden', step !== 'online');
      this.el.landingStepSolo.classList.toggle('hidden', step !== 'solo');
      this.el.btnMainBack.classList.toggle('hidden', step !== 'main');
      this._saveRoute('landing_' + step);
      this._syncProfileUI();
    }

    _syncProfileUI() {
      const hasCache = Stats.hasRegisteredId();
      const nick = Stats.getNickname();
      const rp = Stats.getRP();
      const tier = Stats.getTierInfo(rp);
      const rank = Stats.getMyRank();
      const solo = Stats.getBucket('solo');

      this.el.entryNewWrap.classList.toggle('hidden', hasCache);
      this.el.entryCachedWrap.classList.toggle('hidden', !hasCache);
      if (hasCache) {
        this.el.entryCachedName.textContent = nick;
      }
      if (this.el.onlineIdDisplay) this.el.onlineIdDisplay.textContent = nick;
      this.el.landingTierBadge.textContent = tier.name;
      this.el.landingTierBadge.className = `tier-badge ${tier.cls}`;
      this.el.landingRpVal.textContent = `${rp} RP`;
      this.el.onlineMyRankChip.textContent = `排名 #${rank}`;
      this.el.rankedCardRp.textContent = `${rp} RP · ${tier.name}`;
      this.el.soloRecordChip.textContent = `單機戰績 ${solo.wins} 勝 ${solo.losses} 敗${solo.draws ? ` ${solo.draws} 平` : ''}`;
    }

    _enterArena() {
      this.isQueuingHuman = false;
      this.isConnectingMatch = false;
      clearInterval(this.queueElapsedTimer);
      this.queueElapsedTimer = null;
      clearTimeout(this.matchConnectWatchdog);
      this.matchConnectWatchdog = null;

      this.view = 'arena';
      document.body.classList.remove('mode-landing');
      this.el.viewLanding.classList.add('hidden');
      this.el.viewRankedLobby.classList.add('hidden');
      this.el.viewArena.classList.remove('hidden');
      this._updateOnlineControls();
    }

    _enterRankedLobby(opts = {}) {
      if (this.replay.active) this._exitReplay(true);
      this._stopTimer();
      this._stopConfetti();
      this._hideSoulsOverlay();
      SoundFX.stopMusic();
      if (!opts.isReload && SoundFX.enabled && SoundFX.bgmEnabled && !SoundFX.bgmRunning) SoundFX.startBGM();
      this.aiToken += 1;
      this.aiBusy = false;
      if (this.net.isOnline()) this.net.disconnect(true);

      this.view = 'ranked_lobby';
      this.matchCategory = 'ranked';
      this.pendingRankedAutoStart = false;
      this.rankedP2PContext = null;
      this.replayReturnToLobby = false;
      document.body.classList.remove('mode-landing');
      this.el.viewLanding.classList.add('hidden');
      this.el.viewArena.classList.add('hidden');
      this.el.viewRankedLobby.classList.remove('hidden');
      this._saveRoute('ranked_lobby');

      this.hub.announceLobbyLogin(Stats.getNickname(), { silent: Boolean(opts.isReload) });
      this._renderRankedLobbyView();
    }

    _returnToRankedLobby() {
      this._enterRankedLobby();
    }

    _returnToLanding(targetStep = 'main') {
      if (this.replay.active) this._exitReplay(true);
      this._leaveHumanQueue();
      this._stopTimer();
      this._stopConfetti();
      this._hideSoulsOverlay();
      SoundFX.stopMusic();
      this.aiToken += 1;
      this.aiBusy = false;
      if (this.net.isOnline()) {
        this.net.disconnect(true);
      }
      if (this.matchCategory === 'ranked') {
        this.hub.setMyStatus('offline');
      }
      this.view = 'landing';
      document.body.classList.add('mode-landing');
      this.el.viewArena.classList.add('hidden');
      this.el.viewRankedLobby.classList.add('hidden');
      this.el.viewLanding.classList.remove('hidden');
      this._showLandingStep(targetStep);
      this._syncProfileUI();
    }

    // ==================== FULLSCREEN & SOUND ====================
    _isFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    _toggleFullscreen() {
      const root = document.documentElement;
      if (this._isFullscreen()) {
        const fn = document.exitFullscreen || document.webkitExitFullscreen;
        if (fn) Promise.resolve(fn.call(document)).catch(() => {});
      } else {
        const fn = root.requestFullscreen || root.webkitRequestFullscreen;
        if (!fn) {
          this.showToast('瀏覽器不支援一鍵全螢幕，可按 F11 切換');
          return;
        }
        Promise.resolve(fn.call(root)).catch(() => this.showToast('請再點一次按鈕或按 F11 進入全螢幕'));
      }
    }

    _syncFullscreenUI() {
      const active = this._isFullscreen();
      document.body.classList.toggle('is-fullscreen', active);
      this.el.btnFullscreen.classList.toggle('active', active);
      this.el.btnFullscreen.setAttribute('aria-pressed', String(active));
      this.el.fsLabel.textContent = active ? '✕ 退出全螢幕' : '⛶ 全螢幕';
      this.el.btnLandingFs.classList.toggle('active', active);
      this.el.btnLandingFs.title = active ? '退出全螢幕 (Esc)' : '切換全螢幕 (F)';
      this.el.btnLandingFs.innerHTML = active
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    }

    _syncSoundUI() {
      const on = SoundFX.enabled;
      const bgmOn = on && SoundFX.bgmEnabled;
      this.el.soundIcon.textContent = on ? '🔊' : '🔇';
      this.el.btnSound.innerHTML = `<span id="sound-icon">${on ? '🔊' : '🔇'}</span> 全部音效：${on ? '開' : '關'}`;
      this.el.soundIcon = document.getElementById('sound-icon');
      this.el.btnSound.setAttribute('aria-pressed', String(on));

      this.el.bgmIcon.textContent = bgmOn ? '🎵' : '🔕';
      this.el.bgmLabel.textContent = `背景音樂：${bgmOn ? '開' : '關'}`;
      this.el.btnBgm.setAttribute('aria-pressed', String(bgmOn));

      this.el.btnLandingSound.classList.toggle('muted', !on);
      this.el.btnLandingSound.title = on ? '關閉音效與配樂' : '開啟音效與配樂';
      this.el.btnLandingSound.innerHTML = on
        ? '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'
        : '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    }

    // ==================== SHARED GLOBAL RANKED LOBBY & INDEFINITE HUMAN QUEUE ====================
    _onGlobalLobbySync() {
      this._syncProfileUI();
      if (this.view === 'ranked_lobby') {
        if (!Stats.hasRegisteredId()) {
          this._returnToLanding('entry');
          return;
        }
        this._renderRankedLobbyView();
      } else if (this.view === 'arena' && this.matchCategory === 'ranked') {
        this._renderRightPanels(this._activeEngine());
      }
    }

    _renderRankedLobbyView() {
      const nick = Stats.getNickname();
      const rp = Stats.getRP();
      const tier = Stats.getTierInfo(rp);
      const rank = Stats.getMyRank();
      const bucket = Stats.getBucket('ranked');
      const total = bucket.wins + bucket.losses + bucket.draws;
      const wr = total > 0 ? Math.round((bucket.wins / total) * 100) : 0;

      this.el.rlOnlineCount.textContent = String(this.hub.onlineCount || Stats.getOnlineHumanCount());
      this.el.rlPlayerName.textContent = nick;
      this.el.rlTierBadge.textContent = tier.name;
      this.el.rlTierBadge.className = `tier-badge ${tier.cls}`;
      this.el.rlRp.textContent = String(rp);
      this.el.rlRank.textContent = `#${rank}`;
      this.el.rlWinrate.textContent = `${wr}%`;
      this.el.rlSegWin.style.width = `${total > 0 ? (bucket.wins / total) * 100 : 0}%`;
      this.el.rlSegDraw.style.width = `${total > 0 ? (bucket.draws / total) * 100 : 0}%`;
      this.el.rlSegLoss.style.width = `${total > 0 ? (bucket.losses / total) * 100 : 0}%`;
      this.el.rlWins.textContent = String(bucket.wins);
      this.el.rlLosses.textContent = String(bucket.losses);
      this.el.rlDraws.textContent = String(bucket.draws);

      const showQueueBanner = this.isQueuingHuman || this.isConnectingMatch;
      this.el.rlActionBtns.classList.toggle('hidden', showQueueBanner);
      this.el.rlQueueBox.classList.toggle('hidden', !showQueueBanner);

      const lb = this._renderLeaderboardInto(this.el.rlLeaderboardList);
      this.el.rlLbCount.textContent = `${lb.length} 位選手`;

      this._renderRecentListInto(this.el.rlRecentList, 'ranked', true);
    }

    _enterHumanQueue() {
      this.isConnectingMatch = false;
      clearTimeout(this.matchConnectWatchdog);
      this.matchConnectWatchdog = null;
      this.isQueuingHuman = true;
      this.queueStartedAt = Date.now();
      this.el.rlActionBtns.classList.add('hidden');
      this.el.rlQueueBox.classList.remove('hidden');
      if (this.el.rlQueueTitle) this.el.rlQueueTitle.textContent = '正在排隊配對空閒的在線真人玩家…';
      this.el.rlQueueTimer.textContent = '已排隊 00:00 · 將持續等待空閒的在線真人玩家';
      this.el.btnRlLeaveQueue.textContent = '✕ 離開排隊';

      clearInterval(this.queueElapsedTimer);
      this.queueElapsedTimer = setInterval(() => {
        const sec = Math.floor((Date.now() - this.queueStartedAt) / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        this.el.rlQueueTimer.textContent = `已排隊 ${mm}:${ss} · 將持續等待空閒的在線真人玩家`;
      }, 1000);

      this.hub.setMyStatus('queuing');
      this._renderRankedLobbyView();
    }

    _leaveHumanQueue() {
      clearInterval(this.queueElapsedTimer);
      this.queueElapsedTimer = null;
      clearTimeout(this.matchConnectWatchdog);
      this.matchConnectWatchdog = null;
      const wasActive = this.isQueuingHuman || this.isConnectingMatch;
      if (this.isConnectingMatch) {
        this.isConnectingMatch = false;
        this.pendingRankedAutoStart = false;
        this.rankedP2PContext = null;
        if (this.net.isOnline()) this.net.disconnect(true);
      }
      if (wasActive) {
        this.isQueuingHuman = false;
        if (this.view === 'ranked_lobby') {
          this.hub.setMyStatus('online');
          this._renderRankedLobbyView();
        }
      }
    }

    _onGlobalQueueMatched(info) {
      // Matched with a free online human player! Keep connecting banner visible until Arena opens.
      clearInterval(this.queueElapsedTimer);
      this.queueElapsedTimer = null;
      clearTimeout(this.matchConnectWatchdog);
      this.isQueuingHuman = false;
      this.isConnectingMatch = true;
      this.matchCategory = 'ranked';
      this.currentRankedRival = null;
      this.rankedP2PContext = info; // { role, matchCode, opponentName, opponentRp }

      if (this.el.rlQueueTitle) {
        this.el.rlQueueTitle.textContent = `⚡ 配對成功！對手：${info.opponentName}（${info.opponentRp} RP）`;
      }
      this.el.rlQueueTimer.textContent = info.role === 'host'
        ? '正在開啟即時棋局並等待對手接入…'
        : '正在自動連線進入對手的即時棋局…';
      this.el.btnRlLeaveQueue.textContent = '✕ 取消連線';
      this._renderRankedLobbyView();

      SoundFX.territoryLock();
      this.showToast(`⚡ 配對成功！對手：${info.opponentName}（${info.opponentRp} RP）`);

      // Safety watchdog in case WebRTC is blocked by strict firewall
      this.matchConnectWatchdog = setTimeout(() => {
        if (this.isConnectingMatch && this.view !== 'arena') {
          this.isConnectingMatch = false;
          this.pendingRankedAutoStart = false;
          this.rankedP2PContext = null;
          if (this.net.isOnline()) this.net.disconnect(true);
          this.hub.setMyStatus('online');
          this._renderRankedLobbyView();
          this.showToast('⚠️ 與對手建立棋局連線逾時，請重新點擊「排隊真人對戰」');
        }
      }, 18000);

      if (info.role === 'host') {
        this.pendingRankedAutoStart = true;
        this.net.createRoom({
          ruleVariant: 'v2',
          numPlayers: 2,
          openingStyle: 'classic',
          timerEnabled: true,
          matchCategory: 'ranked',
          hostName: Stats.getNickname(),
          fixedCode: info.matchCode
        });
      } else {
        setTimeout(() => {
          if (!this.isConnectingMatch) return;
          this.net.joinRoom(info.matchCode, Stats.getNickname(), {
            maxRetries: 12,
            retryDelayMs: 900
          });
        }, 350);
      }
    }

    _launchRankedAIMatchNow() {
      const rival = Stats.pickRankedChallenger();
      this.currentRankedRival = rival;
      this.rankedP2PContext = null;
      this.matchCategory = 'ranked';
      this.hub.setMyStatus('playing');

      this.config = {
        ruleVariant: 'v2',
        numPlayers: 2,
        gameMode: 'ai',
        aiLevel: rival.aiLevel || 'medium',
        aiSkill: Number.isFinite(rival.skill) ? rival.skill : null,
        aiRank: Number.isInteger(rival.aiRank) ? rival.aiRank : null,
        openingStyle: 'classic',
        timerEnabled: true,
        onlineSeats: [
          { nickname: Stats.getNickname(), isAI: false },
          { nickname: rival.name, isAI: true }
        ]
      };
      this._enterArena();
      this.startNewMatch();
      const rankTag = rival.aiRank ? `AI #${rival.aiRank} · ` : '';
      this.showToast(`🤖 積分賽開戰！對手 ${rival.name}（${rankTag}${rival.rp} RP）`);
    }

    // ==================== ONLINE MULTIPLAYER (FRIENDS & RANKED P2P) ====================
    _checkInviteLink() {
      try {
        const room = new URLSearchParams(window.location.search).get('room');
        if (room && room.trim().length >= 4) {
          this.el.inputRoomCode.value = room.trim().toUpperCase();
          this._openOnlineModal('join', 'friends');
          return true;
        }
      } catch (_) {}
      return false;
    }

    _openOnlineModal(tab = 'create', category = 'friends') {
      this.onlineConfig.matchCategory = category;
      this.el.inputNickname.value = Stats.getNickname();
      this.el.onlineKicker.textContent = category === 'ranked' ? 'RANKED P2P ARENA · 積分對戰房' : 'WEBRTC P2P · 邀請好友';
      this.el.onlineTitle.textContent = category === 'ranked' ? '🏆 建立／加入線上積分房' : '🤝 邀請好友對戰房間';

      // Ranked P2P defaults to 2-player duel
      this.el.onlineGroupPlayers.classList.toggle('hidden', category === 'ranked');
      if (category === 'ranked') this.onlineConfig.numPlayers = 2;

      if (this.net.isOnline()) {
        this.el.onlineEntryView.classList.add('hidden');
        this.el.onlineLobbyView.classList.remove('hidden');
        this._renderOnlineLobby();
      } else {
        this.el.onlineEntryView.classList.remove('hidden');
        this.el.onlineLobbyView.classList.add('hidden');
        this._switchOnlineTab(tab);
        this.el.onlineStatusMsg.classList.add('hidden');
      }
      this._openModal('modal-online');
    }

    _switchOnlineTab(tab) {
      document.querySelectorAll('#online-tabs .online-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
      this.el.onlineTabCreate.classList.toggle('hidden', tab !== 'create');
      this.el.onlineTabJoin.classList.toggle('hidden', tab !== 'join');
    }

    _setOnlineStatus(msg, isError) {
      this.el.onlineStatusMsg.textContent = msg;
      this.el.onlineStatusMsg.classList.remove('hidden', 'error');
      if (isError) this.el.onlineStatusMsg.classList.add('error');

      if (this.isConnectingMatch && this.view === 'ranked_lobby') {
        if (isError) {
          clearTimeout(this.matchConnectWatchdog);
          this.matchConnectWatchdog = null;
          this.isConnectingMatch = false;
          this.pendingRankedAutoStart = false;
          this.rankedP2PContext = null;
          this.hub.setMyStatus('online');
          this._renderRankedLobbyView();
          this.showToast(`⚠️ ${msg}`);
        } else {
          this.el.rlQueueTimer.textContent = msg;
        }
      }
    }

    _onRoomReady(info) {
      this.matchCategory = (info.roomConfig && info.roomConfig.matchCategory === 'ranked') ? 'ranked' : 'friends';
      this.currentRankedRival = null;
      // If this room was silently created by the Global Ranked Queue, don't show any room-code modal!
      if (this.pendingRankedAutoStart || this.matchCategory === 'ranked') {
        this._updateOnlineControls();
        return;
      }
      this.el.onlineEntryView.classList.add('hidden');
      this.el.onlineLobbyView.classList.remove('hidden');
      this._renderOnlineLobby();
      this._updateOnlineControls();
      this.showToast(info.role === 'host' ? `房間已建立！房號：${info.roomCode}` : `已加入房間 ${info.roomCode}`);
    }

    _onRosterUpdate(info) {
      // Auto-launch silently when queued human Guest connects to Ranked Host!
      if (this.pendingRankedAutoStart && this.net.isHost()) {
        const connectedCount = this.net.seats.filter(s => s.connected).length;
        if (connectedCount >= 2) {
          this.pendingRankedAutoStart = false;
          this._hostStartOnlineMatch();
          return;
        }
      }
      this._renderOnlineLobby();
      if (info && info.event) {
        this._appendChatMessage({ system: true, text: info.event });
        this.showToast(info.event);
      }
    }

    _renderOnlineLobby() {
      const cfg = this.net.roomConfig || this.onlineConfig;
      this.el.lobbyRoomCode.textContent = this.net.roomCode || '------';
      const vTxt = cfg.ruleVariant === 'v2' ? 'Ⅱ代' : 'Ⅰ代';
      const cTxt = cfg.matchCategory === 'ranked' ? '🏆積分賽' : '🤝好友賽';
      this.el.lobbyRuleBadge.textContent = `${cTxt} · ${vTxt} · ${cfg.numPlayers}人`;

      this.el.lobbySeats.innerHTML = this.net.seats.map(s => {
        const isMe = s.seat === this.net.mySeat;
        const status = s.connected
          ? (s.isHost ? '房主已就緒' : '已連線')
          : '等待加入…';
        return `
          <div class="lobby-seat-row ${s.connected ? 'connected' : ''}">
            <span><strong>${s.colorName}</strong> · ${this._escapeHtml(s.nickname || '空位')}${isMe ? ' (你)' : ''}</span>
            <span class="chip">${status}</span>
          </div>`;
      }).join('');

      const connectedCount = this.net.seats.filter(s => s.connected).length;
      if (this.net.isHost()) {
        this.el.btnHostStart.classList.remove('hidden');
        const ready = connectedCount >= 2;
        this.el.btnHostStart.disabled = !ready;
        this.el.btnHostStart.textContent = ready
          ? (connectedCount < cfg.numPlayers ? '▶ 立即開戰（其餘席位 AI 補滿）' : '▶ 全員到齊・立即開戰！')
          : '等待至少 1 位對手加入…';
        this.el.lobbyHint.textContent = '複製 6 碼房號或邀請連結傳給朋友，對手進房後即可開戰！';
      } else {
        this.el.btnHostStart.classList.add('hidden');
        this.el.lobbyHint.textContent = '已連線至房間，請等待房主點擊開始對局…';
      }
    }

    _hostStartOnlineMatch() {
      if (!this.net.isHost()) return;
      const cfg = this.net.roomConfig;
      this.matchCategory = cfg.matchCategory === 'ranked' ? 'ranked' : 'friends';
      this.currentRankedRival = null;
      this.activeOnlineRoomCode = this.net.roomCode || '';
      this.myLocalSeat = 0;

      const seatsWithAI = this.net.seats.map(s => ({
        ...s,
        isAI: !s.connected,
        nickname: s.connected ? s.nickname : `${s.colorName}AI`
      }));

      this.config = {
        ruleVariant: cfg.ruleVariant,
        numPlayers: cfg.numPlayers,
        gameMode: 'online',
        aiLevel: cfg.aiLevel || 'medium',
        openingStyle: cfg.openingStyle,
        timerEnabled: cfg.timerEnabled,
        onlineSeats: seatsWithAI
      };

      this._closeModal('modal-online');
      this._enterArena();
      this._resetLocalTransientState();
      delete this.config.firstPlayer;
      this.engine.reset(this.config);
      this.net.hostStartMatch(this.engine.serialize());
      this._saveActiveMatchCheckpoint();
      SoundFX.place();
      SoundFX.startBGM();
      this.render();
      this._playFirstPlayerDrawAnimation(() => {
        this.render();
        this._syncTurnTimer(true);
        this._triggerTurnCallout(true);
        this._maybeTriggerAI();
      });
    }

    _onRemoteMatchStart(info) {
      this.matchCategory = (info.roomConfig && info.roomConfig.matchCategory === 'ranked') ? 'ranked' : 'friends';
      this.currentRankedRival = null;
      this.activeOnlineRoomCode = this.net.roomCode || '';
      this.myLocalSeat = Number.isInteger(this.net.mySeat) && this.net.mySeat >= 0 ? this.net.mySeat : 1;
      this._closeModal('modal-online');
      this._closeModal('modal-gameover');
      this._enterArena();
      this._resetLocalTransientState();
      this.engine.loadSnapshot(info.snapshot);
      this._saveActiveMatchCheckpoint();
      this.prevLockedSum = this.engine.analyzeTerritories().lockedScores.reduce((a, b) => a + b, 0);
      SoundFX.place();
      SoundFX.startBGM();
      this.render();
      this._playFirstPlayerDrawAnimation(() => {
        this.render();
        this._syncTurnTimer(true);
        this._triggerTurnCallout(true);
      });
    }

    _onRemoteAction(info) {
      if (!this.net.isHost()) return;
      const { seat, action } = info;
      if (this.engine.currentPlayer !== seat) return;
      this._executeAuthoritativeAction(action, true);
    }

    _onStateSync(msg) {
      if (this.net.isHost()) return;
      this.selectedPieceId = null;
      this.validDests = [];
      this.pendingMove = null;
      this.hammerMode = false;
      this.engine.loadSnapshot(msg.snapshot);
      if (msg.sound && typeof SoundFX[msg.sound] === 'function') SoundFX[msg.sound]();
      this._afterStateTransition();
    }

    _onOnlineDisconnected(info) {
      this._updateOnlineControls();
      this.showToast((info && info.reason) || '連線已中斷');
    }

    // ==================== MID-MATCH LEAVE GUARD & OPPONENT-LEFT VICTORY ====================
    _saveActiveMatchCheckpoint() {
      try {
        const mySeat = this._getLocalSeat();
        const oppObj = this.engine.players.find(p => p.id !== mySeat);
        const oppName = this.currentRankedRival ? this.currentRankedRival.name : (oppObj ? oppObj.name : '對手');
        const roomCode = this.activeOnlineRoomCode || this.net.roomCode || '';
        const ckpt = {
          category: this.matchCategory,
          myName: Stats.getNickname(),
          oppName,
          bIsAI: Boolean(this.currentRankedRival || !this.net.isOnline()),
          rivalId: this.currentRankedRival ? this.currentRankedRival.id : null,
          roomCode,
          matchId: this.currentRankedRival
            ? ('rk_forfeit_' + Date.now())
            : ('p2p_' + (roomCode || Date.now()) + '_forfeit'),
          startedAt: Date.now()
        };
        localStorage.setItem(ACTIVE_MATCH_KEY, JSON.stringify(ckpt));
      } catch (_) {}
    }

    _clearActiveMatchCheckpoint() {
      try { localStorage.removeItem(ACTIVE_MATCH_KEY); } catch (_) {}
    }

    _resolveAbandonedMatchOnLoad() {
      let ckpt = null;
      try {
        const raw = localStorage.getItem(ACTIVE_MATCH_KEY);
        if (!raw) return;
        localStorage.removeItem(ACTIVE_MATCH_KEY);
        ckpt = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (!ckpt || typeof ckpt !== 'object') return;
      // Ignore ancient stale checkpoints (> 6 hours)
      if (Date.now() - (Number(ckpt.startedAt) || 0) > 6 * 3600 * 1000) return;

      if (ckpt.category === 'ranked' && ckpt.myName) {
        const payload = {
          matchId: ckpt.matchId || ('rk_forfeit_' + Date.now()),
          playerAName: ckpt.myName,
          playerBName: ckpt.oppName || '對手',
          bIsAI: Boolean(ckpt.bIsAI),
          rivalId: ckpt.rivalId || null,
          outcomeForA: 'loss',
          isForfeit: true
        };
        // Wait briefly for hub mode detection to finish, then reliably report via fetch
        setTimeout(() => {
          this.hub.reportRankedMatch(payload);
          this._syncProfileUI();
          if (this.view === 'ranked_lobby') this._renderRankedLobbyView();
        }, 650);
      } else {
        Stats.recordAbandonedLoss(ckpt.category || 'solo');
        this._syncProfileUI();
      }

      setTimeout(() => {
        this.showToast('⚠️ 你在前一場對局中提前離開／重新整理，本局已判定敗北並結算戰績！');
      }, 450);
    }

    _isActiveMatchInProgress() {
      return Boolean(
        this.view === 'arena' &&
        !this.replay.active &&
        this.engine &&
        this.engine.phase !== 'gameover' &&
        !this.matchRecorded
      );
    }

    _promptLeaveWarning(action) {
      this.pendingLeaveAction = action;
      const modeHint = this.matchCategory === 'ranked'
        ? '目前為線上積分對局，放棄將扣除積分並計入敗場。'
        : (this.matchCategory === 'friends'
          ? '目前為線上好友對局，離開後對手將直接獲勝並結算戰績。'
          : '目前為單機 AI 對局，離開將直接記錄為 1 敗。');
      if (this.el.leaveWarnSub) this.el.leaveWarnSub.textContent = modeHint;
      this._openModal('modal-leave-warn');
      SoundFX.select();
    }

    _recordForfeitLossAndNotify(useBeacon = false) {
      if (!this._isActiveMatchInProgress()) return;
      this.matchRecorded = true;
      this._clearActiveMatchCheckpoint();
      this._stopTimer();

      const mySeat = this._getLocalSeat();
      const oppObj = this.engine.players.find(p => p.id !== mySeat);
      const oppName = this.currentRankedRival ? this.currentRankedRival.name : (oppObj ? oppObj.name : '對手');
      const analysis = this.engine.analyzeTerritories();

      // Build forfeit-loss result snapshot for local replay/record
      const rankings = this.engine.players.map((p) => ({
        player: p.id,
        name: p.name,
        short: p.short,
        score: (analysis && analysis.lockedScores && analysis.lockedScores[p.id]) || 0,
        largest: (analysis && analysis.largestTerritory && analysis.largestTerritory[p.id]) || 0
      }));
      const winnerEntry = rankings.find(r => r.player !== mySeat) || rankings[0];
      rankings.sort((a, b) => (a.player === mySeat ? 1 : -1));

      this.engine.phase = 'gameover';
      this.engine.result = {
        isDraw: false,
        forfeitLoss: true,
        winners: winnerEntry ? [winnerEntry] : [],
        rankings
      };

      const rpDelta = this.matchCategory === 'ranked' ? -14 : 0;
      const recOutcome = Stats.recordLocalReplay({
        category: this.matchCategory,
        engine: this.engine,
        mySeat,
        opponentName: oppName,
        rpDelta
      });
      const rec = recOutcome ? recOutcome.record : null;

      // Notify P2P opponent so they immediately receive "對手離開 · 勝利" & score settlement
      const roomCode = this.activeOnlineRoomCode || this.net.roomCode || '';
      if (this.net.isOnline()) {
        this.net.sendForfeit(Stats.getNickname());
      }

      if (this.matchCategory === 'ranked') {
        const matchId = this.currentRankedRival
          ? ('rk_forfeit_' + (rec ? rec.id : Date.now()))
          : ('p2p_' + (roomCode || Date.now()) + '_forfeit');
        const payload = {
          matchId,
          playerAName: Stats.getNickname(),
          playerBName: oppName,
          bIsAI: Boolean(this.currentRankedRival),
          rivalId: this.currentRankedRival ? this.currentRankedRival.id : null,
          outcomeForA: 'loss',
          isForfeit: true,
          replayRecord: rec
        };
        if (useBeacon && typeof this.hub.reportRankedMatchBeacon === 'function') {
          const sent = this.hub.reportRankedMatchBeacon(payload);
          if (!sent) this.hub.reportRankedMatch(payload);
        } else {
          this.hub.reportRankedMatch(payload);
        }
      }

      if (useBeacon && this.net.isOnline()) {
        // Also close WebRTC channel immediately on tab unload so peer sees drop faster
        try { this.net.disconnect(true); } catch (_) {}
      }
    }

    _confirmForfeitAndLeave() {
      const action = this.pendingLeaveAction || 'reload';
      this.pendingLeaveAction = null;
      this._closeModal('modal-leave-warn');

      this._recordForfeitLossAndNotify(action === 'reload');

      if (action === 'reload') {
        this.allowUnloadOnce = true;
        // Brief 180ms flush window so PeerJS forfeit packet & sendBeacon reach the peer/server
        setTimeout(() => {
          if (this.net.isOnline()) this.net.disconnect(true);
          window.location.reload();
        }, 180);
        return;
      }

      if (this.net.isOnline()) {
        setTimeout(() => {
          if (this.net.isOnline()) this.net.disconnect(true);
        }, 120);
      }

      if (action === 'back_ranked') {
        this._returnToRankedLobby();
      } else if (action === 'new_game') {
        if (this.net.isOnline()) this.net.disconnect(true);
        this._syncSetupModalFromConfig();
        this._openModal('modal-setup');
      } else {
        this._returnToLanding();
      }
    }

    _onOpponentLeft(info) {
      if (!this._isActiveMatchInProgress()) return;

      const mySeat = (info && Number.isInteger(info.mySeat) && info.mySeat >= 0) ? info.mySeat : this._getLocalSeat();
      if (info && info.roomCode && !this.activeOnlineRoomCode) {
        this.activeOnlineRoomCode = info.roomCode;
      }
      const leftSeat = (info && Number.isInteger(info.seat)) ? info.seat : (mySeat === 0 ? 1 : 0);

      // In 3-player online Friends mode, only end if no other connected human opponents remain
      if (this.engine.numPlayers === 3 && this.net.seats && this.net.seats.length >= 3) {
        const otherHumansAlive = this.net.seats.some(
          s => s.seat !== mySeat && s.seat !== leftSeat && !s.isAI && s.connected
        );
        if (otherHumansAlive) {
          const leftPlayer = this.engine.players[leftSeat];
          if (leftPlayer) leftPlayer.isAI = true;
          this.showToast(`⚠️ 對手「${(info && info.name) || '玩家'}」已離開，剩餘席位由 AI 接手`);
          this._maybeTriggerAI();
          return;
        }
      }

      this._stopTimer();
      this._closeModal('modal-leave-warn');
      this.pendingLeaveAction = null;

      const oppObj = this.engine.players[leftSeat] || this.engine.players.find(p => p.id !== mySeat);
      const leftName = (info && info.name) || (oppObj ? oppObj.name : '對手');
      const analysis = this.engine.analyzeTerritories();

      const rankings = this.engine.players.map((p) => ({
        player: p.id,
        name: p.name,
        short: p.short,
        score: (analysis && analysis.lockedScores && analysis.lockedScores[p.id]) || 0,
        largest: (analysis && analysis.largestTerritory && analysis.largestTerritory[p.id]) || 0
      }));
      const myEntry = rankings.find(r => r.player === mySeat) || rankings[0];
      rankings.sort((a, b) => (a.player === mySeat ? -1 : (b.player === mySeat ? 1 : b.score - a.score)));

      this.engine.phase = 'gameover';
      this.engine.result = {
        isDraw: false,
        forfeitWin: true,
        serverSettled: Boolean(info && info.serverSettled),
        settledRpDelta: (info && Number.isFinite(info.rpDelta)) ? info.rpDelta : null,
        settledNewRp: (info && Number.isFinite(info.newRp)) ? info.newRp : null,
        leftName,
        winners: myEntry ? [myEntry] : [],
        rankings
      };
      this.engine.logs.unshift({
        player: -1,
        text: `🏆 對手（${leftName}）已離開對局，判定 ${myEntry ? myEntry.name : Stats.getNickname()} 直接獲勝！`
      });

      this.showToast(`🏆 對手「${leftName}」已離開，你直接獲得勝利！`);
      // Disconnect P2P AFTER capturing seat/room info in _handleMatchConcluded
      this._handleMatchConcluded();
      if (this.net.isOnline()) this.net.disconnect(true);
      this._updateOnlineControls();
    }

    _updateOnlineControls() {
      const online = this.net.isOnline();
      const isRankedP2P = online && this.matchCategory === 'ranked';
      // Ranked uses the shared public lobby (no room code pill or room lobby button!)
      this.el.onlinePill.classList.toggle('hidden', !online || isRankedP2P);
      this.el.btnOnline.classList.toggle('hidden', online || this.matchCategory !== 'friends');
      this.el.panelChat.classList.toggle('hidden', !online);
      if (online && !isRankedP2P) {
        this.el.onlinePillText.textContent = `房號 ${this.net.roomCode || '------'}`;
      }
      this.el.btnUndo.disabled = online || this.undoStack.length === 0 || this.replay.active;
    }

    _appendChatMessage(msg) {
      const div = document.createElement('div');
      div.className = `chat-msg ${msg.system ? 'system' : ''}`;
      div.innerHTML = msg.system
        ? `• ${this._escapeHtml(msg.text)}`
        : `<strong>${this._escapeHtml(msg.name || '玩家')}：</strong>${this._escapeHtml(msg.text)}`;
      this.el.chatMessages.appendChild(div);
      this.el.chatMessages.scrollTop = this.el.chatMessages.scrollHeight;
    }

    // ==================== MATCH LIFECYCLE ====================
    _resetLocalTransientState() {
      this._clearFirstDrawOverlay();
      if (this.replay.active) this._exitReplay(true);
      this._stopConfetti();
      this._hideSoulsOverlay();
      SoundFX.stopMusic();
      this.aiToken += 1;
      this.aiBusy = false;
      this.aiPreviewPiecePos = null;
      this.undoStack = [];
      this.selectedPieceId = null;
      this.validDests = [];
      this.pendingMove = null;
      this.hammerMode = false;
      this.prevLockedSum = 0;
      this.lastAnnouncedTurn = '';
      this.matchRecorded = false;
      this.lastCompletedRecord = null;
      this.el.piecesLayer.innerHTML = '';
      this.pieceElements.clear();
    }

    startNewMatch() {
      this._resetLocalTransientState();
      this.myLocalSeat = 0;
      delete this.config.firstPlayer;
      this.engine.reset(this.config);
      this._saveActiveMatchCheckpoint();
      SoundFX.place();
      SoundFX.startBGM();
      this.render();
      this._playFirstPlayerDrawAnimation(() => {
        this.render();
        this._syncTurnTimer(true);
        this._triggerTurnCallout(true);
        this._maybeTriggerAI();
      });
    }

    _clearFirstDrawOverlay() {
      for (const t of this.firstDrawTimers) clearTimeout(t);
      this.firstDrawTimers = [];
      this.firstDrawActive = false;
      if (this.el && this.el.firstTurnOverlay) {
        this.el.firstTurnOverlay.onclick = null;
        this.el.firstTurnOverlay.classList.add('hidden');
      }
    }

    _playFirstPlayerDrawAnimation(onFinished) {
      this._clearFirstDrawOverlay();
      const overlay = this.el.firstTurnOverlay;
      const splitBg = this.el.ftSplitBg;
      const rotorEl = this.el.ftSpinnerRotor;
      if (!overlay || !splitBg || !rotorEl || !this.engine || !this.engine.players.length) {
        if (typeof onFinished === 'function') onFinished();
        return;
      }

      const players = this.engine.players;
      const count = players.length;
      const is3P = count === 3;
      const winnerIdx = (Number.isInteger(this.engine.firstPlayer) && this.engine.firstPlayer >= 0 && this.engine.firstPlayer < count)
        ? this.engine.firstPlayer
        : 0;
      const mySeat = this._getLocalSeat();

      const halves = [this.el.ftHalf0, this.el.ftHalf1, this.el.ftHalf2];
      const names = [this.el.ftName0, this.el.ftName1, this.el.ftName2];
      const badges = [this.el.ftBadge0, this.el.ftBadge1, this.el.ftBadge2];

      this.firstDrawActive = true;
      splitBg.classList.toggle('is-3p', is3P);
      halves[2].classList.toggle('hidden', !is3P);

      for (let i = 0; i < 3; i++) {
        halves[i].classList.remove('is-dim');
        badges[i].classList.add('hidden');
        if (players[i]) {
          names[i].textContent = players[i].name;
        }
      }

      // Reset rotor to 0deg without transition, then spin smoothly into winning side
      rotorEl.style.transition = 'none';
      rotorEl.style.transform = 'rotate(0deg)';
      overlay.classList.remove('hidden');
      void rotorEl.offsetWidth;

      // Exact landing angle:
      // 2P: Left Red = 270deg (9 o'clock), Right Blue = 90deg (3 o'clock)
      // 3P: Top-Left Red = 315deg, Top-Right Blue = 45deg, Bottom Gold = 180deg
      const jitter = Math.round((Math.random() - 0.5) * 20);
      let targetAngle = 270;
      if (is3P) {
        targetAngle = winnerIdx === 0 ? 315 : (winnerIdx === 1 ? 45 : 180);
      } else {
        targetAngle = winnerIdx === 0 ? 270 : 90;
      }
      const totalRotation = 5 * 360 + targetAngle + jitter;
      const spinDurationMs = 1500;

      let finished = false;
      const finishNow = () => {
        if (finished) return;
        finished = true;
        this._clearFirstDrawOverlay();
        if (typeof onFinished === 'function') onFinished();
      };

      const startTimer = setTimeout(() => {
        if (!this.firstDrawActive) return;
        rotorEl.style.transition = `transform ${spinDurationMs}ms cubic-bezier(0.12, 0.86, 0.16, 1)`;
        rotorEl.style.transform = `rotate(${totalRotation}deg)`;
      }, 45);
      this.firstDrawTimers.push(startTimer);

      const tickAt = [90, 180, 280, 400, 540, 710, 910, 1140, 1360];
      for (const ms of tickAt) {
        const tk = setTimeout(() => {
          if (this.firstDrawActive) SoundFX.select();
        }, ms);
        this.firstDrawTimers.push(tk);
      }

      const revealTimer = setTimeout(() => {
        if (!this.firstDrawActive) return;
        for (let i = 0; i < count; i++) {
          if (i === winnerIdx) {
            badges[i].classList.remove('hidden');
          } else {
            halves[i].classList.add('is-dim');
          }
        }
        const winName = players[winnerIdx] ? players[winnerIdx].name : '紅方';
        SoundFX.territoryLock();
        this.showToast(winnerIdx === mySeat ? `⚡ 你取得先手！請優先佈子` : `🎯 本局由 ${winName} 先手！`);

        overlay.onclick = () => finishNow();
        const endTimer = setTimeout(finishNow, 1050);
        this.firstDrawTimers.push(endTimer);
      }, spinDurationMs + 90);
      this.firstDrawTimers.push(revealTimer);
    }

    _dispatchHumanAction(action) {
      if (this.net.isOnline() && !this.net.isHost()) {
        this.net.sendAction(action);
        this.selectedPieceId = null;
        this.validDests = [];
        this.pendingMove = null;
        this.hammerMode = false;
        this.render();
        return;
      }
      this._executeAuthoritativeAction(action, true);
    }

    _executeAuthoritativeAction(action, saveUndo = false) {
      if (saveUndo && !this.net.isOnline()) {
        this.undoStack.push(this.engine.clone());
        if (this.undoStack.length > 50) this.undoStack.shift();
      }

      let ok = false;
      let sfx = 'place';

      if (action.kind === 'place') {
        ok = this.engine.placeInitialPiece(action.r, action.c);
        sfx = 'place';
      } else if (action.kind === 'move') {
        ok = this.engine.applyAction(action.pieceId, action.toR, action.toC, action.wall);
        sfx = 'wall';
      } else if (action.kind === 'hammer') {
        ok = this.engine.useHammer(action.wallType, action.r, action.c);
        sfx = 'hammer';
      } else if (action.kind === 'declineHammer') {
        ok = this.engine.declineEndgameHammer();
        sfx = 'select';
      }

      if (!ok) {
        if (saveUndo && !this.net.isOnline()) this.undoStack.pop();
        return false;
      }

      if (typeof SoundFX[sfx] === 'function') SoundFX[sfx]();
      if (this.net.isOnline() && this.net.isHost()) {
        this.net.broadcastState(this.engine.serialize(), { sound: sfx });
      }
      this._afterStateTransition();
      return true;
    }

    _undo() {
      if (this.net.isOnline() || this.replay.active || this.undoStack.length === 0) return;
      this.aiToken += 1;
      this.aiBusy = false;
      this.aiPreviewPiecePos = null;
      this.selectedPieceId = null;
      this.validDests = [];
      this.pendingMove = null;
      this.hammerMode = false;

      this.engine = this.undoStack.pop();
      this.prevLockedSum = this.engine.analyzeTerritories().lockedScores.reduce((a, b) => a + b, 0);
      this._closeModal('modal-gameover');
      this._hideSoulsOverlay();
      SoundFX.stopMusic();
      SoundFX.select();
      this.showToast('已退回上一步');
      this.render();
      this._syncTurnTimer(true);
    }

    // ==================== BOARD INTERACTION ====================
    _isHumanTurn() {
      if (this.firstDrawActive) return false;
      if (this.replay.active) return false;
      if (this.engine.phase === 'gameover') return false;
      if (this.aiBusy) return false;
      if (this.net.isOnline()) {
        if (!this.net.matchStarted) return false;
        return this.engine.currentPlayer === this.net.mySeat;
      }
      return !this.engine.players[this.engine.currentPlayer].isAI;
    }

    _onCellClick(r, c) {
      if (!this._isHumanTurn()) return;
      if (this.engine.phase === 'placement') {
        if (this.engine.getPieceAt(r, c)) return;
        this._dispatchHumanAction({ kind: 'place', r, c });
        return;
      }
      if (this.engine.phase !== 'play' || this.hammerMode || this.engine.hammerOnlyEndgame || this.pendingMove) return;

      if (this.selectedPieceId !== null) {
        const dest = this.validDests.find(d => d.r === r && d.c === c);
        if (dest) {
          const piece = this.engine.getPieceById(this.selectedPieceId);
          this.pendingMove = { pieceId: piece.id, fromR: piece.r, fromC: piece.c, toR: r, toC: c };
          this.selectedPieceId = null;
          this.validDests = [];
          this._enterWallTimer();
          SoundFX.move();
          this.render();
          return;
        }
      }

      const clickedPiece = this.engine.getPieceAt(r, c);
      if (clickedPiece && clickedPiece.player === this.engine.currentPlayer) {
        this._selectPiece(clickedPiece.id);
      } else {
        this.selectedPieceId = null;
        this.validDests = [];
        this.render();
      }
    }

    _onPieceClick(pieceId, e) {
      e.stopPropagation();
      if (!this._isHumanTurn() || this.engine.phase !== 'play') return;
      if (this.hammerMode || this.engine.hammerOnlyEndgame || this.pendingMove) return;
      const piece = this.engine.getPieceById(pieceId);
      if (!piece || piece.player !== this.engine.currentPlayer) return;

      if (this.selectedPieceId === pieceId) {
        this.selectedPieceId = null;
        this.validDests = [];
        SoundFX.select();
        this.render();
        return;
      }
      this._selectPiece(pieceId);
    }

    _selectPiece(pieceId) {
      const dests = this.engine.getValidDestinations(pieceId);
      if (dests.length === 0) {
        this.showToast('這顆棋子已被完全封死，無法移動或築牆');
        return;
      }
      this.selectedPieceId = pieceId;
      this.validDests = dests;
      SoundFX.select();
      this.render();
    }

    _onWallClick(type, r, c) {
      if (!this._isHumanTurn() || this.engine.phase !== 'play') return;

      if (this.hammerMode || this.engine.hammerOnlyEndgame) {
        const breakable = this.engine.getBreakableWalls(this.engine.currentPlayer, this.engine.hammerOnlyEndgame);
        if (!breakable.some(w => w.type === type && w.r === r && w.c === c)) return;
        this._dispatchHumanAction({ kind: 'hammer', wallType: type, r, c });
        return;
      }

      if (!this.pendingMove) return;
      const openEdges = this.engine.getOpenEdges(this.pendingMove.toR, this.pendingMove.toC);
      const chosen = openEdges.find(e => e.type === type && e.r === r && e.c === c);
      if (!chosen) return;

      const { pieceId, toR, toC } = this.pendingMove;
      this.pendingMove = null;
      this._dispatchHumanAction({ kind: 'move', pieceId, toR, toC, wall: chosen });
    }

    _afterStateTransition() {
      const analysis = this.engine.analyzeTerritories();
      const newLockedSum = analysis.lockedScores.reduce((a, b) => a + b, 0);
      if (newLockedSum > this.prevLockedSum && this.engine.phase !== 'gameover') {
        setTimeout(() => SoundFX.territoryLock(), 120);
      }
      this.prevLockedSum = newLockedSum;
      this.hammerMode = Boolean(this.engine.hammerOnlyEndgame && this._isHumanTurn());

      this.render();

      if (this.engine.phase === 'gameover') {
        this._handleMatchConcluded();
        return;
      }
      this._syncTurnTimer();
      this._triggerTurnCallout();
      this._maybeTriggerAI();
    }

    // ==================== AI TURN SCHEDULING ====================
    _maybeTriggerAI() {
      if (this.replay.active || this.engine.phase === 'gameover') return;
      if (this.net.isOnline() && !this.net.isHost()) return;
      const p = this.engine.currentPlayer;
      if (!this.engine.players[p].isAI) return;

      const myToken = ++this.aiToken;
      this.aiBusy = true;
      this.render();

      const delay = this.engine.phase === 'placement' ? 420 : 500;
      setTimeout(() => {
        if (myToken !== this.aiToken || this.replay.active) return;

        if (this.engine.phase === 'placement') {
          const spot = global.WallGoAI.choosePlacement(this.engine, p);
          this.aiBusy = false;
          if (spot) this._executeAuthoritativeAction({ kind: 'place', r: spot.r, c: spot.c }, false);
          return;
        }

        const choice = global.WallGoAI.choosePlayAction(this.engine, p);
        if (!choice) {
          this.aiBusy = false;
          this.render();
          return;
        }

        if (choice.type === 'decline_hammer') {
          this.aiBusy = false;
          this._executeAuthoritativeAction({ kind: 'declineHammer' }, false);
          return;
        }

        if (choice.type === 'hammer' && choice.wall) {
          this.aiBusy = false;
          this._executeAuthoritativeAction({ kind: 'hammer', wallType: choice.wall.type, r: choice.wall.r, c: choice.wall.c }, false);
          return;
        }

        const move = choice.action;
        if (!move) {
          this.aiBusy = false;
          this.render();
          return;
        }

        // Slide piece visibly before wall slam
        this.aiPreviewPiecePos = { pieceId: move.pieceId, r: move.toR, c: move.toC };
        SoundFX.move();
        this.render();

        setTimeout(() => {
          if (myToken !== this.aiToken || this.replay.active) return;
          this.aiPreviewPiecePos = null;
          this.aiBusy = false;
          this._executeAuthoritativeAction({ kind: 'move', pieceId: move.pieceId, toR: move.toR, toC: move.toC, wall: move.wall }, false);
        }, 320);
      }, delay);
    }

    // ==================== COUNTDOWN TIMER (90s / 30s + 5s RED FLASH) ====================
    _getTurnKey() {
      return `${this.engine.phase}-${this.engine.turnNumber}-${this.engine.currentPlayer}-${this.engine.placementQueue.length}`;
    }

    _stopTimer() {
      if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
      this.timerPhase = null;
      this.lastTickSec = -1;
      if (this.el.turnTimer) {
        this.el.turnTimer.classList.add('hidden');
        this.el.timerBarTrack.classList.add('hidden');
      }
      if (this.el.urgentVignette) this.el.urgentVignette.classList.remove('active');
    }

    _syncTurnTimer(forceReset = false) {
      if (this.replay.active || !this.engine.timerEnabled || this.engine.phase === 'gameover' || (this.net.isOnline() && !this.net.matchStarted)) {
        this._stopTimer();
        return;
      }
      const pObj = this.engine.players[this.engine.currentPlayer];
      if (!pObj || pObj.isAI) { this._stopTimer(); return; }

      const key = this._getTurnKey();
      if (!forceReset && this.timerInterval && key === this.lastTurnKey) {
        this._renderTimerUI();
        return;
      }
      this._stopTimer();
      this.lastTurnKey = key;
      this.savedThinkMs = THINK_TIME_MS;
      this.timerPhase = 'think';
      this.timerTotalMs = THINK_TIME_MS;
      this.timerDeadline = Date.now() + THINK_TIME_MS;
      this.lastTickSec = -1;
      this._renderTimerUI();
      this.timerInterval = setInterval(() => this._onTimerTick(), 200);
    }

    _enterWallTimer() {
      if (!this.engine.timerEnabled || !this._isHumanTurn()) return;
      if (this.timerPhase === 'think') this.savedThinkMs = Math.max(1000, this.timerDeadline - Date.now());
      this.timerPhase = 'wall';
      this.timerTotalMs = WALL_TIME_MS;
      this.timerDeadline = Date.now() + WALL_TIME_MS;
      this.lastTickSec = -1;
      if (!this.timerInterval) this.timerInterval = setInterval(() => this._onTimerTick(), 200);
      this._renderTimerUI();
    }

    _resumeThinkTimerFromCancel() {
      if (!this.engine.timerEnabled || !this._isHumanTurn()) return;
      this.timerPhase = 'think';
      this.timerTotalMs = THINK_TIME_MS;
      this.timerDeadline = Date.now() + Math.max(1000, this.savedThinkMs);
      this.lastTickSec = -1;
      this._renderTimerUI();
    }

    _formatClock(ms) {
      const totalSec = Math.max(0, Math.ceil(ms / 1000));
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    _renderTimerUI() {
      if (!this.timerPhase || !this.engine.timerEnabled || this.replay.active) {
        this.el.turnTimer.classList.add('hidden');
        this.el.timerBarTrack.classList.add('hidden');
        return;
      }
      const remMs = Math.max(0, this.timerDeadline - Date.now());
      const sec = Math.ceil(remMs / 1000);
      const pct = Math.max(0, Math.min(100, (remMs / this.timerTotalMs) * 100));

      this.el.turnTimer.classList.remove('hidden', 'wall-phase', 'warning', 'danger');
      this.el.timerBarTrack.classList.remove('hidden');
      this.el.timerBarFill.classList.remove('wall-phase', 'warning', 'danger');

      this.el.timerPhaseLabel.textContent = this.timerPhase === 'wall' ? '築牆' : '思考';
      this.el.timerClock.textContent = this._formatClock(remMs);
      this.el.timerBarFill.style.width = `${pct}%`;

      if (sec <= 10) {
        this.el.turnTimer.classList.add('danger');
        this.el.timerBarFill.classList.add('danger');
      } else if (sec <= 20) {
        this.el.turnTimer.classList.add('warning');
        this.el.timerBarFill.classList.add('warning');
      } else if (this.timerPhase === 'wall') {
        this.el.turnTimer.classList.add('wall-phase');
        this.el.timerBarFill.classList.add('wall-phase');
      }

      const showUrgent = Boolean(this._isHumanTurn() && sec > 0 && sec <= 5);
      this.el.urgentVignette.classList.toggle('active', showUrgent);
    }

    _onTimerTick() {
      if (!this.timerPhase || !this.engine.timerEnabled || this.engine.phase === 'gameover' || this.replay.active) {
        this._stopTimer();
        return;
      }
      const remMs = this.timerDeadline - Date.now();
      this._renderTimerUI();
      const sec = Math.ceil(remMs / 1000);
      if (this._isHumanTurn() && sec > 0 && sec <= 10 && sec !== this.lastTickSec) {
        this.lastTickSec = sec;
        SoundFX.countdownTick(sec);
      }
      if (remMs <= 0) {
        if (this._isHumanTurn()) {
          const expired = this.timerPhase;
          this._stopTimer();
          SoundFX.timeout();
          this._autoResolveTimeout(expired);
        } else if (this.net.isOnline() && this.net.isHost() && remMs <= -HOST_GRACE_MS) {
          this._stopTimer();
          this._autoResolveTimeout('think');
        }
      }
    }

    _autoResolveTimeout(phase) {
      if (this.engine.phase === 'placement') {
        const empties = [];
        for (let r = 0; r < BOARD_SIZE; r++)
          for (let c = 0; c < BOARD_SIZE; c++)
            if (!this.engine.getPieceAt(r, c)) empties.push({ r, c });
        if (empties.length) {
          const pick = empties[Math.floor(Math.random() * empties.length)];
          this.showToast('⏱ 思考逾時，系統已自動隨機放子！');
          this._dispatchHumanAction({ kind: 'place', r: pick.r, c: pick.c });
        }
        return;
      }
      if (this.engine.hammerOnlyEndgame) {
        this._dispatchHumanAction({ kind: 'declineHammer' });
        return;
      }
      if (phase === 'wall' && this.pendingMove) {
        const edges = this.engine.getOpenEdges(this.pendingMove.toR, this.pendingMove.toC);
        if (edges.length) {
          const chosen = edges[Math.floor(Math.random() * edges.length)];
          const { pieceId, toR, toC } = this.pendingMove;
          this.pendingMove = null;
          this.showToast('⏱ 30 秒築牆逾時，已於棋子旁自動隨機築牆！');
          this._dispatchHumanAction({ kind: 'move', pieceId, toR, toC, wall: chosen });
          return;
        }
      }
      const actions = this.engine.getAllLegalActions(this.engine.currentPlayer);
      if (actions.length) {
        const pick = actions[Math.floor(Math.random() * actions.length)];
        this.selectedPieceId = null;
        this.validDests = [];
        this.pendingMove = null;
        this.showToast('⏱ 90 秒思考逾時，系統已自動隨機走棋！');
        this._dispatchHumanAction({ kind: 'move', pieceId: pick.pieceId, toR: pick.toR, toC: pick.toC, wall: pick.wall });
      }
    }

    // ==================== INTERACTIVE REPLAY THEATER ====================
    _getReplayInitConfig(record) {
      const cfg = { ...(record.initialConfig || {}) };
      if (!Number.isInteger(cfg.firstPlayer)) {
        const firstStep = Array.isArray(record.steps) && record.steps.length > 0 ? record.steps[0] : null;
        cfg.firstPlayer = (firstStep && Number.isInteger(firstStep.player)) ? firstStep.player : 0;
      }
      if (Array.isArray(record.players) && record.players.length) {
        cfg.onlineSeats = record.players.map(p => ({ nickname: p.name, isAI: Boolean(p.isAI) }));
      }
      return cfg;
    }

    _startReplay(record) {
      if (!record || !record.initialConfig) {
        this.showToast('此場紀錄缺少棋譜資料，無法演練');
        return;
      }
      this._stopTimer();
      this._stopConfetti();
      this.aiToken += 1;
      this.aiBusy = false;
      this.selectedPieceId = null;
      this.validDests = [];
      this.pendingMove = null;
      this.hammerMode = false;

      this._stopReplayAuto();
      this.replay.active = true;
      this.replay.record = record;
      this.replay.stepIndex = 0;
      this.replay.engine = new global.WallGoEngine(this._getReplayInitConfig(record));

      this.el.piecesLayer.innerHTML = '';
      this.pieceElements.clear();

      this.el.replaySlider.min = '0';
      this.el.replaySlider.max = String(record.steps.length);
      this.el.replaySlider.value = '0';
      const p0Name = record.players[0] ? record.players[0].name : '紅方';
      const p1Name = record.players[1] ? record.players[1].name : '藍方';
      this.el.replayMatchTitle.textContent = `${p0Name} vs ${p1Name}（${record.scores.join(' : ')}）`;

      this.el.tacticalStrip.classList.add('hidden');
      this.el.replayBar.classList.remove('hidden');
      this._seekReplay(0);
      this.showToast('🎬 已進入歷史對戰流程演練！可按「自動演練」或左右方向鍵逐手檢視');
    }

    _seekReplay(targetIdx) {
      if (!this.replay.active || !this.replay.record) return;
      const maxStep = this.replay.record.steps.length;
      const clamped = Math.max(0, Math.min(maxStep, targetIdx));
      this.replay.stepIndex = clamped;

      const eng = new global.WallGoEngine(this._getReplayInitConfig(this.replay.record));
      for (let i = 0; i < clamped; i++) {
        eng.applyRecordedStep(this.replay.record.steps[i]);
      }
      this.replay.engine = eng;

      this.el.replaySlider.value = String(clamped);
      this.el.replayStepCounter.textContent = `第 ${clamped} / ${maxStep} 手`;
      if (clamped === 0) {
        this.el.replayStepDesc.textContent = '開局初始盤面（點擊 ▶ 自動演練 或 下手 ▶ 逐步觀看）';
      } else {
        const lastStep = this.replay.record.steps[clamped - 1];
        this.el.replayStepDesc.textContent = `第 ${clamped} 手：${lastStep.desc || '落子／移動'}`;
      }
      SoundFX.select();
      this.render();
    }

    _toggleReplayPlay() {
      if (!this.replay.active) return;
      if (this.replay.playing) this._stopReplayAuto();
      else this._startReplayAuto();
    }

    _startReplayAuto() {
      if (!this.replay.active || !this.replay.record) return;
      if (this.replay.stepIndex >= this.replay.record.steps.length) {
        this._seekReplay(0);
      }
      this.replay.playing = true;
      this.el.btnRpPlay.textContent = '⏸ 暫停演練';
      const ms = Math.round(900 / this.replay.speed);
      this.replay.timer = setInterval(() => {
        if (!this.replay.active) { this._stopReplayAuto(); return; }
        if (this.replay.stepIndex >= this.replay.record.steps.length) {
          this._stopReplayAuto();
          this.showToast('🎬 流程演練播放完畢！');
          return;
        }
        this._seekReplay(this.replay.stepIndex + 1);
      }, ms);
    }

    _stopReplayAuto() {
      if (this.replay.timer) { clearInterval(this.replay.timer); this.replay.timer = null; }
      this.replay.playing = false;
      if (this.el && this.el.btnRpPlay) this.el.btnRpPlay.textContent = '▶ 自動演練';
    }

    _exitReplay(silent = false) {
      this._stopReplayAuto();
      this.replay.active = false;
      this.replay.record = null;
      this.replay.engine = null;
      this.el.replayBar.classList.add('hidden');
      this.el.tacticalStrip.classList.remove('hidden');
      this.el.piecesLayer.innerHTML = '';
      this.pieceElements.clear();
      if (!silent) {
        if (this.replayReturnToLobby) {
          this.replayReturnToLobby = false;
          this._enterRankedLobby();
          return;
        }
        this.render();
        this._syncTurnTimer();
        this._maybeTriggerAI();
      }
    }

    // ==================== RENDERING ====================
    _activeEngine() {
      return this.replay.active && this.replay.engine ? this.replay.engine : this.engine;
    }

    render() {
      const eng = this._activeEngine();
      const analysis = eng.analyzeTerritories();
      this._renderVSBanner(eng, analysis);
      this._renderTacticalStrip(eng);
      this._renderBoard(eng, analysis);
      this._renderRightPanels(eng);
      this._updateOnlineControls();
      if (this.el.postgameLobbyBar) {
        this.el.postgameLobbyBar.classList.toggle('hidden', this.replay.active || eng.phase !== 'gameover');
      }
    }

    _renderVSBanner(eng, analysis) {
      const is3P = eng.numPlayers === 3;
      this.el.vsBanner.classList.toggle('three-players', is3P);
      this.el.vsBanner.classList.remove('turn-p0', 'turn-p1', 'turn-p2', 'turn-none');
      if (eng.phase === 'gameover') {
        this.el.vsBanner.classList.add('turn-none');
      } else {
        this.el.vsBanner.classList.add(`turn-p${eng.currentPlayer}`);
      }
      this.el.vsSide2.classList.toggle('hidden', !is3P);

      const slots = [
        { side: this.el.vsSide0, score: this.el.vsScore0, name: this.el.vsName0, pill: this.el.vsTurnPill0 },
        { side: this.el.vsSide1, score: this.el.vsScore1, name: this.el.vsName1, pill: this.el.vsTurnPill1 },
        { side: this.el.vsSide2, score: this.el.vsScore2, name: this.el.vsName2, pill: this.el.vsTurnPill2 }
      ];

      eng.players.forEach((p, idx) => {
        const s = slots[idx];
        if (!s) return;
        const isActive = eng.phase !== 'gameover' && eng.currentPlayer === idx;
        const isMe = !this.replay.active && (this.net.isOnline() ? this.net.mySeat === idx : (!p.isAI && idx === 0));

        s.side.classList.toggle('active', isActive);
        s.score.textContent = String(analysis.lockedScores[idx] ?? 0);
        s.name.textContent = p.name;

        s.pill.classList.toggle('hidden', !isActive);
        if (isActive) {
          s.pill.textContent = this.replay.active
            ? '▶ 演練行動'
            : (isMe ? '▶ 輪到你' : '▶ 思考中');
        }
      });

      this.el.vsTurnCounter.textContent = this.replay.active
        ? `${this.replay.stepIndex}/${this.replay.record.steps.length} 手`
        : (eng.phase === 'placement' ? '佈子階段' : `第 ${eng.turnNumber} 回合`);

      if (eng.phase === 'gameover') {
        this.el.turnBadge.textContent = '對局結束';
      } else if (eng.phase === 'placement') {
        this.el.turnBadge.textContent = '開局佈子';
      } else if (this.pendingMove) {
        this.el.turnBadge.textContent = '步驟 2/2 築牆';
      } else if (this.hammerMode || eng.hammerOnlyEndgame) {
        this.el.turnBadge.textContent = '🔨 破牆階段';
      } else {
        this.el.turnBadge.textContent = '步驟 1/2 移動';
      }
    }

    _renderTacticalStrip(eng) {
      if (this.replay.active) return;

      const curIdx = eng.currentPlayer;
      const pObj = eng.players[curIdx] || eng.players[0];
      this.el.turnDot.style.background = PLAYER_COLORS[curIdx];
      this.el.turnDot.style.color = PLAYER_COLORS[curIdx];

      this.el.btnCancelMove.classList.add('hidden');
      this.el.btnHammer.classList.add('hidden');
      this.el.btnHammer.classList.remove('active');
      this.el.btnEndHammer.classList.add('hidden');

      if (eng.phase === 'gameover') {
        const w = eng.result && eng.result.winners[0];
        const immNote = (eng.result && eng.result.endReason === 'immobile' && eng.result.immobilePlayers && eng.result.immobilePlayers.length)
          ? `${eng.result.immobilePlayers.map(p => p.name).join('、')} 無子可動・`
          : '';
        this.el.turnInstruction.textContent = eng.result && eng.result.isDraw
          ? `${immNote}對局平手結束！可從右側「最近 5 場戰績」隨時回看流程演練。`
          : `${immNote}對局結束！由 ${w ? w.name : ''} 以 ${w ? w.score : 0} 分奪勝！`;
        return;
      }

      if (this.aiBusy) {
        this.el.turnInstruction.textContent = `${pObj.name} 正在運算最佳領地封鎖路線…`;
        return;
      }

      if (!this._isHumanTurn()) {
        this.el.turnInstruction.textContent = `等待對手 ${pObj.name} 落子…`;
        return;
      }

      if (eng.phase === 'placement') {
        const slot = eng.getCurrentPlacement();
        const shTxt = slot && slot.shape === 'square' ? '【■ 方形棋・直線 1–2 格】' : slot && slot.shape === 'circle' ? '【● 圓形棋・1 格或 L 型轉彎】' : '棋子';
        this.el.turnInstruction.textContent = `請點擊棋盤任一空格放置你的 ${shTxt}（滑鼠移入空格可預覽形狀）。`;
        return;
      }

      if (eng.hammerOnlyEndgame) {
        this.el.btnEndHammer.classList.remove('hidden');
        this.el.turnInstruction.textContent = '全場領地已隔離！你可以點擊發光牆壁「破牆續戰」，或點右側按鈕直接結算。';
        return;
      }

      if (this.pendingMove) {
        this.el.btnCancelMove.classList.remove('hidden');
        this.el.turnInstruction.textContent = '請點擊該棋子周圍發亮的黃色邊界蓋下一道牆壁（或點擊「取消移動」重選）。';
        return;
      }

      if (eng.numPlayers === 3 && pObj.hammers > 0 && eng.getBreakableWalls(curIdx, false).length > 0) {
        this.el.hammerCount.textContent = String(pObj.hammers);
        this.el.btnHammer.classList.remove('hidden');
        if (this.hammerMode) {
          this.el.btnHammer.classList.add('active');
          this.el.turnInstruction.textContent = '🔨 破牆模式：點擊緊鄰己方棋子的紅色發光牆壁將其擊碎！';
          return;
        }
      }

      if (this.selectedPieceId !== null) {
        const sel = eng.getPieceById(this.selectedPieceId);
        this.el.turnInstruction.textContent = sel && sel.shape === 'square'
          ? '【■ 方形棋】請點擊綠色高亮格沿直線移動 1～2 格（不可轉彎、不可原地不動）。'
          : sel && sel.shape === 'circle'
            ? '【● 圓形棋】請點擊綠色高亮格移動 1 格或 L 型轉彎 2 格（不可直走 2 格、不可原地不動）。'
            : '請點擊綠色高亮格移動 1～2 格（不可原地不動）。';
      } else {
        this.el.turnInstruction.textContent = eng.ruleVariant === 'v2'
          ? `輪到 ${pObj.name}：請點擊己方的 ■ 方形棋（直線）或 ● 圓形棋（L 型轉彎）開始移動。`
          : `輪到 ${pObj.name}：請點擊一顆己方棋子移動 1～2 格。`;
      }
    }

    _renderBoard(eng, analysis) {
      const humanTurn = this._isHumanTurn();
      const validDestSet = new Set(this.validDests.map(d => `${d.r},${d.c}`));
      const placementSlot = (humanTurn && eng.phase === 'placement') ? eng.getCurrentPlacement() : null;

      // 1. Cells
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          const cell = this.cellEls[r][c];
          const classes = ['cell'];
          if (eng.phase !== 'placement') {
            const owner = analysis.cellOwner[r][c];
            if (owner >= 0) classes.push(`territory-${owner}`);
            else if (owner === -2) classes.push('territory-neutral');
          }
          if (eng.lastMoveFrom && eng.lastMoveFrom.r === r && eng.lastMoveFrom.c === c) classes.push('last-move-from');
          if (placementSlot && !eng.getPieceAt(r, c)) {
            classes.push('placeable', `ghost-p${placementSlot.player}`, `ghost-${placementSlot.shape}`);
          }
          if (humanTurn && this.selectedPieceId !== null && validDestSet.has(`${r},${c}`)) {
            classes.push('move-target');
          }
          cell.className = classes.join(' ');
        }
      }

      // 2. Walls
      const buildableSet = new Set();
      const breakableSet = new Set();
      if (humanTurn && eng.phase === 'play') {
        if (this.pendingMove) {
          for (const e of eng.getOpenEdges(this.pendingMove.toR, this.pendingMove.toC)) buildableSet.add(`${e.type}-${e.r}-${e.c}`);
        } else if (this.hammerMode || eng.hammerOnlyEndgame) {
          for (const w of eng.getBreakableWalls(eng.currentPlayer, eng.hammerOnlyEndgame)) breakableSet.add(`${w.type}-${w.r}-${w.c}`);
        }
      }

      for (let r = 0; r < BOARD_SIZE - 1; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          const key = `h-${r}-${c}`;
          const cls = ['wall-slot', 'horizontal'];
          if (eng.hWalls[r][c]) {
            cls.push('built', `owner-${eng.hWallOwner[r][c]}`);
            if (eng.lastBuiltWall && eng.lastBuiltWall.type === 'h' && eng.lastBuiltWall.r === r && eng.lastBuiltWall.c === c) cls.push('last-built');
          }
          if (buildableSet.has(key)) cls.push('buildable');
          if (breakableSet.has(key)) cls.push('breakable');
          this.hWallEls[r][c].className = cls.join(' ');
        }
      }
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE - 1; c++) {
          const key = `v-${r}-${c}`;
          const cls = ['wall-slot', 'vertical'];
          if (eng.vWalls[r][c]) {
            cls.push('built', `owner-${eng.vWallOwner[r][c]}`);
            if (eng.lastBuiltWall && eng.lastBuiltWall.type === 'v' && eng.lastBuiltWall.r === r && eng.lastBuiltWall.c === c) cls.push('last-built');
          }
          if (buildableSet.has(key)) cls.push('buildable');
          if (breakableSet.has(key)) cls.push('breakable');
          this.vWallEls[r][c].className = cls.join(' ');
        }
      }

      // 3. Pieces (Zero movement icons on pieces!)
      const activeIds = new Set(eng.pieces.map(p => p.id));
      for (const [id, node] of this.pieceElements.entries()) {
        if (!activeIds.has(id)) {
          node.remove();
          this.pieceElements.delete(id);
        }
      }

      for (const pc of eng.pieces) {
        let el = this.pieceElements.get(pc.id);
        if (!el) {
          el = document.createElement('div');
          el.addEventListener('click', (e) => this._onPieceClick(pc.id, e));
          this.el.piecesLayer.appendChild(el);
          this.pieceElements.set(pc.id, el);
        }

        let vr = pc.r, vc = pc.c;
        if (!this.replay.active) {
          if (this.pendingMove && this.pendingMove.pieceId === pc.id) { vr = this.pendingMove.toR; vc = this.pendingMove.toC; }
          else if (this.aiPreviewPiecePos && this.aiPreviewPiecePos.pieceId === pc.id) { vr = this.aiPreviewPiecePos.r; vc = this.aiPreviewPiecePos.c; }
        }

        el.style.left = `calc(${vc} * (var(--cell-size) + var(--gap-size)) + var(--cell-size) / 2)`;
        el.style.top = `calc(${vr} * (var(--cell-size) + var(--gap-size)) + var(--cell-size) / 2)`;
        el.textContent = '';

        const cls = ['piece', `p${pc.player}`, `shape-${pc.shape || 'classic'}`];
        if (humanTurn && eng.phase === 'play' && !this.hammerMode && !eng.hammerOnlyEndgame && !this.pendingMove && pc.player === eng.currentPlayer) {
          if (eng.getValidDestinations(pc.id).length > 0) cls.push('selectable');
          else cls.push('disabled-piece');
        }
        if (!this.replay.active && this.selectedPieceId === pc.id) cls.push('selected');
        if (!this.replay.active && this.pendingMove && this.pendingMove.pieceId === pc.id) cls.push('building-wall');
        el.className = cls.join(' ');
      }

      document.querySelectorAll('.legend-v2').forEach(n => n.classList.toggle('hidden', eng.ruleVariant !== 'v2'));
    }

    _renderLeaderboardInto(targetEl) {
      const lb = Stats.getLeaderboard();
      if (!targetEl) return lb;
      const presenceLabel = (st) => {
        if (st === 'online') return '<span class="presence-badge presence-online">🟢 在線</span>';
        if (st === 'queuing') return '<span class="presence-badge presence-queuing">🔍 排隊</span>';
        if (st === 'playing') return '<span class="presence-badge presence-playing">⚔️ 遊玩中</span>';
        return '<span class="presence-badge presence-offline">⚪ 離線</span>';
      };

      targetEl.innerHTML = lb.map(row => {
        const rankCls = row.rank === 1 ? 'top1' : (row.rank === 2 ? 'top2' : (row.rank === 3 ? 'top3' : ''));
        const medal = row.rank === 1 ? '👑' : `#${row.rank}`;
        const statusTag = row.isAI
          ? '<span class="lb-tag-ai">AI</span>'
          : `${row.isMe ? '<span class="lb-tag-human">你</span>' : ''}${presenceLabel(row.presence)}`;
        const deltaHtml = row.lastDelta
          ? `<span class="mh-rp ${row.lastDelta > 0 ? 'pos' : 'neg'}">${row.lastDelta > 0 ? `+${row.lastDelta}` : row.lastDelta}</span>`
          : '';
        return `
          <div class="lb-row ${row.isMe ? 'me' : ''}">
            <div class="lb-left">
              <span class="lb-rank ${rankCls}">${medal}</span>
              <span class="tier-badge ${row.tier.cls}">${row.tier.name}</span>
              <span class="lb-name">${this._escapeHtml(row.name)}</span>
              ${statusTag}
            </div>
            <div class="lb-right">
              <span class="lb-wl">${row.wins}勝${row.losses}敗</span>
              ${deltaHtml}
              <span class="lb-rp">${row.rp}</span>
            </div>
          </div>`;
      }).join('');
      return lb;
    }

    _renderRecentListInto(targetEl, cat, fromRankedLobby = false) {
      if (!targetEl) return;
      const bucket = Stats.getBucket(cat);
      if (!bucket.history.length) {
        targetEl.innerHTML = '<div class="recent-empty">尚無完賽紀錄 — 完成對局後將自動保存並支援「流程演練」！</div>';
        return;
      }
      targetEl.innerHTML = bucket.history.map(m => {
        const resTxt = m.outcome === 'win' ? '勝' : (m.outcome === 'loss' ? '敗' : '平');
        const rpHtml = m.category === 'ranked' && m.rpDelta !== 0
          ? `<span class="mh-rp ${m.rpDelta > 0 ? 'pos' : 'neg'}">${m.rpDelta > 0 ? '+' : ''}${m.rpDelta} RP</span>`
          : '';
        const d = new Date(m.timestamp);
        const timeStr = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const isReplayingThis = this.replay.active && this.replay.record && this.replay.record.id === m.id;
        return `
          <div class="match-hist-card ${m.outcome} ${isReplayingThis ? 'replaying' : ''}">
            <div class="mh-info">
              <div class="mh-top">
                <span class="mh-badge ${m.outcome}">${resTxt}</span>
                <span class="mh-score">${m.scores.join(' : ')}</span>
                ${rpHtml}
              </div>
              <div class="mh-sub">對手：${this._escapeHtml(m.opponentName)} · ${m.steps.length} 手 · ${timeStr}</div>
            </div>
            <button type="button" class="btn btn-sm ${isReplayingThis ? 'btn-esports-red' : 'btn-hud'}" data-replay-id="${m.id}">
              ${isReplayingThis ? '演練中' : '▶ 演練'}
            </button>
          </div>`;
      }).join('');

      targetEl.querySelectorAll('[data-replay-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const rec = Stats.getMatchById(cat, btn.dataset.replayId);
          if (!rec) return;
          if (fromRankedLobby) {
            this.replayReturnToLobby = true;
            this._enterArena();
          }
          this._startReplay(rec);
        });
      });
    }

    _renderRightPanels(eng) {
      const cat = this.matchCategory;
      const verText = eng.ruleVariant === 'v2' ? 'Ⅱ代' : 'Ⅰ代';
      const catLabel = cat === 'ranked' ? '🏆 線上積分賽' : (cat === 'friends' ? '🤝 邀請好友賽' : `🤖 單機 ${this._aiLabel(eng.aiLevel)}`);
      this.el.modeTag.textContent = `${verText} · ${catLabel}`;
      this.el.turnCounter.textContent = eng.phase === 'placement' ? '開局佈子' : `第 ${eng.turnNumber} 回合`;

      // Ranked Lobby Human-vs-Human focused HUD: ONLY Player Chat (top) + Move Log (below); hide Leaderboard & Record!
      const isRankedHumanMatch = (cat === 'ranked' && !this.currentRankedRival && !this.replay.active);
      if (this.el.arenaDashboard) {
        this.el.arenaDashboard.classList.toggle('ranked-human-mode', isRankedHumanMatch);
      }

      // 1. Live Shared Ranked Leaderboard Panel (shown in Ranked vs AI / Replay; hidden in Ranked Human-vs-Human)
      this.el.panelLeaderboard.classList.toggle('hidden', cat !== 'ranked' || isRankedHumanMatch);
      if (cat === 'ranked' && !isRankedHumanMatch) {
        const rp = Stats.getRP();
        const tier = Stats.getTierInfo(rp);
        this.el.lbMyTierChip.textContent = `${tier.name} · ${rp} RP`;
        this._renderLeaderboardInto(this.el.leaderboardList);
      }

      // 2. W/L/D Proportional Bar & Recent 5 Matches with Replay Button (hidden in Ranked Human-vs-Human)
      this.el.panelRecord.classList.toggle('hidden', isRankedHumanMatch);
      if (!isRankedHumanMatch) {
        const bucket = Stats.getBucket(cat);
        const total = bucket.wins + bucket.losses + bucket.draws;
        const winRate = total > 0 ? Math.round((bucket.wins / total) * 100) : 0;
        const winPct = total > 0 ? (bucket.wins / total) * 100 : 0;
        const drawPct = total > 0 ? (bucket.draws / total) * 100 : 0;
        const lossPct = total > 0 ? (bucket.losses / total) * 100 : 0;

        this.el.recordPanelTitle.textContent = cat === 'ranked'
          ? '積分賽近期戰績'
          : (cat === 'friends' ? '好友對戰戰績' : '單機 AI 戰績');
        this.el.recordWinrateChip.textContent = `共 ${total} 場`;
        this.el.statWinrate.textContent = `${winRate}%`;
        this.el.ratioSegWin.style.width = `${winPct}%`;
        this.el.ratioSegDraw.style.width = `${drawPct}%`;
        this.el.ratioSegLoss.style.width = `${lossPct}%`;
        this.el.statWins.textContent = String(bucket.wins);
        this.el.statLosses.textContent = String(bucket.losses);
        this.el.statDraws.textContent = String(bucket.draws);

        this._renderRecentListInto(this.el.recentMatchesList, cat, false);
      }

      // 3. Move Log
      this.el.moveLog.innerHTML = eng.logs.map(entry => {
        const cls = entry.player === -1 ? 'system' : `p${entry.player}`;
        return `<li class="log-entry ${cls}">${entry.text}</li>`;
      }).join('');
    }

    // ==================== MATCH CONCLUSION & CINEMATICS ====================
    _getLocalSeat() {
      if (this.net.isOnline() && Number.isInteger(this.net.mySeat) && this.net.mySeat >= 0) {
        return this.net.mySeat;
      }
      return Number.isInteger(this.myLocalSeat) ? this.myLocalSeat : 0;
    }

    _didLocalPlayerLose() {
      const res = this.engine.result;
      if (!res || res.isDraw) return false;
      return !res.winners.some(w => w.player === this._getLocalSeat());
    }

    _handleMatchConcluded() {
      this._clearActiveMatchCheckpoint();
      this._stopTimer();
      const res = this.engine.result;
      if (!res) return;

      // Record match ONCE into shared Global Hub leaderboard + local 5-match replay history
      let recOutcome = null;
      if (!this.matchRecorded) {
        this.matchRecorded = true;
        const mySeat = this._getLocalSeat();
        const oppObj = this.engine.players.find(p => p.id !== mySeat);
        const oppName = this.currentRankedRival ? this.currentRankedRival.name : (oppObj ? oppObj.name : '對手');
        const myOutcome = res.isDraw ? 'draw' : (res.winners.some(w => w.player === mySeat) ? 'win' : 'loss');

        let rpDelta = (this.matchCategory === 'ranked')
          ? (res.serverSettled && Number.isFinite(res.settledRpDelta)
            ? res.settledRpDelta
            : (myOutcome === 'win' ? 18 : myOutcome === 'loss' ? -14 : 0))
          : 0;

        recOutcome = Stats.recordLocalReplay({
          category: this.matchCategory,
          engine: this.engine,
          mySeat,
          opponentName: oppName,
          rpDelta
        });
        if (recOutcome && res.serverSettled && Number.isFinite(res.settledNewRp)) {
          recOutcome.newRp = res.settledNewRp;
        }
        this.lastCompletedRecord = recOutcome ? recOutcome.record : null;

        if (this.matchCategory === 'ranked') {
          const matchId = 'rk_' + (this.lastCompletedRecord ? this.lastCompletedRecord.id : Date.now());
          if (this.currentRankedRival) {
            // Human vs AI Ranked match -> write to server wallgo-data.txt (updates player + evolves all idle AI pros!)
            const hubRes = this.hub.reportRankedMatch({
              matchId,
              playerAName: Stats.getNickname(),
              playerBName: this.currentRankedRival.name,
              bIsAI: true,
              rivalId: this.currentRankedRival.id,
              outcomeForA: myOutcome,
              replayRecord: this.lastCompletedRecord
            });
            if (hubRes && Number.isFinite(hubRes.rpDeltaA)) {
              rpDelta = hubRes.rpDeltaA;
              if (this.lastCompletedRecord) this.lastCompletedRecord.rpDelta = rpDelta;
              if (recOutcome) recOutcome.rpDelta = rpDelta;
            }
          } else if (res.forfeitWin) {
            // Surviving winner when opponent left/forfeited (works even if Host was the one who left!)
            if (res.serverSettled) {
              // Server already settled RP via opponent's forfeit beacon -> just save our replay!
              if (this.lastCompletedRecord) {
                this.hub.saveServerReplay(Stats.getNickname(), this.lastCompletedRecord);
              }
            } else {
              const roomCode = this.activeOnlineRoomCode || this.net.roomCode || '';
              const hubRes = this.hub.reportRankedMatch({
                matchId: 'p2p_' + (roomCode || Date.now()) + '_forfeit',
                playerAName: Stats.getNickname(),
                playerBName: res.leftName || oppName,
                bIsAI: false,
                outcomeForA: 'win',
                replayRecord: this.lastCompletedRecord
              });
              if (hubRes && Number.isFinite(hubRes.rpDeltaA)) {
                rpDelta = hubRes.rpDeltaA;
                if (this.lastCompletedRecord) this.lastCompletedRecord.rpDelta = rpDelta;
                if (recOutcome) recOutcome.rpDelta = rpDelta;
              }
            }
          } else if (this.net.isOnline() && this.net.isHost()) {
            // Human vs Human Ranked match -> Host reports ONCE to server wallgo-data.txt
            const p0Name = this.engine.players[0] ? this.engine.players[0].name : Stats.getNickname();
            const p1Name = this.engine.players[1] ? this.engine.players[1].name : oppName;
            const hostOutcome = res.isDraw ? 'draw' : (res.winners.some(w => w.player === 0) ? 'win' : 'loss');
            const hubRes = this.hub.reportRankedMatch({
              matchId: 'p2p_' + (this.activeOnlineRoomCode || this.net.roomCode || '') + '_' + this.engine.turnNumber,
              playerAName: p0Name,
              playerBName: p1Name,
              bIsAI: false,
              outcomeForA: hostOutcome,
              replayRecord: this.lastCompletedRecord
            });
            if (hubRes && Number.isFinite(hubRes.rpDeltaA)) {
              rpDelta = hubRes.rpDeltaA;
              if (this.lastCompletedRecord) this.lastCompletedRecord.rpDelta = rpDelta;
              if (recOutcome) recOutcome.rpDelta = rpDelta;
            }
          } else if (this.lastCompletedRecord) {
            // Guest in Human vs Human -> also persist guest's replay to server wallgo-data.txt
            this.hub.saveServerReplay(Stats.getNickname(), this.lastCompletedRecord);
          }
        }
        this._syncProfileUI();
        this._renderRightPanels(this.engine);
      }
      if (this.el.postgameLobbyBar) {
        this.el.postgameLobbyBar.classList.toggle('hidden', this.replay.active || this.engine.phase !== 'gameover');
      }

      if (this._didLocalPlayerLose()) {
        SoundFX.soulsDefeat();
        const winner = res.winners[0];
        this.el.soulsSubtitle.textContent = winner
          ? `敗北 · ${winner.name} 以 ${winner.score} 格領地奪勝`
          : '敗北 · 領地爭奪戰落敗';
        this.el.soulsOverlay.classList.remove('hidden');

        clearTimeout(this.soulsTimer);
        this.soulsTimer = setTimeout(() => {
          this._hideSoulsOverlay();
          this._showGameOverModal(false, recOutcome);
        }, 5800);
        return;
      }

      if (res.isDraw) {
        SoundFX.territoryLock();
        setTimeout(() => this._showGameOverModal(false, recOutcome), 420);
      } else {
        SoundFX.victoryMusic();
        setTimeout(() => this._showGameOverModal(true, recOutcome), 420);
      }
    }

    _showGameOverModal(celebrate = true, recOutcome = null) {
      const res = this.engine.result;
      if (!res) return;

      const immSuffix = (res.endReason === 'immobile' && Array.isArray(res.immobilePlayers) && res.immobilePlayers.length > 0)
        ? `（${res.immobilePlayers.map(p => this._escapeHtml(p.name)).join('、')} 所有棋子已無法移動・立即結算）`
        : '';

      if (res.forfeitWin) {
        const leftName = this._escapeHtml(res.leftName || '對手');
        this.el.winnerBanner.innerHTML = `
          <div class="winner-crown">🏆</div>
          <div class="winner-title">對手離開・勝利！</div>
          <div class="winner-sub">對手（${leftName}）已離開對局，判定你直接獲勝並結算成績！</div>`;
      } else if (res.isDraw) {
        const names = res.winners.map(w => this._escapeHtml(w.name)).join(' 與 ');
        this.el.winnerBanner.innerHTML = `
          <div class="winner-crown">⚖️</div>
          <div class="winner-title">${names} 勢均力敵・平手！</div>
          <div class="winner-sub">雙方皆圍得 ${res.winners[0].score} 格領地（最大單塊 ${res.winners[0].largest} 格）${immSuffix}</div>`;
      } else {
        const w = res.winners[0];
        this.el.winnerBanner.innerHTML = `
          <div class="winner-crown">👑</div>
          <div class="winner-title">${this._escapeHtml(w.name)} 奪下勝利！</div>
          <div class="winner-sub">共圍得 ${w.score} 格專屬領地（最大單塊 ${w.largest} 格）${immSuffix}</div>`;
      }

      // Show RP Delta Banner in Ranked mode
      if (this.matchCategory === 'ranked' && recOutcome) {
        const d = recOutcome.rpDelta;
        const tier = Stats.getTierInfo(recOutcome.newRp);
        this.el.rpDeltaBanner.classList.remove('hidden', 'pos', 'neg');
        this.el.rpDeltaBanner.classList.add(d >= 0 ? 'pos' : 'neg');
        this.el.rpDeltaBanner.textContent = `🏆 積分結算：${d >= 0 ? '+' : ''}${d} RP → 目前 ${recOutcome.newRp} RP（${tier.name} · 全服第 #${Stats.getMyRank()} 名）`;
      } else {
        this.el.rpDeltaBanner.classList.add('hidden');
      }

      const rankIcons = ['🥇', '🥈', '🥉'];
      this.el.finalScores.innerHTML = res.rankings.map((r, idx) => {
        const isWin = res.winners.some(w => w.player === r.player);
        return `
          <div class="final-row ${isWin ? 'winner' : ''}">
            <div class="final-rank">
              <span>${rankIcons[idx] || (idx + 1)}</span>
              <span class="player-dot" style="background:${PLAYER_COLORS[r.player]}"></span>
              <span>${this._escapeHtml(r.name)}</span>
            </div>
            <div style="text-align:right">
              <div class="final-pts">${r.score} 分</div>
              <div class="final-detail">最大單塊領地：${r.largest} 格</div>
            </div>
          </div>`;
      }).join('');

      const onlineFriends = this.net.isOnline() && this.matchCategory === 'friends';
      this.el.btnOnlineRematch.classList.toggle('hidden', !(onlineFriends && this.net.isHost()));
      this.el.guestRematchWait.classList.toggle('hidden', !(onlineFriends && !this.net.isHost()));
      this.el.btnPlayAgain.textContent = this.matchCategory === 'ranked'
        ? '返回積分個人大廳'
        : (this.matchCategory === 'friends' ? (onlineFriends ? '離開房間' : '返回線上大廳') : '再來一局');

      this._openModal('modal-gameover');
      if (celebrate && !res.isDraw && res.winners.length > 0) {
        this._launchConfetti(res.winners[0].player);
      }
    }

    _hideSoulsOverlay() {
      clearTimeout(this.soulsTimer);
      this.soulsTimer = null;
      if (this.el && this.el.soulsOverlay) this.el.soulsOverlay.classList.add('hidden');
    }

    _triggerTurnCallout(force = false) {
      if (this.replay.active || this.engine.phase === 'gameover') return;
      const pIdx = this.engine.currentPlayer;
      const pObj = this.engine.players[pIdx];
      const key = `${this.engine.phase}-${this.engine.turnNumber}-${pIdx}-${this.engine.placementQueue.length}`;
      if (!force && key === this.lastAnnouncedTurn) return;
      this.lastAnnouncedTurn = key;

      const isMyTurn = this._isHumanTurn();
      if (!isMyTurn && this.engine.gameMode === 'ai') return;

      const el = this.el.turnCallout;
      el.className = `turn-callout p${pIdx}`;
      el.textContent = isMyTurn
        ? (this.engine.phase === 'placement' ? `▶ 輪到你佈子` : `▶ 輪到你行動！`)
        : `▶ 輪到 ${pObj.name}`;
      el.classList.remove('hidden');
      void el.offsetWidth;
      clearTimeout(this.calloutTimer);
      this.calloutTimer = setTimeout(() => el.classList.add('hidden'), 1450);
    }

    // 3-Wave 420-Particle Dazzling Confetti (Preserved!)
    _launchConfetti(winnerSeat) {
      this._stopConfetti();
      const canvas = this.el.confettiCanvas;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const W = window.innerWidth;
      const H = window.innerHeight;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas.classList.remove('hidden');

      const palettes = {
        0: ['#ef4444', '#fca5a5', '#f59e0b', '#fde047', '#ffffff'],
        1: ['#3b82f6', '#93c5fd', '#38bdf8', '#fde047', '#ffffff'],
        2: ['#f59e0b', '#fde047', '#fb923c', '#ffffff', '#f87171']
      };
      const colors = palettes[winnerSeat] || palettes[0];
      const shapes = ['rect', 'ribbon', 'circle', 'diamond'];
      this.confettiParticles = [];

      const spawnWave = (count, fromSides) => {
        for (let i = 0; i < count; i++) {
          const left = fromSides ? (i % 2 === 0) : false;
          const x = fromSides ? (left ? W * 0.08 : W * 0.92) : (Math.random() * W);
          const y = fromSides ? H * 0.72 : (-10 - Math.random() * 80);
          const angle = fromSides
            ? (left ? (-Math.PI * 0.38 + (Math.random() - 0.5) * 0.5) : (-Math.PI * 0.62 + (Math.random() - 0.5) * 0.5))
            : (Math.PI * 0.5 + (Math.random() - 0.5) * 0.4);
          const speed = fromSides ? (11 + Math.random() * 11) : (2.5 + Math.random() * 4);
          this.confettiParticles.push({
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            w: 7 + Math.random() * 8,
            h: 4 + Math.random() * 6,
            rot: Math.random() * Math.PI * 2,
            vrot: (Math.random() - 0.5) * 0.25,
            color: colors[i % colors.length],
            shape: shapes[i % shapes.length],
            life: 1,
            decay: 0.0045 + Math.random() * 0.0035
          });
        }
      };

      spawnWave(180, true);
      this.confettiWaveTimers.push(setTimeout(() => spawnWave(140, false), 550));
      this.confettiWaveTimers.push(setTimeout(() => spawnWave(120, true), 1250));

      const tick = () => {
        ctx.clearRect(0, 0, W, H);
        let alive = 0;
        for (const p of this.confettiParticles) {
          if (p.life <= 0) continue;
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.26;
          p.vx *= 0.99;
          p.rot += p.vrot;
          p.life -= p.decay;
          if (p.y > H + 40) p.life = 0;
          if (p.life <= 0) continue;
          alive++;

          ctx.save();
          ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          if (p.shape === 'circle') {
            ctx.beginPath();
            ctx.arc(0, 0, p.w * 0.42, 0, Math.PI * 2);
            ctx.fill();
          } else if (p.shape === 'diamond') {
            ctx.beginPath();
            ctx.moveTo(0, -p.w * 0.6); ctx.lineTo(p.w * 0.45, 0); ctx.lineTo(0, p.w * 0.6); ctx.lineTo(-p.w * 0.45, 0);
            ctx.closePath(); ctx.fill();
          } else {
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.shape === 'ribbon' ? p.h * 1.9 : p.h);
          }
          ctx.restore();
        }
        if (alive > 0) this.confettiRaf = requestAnimationFrame(tick);
        else this._stopConfetti();
      };
      this.confettiRaf = requestAnimationFrame(tick);
    }

    _stopConfetti() {
      if (this.confettiRaf) { cancelAnimationFrame(this.confettiRaf); this.confettiRaf = null; }
      for (const t of this.confettiWaveTimers) clearTimeout(t);
      this.confettiWaveTimers = [];
      this.confettiParticles = [];
      if (this.el && this.el.confettiCanvas) this.el.confettiCanvas.classList.add('hidden');
    }

    // ==================== HELPERS ====================
    _syncSetupModalFromConfig() {
      const syncSeg = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.value === String(val)));
      };
      syncSeg('opt-rule-variant', this.config.ruleVariant);
      syncSeg('opt-player-count', this.config.numPlayers);
      syncSeg('opt-ai-level', this.config.aiLevel);
      syncSeg('opt-opening', this.config.openingStyle);
      syncSeg('opt-timer', this.config.timerEnabled ? 'on' : 'off');
      this.el.groupOpening.classList.toggle('hidden', this.config.numPlayers === 3);
    }

    _openModal(id) {
      const m = document.getElementById(id);
      if (m) m.classList.remove('hidden');
    }

    _closeModal(id) {
      const m = document.getElementById(id);
      if (m) m.classList.add('hidden');
    }

    showToast(msg) {
      this.el.toast.textContent = msg;
      this.el.toast.classList.remove('hidden');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => this.el.toast.classList.add('hidden'), 2600);
    }

    _copyText(text, successMsg) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => this.showToast(successMsg)).catch(() => this.showToast(text));
      } else {
        this.showToast(successMsg);
      }
    }

    _escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    global.wallGoApp = new WallGoApp();
  });
})(window);
