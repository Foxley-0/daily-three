/**
 * 云备份（WebDAV · 坚果云）
 *
 * ── 两个文件，职责不同 ──
 *   我的坚果云/daily-three.json          主存档：今天 + 全部历史，每次改动写
 *   我的坚果云/daily-three-backup.json   昨日副本：跨天归档时写一次
 *
 * 副本**一整天不变**，所以主存档哪天被代码 bug 写坏了，你有整整一天时间
 * 从副本恢复（最坏丢当天的任务，历史全在）。
 *
 * 为什么不用"每次改动都写两份"：那样两份的间隔只有 1.5 秒，
 * 坏数据几秒内就把两份都污染了，人来不及反应。
 * **备份的价值不在"有几份"，在"隔了多久"。**
 *
 * 文件内容：
 *   { savedAt: 毫秒, device: 'xxx', data: { version, activeId, accounts } }
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
 *   所以「网络中断写坏档」不会发生，副本防的是**代码 bug**。
 */
(function () {
  var CFG_KEY = 'daily_three_cloud';
  var BASE = 'https://dav.jianguoyun.com/dav';
  var HOME = '我的坚果云';
  var MAIN = 'daily-three.json';
  var COPY = 'daily-three-backup.json';
  var RETRY_MS = 5000;   // 推送失败后重试间隔
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
        lastBackup: cfg.lastBackup || 0,
        copyAt: cfg.copyAt || 0,
        copyDay: String(cfg.copyDay || ''),
        copyHour: Number(cfg.copyHour) || 0
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
  function mainUrl() { return dirUrl() + '/' + MAIN; }
  function copyUrl() { return dirUrl() + '/' + COPY; }
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

  /** 读一个文件，返回 { savedAt, data } 或 null（404 / 坏档 / 网络问题都返回 null） */
  function readFile(url, cfg) {
    return request('GET', url, cfg).then(function (r) {
      if (!r.ok) return null;
      var obj;
      try {
        obj = JSON.parse(r.text);
      } catch (e) {
        return null;
      }
      if (!obj || !obj.data || !Array.isArray(obj.data.accounts) || !obj.data.accounts.length) {
        return null;
      }
      return {
        savedAt: Number(obj.savedAt) || 0,
        day: String(obj.day || ''),
        cutoffHour: Number(obj.cutoffHour) || 0,
        data: obj.data
      };
    }).catch(function () {
      return null;
    });
  }

  function put(url, cfg, obj, label) {
    var body = JSON.stringify(obj);
    return request('PUT', url, cfg, body).then(function (r) {
      if (r.status === 200 || r.status === 201 || r.status === 204) return body.length;
      throw httpErr(label + '失败', r.status);
    });
  }

  /* ---------- 备份 / 恢复 ---------- */

  /** 写主存档（每次改动） */
  function backup(payload) {
    var cfg = readCfg();
    if (!cfg.user) return Promise.reject(new Error('还没填账号'));

    var at = Date.now();
    return put(mainUrl(), cfg, { savedAt: at, device: String(cfg.device || ''), data: payload }, '上传')
      .then(function (bytes) {
        cfg.lastBackup = at;
        writeCfg(cfg);
        return { bytes: bytes, path: relDir() + '/' + MAIN };
      });
  }

  /**
   * 写昨日副本（只在跨天归档时调用一次）。
   * day / cutoffHour 是**逻辑日期和统计截止小时**（dayStartHour），
   * 副本代表的是那个周期的完整状态，所以时间戳跟结算时间挂钩，不是写入时刻。
   */
  function copyNow(payload, day, cutoffHour) {
    var cfg = readCfg();
    if (!cfg.user) return Promise.resolve(null);

    var at = Date.now();
    return put(copyUrl(), cfg, {
      savedAt: at,
      day: String(day || ''),
      cutoffHour: Number(cutoffHour) || 0,
      device: String(cfg.device || ''),
      data: payload
    }, '写副本')
      .then(function (bytes) {
        cfg.copyAt = at;
        cfg.copyDay = String(day || '');
        cfg.copyHour = Number(cutoffHour) || 0;
        writeCfg(cfg);
        return { bytes: bytes, path: relDir() + '/' + COPY, day: day, cutoffHour: cutoffHour };
      })
      .catch(function (e) {
        // 副本写失败不影响主流程，下次跨天再写
        return null;
      });
  }

  /**
   * 恢复：先读主存档；读不到（404 / 坏档）再读昨日副本。
   * 返回 { data, fromCopy, savedAt }
   */
  function restore() {
    var cfg = readCfg();
    if (!cfg.user) return Promise.reject(new Error('还没填账号'));

    return readFile(mainUrl(), cfg).then(function (main) {
      if (main) return { data: main.data, fromCopy: false, savedAt: main.savedAt };
      return readFile(copyUrl(), cfg).then(function (cp) {
        if (cp) return { data: cp.data, fromCopy: true, savedAt: cp.savedAt, day: cp.day, cutoffHour: cp.cutoffHour };
        throw new Error('云端还没有备份');
      });
    });
  }

  /** 副本时间（给界面显示"副本有多旧"） */
  function copyTime() {
    var c = readCfg();
    return c.copyAt || 0;
  }

  /* ---------- 自动同步 ---------- */

  var state = {
    online: true,      // 启动时能不能连上云端
    dirty: false,      // 有改动没推上去
    lastError: '',
    pushTimer: null,
    retryTimer: null,
    lastPayload: null
  };

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {}
  }

  function publishState() {
    emit('cloud:state', { online: state.online, dirty: state.dirty, error: state.lastError });
  }

  function isOnline() { return state.online; }
  function isDirty() { return state.dirty; }
  function lastError() { return state.lastError; }

  /** 真正推一次 */
  function flush(getPayload) {
    var payload;
    try {
      payload = getPayload ? getPayload() : state.lastPayload;
    } catch (e) {
      payload = null;
    }
    if (!payload) return Promise.resolve(false);
    state.lastPayload = payload;

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
      // ⚠️ 这里**不把 online 置 false** —— 推送失败不等于离线。
      // 锁死只读会让本地改动永远上不去。
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
    copyNow: copyNow,
    restore: restore,
    copyTime: copyTime,
    clear: clear,
    autoPull: autoPull,
    scheduleBackup: scheduleBackup,
    isOnline: isOnline,
    isDirty: isDirty,
    lastError: lastError
  };
})();
