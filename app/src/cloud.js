/**
 * 云备份（WebDAV · 坚果云）
 *
 * ── 双缓冲 ──
 *   我的坚果云/daily-three-a.json
 *   我的坚果云/daily-three-b.json
 *
 * 每次备份写到「上次没写的那个」，所以**任何时候都有一份完好的上一版**。
 * 恢复时两个都读，取 savedAt 大的、能解析的那个。
 * 这样代码写坏一次不会丢数据 —— 另一个文件还完好。
 *
 * 文件内容：
 *   { savedAt: 毫秒时间戳, device: 'xxx', data: { version, activeId, accounts } }
 *
 * ── 为什么不用 MKCOL / PROPFIND（2026-10-21 实测） ──
 *   CapacitorHttp 只允许 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/PATCH
 *     → MKCOL 报错，App 建不了文件夹
 *     → PROPFIND 报错，App 列不了目录
 *   GET 目录 → 坚果云返回 OperationNotAllowed
 *   所以文件直接放「我的坚果云」下面 —— 那是坚果云自带的目录，不用手动建。
 *
 * ── 覆盖写可靠性（2026-10-21 实测坚果云） ──
 *   PUT 已存在文件 → 204，内容正确替换
 *   40KB 覆盖成 20B  → GET 20 字节，无残留
 *   限速传 2MB 中途掐断 → 云端保持原来的完好版本（PUT 是原子的）
 *   所以「网络中断写坏档」不会发生，双缓冲防的是**代码 bug**。
 */
