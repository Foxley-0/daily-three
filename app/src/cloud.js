/**
 * 云备份（WebDAV · 坚果云）
 *
 * 设计前提：**云端是唯一真相，不做合并、不做增量**。
 *   - 备份：整份 JSON PUT 上去
 *   - 恢复：整份 GET 下来，覆盖本地
 *   - 冲突：不存在（同一时刻只有一个在线设备在写）
 *
 * ── 路径 ──
 *   https://dav.jianguoyun.com/dav/我的坚果云/daily-three/backup-log.txt
 *   https://dav.jianguoyun.com/dav/我的坚果云/daily-three/backup-20261021.json
 *
 * 数据文件按**日期**命名（一天一个快照），`backup-log.txt` 里每行记一次备份：
 *   2026-10-21 13:20:15  backup-20261021.json
 * 恢复时读日志的**最后一行**拿到文件名，再去读那个文件。
 * 这样不需要"列目录"就能找回存档，也不用把路径绑在任何账号上。
 *
 * ── 为什么不用 App 建目录 / 列目录（2026-10-20/21 实测） ──
 *   CapacitorHttp 只允许 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/PATCH：
 *     MKCOL    → 报错，App 建不了文件夹
 *     PROPFIND → 报错，App 列不了目录
 *   GET 目录 → 坚果云返回 OperationNotAllowed
 *   坚果云行为：
 *     PUT /dav/我的坚果云/xxx.json    → 201 ✓（写进已存在的文件夹可以）
 *     PUT /dav/xxx.json（根目录）     → 404 ✗（根目录不许建文件）
 *     PUT /dav/不存在/x.json          → 409 ✗（父目录不存在）
 *   所以 `daily-three` 文件夹要在坚果云里手动建一次，建完一直存在。
 *
 * ── 多个账号 ──
 *   备份的是整个容器（`accounts` 数组），App 里所有账号都在同一个文件里。
 *   所以文件名不需要区分账号。
 */
