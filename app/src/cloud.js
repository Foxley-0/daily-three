/**
 * 云备份（WebDAV）
 *
 * 设计前提：**云端是唯一真相，不做合并、不做增量**。
 *   - 备份：整份 JSON PUT 上去，覆盖云端那份
 *   - 恢复：整份 GET 下来，覆盖本地
 *   - 冲突：不存在（同一时刻只有一个在线设备在写）
 *
 * 为什么用 fetch 而不是原生 HTTP：
 *   APK 里开了 CapacitorHttp，fetch 会被换成原生网络栈，**绕过 CORS**。
 *   浏览器预览时没有 CORS 头，所以预览环境下不配 WebDAV 就行。
 */
(function () {
  var CFG_KEY = 'daily_three_cloud';

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
        url: String(cfg.url || '').trim(),
        user: String(cfg.user || '').trim(),
        pass: String(cfg.pass || ''),
        lastBackup: cfg.lastBackup || 0
      }));
    } catch (e) {}
  }

  /** 只存"上次备份时间"，不动其它字段 */
  function markBackedUp(at) {
    var c = readCfg();
    c.lastBackup = at || Date.now();
    writeCfg(c);
  }

  function isConfigured() {
    var c = readCfg();
    return !!(c.url && c.user);
  }

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

  function request(method, cfg, body) {
    var headers = { Authorization: authHeader(cfg) };
    var opts = { method: method, headers: headers };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = body;
    }
    return fetch(cfg.url, opts).then(function (res) {
      return res.text().then(function (txt) {
        return { status: res.status, ok: res.ok, text: txt };
      });
    });
  }

  /** 把当前数据整份传上去 */
  function backup(payload) {
    var cfg = readCfg();
    if (!cfg.url) return Promise.reject(new Error('还没配置云备份地址'));
    var body = JSON.stringify(payload);
    return request('PUT', cfg, body).then(function (r) {
      // WebDAV 的 PUT：新建 201，覆盖 200/204
      if (r.status === 200 || r.status === 201 || r.status === 204) {
        markBackedUp(Date.now());
        return { bytes: body.length };
      }
      if (r.status === 401 || r.status === 403) {
        throw new Error('账号或应用密码不对（HTTP ' + r.status + '）');
      }
      if (r.status === 404) {
        throw new Error('地址不对，找不到这个路径（HTTP 404）');
      }
      if (r.status === 405) {
        throw new Error('这个地址不允许上传（HTTP 405），检查是不是目录地址');
      }
      throw new Error('上传失败 HTTP ' + r.status);
    });
  }

  /** 把云端那份拉下来 */
  function restore() {
    var cfg = readCfg();
    if (!cfg.url) return Promise.reject(new Error('还没配置云备份地址'));
    return request('GET', cfg).then(function (r) {
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

  /** 清掉配置（断开云备份） */
  function clear() {
    try {
      localStorage.removeItem(CFG_KEY);
    } catch (e) {}
  }

  window.DailyCloud = {
    readCfg: readCfg,
    writeCfg: writeCfg,
    markBackedUp: markBackedUp,
    isConfigured: isConfigured,
    backup: backup,
    restore: restore,
    clear: clear
  };
})();
