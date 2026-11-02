/*
 * BiliDouLiveSwapHub（内容脚本）
 *
 * 设计要点：
 * 1. 不替换 B 站播放器，只在 #live-player 里叠加一个 z-index=2 的视频层，
 *    B 站弹幕层（z-index=10）与控件仍然在它上方；B 站原视频继续播放但静音并隐藏。
 * 2. 抖音流用 flv.js（优先）或 hls.js 播放，延迟 = 直播边缘 - 目标延迟。
 *    flv.js 默认保留约 3 分钟缓冲，因此 0~120 秒的回退延迟都在可 seek 范围内。
 * 3. 延迟建立方式：缓冲不足时暂停视频等待缓冲增长，够用后跳到目标位置继续播放，
 *    之后只做大幅度漂移校正，避免频繁 seek 造成卡顿。
 */
(() => {
  'use strict';

  if (window.__BDS_CONTENT__) return;
  window.__BDS_CONTENT__ = true;

  const STORAGE_KEY = 'bds.settings.v1';
  const MAX_DELAY = 120;
  const PLAYER_TIMEOUT = 15000;
  const MpegtsLib = (typeof mpegts !== 'undefined' ? mpegts : (window.mpegts || null));

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const fmt1 = (value) => (Number.isFinite(value) ? value.toFixed(1) : '--');

  const state = {
    roomId: '',
    settings: null,
    active: false,
    autoStarted: false,
    rid: '',
    inputValue: '',
    stream: null,
    quality: '',
    qualityAuto: true,
    hlsUnavailable: false,
    hlsFallbackTried: false,
    hlsPlayed: false,
    hevcUnavailable: false,
    hevcFallbackTried: false,
    h265FlvFailed: false,
    engineNotice: '',
    hevcPlayed: false,
    hevcStartedAt: 0,
    hevcLastProgressAt: 0,
    hevcLastTime: 0,
    hevcStallCount: 0,
    hevcPerfLastFrames: 0,
    hevcPerfLastAt: 0,
    hevcLowFpsCount: 0,
    infoOpen: false,
    playerStats: null,
    downloadSpeed: 0,
    downloadAt: 0,
    infoFrameTotal: 0,
    infoFrameAt: 0,
    infoFps: 0,
    delay: 0,
    pendingTarget: null,
    userPlaying: true,
    muted: false,
    autoplayMuted: false,
    volume: 1,
    followBiliVolume: true,
    collapsed: false,
    session: 0,
    retry: 0,
    retryTimer: null,
    refreshTimer: null,
    saveTimer: null,
    engine: null,
    engineKind: '',
    engineStartedAt: 0,
    lastProgressAt: 0,
    lastCurrentTime: 0,
    playerEl: null,
    layer: null,
    overlay: null,
    orig: null,
    origHandlers: null,
    origSaved: null,
    origSavedEl: null,
    suppressVolumeUntil: 0,
    lastPauseIntentAt: 0,
    lastAutoResumeAt: 0,
    lastPlayAttemptAt: 0,
    status: { kind: 'idle', text: '' },
    qualitySig: '',
    historySig: '',
    unlockArmed: false,
    fsFixing: false,
    rootBuilt: false
  };

  let ui = {};

  // ---------------------------------------------------------------- helpers

  function getBiliRoomId() {
    const match = location.pathname.match(/\/(?:blanc\/)?(\d{3,})(?:\/|$)/);
    return match ? match[1] : '';
  }

  function getUrlRid() {
    try {
      const search = new URLSearchParams(location.search);
      let value = search.get('douyin') || search.get('douyin_rid') || search.get('dy') || '';
      if (!value && location.hash) {
        const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
        value = hash.get('douyin') || hash.get('douyin_rid') || '';
      }
      return String(value || '').trim();
    } catch (error) {
      return '';
    }
  }

  function extractRid(text) {
    const value = String(text || '');
    const match = value.match(/live\.douyin\.com\/(?:share\/)?(\d{5,})/i) || value.match(/(\d{5,})/);
    return match ? match[1] : '';
  }

  function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, code: 'EXT', error: '扩展后台无响应：' + error.message });
          } else {
            resolve(response || { ok: false, code: 'EMPTY', error: '扩展后台无响应' });
          }
        });
      } catch (error) {
        resolve({ ok: false, code: 'EXT', error: String((error && error.message) || error) });
      }
    });
  }

  // 抖音 H.265 原画是 HLS(TS) 封装；mpegts.js 的 TSDemuxer 支持 HEVC，
  // 但 FLV demuxer 不支持。这里实现一个最小的 HLS 直播加载器，把 TS 分片连续喂给 mpegts.js。
  let HlsTsLoader = null;
  if (MpegtsLib && typeof MpegtsLib.BaseLoader === 'function') {
    HlsTsLoader = class HlsTsLoader extends MpegtsLib.BaseLoader {
      constructor(seekHandler, config) {
        super('hls-ts');
        this._seekHandler = seekHandler;
        this._config = config;
        this._url = '';
        this._timer = null;
        this._aborted = false;
        this._seen = new Set();
        this._receivedLength = 0;
        this._failures = 0;
        this._started = false;
        this._targetDuration = 4;
      }

      open(dataSource, range) {
        this._url = dataSource.url;
        this._aborted = false;
        this._timer = null;
        this._seen = new Set();
        this._receivedLength = 0;
        this._failures = 0;
        this._started = false;
        this._status = MpegtsLib.LoaderStatus.kConnecting;
        this._poll();
      }

      abort() {
        this._aborted = true;
        if (this._timer) {
          clearTimeout(this._timer);
          this._timer = null;
        }
        this._status = MpegtsLib.LoaderStatus.kIdle;
      }

      destroy() {
        this.abort();
        if (super.destroy) super.destroy();
      }

      _schedule(delay) {
        if (this._aborted) return;
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => {
          this._timer = null;
          this._poll();
        }, delay);
      }

      async _poll() {
        if (this._aborted) return;
        try {
          const response = await fetch(this._url, { cache: 'no-store' });
          if (this._aborted) return;
          if (!response.ok) throw new Error('播放列表 HTTP ' + response.status);
          const text = await response.text();
          if (this._aborted) return;

          const baseUrl = response.url || this._url;
          const playlist = this._parsePlaylist(text, baseUrl);

          if (playlist.isMaster && playlist.segments.length) {
            this._url = playlist.segments[0];
            return this._poll();
          }
          if (!playlist.segments.length) throw new Error('HLS 播放列表为空');

          this._targetDuration = playlist.targetDuration || this._targetDuration;

          let start = 0;
          if (!this._started) {
            this._started = true;
            // 预取 2 个分片（约 8 秒）再起播，降低每次 4 秒分片到达前后的抖动/卡顿。
            start = Math.max(0, playlist.segments.length - 2);
            for (let i = 0; i < start; i++) this._seen.add(playlist.segments[i]);
          }

          for (let i = start; i < playlist.segments.length; i++) {
            const segmentUrl = playlist.segments[i];
            if (this._seen.has(segmentUrl)) continue;
            await this._downloadSegment(segmentUrl);
            if (this._aborted) return;
            this._seen.add(segmentUrl);
          }

          this._failures = 0;
          this._status = MpegtsLib.LoaderStatus.kBuffering;
          this._schedule(Math.max(800, Math.min(2000, this._targetDuration * 250)));
        } catch (error) {
          if (this._aborted) return;
          this._failures += 1;
          if (this._failures <= 6) {
            this._schedule(1200);
            return;
          }
          this._status = MpegtsLib.LoaderStatus.kError;
          if (this._onError) {
            this._onError(MpegtsLib.LoaderErrors.EXCEPTION, {
              code: -1,
              msg: String((error && error.message) || error)
            });
          }
        }
      }

      _parsePlaylist(text, baseUrl) {
        const segments = [];
        let targetDuration = 0;
        let isMaster = false;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          if (line.startsWith('#EXT-X-STREAM-INF')) {
            isMaster = true;
            continue;
          }
          if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            targetDuration = parseFloat(line.split(':')[1]) || 0;
            continue;
          }
          if (line.startsWith('#')) continue;
          try {
            segments.push(new URL(line, baseUrl).href);
          } catch (error) {
            /* 忽略非法行 */
          }
        }
        return { segments, targetDuration, isMaster };
      }

      async _downloadSegment(url) {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error('TS 分片 HTTP ' + response.status);
        if (this._aborted) return;

        // 流式读取分片，边到边喂给 mpegts.js，避免整段 8MB 下载完才开始解码。
        if (response.body && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader();
          while (true) {
            const result = await reader.read();
            if (this._aborted) {
              try { reader.cancel(); } catch (error) { /* noop */ }
              return;
            }
            if (result.done) break;
            const value = result.value;
            if (!value || !value.byteLength) continue;
            const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            const byteStart = this._receivedLength;
            this._receivedLength += chunk.byteLength;
            this._status = MpegtsLib.LoaderStatus.kBuffering;
            if (this._onDataArrival) {
              this._onDataArrival(chunk, byteStart, this._receivedLength);
            }
          }
          return;
        }

        const buffer = await response.arrayBuffer();
        if (this._aborted) return;
        const byteStart = this._receivedLength;
        this._receivedLength += buffer.byteLength;
        this._status = MpegtsLib.LoaderStatus.kBuffering;
        if (this._onDataArrival) {
          this._onDataArrival(buffer, byteStart, this._receivedLength);
        }
      }
    };
  }

  // ---------------------------------------------------------------- storage

  function storageGetRoomSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (result) => {
          resolve(result && result[STORAGE_KEY]);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function normalizeSettings(raw) {
    const settings = raw && typeof raw === 'object' ? raw : {};
    settings.rooms = settings.rooms && typeof settings.rooms === 'object' ? settings.rooms : {};
    settings.lastRid = typeof settings.lastRid === 'string' ? settings.lastRid : '';
    settings.history = Array.isArray(settings.history)
      ? settings.history
          .filter((item) => item && typeof item.rid === 'string' && item.rid)
          .slice(0, 12)
      : [];
    settings.panelCollapsed = !!settings.panelCollapsed;
    settings.infoOpen = !!settings.infoOpen;
    return settings;
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: state.settings });
      } catch (error) {
        /* 忽略存储异常，页面功能不依赖持久化 */
      }
    }, 300);
  }

  function saveRoomConfig(patch) {
    if (!state.roomId) return;
    const rooms = state.settings.rooms || (state.settings.rooms = {});
    const previous = rooms[state.roomId] || {};
    rooms[state.roomId] = Object.assign(
      {
        rid: '',
        delay: 0,
        quality: '',
        qualityAuto: true,
        qualityPlan: 2,
        muted: false,
        volume: 1,
        followBiliVolume: true,
        enabled: false
      },
      previous,
      patch || {}
    );
    if (rooms[state.roomId].rid) state.settings.lastRid = rooms[state.roomId].rid;
    scheduleSave();
  }

  function loadRoomConfig() {
    const config = (state.settings.rooms && state.settings.rooms[state.roomId]) || {};
    state.rid = String(config.rid || state.settings.lastRid || '');
    state.inputValue = state.rid;
    state.delay = clamp(Number(config.delay) || 0, 0, MAX_DELAY);
    // 旧版本没有 qualityPlan/qualityAuto：
    // - 旧自动/旧最高档（FULL_HD1）迁移到“原画（源）”；
    // - 用户明确选过的较低清晰度（HD1/SD1/SD2）保留。
    const qualityPlan = Number(config.qualityPlan) || 0;
    const oldTop = !config.quality || config.quality === 'FULL_HD1';
    if (qualityPlan < 2 && (config.qualityAuto !== false || oldTop)) {
      state.quality = '';
      state.qualityAuto = true;
    } else {
      state.quality = String(config.quality || '');
      state.qualityAuto = config.qualityAuto !== false;
    }
    state.muted = !!config.muted;
    state.volume = typeof config.volume === 'number' ? clamp(config.volume, 0, 1) : 1;
    state.followBiliVolume = config.followBiliVolume !== false;
    return config;
  }

  // ---------------------------------------------------------------- panel UI

  function buildUi() {
    const root = document.createElement('div');
    root.id = 'bds-root';
    root.innerHTML = `
      <button class="bds-fab" type="button" data-act="expand" title="展开换源面板">
        <span class="bds-fab-logo">抖</span>
        <span class="bds-dot" data-role="fabDot"></span>
      </button>
      <div class="bds-panel">
        <div class="bds-head">
          <span class="bds-logo">抖</span>
          <div class="bds-head-main">
            <div class="bds-title">BiliDouLiveSwapHub</div>
            <div class="bds-sub">只替换画面 · 保留B站弹幕</div>
          </div>
          <span class="bds-dot" data-role="dot"></span>
          <button class="bds-iconbtn bds-info-btn" type="button" data-act="toggleInfo" title="媒体信息 / Media Info">i</button>
          <button class="bds-iconbtn" type="button" data-act="collapse" title="收起面板">—</button>
        </div>
        <div class="bds-body">
          <div class="bds-connect-row">
            <input class="bds-input" data-role="rid" type="text" spellcheck="false" autocomplete="off"
              placeholder="抖音房间号 / 直播间链接">
            <button class="bds-btn bds-primary" type="button" data-act="connect">连接</button>
          </div>
          <div class="bds-status" data-role="status" data-kind="idle">输入抖音直播间开始</div>
          <div class="bds-meta" data-role="meta"></div>
          <div class="bds-history-row is-hidden" data-role="historyRow">
            <label class="bds-label">最近</label>
            <select class="bds-select" data-role="history" title="最近连接过的抖音直播间"></select>
            <button class="bds-btn bds-small" type="button" data-act="clearHistory" title="清空最近连接">清空</button>
          </div>

          <div class="bds-group">
            <div class="bds-row">
              <label class="bds-label">清晰度</label>
              <select class="bds-select" data-role="quality" title="原画 H.265 画质最高；卡顿时可切原画 H.264"></select>
            </div>
            <div class="bds-row">
              <label class="bds-label">延迟</label>
              <input class="bds-range" data-role="delayRange" type="range" min="0" max="${MAX_DELAY}" step="0.1" value="0">
              <input class="bds-num" data-role="delayNum" type="number" min="0" max="${MAX_DELAY}" step="0.1" value="0">
              <span class="bds-unit">秒</span>
            </div>
            <div class="bds-seek-row">
              <button class="bds-chip" type="button" data-seek="-10" title="画面提前 10 秒">-10s</button>
              <button class="bds-chip" type="button" data-seek="-3" title="画面提前 3 秒">-3s</button>
              <button class="bds-chip" type="button" data-seek="-1" title="画面提前 1 秒">-1s</button>
              <button class="bds-chip" type="button" data-seek="-0.2" title="画面提前 0.2 秒">-.2s</button>
              <button class="bds-chip" type="button" data-seek="0.2" title="画面延后 0.2 秒">+.2s</button>
              <button class="bds-chip" type="button" data-seek="1" title="画面延后 1 秒">+1s</button>
              <button class="bds-chip" type="button" data-seek="3" title="画面延后 3 秒">+3s</button>
              <button class="bds-chip" type="button" data-seek="10" title="画面延后 10 秒">+10s</button>
            </div>
            <div class="bds-hint-row">
              <button class="bds-linkbtn" type="button" data-act="live">回到最新</button>
              <span class="bds-hint">＋ 画面更慢，用于和弹幕对齐</span>
            </div>
            <div class="bds-stat" data-role="latency">画面延迟：--</div>
            <div class="bds-codec-hint" data-role="codecHint">
              <span>H.265 卡顿请切换 H.264</span>
              <button class="bds-linkbtn" type="button" data-act="switchH264">一键切换</button>
            </div>
          </div>

          <div class="bds-group">
            <div class="bds-row">
              <label class="bds-label">音量</label>
              <input class="bds-range" data-role="volume" type="range" min="0" max="1" step="0.01" value="1">
              <button class="bds-btn bds-small" type="button" data-role="mute" data-act="mute">静音</button>
            </div>
            <label class="bds-check">
              <input type="checkbox" data-role="follow"> 跟随B站音量条
            </label>
          </div>

          <div class="bds-actions">
            <button class="bds-btn" type="button" data-role="reconnect" data-act="reconnect">重连</button>
            <button class="bds-btn" type="button" data-role="openDouyin" data-act="openDouyin">打开抖音页</button>
            <button class="bds-btn bds-danger" type="button" data-role="restore" data-act="restore">恢复B站画面</button>
          </div>
          <div class="bds-foot">仅替换视频画面，B站弹幕 / 聊天 / 礼物等功能不受影响</div>
        </div>
      </div>
      <div class="bds-info is-hidden" data-role="infoPanel">
        <div class="bds-info-head">
          <span>抖音源信息</span>
          <button class="bds-iconbtn" type="button" data-act="closeInfo" title="关闭">×</button>
        </div>
        <div class="bds-info-body">
          <div class="bds-info-row"><span>Mime Type</span><b data-role="infoMime">—</b></div>
          <div class="bds-info-row"><span>Player Core</span><b data-role="infoCore">—</b></div>
          <div class="bds-info-row"><span>Video Info</span><b data-role="infoVideo">—</b></div>
          <div class="bds-info-row"><span>Audio Info</span><b data-role="infoAudio">—</b></div>
          <div class="bds-info-row"><span>Encoder</span><b data-role="infoEncoder">—</b></div>
          <div class="bds-info-row"><span>Stream Host</span><b data-role="infoHost">—</b></div>
          <div class="bds-info-row"><span>Buffer Length</span><b data-role="infoBuffer">—</b></div>
          <div class="bds-info-row"><span>Decoded Frames</span><b data-role="infoFrames">—</b></div>
          <div class="bds-info-row"><span>Download Bitrate</span><b data-role="infoBitrate">—</b></div>
          <div class="bds-info-row"><span>Source Bitrate</span><b data-role="infoSource">—</b></div>
        </div>
      </div>
      <div class="bds-badge" data-role="badge"></div>
    `;

    ui = {
      root,
      panel: root.querySelector('.bds-panel'),
      fab: root.querySelector('.bds-fab'),
      badge: root.querySelector('[data-role="badge"]'),
      status: root.querySelector('[data-role="status"]'),
      meta: root.querySelector('[data-role="meta"]'),
      historyRow: root.querySelector('[data-role="historyRow"]'),
      history: root.querySelector('[data-role="history"]'),
      codecHint: root.querySelector('[data-role="codecHint"]'),
      infoBtn: root.querySelector('[data-act="toggleInfo"]'),
      infoPanel: root.querySelector('[data-role="infoPanel"]'),
      infoMime: root.querySelector('[data-role="infoMime"]'),
      infoCore: root.querySelector('[data-role="infoCore"]'),
      infoVideo: root.querySelector('[data-role="infoVideo"]'),
      infoAudio: root.querySelector('[data-role="infoAudio"]'),
      infoEncoder: root.querySelector('[data-role="infoEncoder"]'),
      infoHost: root.querySelector('[data-role="infoHost"]'),
      infoBuffer: root.querySelector('[data-role="infoBuffer"]'),
      infoFrames: root.querySelector('[data-role="infoFrames"]'),
      infoBitrate: root.querySelector('[data-role="infoBitrate"]'),
      infoSource: root.querySelector('[data-role="infoSource"]'),
      rid: root.querySelector('[data-role="rid"]'),
      quality: root.querySelector('[data-role="quality"]'),
      delayRange: root.querySelector('[data-role="delayRange"]'),
      delayNum: root.querySelector('[data-role="delayNum"]'),
      latency: root.querySelector('[data-role="latency"]'),
      volume: root.querySelector('[data-role="volume"]'),
      follow: root.querySelector('[data-role="follow"]'),
      mute: root.querySelector('[data-role="mute"]'),
      reconnect: root.querySelector('[data-role="reconnect"]'),
      openDouyin: root.querySelector('[data-role="openDouyin"]'),
      restore: root.querySelector('[data-role="restore"]'),
      dot: root.querySelector('[data-role="dot"]'),
      fabDot: root.querySelector('[data-role="fabDot"]')
    };

    wirePanel();
    state.rootBuilt = true;
    applyCollapsed();

    if (state.active) root.classList.add('is-active');
  }

  function wirePanel() {
    const stop = (event) => event.stopPropagation();
    ['click', 'dblclick', 'mousedown', 'pointerdown', 'touchstart', 'wheel', 'keydown', 'keyup', 'keypress', 'contextmenu'].forEach((type) => {
      ui.panel.addEventListener(type, stop);
      ui.fab.addEventListener(type, stop);
      ui.infoPanel.addEventListener(type, stop);
    });

    ui.panel.addEventListener('click', onPanelClick);
    ui.infoPanel.addEventListener('click', onPanelClick);
    ui.fab.addEventListener('click', () => setCollapsed(false));

    ui.rid.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        connectFromInput(true);
      }
    });

    ui.delayRange.addEventListener('input', () => {
      ui.delayNum.value = Number(ui.delayRange.value).toFixed(1);
    });
    ui.delayRange.addEventListener('change', () => {
      setDelay(parseFloat(ui.delayRange.value), true);
      ui.delayNum.value = state.delay.toFixed(1);
    });
    ui.delayNum.addEventListener('change', () => {
      setDelay(parseFloat(ui.delayNum.value), true);
      ui.delayNum.value = state.delay.toFixed(1);
    });
    ui.delayNum.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        ui.delayNum.blur();
      }
    });

    ui.volume.addEventListener('input', () => {
      setVolume(parseFloat(ui.volume.value), false);
    });
    ui.volume.addEventListener('change', () => {
      setVolume(parseFloat(ui.volume.value), true);
      ui.volume.value = String(state.volume);
    });

    ui.follow.addEventListener('change', () => {
      state.followBiliVolume = ui.follow.checked;
      if (state.followBiliVolume && state.orig) {
        state.volume = clamp(state.orig.volume, 0, 1);
        applyAudio();
        syncOrigVolumeQuiet();
      }
      saveRoomConfig({ followBiliVolume: state.followBiliVolume });
      updateUi();
    });

    ui.quality.addEventListener('change', () => {
      switchQuality(ui.quality.value);
    });

    ui.history.addEventListener('change', () => {
      const rid = ui.history.value;
      if (!rid) return;
      state.inputValue = rid;
      ui.rid.value = rid;
      connectFromInput(true);
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'BDS_TOGGLE_PANEL') {
        setCollapsed(!state.collapsed);
      }
    });
  }

  function onPanelClick(event) {
    const seekNode = event.target.closest('[data-seek]');
    if (seekNode) {
      event.preventDefault();
      nudge(parseFloat(seekNode.getAttribute('data-seek')));
      return;
    }

    const actionNode = event.target.closest('[data-act]');
    if (!actionNode) return;
    const action = actionNode.getAttribute('data-act');
    event.preventDefault();

    switch (action) {
      case 'connect':
        connectFromInput(true);
        break;
      case 'reconnect':
        if (state.rid || state.inputValue) start(state.rid || state.inputValue, true);
        else connectFromInput(true);
        break;
      case 'restore':
        if (state.active) disable({ restore: true });
        else connectFromInput(true);
        break;
      case 'openDouyin':
        openDouyinPage();
        break;
      case 'collapse':
        setCollapsed(true);
        break;
      case 'expand':
        setCollapsed(false);
        break;
      case 'mute':
        setMuted(!state.muted);
        break;
      case 'live':
        setDelay(0, true);
        break;
      case 'switchH264':
        switchQuality('ORIGIN_H264');
        break;
      case 'clearHistory':
        state.settings.history = [];
        state.historySig = '';
        scheduleSave();
        updateHistoryOptions();
        break;
      case 'toggleInfo':
        setInfoOpen(!state.infoOpen, true);
        break;
      case 'closeInfo':
        setInfoOpen(false, true);
        break;
      default:
        break;
    }
  }

  function setCollapsed(collapsed) {
    state.collapsed = !!collapsed;
    applyCollapsed();
    if (state.settings) {
      state.settings.panelCollapsed = state.collapsed;
      scheduleSave();
    }
  }

  function applyCollapsed() {
    if (!ui.root) return;
    ui.root.classList.toggle('is-collapsed', state.collapsed);
  }

  function setStatus(kind, text) {
    state.status = { kind: kind, text: text };
    if (ui.status) {
      ui.status.textContent = text;
      ui.status.dataset.kind = kind;
      ui.status.title = text;
    }
    if (ui.dot) ui.dot.dataset.kind = kind;
    if (ui.fabDot) ui.fabDot.dataset.kind = kind;
    if (ui.root) ui.root.dataset.bdsStatus = kind;
    updateDebug();
  }

  function setLatencyText(text) {
    if (!ui.latency) return;
    if (ui.latency.textContent !== text) ui.latency.textContent = text;
  }

  function showBadge(text) {
    if (!ui.badge) return;
    if (ui.badge.textContent !== text) ui.badge.textContent = text;
    ui.badge.classList.add('is-visible');
  }

  function hideBadge() {
    if (ui.badge) ui.badge.classList.remove('is-visible');
  }

  function updateUi() {
    if (!state.rootBuilt) return;

    if (document.activeElement !== ui.rid) {
      ui.rid.value = state.inputValue || state.rid || '';
    }

    const stream = state.stream;
    if (stream) {
      const bits = [];
      if (stream.title) bits.push(stream.title);
      if (stream.anchor) bits.push('@' + stream.anchor);
      bits.push('抖音 ' + (stream.rid || state.rid || ''));
      ui.meta.textContent = bits.join(' · ');
      ui.meta.title = ui.meta.textContent;
    } else {
      ui.meta.textContent = state.rid ? '待连接：' + state.rid : '尚未设置抖音直播间';
      ui.meta.title = ui.meta.textContent;
    }

    updateQualityOptions();
    updateDelayControls();
    updateHistoryOptions();
    updateCodecHint();
    updateInfoPanel();

    if (document.activeElement !== ui.volume) ui.volume.value = String(state.volume);
    ui.mute.textContent = state.muted ? '取消静音' : '静音';
    ui.restore.textContent = state.active ? '恢复B站画面' : '启用换源';
    ui.reconnect.disabled = !(state.rid || state.inputValue);
    ui.openDouyin.disabled = !(state.rid || state.inputValue);
    ui.follow.checked = state.followBiliVolume;
    ui.root.classList.toggle('is-active', state.active);
    updateDebug();
  }

  function updateQualityOptions() {
    if (!ui.quality) return;
    const streams = (state.stream && state.stream.streams) || [];
    const signature = streams
      .map((item) => item.key + ':' + (item.flv ? 'f' : '') + (item.hls ? 'h' : '') + ':' + (item.label || ''))
      .join('|') + '#' + state.quality + '#' + state.active;

    if (signature === state.qualitySig) return;
    state.qualitySig = signature;

    ui.quality.innerHTML = '';
    if (!streams.length) {
      const option = document.createElement('option');
      option.textContent = '暂无可用清晰度';
      option.disabled = true;
      ui.quality.appendChild(option);
      ui.quality.disabled = true;
      return;
    }

    if (!streams.some((item) => item.key === state.quality)) {
      state.quality = streams[0].key;
    }

    streams.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.key;
      option.textContent = item.label;
      if (item.key === state.quality) option.selected = true;
      ui.quality.appendChild(option);
    });
    ui.quality.disabled = false;
  }

  function rememberRoom(room) {
    if (!room || !room.rid) return;
    const history = Array.isArray(state.settings.history)
      ? state.settings.history
      : (state.settings.history = []);
    const rid = String(room.rid);
    const entry = {
      rid: rid,
      title: String(room.title || ''),
      anchor: String(room.anchor || ''),
      lastUsedAt: Date.now()
    };
    const index = history.findIndex((item) => item && item.rid === rid);
    if (index !== -1) history.splice(index, 1);
    history.unshift(entry);
    state.settings.history = history.slice(0, 12);
    scheduleSave();
    updateHistoryOptions();
  }

  function updateHistoryOptions() {
    if (!ui.history || !state.settings) return;
    const history = Array.isArray(state.settings.history) ? state.settings.history : [];
    const signature = history
      .map((item) => item.rid + ':' + (item.title || '') + ':' + (item.anchor || ''))
      .join('|') + '#' + state.rid;
    if (signature === state.historySig) return;
    state.historySig = signature;

    ui.history.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = history.length ? '选择最近连接…' : '暂无最近连接';
    ui.history.appendChild(placeholder);

    let matched = false;
    history.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.rid;
      const name = String(item.title || item.anchor || '抖音直播').slice(0, 18);
      option.textContent = name + ' · ' + item.rid;
      if (item.rid === state.rid) {
        option.selected = true;
        matched = true;
      }
      ui.history.appendChild(option);
    });
    ui.history.value = matched ? state.rid : '';
    ui.historyRow.classList.toggle('is-hidden', history.length === 0);
  }

  function updateCodecHint() {
    if (!ui.codecHint) return;
    ui.codecHint.classList.toggle('is-visible', state.quality === 'ORIGIN');
  }

  function setInfoOpen(open, persist) {
    state.infoOpen = !!open;
    if (ui.infoPanel) ui.infoPanel.classList.toggle('is-hidden', !state.infoOpen);
    if (ui.infoBtn) ui.infoBtn.classList.toggle('is-active', state.infoOpen);
    if (persist && state.settings) {
      state.settings.infoOpen = state.infoOpen;
      scheduleSave();
    }
    if (state.infoOpen) updateInfoPanel();
  }

  function setInfoValue(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function updateInfoPanel() {
    if (!state.infoOpen || !ui.infoPanel) return;
    const info = state.mediaInfo || null;
    const video = state.overlay;
    const stream = selectStream(state.quality);
    const metadata = info && info.metadata && typeof info.metadata === 'object' ? info.metadata : null;

    const core = state.engineKind === 'mpegts-flv'
      ? 'mpegts.js (H.265 FLV)'
      : state.engineKind === 'mpegts'
        ? 'mpegts.js (H.265 HLS)'
        : state.engineKind === 'flv'
          ? 'flv.js (H.264)'
          : state.engineKind === 'hls'
            ? 'hls.js'
            : '—';

    let mime = info && info.mimeType ? String(info.mimeType) : '';
    if (!mime && info) {
      const codecs = [info.videoCodec, info.audioCodec].filter(Boolean).join(', ');
      if (codecs) mime = 'video/mp4; codecs="' + codecs + '"';
    }

    const width = (info && (info.width || info.videoWidth)) || (video && video.videoWidth) || 0;
    const height = (info && (info.height || info.videoHeight)) || (video && video.videoHeight) || 0;
    const fps = (info && info.fps) || (stream && stream.fps) || 0;
    const videoInfo = width && height ? width + '×' + height + (fps ? ', ' + fps + 'FPS' : '') : '—';

    const audioParts = [];
    if (info && info.audioSampleRate) audioParts.push((Math.round(info.audioSampleRate / 100) / 10) + 'KHz');
    if (info && info.audioChannelCount) audioParts.push(info.audioChannelCount === 1 ? 'Mono' : 'Stereo');
    if (info && info.audioDataRate) audioParts.push(Math.round(info.audioDataRate) + 'Kbps');
    else if (metadata && metadata.audiodatarate) audioParts.push(Math.round(metadata.audiodatarate) + 'Kbps');

    const encoder = metadata && (metadata.encoder || metadata.encoderVersion)
      ? String(metadata.encoder || metadata.encoderVersion)
      : '—';

    let host = '—';
    if (stream) {
      let url = '';
      if (state.engineKind === 'mpegts-flv' && stream.flv265) url = stream.flv265;
      else if (state.engineKind === 'mpegts' && stream.hls265) url = stream.hls265;
      else url = stream.flv || stream.hls265 || stream.hls || '';
      try {
        host = new URL(url).host || '—';
      } catch (error) {
        /* noop */
      }
    }

    const buffer = video ? bufferedInfo(video) : null;
    const bufferText = buffer
      ? Math.max(0, buffer.end - video.currentTime).toFixed(2) + 's, ' + Math.max(0, buffer.end - buffer.start).toFixed(2) + 's'
      : '—';

    let frames = '—';
    let measuredFps = state.infoFps;
    if (video) {
      try {
        const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        if (quality) {
          const now = Date.now();
          if (!state.infoFrameAt) {
            state.infoFrameTotal = quality.totalVideoFrames;
            state.infoFrameAt = now;
          } else if (now - state.infoFrameAt >= 1000) {
            const elapsed = (now - state.infoFrameAt) / 1000;
            const delta = quality.totalVideoFrames - state.infoFrameTotal;
            if (elapsed > 0 && delta >= 0) state.infoFps = Math.round(delta / elapsed);
            state.infoFrameTotal = quality.totalVideoFrames;
            state.infoFrameAt = now;
            measuredFps = state.infoFps;
          }
          const shownFps = measuredFps || (info && info.fps) || 0;
          frames = quality.droppedVideoFrames + '/' + quality.totalVideoFrames + (shownFps ? ', ' + shownFps + 'FPS' : '');
        }
      } catch (error) {
        /* noop */
      }
    }

    const stats = state.playerStats;
    if (stats && Number(stats.speed) > 0) {
      state.downloadSpeed = Number(stats.speed);
      state.downloadAt = Date.now();
    }
    // HLS 每 4 秒才拉一次分段，speed 会在 0 和瞬时峰值之间跳动；短暂保留上次结果避免闪烁。
    let download = '—';
    if (state.downloadSpeed > 0 && Date.now() - state.downloadAt < 8000) {
      download = ((state.downloadSpeed * 8) / 1000).toFixed(2) + 'Mbps';
    }

    let source = '—';
    if (stream && Number(stream.bitrate) > 0) {
      source = (Number(stream.bitrate) / 1000000).toFixed(1) + 'Mbps (标称)';
    }

    setInfoValue(ui.infoMime, mime || '—');
    setInfoValue(ui.infoCore, core);
    setInfoValue(ui.infoVideo, videoInfo);
    setInfoValue(ui.infoAudio, audioParts.length ? audioParts.join(', ') : '—');
    setInfoValue(ui.infoEncoder, encoder);
    setInfoValue(ui.infoHost, host);
    setInfoValue(ui.infoBuffer, bufferText);
    setInfoValue(ui.infoFrames, frames);
    setInfoValue(ui.infoBitrate, download);
    setInfoValue(ui.infoSource, source);
  }

  function updateDelayControls() {
    const text = state.delay.toFixed(1);
    if (ui.delayRange && document.activeElement !== ui.delayRange) ui.delayRange.value = text;
    if (ui.delayNum && document.activeElement !== ui.delayNum) ui.delayNum.value = text;
  }

  function updateDebug() {
    if (!ui.root) return;
    const root = ui.root;
    root.dataset.bdsActive = state.active ? '1' : '0';
    root.dataset.bdsStatus = state.status.kind;
    root.dataset.bdsRid = state.rid || '';
    root.dataset.bdsBiliRoom = state.roomId || '';
    root.dataset.bdsDelay = state.delay.toFixed(1);
    root.dataset.bdsQuality = state.quality || '';
    root.dataset.bdsQualityAuto = state.qualityAuto ? '1' : '0';
    root.dataset.bdsEngine = state.engineKind || '';
    root.dataset.bdsCodec = (state.mediaInfo && state.mediaInfo.videoCodec) ? String(state.mediaInfo.videoCodec) : '';
    root.dataset.bdsPending = state.pendingTarget != null ? '1' : '0';
    root.dataset.bdsLatency = '';

    if (state.overlay) {
      const info = bufferedInfo(state.overlay);
      if (info) {
        root.dataset.bdsLatency = (info.end - state.overlay.currentTime).toFixed(1);
        root.dataset.bdsBuffered = Math.max(0, info.end - info.start).toFixed(1);
      }
    }
  }

  // ---------------------------------------------------------------- overlay DOM

  function findPlayerEl() {
    return document.querySelector('#live-player') || document.querySelector('.live-player-mounter');
  }

  function waitForPlayer(timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const player = findPlayerEl();
        if (player) return resolve(player);
        if (Date.now() - startedAt >= timeoutMs) return resolve(null);
        setTimeout(check, 250);
      };
      check();
    });
  }

  function findOrigVideo() {
    const player = state.playerEl;
    if (!player) return null;

    const direct = Array.from(player.children).find(
      (node) => node.tagName === 'VIDEO' && !node.classList.contains('bds-video')
    );
    if (direct) return direct;

    let best = null;
    let bestArea = 0;
    player.querySelectorAll('video').forEach((video) => {
      if (video.classList.contains('bds-video')) return;
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    });
    return best;
  }

  function ensureLayer() {
    if (!state.layer) {
      const layer = createEl('div', 'bds-layer');
      const video = document.createElement('video');
      video.className = 'bds-video';
      video.playsInline = true;
      video.autoplay = false;
      video.preload = 'auto';
      video.setAttribute('playsinline', '');
      layer.appendChild(video);

      state.layer = layer;
      state.overlay = video;
      attachOverlayEvents(video);
    }

    if (state.playerEl && state.layer.parentElement !== state.playerEl) {
      state.playerEl.appendChild(state.layer);
    }
    if (state.overlay && state.overlay.parentElement !== state.layer) {
      state.layer.appendChild(state.overlay);
    }
    state.layer.style.display = state.active && (state.engine || state.stream) ? 'block' : 'none';
  }

  function attachOverlayEvents(video) {
    video.addEventListener('playing', () => {
      if (!state.active) return;
      if (state.engineKind === 'hls') state.hlsPlayed = true;
      if (state.engineKind === 'mpegts' || state.engineKind === 'mpegts-flv') state.hevcPlayed = true;
      state.lastProgressAt = Date.now();
      if (state.status.kind !== 'ok') setStatus('ok', '已连接');
    });
    video.addEventListener('canplay', () => {
      if (!state.active) return;
      if (state.engineKind === 'hls') state.hlsPlayed = true;
      if (state.engineKind === 'mpegts' || state.engineKind === 'mpegts-flv') state.hevcPlayed = true;
      state.lastProgressAt = Date.now();
      maintainSync(true);
    });
    video.addEventListener('error', () => {
      if (!state.active) return;
      scheduleReconnect('抖音视频播放出错');
    });
  }

  function ensureAll() {
    if (!state.rootBuilt) return;

    const player = findPlayerEl();
    if (!player) return;

    if (state.playerEl !== player) {
      state.playerEl = player;
    }

    if (ui.root.parentElement !== player) {
      player.appendChild(ui.root);
    }

    ensureLayer();

    if (state.active && state.stream) {
      bindOriginal();
    }

    const roomId = getBiliRoomId();
    if (roomId && roomId !== state.roomId) {
      handleRoomChange(roomId);
    }
  }

  // ---------------------------------------------------------------- B站原视频

  function bindOriginal() {
    if (!state.active) return;
    const video = findOrigVideo();
    if (!video) return;

    if (state.orig === video) {
      if (!state.origSaved) {
        state.origSaved = {
          opacity: video.style.opacity,
          muted: video.muted,
          volume: video.volume,
          paused: video.paused
        };
        state.origSavedEl = video;
      }
      silenceOriginal();
      return;
    }

    const wasPlaying = !video.paused;
    unbindOriginal();
    state.orig = video;
    state.origSaved = {
      opacity: video.style.opacity,
      muted: video.muted,
      volume: video.volume,
      paused: video.paused
    };
    state.origSavedEl = video;
    state.userPlaying = wasPlaying;

    state.origHandlers = {
      play: () => {
        if (!state.active) return;
        state.userPlaying = true;
        maintainSync(true);
      },
      pause: () => {
        if (!state.active) return;
        if (video.ended || video.error) return;

        // B站/Douyin/浏览器在空闲、后台、切清晰度等情况下也可能自动暂停原视频。
        // 只有在最近确实点过播放/暂停按钮或按过快捷键时，才把暂停同步给抖音画面。
        const userIntent = Date.now() - state.lastPauseIntentAt <= 2000;
        if (!userIntent) {
          state.userPlaying = true;
          if (!document.hidden && Date.now() - state.lastAutoResumeAt > 5000) {
            state.lastAutoResumeAt = Date.now();
            console.info('[BDS] ignored automatic pause of Bilibili video');
            setTimeout(() => {
              if (!state.active || state.orig !== video || !state.userPlaying) return;
              if (video.paused && !video.ended && !video.error) {
                const promise = video.play();
                if (promise && promise.catch) promise.catch(() => {});
              }
            }, 500);
          }
          return;
        }

        state.userPlaying = false;
        hideBadge();
        if (state.overlay && !state.overlay.paused) {
          try {
            state.overlay.pause();
          } catch (error) {
            /* noop */
          }
        }
        setLatencyText('B站播放器已暂停');
      },
      volumechange: () => {
        if (!state.active) return;
        if (performance.now() < state.suppressVolumeUntil) return;
        if (!state.followBiliVolume) {
          // 不跟随音量时也不能让原视频出声，只重新静音，不覆盖 B 站音量条位置。
          if (!video.muted) {
            state.suppressVolumeUntil = performance.now() + 120;
            try {
              video.muted = true;
            } catch (error) {
              /* noop */
            }
          }
          return;
        }
        state.volume = clamp(video.volume, 0, 1);
        if (!video.muted && state.volume > 0) state.muted = false;
        applyAudio();
        syncOrigVolumeQuiet();
        saveRoomConfig({ volume: state.volume, muted: state.muted });
        updateUi();
      }
    };

    video.addEventListener('play', state.origHandlers.play);
    video.addEventListener('pause', state.origHandlers.pause);
    video.addEventListener('volumechange', state.origHandlers.volumechange);

    silenceOriginal();
  }

  function unbindOriginal() {
    const video = state.orig;
    const handlers = state.origHandlers;
    if (video && handlers) {
      video.removeEventListener('play', handlers.play);
      video.removeEventListener('pause', handlers.pause);
      video.removeEventListener('volumechange', handlers.volumechange);
    }
    state.orig = null;
    state.origHandlers = null;
  }

  function silenceOriginal() {
    const video = state.orig;
    if (!video) return;
    // 用 opacity 而不是 visibility：原视频仍可被点击命中，B站“点击暂停/双击全屏”不受影响。
    if (video.style.opacity !== '0') video.style.opacity = '0';
    const volumeMismatch = state.followBiliVolume && Math.abs(video.volume - state.volume) > 0.001;
    if (!video.muted || volumeMismatch) {
      syncOrigVolumeQuiet();
    }
  }

  function restoreOriginal() {
    const video = state.origSavedEl || state.orig;
    const saved = state.origSaved;
    if (!video || !saved) {
      state.origSaved = null;
      state.origSavedEl = null;
      return;
    }

    state.suppressVolumeUntil = performance.now() + 120;
    try {
      video.style.opacity = saved.opacity || '';
      video.volume = saved.volume;
      video.muted = saved.muted;
      if (saved.paused && !video.paused) video.pause();
    } catch (error) {
      /* noop */
    }

    state.origSaved = null;
    state.origSavedEl = null;
  }

  function syncOrigVolumeQuiet() {
    const video = state.orig;
    if (!video) return;
    state.suppressVolumeUntil = performance.now() + 120;
    try {
      if (state.followBiliVolume) video.volume = state.volume;
      video.muted = true;
    } catch (error) {
      /* noop */
    }
  }

  function applyAudio() {
    const video = state.overlay;
    if (!video) return;
    video.volume = clamp(state.volume, 0, 1);
    video.muted = state.muted || state.autoplayMuted || state.volume <= 0.001;
  }

  // ---------------------------------------------------------------- 连接/换源

  async function start(input, force) {
    const text = String(input || '').trim();
    if (!text) {
      setStatus('error', '请输入抖音直播间链接或房间号');
      updateUi();
      return;
    }

    const token = ++state.session;
    state.inputValue = text;
    state.rid = extractRid(text) || text;
    state.active = true;
    state.pendingTarget = null;
    state.autoplayMuted = false;
    state.stream = null;
    state.qualitySig = '';
    state.h265FlvFailed = false;
    state.engineNotice = '';
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retry = 0;
    destroyEngine();
    hideBadge();
    setStatus('loading', '正在获取抖音直播流…');
    updateUi();
    saveRoomConfig({ rid: text, quality: state.quality, qualityAuto: state.qualityAuto, qualityPlan: 2 });

    const player = await waitForPlayer(PLAYER_TIMEOUT);
    if (token !== state.session) return;
    if (!player) {
      state.active = false;
      setStatus('error', '未找到B站直播播放器，请刷新页面后重试');
      updateUi();
      saveRoomConfig({ enabled: false });
      return;
    }

    state.playerEl = player;
    ensureAll();

    const response = await sendMessage({ type: 'BDS_RESOLVE', rid: text, force: !!force });
    if (token !== state.session) return;

    if (!response || !response.ok) {
      state.active = false;
      state.layer && (state.layer.style.display = 'none');
      restoreOriginal();
      setStatus('error', (response && response.error) || '解析抖音直播间失败');
      updateUi();
      saveRoomConfig({ enabled: false });
      return;
    }

    if (!response.live) {
      state.active = false;
      state.layer && (state.layer.style.display = 'none');
      restoreOriginal();
      setStatus('warn', response.message || '抖音直播间当前未开播');
      updateUi();
      saveRoomConfig({ enabled: false });
      return;
    }

    state.stream = response;
    state.rid = response.rid || extractRid(text) || text;
    state.expiresAt = response.expiresAt || 0;
    state.quality = pickQuality(response, state.quality);
    state.retry = 0;
    rememberRoom(response);
    saveRoomConfig({ rid: state.rid, quality: state.quality, qualityAuto: state.qualityAuto, qualityPlan: 2, enabled: true });

    bindOriginal();
    silenceOriginal();
    updateUi();
    scheduleUrlRefresh();
    createEngine(token);
  }

  function pickQuality(response, preferred) {
    const streams = (response && response.streams) || [];
    if (!streams.length) return '';
    const keys = streams.map((item) => item.key);

    // 原画 HLS 在当前网络/浏览器不可用时，自动退到最佳 FLV（蓝光）。
    if (state.hlsUnavailable) {
      const withFlv = streams.find((item) => item.flv);
      if (withFlv) return withFlv.key;
    }

    // 用户手动选过清晰度才沿用；否则跟随抖音页面里的最高画质。
    if (!state.qualityAuto && preferred && keys.indexOf(preferred) !== -1) return preferred;
    if (response.bestQuality && keys.indexOf(response.bestQuality) !== -1) {
      return response.bestQuality;
    }
    const withFlv = streams.find((item) => item.flv);
    return (withFlv || streams[0]).key;
  }

  function selectStream(key) {
    const streams = (state.stream && state.stream.streams) || [];
    if (!streams.length) return null;
    return streams.find((item) => item.key === key) || streams.find((item) => item.flv) || streams[0];
  }

  function resetOverlayVideo(video) {
    if (!video) return;
    try {
      video.pause();
    } catch (error) {
      /* noop */
    }
    try {
      video.removeAttribute('src');
      video.load();
    } catch (error) {
      /* noop */
    }
    applyAudio();
  }

  function destroyEngine() {
    const engine = state.engine;
    state.engine = null;
    state.engineKind = '';
    state.mediaInfo = null;
    state.playerStats = null;
    state.downloadSpeed = 0;
    state.downloadAt = 0;
    state.infoFrameTotal = 0;
    state.infoFrameAt = 0;
    state.infoFps = 0;

    if (engine) {
      if (typeof engine.stopLoad === 'function' && typeof engine.detachMedia === 'function') {
        try { engine.stopLoad(); } catch (error) { /* noop */ }
        try { engine.detachMedia(); } catch (error) { /* noop */ }
        try { engine.destroy(); } catch (error) { /* noop */ }
      } else {
        try { engine.pause(); } catch (error) { /* noop */ }
        try { engine.unload(); } catch (error) { /* noop */ }
        try { engine.detachMediaElement(); } catch (error) { /* noop */ }
        try { engine.destroy(); } catch (error) { /* noop */ }
      }
    }

    if (state.overlay) resetOverlayVideo(state.overlay);
    state.pendingTarget = null;
    hideBadge();
  }

  function createEngine(token) {
    destroyEngine();
    ensureLayer();

    const stream = selectStream(state.quality);
    if (!stream) {
      setStatus('error', '没有可用的抖音直播流地址');
      updateUi();
      return;
    }

    state.quality = stream.key;
    state.engineStartedAt = Date.now();
    state.lastProgressAt = Date.now();
    state.lastCurrentTime = 0;
    state.pendingTarget = null;
    state.layer && (state.layer.style.display = 'block');
    applyAudio();
    updateUi();

    if (canPlayHevc()) {
      // 优先 H.265 原画 FLV：连续流、低延迟，避开 HLS 4 秒分片的起播/抖动。
      if (stream.flv265 && !state.h265FlvFailed) {
        try {
          createMpegtsFlvEngine(stream.flv265);
          setStatus('loading', '正在连接原画 H.265 FLV…');
          return;
        } catch (error) {
          console.warn('[BDS] H.265 FLV 初始化失败', error);
          state.h265FlvFailed = true;
        }
      }

      if (stream.hls265 && !state.hevcUnavailable) {
        try {
          createMpegtsHlsEngine(stream.hls265);
          setStatus('loading', '正在连接原画 H.265 HLS…');
          return;
        } catch (error) {
          console.warn('[BDS] H.265 HLS 初始化失败', error);
        }
      }
    }

    if (stream.flv) {
      try {
        createFlvEngine(stream.flv);
        setStatus('loading', '正在连接抖音直播流…');
        return;
      } catch (error) {
        console.warn('[BDS] flv 初始化失败', error);
        if (!stream.hls) {
          setStatus('error', 'FLV 播放器初始化失败：' + String((error && error.message) || error));
          updateUi();
          return;
        }
      }
    }

    if (stream.hls) {
      try {
        createHlsEngine(stream.hls);
        setStatus('loading', '正在连接抖音 HLS 流…');
        return;
      } catch (error) {
        console.warn('[BDS] hls 初始化失败', error);
        setStatus('error', 'HLS 播放器初始化失败：' + String((error && error.message) || error));
        updateUi();
      }
    }
  }

  function createFlvEngine(url) {
    if (!window.flvjs || !flvjs.isSupported()) {
      throw new Error('当前浏览器不支持 MSE/H.264');
    }

    try {
      flvjs.LoggingControl.enableAll = false;
    } catch (error) {
      /* noop */
    }

    const player = flvjs.createPlayer(
      {
        type: 'flv',
        url: url,
        isLive: true,
        hasAudio: true,
        hasVideo: true,
        cors: true,
        withCredentials: false
      },
      {
        enableWorker: false,
        enableStashBuffer: false,
        stashInitialSize: 128,
        lazyLoad: true,
        lazyLoadMaxDuration: 180,
        lazyLoadRecoverDuration: 30,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 180,
        autoCleanupMinBackwardDuration: 120,
        accurateSeek: true,
        fixAudioTimestampGap: true,
        reuseRedirectedURL: true
      }
    );

    state.engine = player;
    state.engineKind = 'flv';

    player.on(flvjs.Events.ERROR, (type, detail) => {
      if (!state.active || state.engine !== player) return;
      scheduleReconnect('FLV ' + (detail || type));
    });

    player.on(flvjs.Events.MEDIA_INFO, (info) => {
      if (!state.active || state.engine !== player) return;
      state.mediaInfo = info;
      state.lastProgressAt = Date.now();
      markEngineReady();
    });

    player.on(flvjs.Events.STATISTICS_INFO, (stats) => {
      if (!state.active || state.engine !== player) return;
      state.playerStats = stats;
    });

    player.attachMediaElement(state.overlay);
    player.load();
  }

  function markEngineReady() {
    if (state.engineNotice) {
      setStatus('warn', state.engineNotice);
      state.engineNotice = '';
      return;
    }
    if (state.status.kind !== 'ok') setStatus('ok', '已连接');
  }

  function createMpegtsFlvEngine(url) {
    if (!MpegtsLib) throw new Error('mpegts.js 未加载');
    if (!canPlayHevc()) throw new Error('当前浏览器不支持 HEVC MSE');

    const player = MpegtsLib.createPlayer(
      {
        type: 'flv',
        url: url,
        isLive: true,
        hasAudio: true,
        hasVideo: true,
        cors: true
      },
      {
        // 连续 FLV 没有自定义 loader 函数，配置可以被结构化克隆，Worker 转封装可用。
        enableWorker: true,
        enableStashBuffer: false,
        lazyLoad: true,
        lazyLoadMaxDuration: 180,
        lazyLoadRecoverDuration: 30,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 180,
        autoCleanupMinBackwardDuration: 120,
        accurateSeek: true,
        fixAudioTimestampGap: true,
        reuseRedirectedURL: true
      }
    );

    state.engine = player;
    state.engineKind = 'mpegts-flv';
    state.hevcPlayed = false;
    state.hevcStartedAt = Date.now();
    state.hevcLastProgressAt = Date.now();
    state.hevcLastTime = 0;
    state.hevcStallCount = 0;
    state.hevcPerfLastFrames = 0;
    state.hevcPerfLastAt = Date.now();
    state.hevcLowFpsCount = 0;

    player.on(MpegtsLib.Events.ERROR, (type, detail, info) => {
      if (!state.active || state.engine !== player) return;
      console.warn('[BDS] H.265 FLV 错误', type, detail, info ? String(info) : '');
      fallbackFromHevcFlv('H.265 FLV ' + (detail || type), false);
    });

    player.on(MpegtsLib.Events.MEDIA_INFO, (info) => {
      if (!state.active || state.engine !== player) return;
      state.mediaInfo = info;
      state.hevcPlayed = true;
      state.lastProgressAt = Date.now();
      markEngineReady();
    });

    player.on(MpegtsLib.Events.STATISTICS_INFO, (stats) => {
      if (!state.active || state.engine !== player) return;
      state.playerStats = stats;
    });

    player.attachMediaElement(state.overlay);
    player.load();
  }

  function canPlayHevc() {
    if (!MpegtsLib || !HlsTsLoader) return false;
    try {
      if (typeof MpegtsLib.isSupported === 'function' && !MpegtsLib.isSupported()) return false;
      return MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.1.L123.B0"') ||
        MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"') ||
        MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L153.B0"');
    } catch (error) {
      return false;
    }
  }

  function createMpegtsHlsEngine(url) {
    if (!MpegtsLib || !HlsTsLoader) throw new Error('mpegts.js 未加载');
    if (!canPlayHevc()) throw new Error('当前浏览器不支持 HEVC MSE');

    const player = MpegtsLib.createPlayer(
      {
        type: 'mse',
        url: url,
        isLive: true,
        hasAudio: true,
        hasVideo: true,
        cors: true
      },
      {
        customLoader: HlsTsLoader,
        enableWorker: false,
        enableStashBuffer: false,
        lazyLoad: true,
        lazyLoadMaxDuration: 180,
        lazyLoadRecoverDuration: 30,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 180,
        autoCleanupMinBackwardDuration: 120,
        fixAudioTimestampGap: true
      }
    );

    state.engine = player;
    state.engineKind = 'mpegts';
    state.hevcPlayed = false;
    state.hevcStartedAt = Date.now();
    state.hevcLastProgressAt = Date.now();
    state.hevcLastTime = 0;
    state.hevcStallCount = 0;
    state.hevcPerfLastFrames = 0;
    state.hevcPerfLastAt = Date.now();
    state.hevcLowFpsCount = 0;

    player.on(MpegtsLib.Events.ERROR, (type, detail, info) => {
      if (!state.active || state.engine !== player) return;
      console.warn('[BDS] H.265/mpegts 错误', type, detail, info ? String(info) : '');
      fallbackFromHevc('H.265 ' + (detail || type), true);
    });

    player.on(MpegtsLib.Events.MEDIA_INFO, (info) => {
      if (!state.active || state.engine !== player) return;
      state.mediaInfo = info;
      state.hevcPlayed = true;
      state.lastProgressAt = Date.now();
      markEngineReady();
    });

    player.on(MpegtsLib.Events.STATISTICS_INFO, (stats) => {
      if (!state.active || state.engine !== player) return;
      state.playerStats = stats;
    });

    player.attachMediaElement(state.overlay);
    player.load();
  }

  function fallbackFromHevcFlv(reason, auto) {
    if (!state.active) return;
    if (state.engineKind !== 'mpegts-flv') return;

    state.h265FlvFailed = true;
    const stream = selectStream(state.quality);
    if (stream && stream.hls265 && !state.hevcUnavailable) {
      const notice = auto
        ? 'H.265 FLV 卡顿，已切换到 H.265 HLS'
        : 'H.265 FLV 不可用，已切换到 H.265 HLS';
      state.engineNotice = notice;
      const token = ++state.session;
      destroyEngine();
      createEngine(token);
      setStatus('warn', notice);
      updateUi();
      return;
    }

    fallbackFromHevc(reason, auto);
  }

  function fallbackFromHevc(reason, auto) {
    if (!state.active) return;
    if (state.hevcFallbackTried) return;

    state.hevcFallbackTried = true;
    state.hevcUnavailable = true;
    state.quality = 'ORIGIN_H264';
    state.qualityAuto = false;
    saveRoomConfig({ quality: 'ORIGIN_H264', qualityAuto: false, qualityPlan: 2 });

    const notice = auto
      ? 'H.265 持续卡顿，已自动切换到 H.264 原画（可重新选择 H.265）'
      : 'H.265 不可用，已切换到 H.264 原画';
    state.engineNotice = notice;

    const token = ++state.session;
    destroyEngine();
    createEngine(token);
    setStatus('warn', notice);
    updateUi();
  }

  function createHlsEngine(url) {
    if (!window.Hls || !Hls.isSupported()) {
      throw new Error('当前浏览器不支持 HLS/MSE');
    }

    state.hlsPlayed = false;

    const hls = new Hls({
      enableWorker: false,
      lowLatencyMode: false,
      backBufferLength: 180,
      maxBufferLength: 60,
      maxMaxBufferLength: 180,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 30,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      fragLoadingMaxRetryTimeout: 30000
    });

    state.engine = hls;
    state.engineKind = 'hls';

    hls.on(Hls.Events.ERROR, (event, data) => {
      if (!state.active || state.engine !== hls) return;
      if (!data || !data.fatal) return;

      console.warn('[BDS] HLS fatal error', data.type, data.details, data.reason || '', data.response ? data.response.code : '');

      // 只有在原画 HLS 从未成功播放过时才退到蓝光 FLV；
      // 已经播放过后出错则走普通重连，避免一次网络抖动就永久降画质。
      if (state.quality === 'ORIGIN' && !state.hlsPlayed && !state.hlsFallbackTried) {
        state.hlsFallbackTried = true;
        state.hlsUnavailable = true;
        const token = ++state.session;
        destroyEngine();
        state.quality = pickQuality(state.stream, state.quality);
        setStatus('warn', '原画 HLS 播放失败，已切换到蓝光 FLV');
        updateUi();
        createEngine(token);
        return;
      }

      scheduleReconnect('HLS ' + data.type + (data.details ? '/' + data.details : ''));
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!state.active || state.engine !== hls) return;
      state.lastProgressAt = Date.now();
    });

    hls.on(Hls.Events.FRAG_LOADED, () => {
      if (!state.active || state.engine !== hls) return;
      markEngineReady();
    });

    hls.attachMedia(state.overlay);
    hls.loadSource(url);
  }

  function scheduleReconnect(reason) {
    if (!state.active) return;
    if (state.retryTimer) return;

    state.retry += 1;
    if (state.retry > 8) {
      state.retry = 0;
      disable({ restore: true, silent: true, keepEnabled: false });
      setStatus('error', '多次重连失败（' + reason + '），请点“重连”重试');
      updateUi();
      return;
    }

    const wait = Math.min(30000, Math.round(1500 * Math.pow(1.7, Math.min(state.retry - 1, 6))));
    setStatus('warn', '连接中断（' + reason + '），' + Math.ceil(wait / 1000) + ' 秒后重连…');
    updateUi();

    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!state.active) return;
      doReconnect();
    }, wait);
  }

  async function doReconnect() {
    const token = ++state.session;
    destroyEngine();
    setStatus('loading', '正在重新连接抖音直播…');
    updateUi();

    const response = await sendMessage({
      type: 'BDS_RESOLVE',
      rid: state.rid || state.inputValue,
      force: state.retry >= 2
    });
    if (token !== state.session || !state.active) return;

    if (!response || !response.ok) {
      scheduleReconnect((response && response.error) || '解析失败');
      return;
    }
    if (!response.live) {
      scheduleReconnect(response.message || '直播间未开播');
      return;
    }

    state.stream = response;
    state.rid = response.rid || state.rid;
    state.expiresAt = response.expiresAt || 0;
    state.quality = pickQuality(response, state.quality);
    rememberRoom(response);
    saveRoomConfig({ rid: state.rid, quality: state.quality, qualityAuto: state.qualityAuto, qualityPlan: 2, enabled: true });
    updateUi();
    scheduleUrlRefresh();
    createEngine(token);
  }

  function scheduleUrlRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    const expiresAt = Number(state.expiresAt) || 0;
    if (!expiresAt) return;

    const wait = expiresAt - Date.now() - 120000;
    if (wait <= 0 || wait > 2147483000) return;

    state.refreshTimer = setTimeout(async () => {
      state.refreshTimer = null;
      if (!state.active) return;
      const response = await sendMessage({ type: 'BDS_RESOLVE', rid: state.rid || state.inputValue, force: true });
      if (response && response.ok && response.live) {
        state.stream = response;
        state.expiresAt = response.expiresAt || 0;
        state.quality = pickQuality(response, state.quality);
        rememberRoom(response);
        updateUi();
        scheduleUrlRefresh();
      }
    }, wait);
  }

  // ---------------------------------------------------------------- 音画同步

  function bufferedInfo(video) {
    try {
      const buffered = video.buffered;
      if (!buffered || !buffered.length) return null;
      let start = buffered.start(0);
      let end = buffered.end(0);
      for (let i = 1; i < buffered.length; i++) {
        if (buffered.end(i) > end) {
          start = buffered.start(i);
          end = buffered.end(i);
        }
      }
      return { start: start, end: end };
    } catch (error) {
      return null;
    }
  }

  function isBuffered(video, time) {
    try {
      const buffered = video.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (time >= buffered.start(i) + 0.02 && time <= buffered.end(i) - 0.02) return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  function safeSeek(video, time) {
    if (!Number.isFinite(time) || time < 0) return;
    if (!isBuffered(video, time)) return;
    if (Math.abs(video.currentTime - time) < 0.05) return;
    try {
      video.currentTime = time;
    } catch (error) {
      /* noop */
    }
  }

  function tryPlay(video) {
    if (!state.active || !state.userPlaying) return;
    applyAudio();
    state.lastPlayAttemptAt = Date.now();
    let promise = null;
    try {
      promise = video.play();
    } catch (error) {
      return;
    }
    if (!promise || typeof promise.catch !== 'function') return;

    promise.catch((error) => {
      if (!error || error.name !== 'NotAllowedError' || video.muted) return;
      state.autoplayMuted = true;
      applyAudio();
      try {
        video.play().catch(() => {});
      } catch (e) {
        /* noop */
      }
      setStatus('warn', '浏览器拦截了声音，已静音播放；点“取消静音”恢复');
      updateUi();
      armUnlockAudio();
    });
  }

  function armUnlockAudio() {
    if (state.unlockArmed) return;
    state.unlockArmed = true;
    const handler = () => {
      document.removeEventListener('pointerdown', handler, true);
      state.unlockArmed = false;
      if (!state.autoplayMuted) return;
      state.autoplayMuted = false;
      applyAudio();
      if (state.overlay) {
        try {
          state.overlay.play().catch(() => {});
        } catch (error) {
          /* noop */
        }
      }
      setStatus('ok', '已连接');
      updateUi();
    };
    document.addEventListener('pointerdown', handler, true);
  }

  function maintainSync(force) {
    const video = state.overlay;
    if (!video || !state.engine) return;

    if (!state.userPlaying) {
      if (!video.paused) {
        try {
          video.pause();
        } catch (error) {
          /* noop */
        }
      }
      hideBadge();
      return;
    }

    const info = bufferedInfo(video);
    if (!info || info.end - info.start < 0.2) return;

    const target = state.delay;
    const edge = info.end;

    if (target <= 0.3) {
      state.pendingTarget = null;
      hideBadge();
      if (video.paused) tryPlay(video);
      const latency = edge - video.currentTime;
      if (force || latency > 10) {
        safeSeek(video, Math.max(info.start + 0.2, edge - 0.5));
      }
      return;
    }

    const desired = edge - target;
    const available = enoughBufferForDelay(video, info, desired);

    if (!available) {
      state.pendingTarget = target;
      showBadge('缓冲 ' + fmt1(Math.min(info.end - info.start, target)) + ' / ' + fmt1(target) + 's');
      if (!video.paused) {
        try {
          video.pause();
        } catch (error) {
          /* noop */
        }
      }
      return;
    }

    state.pendingTarget = null;
    hideBadge();
    const latency = edge - video.currentTime;
    const drift = latency - target;

    if (force || video.paused || Math.abs(drift) > 1.5) {
      safeSeek(video, desired);
    }
    if (video.paused) tryPlay(video);
  }

  function enoughBufferForDelay(video, info, desired) {
    if (!Number.isFinite(desired)) return false;
    if (desired < info.start + 0.2) return false;
    if (desired > info.end) return false;
    return isBuffered(video, desired);
  }

  function setDelay(value, persist) {
    const next = clamp(Number(value) || 0, 0, MAX_DELAY);
    state.delay = next;
    updateDelayControls();
    if (persist) saveRoomConfig({ delay: state.delay });
    maintainSync(true);
    updateDebug();
  }

  function nudge(delta) {
    if (!Number.isFinite(delta)) return;
    setDelay(state.delay + delta, true);
  }

  function setVolume(value, persist) {
    state.volume = clamp(Number(value) || 0, 0, 1);
    if (state.volume > 0 && state.muted) state.muted = false;
    applyAudio();
    syncOrigVolumeQuiet();
    if (persist) saveRoomConfig({ volume: state.volume, muted: state.muted });
    updateUi();
  }

  function setMuted(muted) {
    state.muted = !!muted;
    state.autoplayMuted = false;
    applyAudio();
    syncOrigVolumeQuiet();
    saveRoomConfig({ muted: state.muted });
    updateUi();
  }

  // B站直播的“点击暂停”可能来自控制条按钮、空白处快捷操作或键盘空格。
  // 这里只把明确的播放/暂停操作标记为用户意图，避免把页面自动暂停误判成用户暂停。
  function isPlayPausePoint(target, clientX, clientY) {
    if (!target || !target.closest) return false;
    if (target.closest('#bds-root')) return false;

    const bar = target.closest('.web-player-controller-wrap');
    if (bar) {
      const label = String(target.getAttribute('aria-label') || '') + ' ' +
        String(target.getAttribute('title') || '') + ' ' +
        (typeof target.className === 'string' ? target.className : '');
      if (/play|pause|播放|暂停/i.test(label)) return true;
      const leftArea = target.closest('.left-area');
      if (leftArea && leftArea.firstElementChild) {
        const firstControl = leftArea.firstElementChild;
        if (firstControl === target || firstControl.contains(target)) return true;
      }
      const rect = bar.getBoundingClientRect();
      if (rect.width > 0 && clientX - rect.left <= 72) return true;
    }

    // 不同版本播放器的控制条类名可能变化；左下角通常就是播放/暂停。
    const player = target.closest('#live-player');
    if (player) {
      const rect = player.getBoundingClientRect();
      if (rect.width > 0 && clientY >= rect.bottom - 72 && clientX <= rect.left + 84) {
        return true;
      }
    }
    return false;
  }

  function installUserIntentTracking() {
    const markIfPlaying = () => {
      // 只有当前确实在播放时，播放/暂停按钮才可能是在“暂停”；
      // 暂停状态下点它是“恢复”，不应被当成暂停意图。
      if (state.orig && !state.orig.paused) {
        state.lastPauseIntentAt = Date.now();
      }
    };

    const onPointer = (event) => {
      const target = event.target;
      const touch = event.changedTouches && event.changedTouches[0];
      const x = touch ? touch.clientX : event.clientX;
      const y = touch ? touch.clientY : event.clientY;
      if (isPlayPausePoint(target, x, y)) {
        markIfPlaying();
      }
    };

    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('touchstart', onPointer, true);
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      if (event.code === 'Space' || event.key === ' ' || event.key === 'k' || event.key === 'K') {
        markIfPlaying();
      } else if (event.key === 'Enter' && target && target.closest &&
        target.closest('#live-player') && !target.closest('#bds-root')) {
        markIfPlaying();
      }
    }, true);
  }

  function onVisibilityChange() {
    if (document.hidden || !state.active) return;

    // 后台期间 B站原视频可能被浏览器/播放器自动暂停，回到前台时恢复它。
    const original = state.orig;
    if (original && state.userPlaying && original.paused && !original.ended && !original.error) {
      setTimeout(() => {
        if (!state.active || state.orig !== original || !state.userPlaying) return;
        if (original.paused && !original.ended) {
          const promise = original.play();
          if (promise && promise.catch) promise.catch(() => {});
        }
      }, 300);
    }

    if (state.userPlaying) maintainSync(true);
  }

  function checkHevcStability(video) {
    if ((state.engineKind !== 'mpegts' && state.engineKind !== 'mpegts-flv') || !state.hevcPlayed || !state.userPlaying ||
        state.pendingTarget != null || video.paused || document.hidden) {
      return false;
    }

    const now = Date.now();
    if (now - state.hevcStartedAt < 10000) return false;

    if (Math.abs(video.currentTime - state.hevcLastTime) > 0.05) {
      state.hevcLastTime = video.currentTime;
      state.hevcLastProgressAt = now;
      state.hevcStallCount = 0;
    } else if (state.hevcLastProgressAt && now - state.hevcLastProgressAt > 3500) {
      state.hevcStallCount += 1;
      state.hevcLastProgressAt = now;
      if (state.hevcStallCount >= 2) {
        console.warn('[BDS] H.265 连续停滞，自动降级');
        if (state.engineKind === 'mpegts-flv') {
          fallbackFromHevcFlv('H.265 FLV 播放停滞', true);
        } else {
          fallbackFromHevc('H.265 播放停滞', true);
        }
        return true;
      }
    }

    if (state.hevcPerfLastAt && now - state.hevcPerfLastAt > 5000) {
      try {
        const quality = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        if (quality) {
          const elapsed = (now - state.hevcPerfLastAt) / 1000;
          const frames = quality.totalVideoFrames - state.hevcPerfLastFrames;
          const fps = elapsed > 0 ? frames / elapsed : 0;
          state.hevcPerfLastFrames = quality.totalVideoFrames;
          state.hevcPerfLastAt = now;
          // 抖音原画是 60fps；持续低于 40fps 说明解码/带宽跟不上，长看会卡。
          if (fps > 0 && fps < 40) {
            state.hevcLowFpsCount += 1;
            if (state.hevcLowFpsCount >= 2) {
              console.warn('[BDS] H.265 帧率偏低，自动降级', fps.toFixed(1));
              if (state.engineKind === 'mpegts-flv') {
                fallbackFromHevcFlv('H.265 FLV 解码帧率不足', true);
              } else {
                fallbackFromHevc('H.265 解码帧率不足', true);
              }
              return true;
            }
          } else {
            state.hevcLowFpsCount = 0;
          }
        }
      } catch (error) {
        /* noop */
      }
    }
    return false;
  }

  function tick() {
    if (!state.active) return;

    const video = state.overlay;
    if (!video) return;

    const info = bufferedInfo(video);

    if (info && info.end > info.start) {
      if (!video.paused && Math.abs(video.currentTime - state.lastCurrentTime) > 0.05) {
        state.lastCurrentTime = video.currentTime;
        state.lastProgressAt = Date.now();
      }

      if (state.userPlaying) maintainSync(false);

      if (checkHevcStability(video)) return;

      // 看门狗：抖音画面被外部因素（媒体键、系统、页面脚本）意外暂停时自动续播。
      // 用户主动暂停时 userPlaying=false，不会触发；缓冲延迟时 pendingTarget!=null，也不会触发。
      if (
        state.engine &&
        state.userPlaying &&
        state.pendingTarget == null &&
        !document.hidden &&
        video.paused &&
        !video.ended &&
        !video.error &&
        video.readyState >= 2 &&
        Date.now() - state.lastPlayAttemptAt > 2000
      ) {
        console.info('[BDS] auto-resume paused overlay');
        tryPlay(video);
      }

      if (state.pendingTarget != null) {
        setLatencyText('缓冲中 ' + fmt1(Math.min(info.end - info.start, state.delay)) + ' / ' + fmt1(state.delay) + 's（用于对齐弹幕）');
      } else if (!state.userPlaying) {
        setLatencyText('B站播放器已暂停');
      } else {
        setLatencyText('画面延迟 ' + fmt1(info.end - video.currentTime) + 's · 可回退 ' + Math.max(0, info.end - info.start).toFixed(0) + 's' + (state.engineKind === 'mpegts' ? ' · H.265 HLS' : state.engineKind === 'mpegts-flv' ? ' · H.265 FLV' : ''));
      }

      if (!video.paused && video.readyState < 3 && Date.now() - state.lastProgressAt > 20000) {
        scheduleReconnect('播放停滞');
      }

      if (state.retry > 0 && Date.now() - state.lastProgressAt < 1500 && Date.now() - state.engineStartedAt > 20000) {
        state.retry = 0;
      }
    } else {
      setLatencyText('等待抖音视频数据…');
      if (state.engineKind === 'mpegts-flv' && Date.now() - state.engineStartedAt > 15000) {
        console.warn('[BDS] H.265 FLV 长时间无视频数据，回退 H.265 HLS');
        fallbackFromHevcFlv('H.265 FLV 长时间无数据', false);
        return;
      }
      if (Date.now() - state.engineStartedAt > 25000) {
        scheduleReconnect('长时间无数据');
      }
    }

    updateDebug();
    if (state.infoOpen) updateInfoPanel();
  }

  // ---------------------------------------------------------------- 操作

  function connectFromInput(force) {
    const text = ui.rid ? ui.rid.value.trim() : (state.inputValue || '').trim();
    if (!text) {
      setStatus('error', '请输入抖音直播间链接或房间号');
      updateUi();
      return;
    }
    state.inputValue = text;
    start(text, force);
  }

  function switchQuality(key) {
    if (!key || key === state.quality) return;
    state.quality = key;
    state.qualityAuto = false;
    state.engineNotice = '';
    if (key === 'ORIGIN') {
      state.hlsFallbackTried = false;
      state.hlsUnavailable = false;
      state.hlsPlayed = false;
      state.hevcFallbackTried = false;
      state.hevcUnavailable = false;
      state.hevcPlayed = false;
      state.h265FlvFailed = false;
    }
    saveRoomConfig({ quality: key, qualityAuto: false, qualityPlan: 2 });

    if (!state.active || !state.stream) {
      updateUi();
      return;
    }

    const token = ++state.session;
    destroyEngine();
    setStatus('loading', '正在切换清晰度…');
    updateUi();
    createEngine(token);
  }

  function disable(options) {
    const opts = options || {};
    const restore = opts.restore !== false;
    const silent = !!opts.silent;

    state.session += 1;
    state.active = false;
    state.pendingTarget = null;
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retry = 0;
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    destroyEngine();

    if (state.layer) state.layer.style.display = 'none';
    hideBadge();
    if (restore) restoreOriginal();
    unbindOriginal();
    state.userPlaying = true;

    if (!silent) {
      setStatus('idle', '已恢复B站原画面');
    }
    if (!opts.keepEnabled) saveRoomConfig({ enabled: false });
    updateUi();
  }

  function openDouyinPage() {
    const value = (state.inputValue || state.rid || '').trim();
    if (!value) {
      setStatus('warn', '请先填写抖音直播间');
      return;
    }
    let url = '';
    if (/^https?:\/\//i.test(value) && /douyin\.com/i.test(value)) {
      url = value;
    } else {
      const rid = extractRid(value);
      if (!rid) {
        setStatus('warn', '无法识别抖音房间号');
        return;
      }
      url = 'https://live.douyin.com/' + encodeURIComponent(rid);
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function handleRoomChange(roomId) {
    const wasActive = state.active;
    if (wasActive) disable({ restore: true, silent: true });
    state.roomId = roomId;
    state.autoStarted = false;
    loadRoomConfig();
    state.stream = null;
    state.qualitySig = '';
    state.h265FlvFailed = false;
    state.engineNotice = '';
    updateUi();
    if (state.rid) setStatus('idle', '已切换房间，点击“连接”开始');
    else setStatus('idle', '输入抖音直播间开始');
    maybeAutoStart();
  }

  function onFullscreenChange() {
    if (!state.active || state.fsFixing) return;
    const fullscreen = document.fullscreenElement;
    if (!fullscreen) return;
    if (state.layer && fullscreen.contains(state.layer)) return;
    if (!state.playerEl) return;

    const player = state.playerEl;
    state.fsFixing = true;
    document.exitFullscreen()
      .then(() => player.requestFullscreen())
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          state.fsFixing = false;
        }, 600);
      });
  }

  function maybeAutoStart() {
    if (state.autoStarted) return;
    const config = (state.settings.rooms && state.settings.rooms[state.roomId]) || {};
    if (!config.enabled || !config.rid) return;
    state.autoStarted = true;
    start(config.rid, false);
  }

  // ---------------------------------------------------------------- init

  async function init() {
    state.roomId = getBiliRoomId();
    if (!state.roomId) return;

    state.settings = normalizeSettings(await storageGetRoomSettings());
    loadRoomConfig();

    const urlRid = getUrlRid();
    if (urlRid) {
      state.rid = urlRid;
      state.inputValue = urlRid;
    }

    state.collapsed = !!state.settings.panelCollapsed;
    state.infoOpen = !!state.settings.infoOpen;
    buildUi();
    setInfoOpen(state.infoOpen, false);

    const tryAttach = () => {
      ensureAll();
      if (ui.root && !ui.root.isConnected) {
        const player = findPlayerEl();
        if (player) player.appendChild(ui.root);
      }
    };

    tryAttach();
    ensureAll();
    setInterval(ensureAll, 1000);
    setInterval(tick, 500);

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    installUserIntentTracking();
    updateUi();
    setStatus('idle', state.rid ? '已就绪，点击“连接”开始' : '输入抖音直播间开始');

    if (urlRid) {
      state.autoStarted = true;
      setTimeout(() => start(urlRid, false), 800);
    } else {
      setTimeout(maybeAutoStart, 800);
    }

    console.info('[BDS] content script ready, room=' + state.roomId);
  }

  init().catch((error) => {
    console.error('[BDS] init failed', error);
  });
})();