(function () {
  var CFG_KEY = 'daily_three_cloud';
  var BASE = 'https://dav.jianguoyun.com/dav';
  var HOME = '我的坚果云';
  var TOP = 'daily-three';

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
        lastFile: String(cfg.lastFile || '')
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

  /**
   * 服务器根地址。默认坚果云；localStorage 里设了 daily_three_cloud_base 就用它。
   * 平时不暴露到界面 —— 用户不需要填地址。
   */
  function baseUrl() {
    try {
      var o = localStorage.getItem('daily_three_cloud_base');
      if (o) return String(o).replace(/\/+$/, '');
    } catch (e) {}
    return BASE;
  }

  function dirUrl() {
    return baseUrl() + '/' + encodeURIComponent(HOME) + '/' + TOP;
  }

  /** 数据文件名：按日期，一天一个快照 */
  function dataName(d) {
    var x = d || new Date();
    var y = x.getFullYear();
    var m = x.getMonth() + 1;
    var day = x.getDate();
    return 'backup-' + y + (m < 10 ? '0' : '') + m + (day < 10 ? '0' : '') + day + '.json';
  }

  var LOG = 'backup-log.txt';

  function relDir() { return HOME + '/' + TOP; }

  /** 一行日志：时间 + 文件名 */
  function logLine(file, at) {
    var d = new Date(at || Date.now());
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
           ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) +
           '  ' + file;
  }

  /** 从日志里取最后一个文件名 */
  function lastFileOf(logText) {
    var lines = String(logText || '').split(/\r?\n/);
    for (var i = lines.length - 1; i >= 0; i--) {
      var ln = lines[i].trim();
      if (!ln) continue;
      var parts = ln.split(/\s+/);
      var name = parts[parts.length - 1];
      if (/^backup-\d{8}\.json$/.test(name)) return name;
    }
    return '';
  }

  /* ---------- 请求 ---------- */

  /** btoa 遇到中文会抛异常，兜一下 */
  function b64(str) {
    try {
      return btoa(str);
    } catch (e) {
      return btoa(unescape(encodeURIComponent(str)));
    }
  }

  function authHeader(cfg) {
    return 'Basic ' + b64(String(cfg.user || '') + ':' + String(cfg.pass || ''));
  }

  function request(method, url, cfg, body) {
    var headers = { Authorization: authHeader(cfg) };
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
    if (status === 401 || status === 403) {
      return new Error('账号或应用密码不对（HTTP ' + status + '）');
    }
    if (status === 409) {
      return new Error('坚果云里没有「' + TOP + '」这个文件夹。\n\n' +
        '请打开坚果云，在「我的坚果云」下面新建一个名为 ' + TOP + ' 的文件夹，建一次就好。');
    }
    if (status === 404) {
      return new Error('路径不对（HTTP 404）。检查坚果云里有没有 ' + TOP + ' 文件夹。');
    }
    if (status === 507) {
      return new Error('坚果云空间不够了（HTTP 507）');
    }
    return new Error(prefix + '（HTTP ' + status + '）');
  }

  /* ---------- 备份 / 恢复 ---------- */

  /**
   * 备份三步走：
   *   1. PUT 数据文件（backup-YYYYMMDD.json，同一天覆盖同一个）
   *   2. GET 备份日志
   *   3. PUT 日志（追加一行）
   * 日志只留最近 200 行，防止无限增长。
   */
  function backup(payload) {
    var cfg = readCfg();
    if (!cfg.user) return Promise.reject(new Error('还没填账号'));

    var name = dataName();
    var body = JSON.stringify(payload);
    var at = Date.now();

    return request('PUT', dirUrl() + '/' + name, cfg, body).then(function (r) {
      if (!(r.status === 200 || r.status === 201 || r.status === 204)) {
        throw httpErr('上传失败', r.status);
      }
      // 读日志（可能还不存在）
      return request('GET', dirUrl() + '/' + LOG, cfg);
    }).then(function (r) {
      var old = '';
      if (r.status === 200 && r.ok) old = String(r.text || '');
      else if (r.status !== 404) throw httpErr('读日志失败', r.status);

      var lines = old.split(/\r?\n/).filter(function (x) { return x.trim(); });
      lines.push(logLine(name, at));
      if (lines.length > 200) lines = lines.slice(lines.length - 200);

      return request('PUT', dirUrl() + '/' + LOG, cfg, lines.join('\n') + '\n');
    }).then(function (r) {
      if (!(r.status === 200 || r.status === 201 || r.status === 204)) {
        throw httpErr('写日志失败', r.status);
      }
      cfg.lastBackup = at;
      cfg.lastFile = name;
      writeCfg(cfg);
      return { bytes: body.length, file: name, path: relDir() + '/' + name };
    });
  }

  /**
   * 恢复：读备份日志，取最后一行里的文件名，再去读那个文件。
   * 日志丢了就退回试今天的文件名。
   */
  function restore() {
    var cfg = readCfg();
    if (!cfg.user) return Promise.reject(new Error('还没填账号'));

    function fetchData(name) {
      return request('GET', dirUrl() + '/' + name, cfg).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw httpErr('下载失败', r.status);
        var data;
        try {
          data = JSON.parse(r.text);
        } catch (e) {
          throw new Error('云端文件不是有效数据');
        }
        if (!data || !Array.isArray(data.accounts) || !data.accounts.length) {
          throw new Error('云端数据格式不对');
        }
        return data;
      });
    }

    return request('GET', dirUrl() + '/' + LOG, cfg).then(function (r) {
      if (r.status === 404) {
        return fetchData(dataName()).then(function (d) {
          if (!d) throw new Error('云端还没有备份');
          return d;
        });
      }
      if (!r.ok) throw httpErr('读日志失败', r.status);

      var name = lastFileOf(r.text);
      if (!name) throw new Error('云端还没有备份');
      return fetchData(name).then(function (d) {
        if (!d) throw new Error('日志里指向的备份文件不见了：' + name);
        return d;
      });
    });
  }

  /* ---------- 自动同步 ---------- */

  var state = { online: true, lastError: '', pushTimer: null, retryTimer: null };

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {}
  }

  function setOnline(v, err) {
    var changed = state.online !== v;
    state.online = v;
    state.lastError = v ? '' : (err || '');
    if (changed) emit('cloud:state', { online: v, error: state.lastError });
  }

  function isOnline() { return state.online; }
  function lastError() { return state.lastError; }

  function autoPull() {
    if (!isConfigured()) { setOnline(true); return Promise.resolve(); }
    return restore().then(function (data) {
      setOnline(true);
      emit('cloud:data', data);
    }).catch(function (e) {
      var msg = String((e && e.message) || '');
      if (msg.indexOf('还没有备份') >= 0) { setOnline(true); return; }
      setOnline(false, msg);
    });
  }

  function scheduleBackup(getPayload) {
    if (!isConfigured() || !state.online) return;
    clearTimeout(state.pushTimer);
    state.pushTimer = setTimeout(function () {
      var payload;
      try {
        payload = getPayload();
      } catch (e) {
        return;
      }
      if (!payload) return;
      backup(payload).then(function () {
        setOnline(true);
        emit('cloud:pushed', { ok: true });
      }).catch(function (e) {
        setOnline(false, e && e.message);
      });
    }, 1500);
  }

  function startRetry() {
    clearInterval(state.retryTimer);
    state.retryTimer = setInterval(function () {
      if (state.online || !isConfigured()) return;
      autoPull();
    }, 30000);
  }

  window.addEventListener('load', function () {
    if (!isConfigured()) return;
    autoPull();
    startRetry();
  });

  window.DailyCloud = {
    BASE: BASE,
    readCfg: readCfg,
    writeCfg: writeCfg,
    isConfigured: isConfigured,
    relDir: relDir,
    dataName: dataName,
    backup: backup,
    restore: restore,
    clear: clear,
    autoPull: autoPull,
    scheduleBackup: scheduleBackup,
    isOnline: isOnline,
    lastError: lastError
  };
})();