(function () {
  var CFG_KEY = 'daily_three_cloud';
  var BASE = 'https://dav.jianguoyun.com/dav';
  var HOME = '我的坚果云';
  var SLOT_A = 'daily-three-a.json';
  var SLOT_B = 'daily-three-b.json';
  var RETRY_MS = 5000;
  var DEBOUNCE_MS = 1500;

  /* ---------- 配置 ---------- */

  function readCfg() {
    try {
      var raw = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      return (raw && typeof raw === 'object') ? raw : {};
    } catch (e) {
      return {};
    }
  }

  function writeCfg(cfg) {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify({
        user: String(cfg.user || '').trim(),
        pass: String(cfg.pass || ''),
        lastSlot: cfg.lastSlot === 'b' ? 'b' : (cfg.lastSlot === 'a' ? 'a' : ''),
        lastBackup: cfg.lastBackup || 0
      }));
    } catch (e) {}
  }

  function isConfigured() {
    var c = readCfg();
    return !!(c.user && c.pass);
  }

  function clear() {
    try {
      localStorage.removeItem(CFG_KEY);
    } catch (e) {}
  }

  /* ---------- 路径 ---------- */

  /** 服务器根地址。默认坚果云；localStorage 设了 daily_three_cloud_base 就覆盖（测试用） */
  function baseUrl() {
    try {
      var o = localStorage.getItem('daily_three_cloud_base');
      if (o) return String(o).replace(/\/+$/, '');
    } catch (e) {}
    return BASE;
  }

  function dirUrl() { return baseUrl() + '/' + encodeURIComponent(HOME); }
  function slotUrl(slot) { return dirUrl() + '/' + (slot === 'b' ? SLOT_B : SLOT_A); }
  function relDir() { return HOME; }

  /* ---------- 请求 ---------- */

  /** btoa 遇到中文会抛异常，兜一下 */
  function b64(str) {
    try {
      return btoa(str);
    } catch (e) {
      return btoa(unescape(encodeURIComponent(str)));
    }
  }

  function request(method, url, cfg, body) {
    var headers = { Authorization: 'Basic ' + b64(String(cfg.user || '') + ':' + String(cfg.pass || '')) };
    var opts = { method: method, headers: headers };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = body;
    }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (txt) {
        return { status: res.status, ok: res.ok, text: txt, url: url };
      });
    });
  }

  function httpErr(prefix, status) {
    if (status === 401 || status === 403) return new Error('账号或应用密码不对（HTTP ' + status + '）');
    if (status === 409) return new Error('坚果云拒绝了这个路径（HTTP 409）。检查账号能不能正常访问「我的坚果云」。');
    if (status === 507) return new Error('坚果云空间不够了（HTTP 507）');
    return new Error(prefix + '（HTTP ' + status + '）');
  }

  /** 读一个槽位，返回 { slot, savedAt, data } 或 null */
  function readSlot(slot, cfg) {
    return request('GET', slotUrl(slot), cfg).then(function (r) {
      if (r.status === 404) return null;
      if (r.status === 401 || r.status === 403) throw httpErr('读取失败', r.status);
      if (!r.ok) return null;   // 其它状态当"这个槽坏了"，交给另一个槽兜底
      var obj;
      try {
        obj = JSON.parse(r.text);
      } catch (e) {
        return null;            // 坏档 → 当没有
      }
      if (!obj || !obj.data || !Array.isArray(obj.data.accounts) || !obj.data.accounts.length) {
        return null;
      }
      return { slot: slot, savedAt: Number(obj.savedAt) || 0, data: obj.data };
    }).catch(function () {
      return null;
    });
  }

  /* ---------- 备份 / 恢复 ---------- */

  /**
   * 备份：写到「上次没写的那个槽」。
   * 本地记着 lastSlot，所以不需要先读，1 次 PUT 就够。
   */
  function backup(payload) {
    var cfg = readCfg();
    if (!cfg.user) return Promise.reject(new Error('还没填账号'));

    var target = cfg.lastSlot === 'a' ? 'b' : 'a';   // 上次写 a 就写 b，反之写 a
    var at = Date.now();
    var body = JSON.stringify({
      savedAt: at,
      device: String(cfg.device || ''),
      data: payload
    });

    return request('PUT', slotUrl(target), cfg, body).then(function (r) {
      if (!(r.status === 200 || r.status === 201 || r.status === 204)) {
        throw httpErr('上传失败', r.status);
      }
      cfg.lastSlot = target;
      cfg.lastBackup = at;
      writeCfg(cfg);
      return { bytes: body.length, slot: target, path: relDir() + '/' + (target === 'b' ? SLOT_B : SLOT_A) };
    });
  }

  /** 恢复：两个槽都读，取 savedAt 大且能解析的 */
  function restore() {
    var cfg = readCfg();
    if (!cfg.user) return Promise.reject(new Error('还没填账号'));

    return Promise.all([readSlot('a', cfg), readSlot('b', cfg)]).then(function (arr) {
      var a = arr[0], b = arr[1];
      if (!a && !b) throw new Error('云端还没有备份');
      var best = (!a) ? b : (!b) ? a : (a.savedAt >= b.savedAt ? a : b);
      var other = (best === a) ? b : a;
      cfg.lastSlot = best.slot;          // 下次备份写另一个槽
      cfg.lastBackup = best.savedAt;
      writeCfg(cfg);
      return {
        data: best.data,
        slot: best.slot,
        savedAt: best.savedAt,
        recovered: !!other ? (best.savedAt > other.savedAt) : false,
        backupSlot: other ? other.slot : ''
      };
    });
  }

  /* ---------- 自动同步 ---------- */

  var state = {
    online: true,      // 启动时能不能连上云端
    dirty: false,      // 有改动没推上去
    lastError: '',
    pushTimer: null,
    retryTimer: null
  };

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {}
  }

  function publishState() {
    emit('cloud:state', {
      online: state.online,
      dirty: state.dirty,
      error: state.lastError
    });
  }

  function isOnline() { return state.online; }
  function isDirty() { return state.dirty; }
  function lastError() { return state.lastError; }

  /** 真正推一次 */
  function flush(getPayload) {
    var payload;
    try {
      payload = getPayload ? getPayload() : null;
    } catch (e) {
      payload = null;
    }
    if (!payload) return Promise.resolve(false);

    return backup(payload).then(function () {
      var changed = state.dirty || !state.online || state.lastError;
      state.dirty = false;
      state.online = true;
      state.lastError = '';
      if (changed) publishState();
      emit('cloud:pushed', { ok: true });
      return true;
    }).catch(function (e) {
      state.dirty = true;
      state.lastError = (e && e.message) || '上传失败';
      // ⚠️ 注意：这里**不把 online 置 false**。
      // 推送失败不等于离线 —— 锁死只读会让本地改动永远上不去。
      publishState();
      scheduleRetry(getPayload);
      return false;
    });
  }

  function scheduleRetry(getPayload) {
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(function () {
      if (!state.dirty || !isConfigured()) return;
      flush(getPayload);
    }, RETRY_MS);
  }

  /** 启动时拉一次。拉不到才算离线（唯一会把 online 置 false 的地方） */
  function autoPull() {
    if (!isConfigured()) { state.online = true; publishState(); return Promise.resolve(null); }

    // 有没推上去的改动 → 先推，别让云端旧数据覆盖本地
    var pre = state.dirty ? Promise.resolve(true) : Promise.resolve(false);

    return pre.then(function () {
      return restore();
    }).then(function (res) {
      state.online = true;
      state.lastError = '';
      publishState();
      emit('cloud:data', res);
      return res;
    }).catch(function (e) {
      var msg = String((e && e.message) || '');
      if (msg.indexOf('还没有备份') >= 0) {
        state.online = true;
        state.lastError = '';
        publishState();
        return null;
      }
      state.online = false;
      state.lastError = msg;
      publishState();
      return null;
    });
  }

  /** 改动后防抖推送（1.5 秒，连续改只推一次） */
  function scheduleBackup(getPayload) {
    if (!isConfigured()) return;
    clearTimeout(state.pushTimer);
    state.pushTimer = setTimeout(function () {
      flush(getPayload);
    }, DEBOUNCE_MS);
  }

  window.addEventListener('load', function () {
    if (!isConfigured()) return;
    autoPull();
  });

  window.DailyCloud = {
    BASE: BASE,
    readCfg: readCfg,
    writeCfg: writeCfg,
    isConfigured: isConfigured,
    relDir: relDir,
    backup: backup,
    restore: restore,
    clear: clear,
    autoPull: autoPull,
    scheduleBackup: scheduleBackup,
    isOnline: isOnline,
    isDirty: isDirty,
    lastError: lastError
  };
})();
