/**
 * 云备份（WebDAV）
 *
 * 设计前提：**云端是唯一真相，不做合并、不做增量**。
 *   - 备份：整份 JSON PUT 上去，覆盖云端那份
 *   - 恢复：整份 GET 下来，覆盖本地
 *   - 冲突：不存在（同一时刻只有一个在线设备在写）
 *
 * 地址不用用户填：服务器固定坚果云，目录按账号算出来。
 *   https://dav.jianguoyun.com/dav/daily-three/<账号hash>/backup.json
 * 同一账号在任何设备算出同一个 hash，所以换设备也不用填、不会重名。
 */
(function () {
  var CFG_KEY = 'daily_three_cloud';
  var BASE = 'https://dav.jianguoyun.com/dav';
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
        lastBackup: cfg.lastBackup || 0
      }));
    } catch (e) {}
  }

  function markBackedUp(at) {
    var c = readCfg();
    c.lastBackup = at || Date.now();
    writeCfg(c);
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

  /* ---------- 路径：账号 → 目录 ---------- */

  /** FNV-1a，32 位 */
  function fnv(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /** 账号 → 8 位小写字母数字，当目录名 */
  function dirOf(user) {
    var u = String(user || '').trim().toLowerCase();
    return (fnv(u).toString(36) + fnv(u + '#daily-three').toString(36)).slice(0, 8);
  }

  function dirUrl(user) {
    return baseUrl() + '/' + TOP + '/' + dirOf(user);
  }

  function fileUrl(user) {
    return dirUrl(user) + '/backup.json';
  }

  /** 给界面显示的相对路径 */
  function relPath(user) {
    return TOP + '/' + dirOf(user) + '/backup.json';
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
        return { status: res.status, ok: res.ok, text: txt };
      });
    });
  }

  /**
   * 建目录。WebDAV 的 MKCOL：
   *   201 建好了 / 405 已经存在 —— 都算成功
   *   409 父目录不存在 —— 先建父目录
   *   401 密码错
   */
  function mkcol(url, cfg) {
    return request('MKCOL', url, cfg).then(function (r) {
      if (r.status === 201 || r.status === 405 || r.status === 200) return true;
      if (r.status === 401 || r.status === 403) throw new Error('账号或应用密码不对（HTTP ' + r.status + '）');
      if (r.status === 409) throw new Error('父目录不存在，可能账号还没初始化（HTTP 409）');
      throw new Error('建目录失败 HTTP ' + r.status);
    });
  }

  function ensureDirs(cfg) {
    var top = baseUrl() + '/' + TOP;
    var sub = dirUrl(cfg.user);
    return mkcol(top, cfg).then(function () {
      return mkcol(sub, cfg);
    }).then(function () {
      return sub;
    });
  }

  /* ---------- 备份 / 恢复 ---------- */

  function backup(payload) {
    var cfg = readCfg();
    if (!cfg.user) return Promise.reject(new Error('还没填账号'));

    var body = JSON.stringify(payload);
    return ensureDirs(cfg).then(function () {
      return request('PUT', fileUrl(cfg.user), cfg, body);
    }).then(function (r) {
      if (r.status === 200 || r.status === 201 || r.status === 204) {
        markBackedUp(Date.now());
        return { bytes: body.length, path: relPath(cfg.user) };
      }
      if (r.status === 401 || r.status === 403) {
        throw new Error('账号或应用密码不对（HTTP ' + r.status + '）');
      }
      if (r.status === 404) throw new Error('目录不存在，坚果云可能不支持自动建目录（HTTP 404）');
      if (r.status === 507) throw new Error('坚果云空间不够了（HTTP 507）');
      throw new Error('上传失败 HTTP ' + r.status);
    });
  }

  function restore() {
    var cfg = readCfg();
    if (!cfg.user) return Promise.reject(new Error('还没填账号'));
    return request('GET', fileUrl(cfg.user), cfg).then(function (r) {
      if (r.status === 404) throw new Error('云端还没有备份');
      if (r.status === 401 || r.status === 403) {
        throw new Error('账号或应用密码不对（HTTP ' + r.status + '）');
      }
      if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
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

  window.DailyCloud = {
    BASE: BASE,
    readCfg: readCfg,
    writeCfg: writeCfg,
    markBackedUp: markBackedUp,
    isConfigured: isConfigured,
    dirOf: dirOf,
    relPath: relPath,
    fileUrl: fileUrl,
    backup: backup,
    restore: restore,
    clear: clear
  };
})();
