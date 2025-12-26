/*
qx_opapp_capture_gist.js
增强版抓包脚本：抓取 opapp 的 Cookie 与 X-CSRF-Token，并自动同步到 GitHub Gist。
支持：
 - 优先使用 BoxJS 中的 `opapp_github_token` / `opapp_gist_id` / `opapp_gist_filename`
 - 若 BoxJS 未配置，则尝试读取仓库中的 `script/auth.json` (raw GitHub URL)
 - 上传的 Gist 内容遵循用户要求的 JSON 结构：{ cookies: [...], origins: [...] }

使用示例 (Quantumult X 重写规则)：
  [rewrite_local]
  ^https?:\/\/g\.opapp\.cn\/pet\/api\/(login|init)\.php url script-request-body https://raw.githubusercontent.com/Bigzhangbig/panda/master/script/qx_opapp_capture_gist.js
  
[mitm]
hostname = g.opapp.cn
*/


const $ = new Env('opapp-capture-gist');
const CONFIG = {
  cookieKey: 'opapp_cookie',
  csrfKey: 'opapp_csrf',
  githubTokenKey: 'opapp_github_token',
  gistIdKey: 'opapp_gist_id',
  gistFilenameKey: 'opapp_gist_filename',
  debugKey: 'opapp_debug'
};

(async () => {
  try {
    if (typeof $request !== 'undefined' || typeof $response !== 'undefined') {
      await captureOpappCreds();
    } else {
      log(`[${$.name}] 未检测到 request/response 环境，直接退出`);
    }
  } catch (e) {
    log(`[${$.name}] 执行异常: ${e}`);
    $.msg($.name, '脚本执行异常', e.toString());
  }
  $done({});
})();


function log(msg) {
  // 始终输出日志，debugKey为true时加[debug]前缀
  if ($.getdata && $.getdata(CONFIG.debugKey) === 'true') {
    console.log('[debug]', msg);
  } else {
    console.log(msg);
  }
}


async function captureOpappCreds() {
  // 多信源提取
  const reqHeaders = ($request && $request.headers) ? $request.headers : {};
  const resHeaders = ($response && $response.headers) ? $response.headers : {};
  const body = ($response && typeof $response.body === 'string') ? $response.body : '';
  // cookie
  const cookie = reqHeaders['Cookie'] || reqHeaders['cookie'] || resHeaders['Cookie'] || resHeaders['cookie'] || '';
  // csrf
  let csrf = reqHeaders['X-CSRF-Token'] || reqHeaders['x-csrf-token'] || resHeaders['X-CSRF-Token'] || resHeaders['x-csrf-token'] || '';
  // origin
  const origin = reqHeaders['Origin'] || reqHeaders['origin'] || reqHeaders['Referer'] || reqHeaders['referer'] || resHeaders['Origin'] || resHeaders['origin'] || 'https://g.opapp.cn';
  // set-cookie
  const setCookieHeader = resHeaders['Set-Cookie'] || resHeaders['set-cookie'] || reqHeaders['Set-Cookie'] || reqHeaders['set-cookie'] || null;
  // 响应体提取 csrf
  if (body && !csrf) {
    try {
      const j = JSON.parse(body);
      csrf = j.csrf_token || j.csrf || j.token || csrf;
    } catch (e) {
      const m = body.match(/csrf_token["']?\s*[:=]\s*["']?([0-9a-f|]+)["']?/i);
      if (m && m[1]) csrf = m[1];
    }
  }
  // 本地持久化
  if (cookie) setValue(cookie, CONFIG.cookieKey);
  if (csrf) setValue(csrf, CONFIG.csrfKey);

  // 读取 gist 以对比
  const gistResult = await getGistOpapp();
  const gistData = gistResult && gistResult.ok ? (gistResult.data || null) : null;
  if (gistResult && gistResult.failed) {
    $.msg($.name, '获取 Gist 失败', gistResult.message || '无法获取远端数据，请检查配置或网络');
  }

  // 构造本地最新 payload
  const localPayload = await buildPayload({ requestCookie: cookie, setCookieHeader, originHeader: origin });
  // 若信息不全（无cookie），仅本地保存，等待下次补全
  if (!cookie) {
    log(`[${$.name}] 未获取到Cookie，仅本地保存，跳过Gist上传`);
    return;
  }
  // 若 gist 内容一致则跳过上传
  if (gistData && stableStringify(gistData) === stableStringify(localPayload)) {
    log(`[${$.name}] 本地凭证与 Gist 一致，跳过上传`);
    return;
  }
  // 上传 gist
  const ok = await syncToGist(localPayload);
  if (!ok) $.msg($.name, '凭证更新失败', '同步到 Gist 失败，请查看日志');
  else log(`[${$.name}] 已上传Gist: ${ok}`);
}

async function getGistOpapp() {
  const token = $.getdata(CONFIG.githubTokenKey);
  const gistId = $.getdata(CONFIG.gistIdKey);
  const filename = $.getdata(CONFIG.gistFilenameKey) || 'opapp_cookies.json';
  if (!token || !gistId) return { ok: false, failed: true, message: '配置缺失：未设置 GitHub Token 或 Gist ID' };
  const req = {
    url: `https://api.github.com/gists/${gistId}`,
    method: 'GET',
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'opapp-capture-script',
      'Accept': 'application/vnd.github.v3+json'
    }
  };
  return new Promise((resolve) => {
    if ($.isQuanX) {
      $task.fetch(req).then(
        resp => {
          if (resp.statusCode === 200) {
            try {
              const body = JSON.parse(resp.body);
              if (body.files && body.files[filename]) {
                resolve({ ok: true, data: JSON.parse(body.files[filename].content) });
              } else {
                resolve({ ok: true, data: null });
              }
            } catch (e) {
              log(`[${$.name}] 解析Gist失败: ${e}`);
              resolve({ ok: false, failed: true, message: `解析 Gist 失败: ${e}` });
            }
          } else {
            log(`[${$.name}] 获取Gist失败: ${resp.statusCode}`);
            resolve({ ok: false, failed: true, message: `获取 Gist 失败: ${resp.statusCode}` });
          }
        },
        reason => {
          log(`[${$.name}] 获取Gist出错: ${reason.error}`);
          resolve({ ok: false, failed: true, message: `获取 Gist 出错: ${reason.error}` });
        }
      );
    } else {
      resolve({ ok: false, failed: true, message: '当前环境不支持网络请求' });
    }
  });
}

function stableStringify(obj) {
  if (!obj) return '';
  const allKeys = [];
  JSON.stringify(obj, (key, value) => { allKeys.push(key); return value; });
  allKeys.sort();
  return JSON.stringify(obj, allKeys);
}

async function buildPayload(opts) {
  // opts: { requestCookie, setCookieHeader, responseLocalStorage, originHeader }
  const requestCookie = opts.requestCookie || '';
  const setCookieHeader = opts.setCookieHeader || null;
  const responseLocalStorage = opts.responseLocalStorage || [];
  const originHeader = opts.originHeader || 'https://g.opapp.cn';

  const cookieMap = new Map();

  // 1. 从 request Cookie 解析简单 name=value 列表
  if (requestCookie && typeof requestCookie === 'string') {
    const pairs = requestCookie.split(/;\s*/).filter(Boolean);
    for (const p of pairs) {
      const idx = p.indexOf('=');
      const name = idx >= 0 ? p.slice(0, idx).trim() : p.trim();
      const value = idx >= 0 ? p.slice(idx + 1).trim() : '';
      cookieMap.set(name, { name, value, domain: 'g.opapp.cn', path: '/' });
    }
  }

  // 2. 如果存在 Set-Cookie（可能包含属性），解析覆盖或补充信息
  if (setCookieHeader) {
    // Set-Cookie 可能为字符串或数组
    const scs = Array.isArray(setCookieHeader) ? setCookieHeader : String(setCookieHeader).split(/,(?=[^;]+=)/);
    for (const sc of scs) {
      const parts = sc.split(/;\s*/).filter(Boolean);
      if (parts.length === 0) continue;
      const nv = parts[0];
      const idx = nv.indexOf('=');
      if (idx < 0) continue;
      const name = nv.slice(0, idx).trim();
      const value = nv.slice(idx + 1).trim();
      let domain = 'g.opapp.cn';
      let path = '/';
      for (let i = 1; i < parts.length; i++) {
        const kv = parts[i];
        const kidx = kv.indexOf('=');
        const k = kidx >= 0 ? kv.slice(0, kidx).trim().toLowerCase() : kv.trim().toLowerCase();
        const v = kidx >= 0 ? kv.slice(kidx + 1).trim() : '';
        if (k === 'domain' && v) domain = v;
        if (k === 'path' && v) path = v;
      }
      cookieMap.set(name, { name, value, domain, path });
    }
  }

  const cookies = Array.from(cookieMap.values());

  // origins: include originHeader and any localStorage items
  const origins = [
    {
      origin: originHeader,
      localStorage: Array.isArray(responseLocalStorage) ? responseLocalStorage.map(i => ({ name: i.name, value: i.value })) : []
    }
  ];

  return { cookies, origins };
}

function parseLocalStorage(storageRaw) {
  const arr = [];
  if (!storageRaw) return arr;
  try {
    if (Array.isArray(storageRaw)) {
      for (const it of storageRaw) {
        if (it && (it.name || it.key)) {
          arr.push({ name: it.name || it.key, value: it.value || '' });
        }
      }
    } else if (typeof storageRaw === 'object') {
      for (const k of Object.keys(storageRaw)) {
        arr.push({ name: k, value: storageRaw[k] });
      }
    } else if (typeof storageRaw === 'string') {
      // 尝试以 JSON 解析
      try {
        const j = JSON.parse(storageRaw);
        return parseLocalStorage(j);
      } catch (e) {
        // fallback: not parseable
      }
    }
  } catch (e) {}
  return arr;
}

async function syncToGist(payload) {
  const token = $.getdata(CONFIG.githubTokenKey);
  const gistId = $.getdata(CONFIG.gistIdKey);
  const filename = $.getdata(CONFIG.gistFilenameKey) || 'opapp_cookies.json';
  if (!token || !gistId) {
    log(`[${$.name}] 未配置 GitHub Token 或 Gist ID，跳过同步`);
    return false;
  }
  const content = JSON.stringify(payload, null, 2);
  const url = `https://api.github.com/gists/${gistId}`;
  const body = JSON.stringify({ files: { [filename]: { content: content } } });
  const req = {
    url: url,
    method: 'PATCH',
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'opapp-capture-script',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: body
  };
  return new Promise((resolve) => {
    if ($.isQuanX) {
      $task.fetch(req).then(resp => {
        log(`[${$.name}] Gist 同步响应: ${resp.statusCode}`);
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          log(`[${$.name}] Gist 同步成功`);
          resolve(true);
        } else {
          log(`[${$.name}] Gist 同步失败: ${resp.body}`);
          resolve(false);
        }
      }, err => {
        log(`[${$.name}] Gist 同步出错: ${err}`);
        resolve(false);
      });
    } else {
      log(`[${$.name}] 当前环境不支持网络请求`);
      resolve(false);
    }
  });
}

// note: no fallback to auth.json; only BoxJS config is used

// 兼容持久化写入
function setValue(val, key) {
  try {
    let ok = false;
    if (typeof $prefs !== 'undefined' && $prefs.setValueForKey) {
      ok = $prefs.setValueForKey(val, key);
    }
    if ((!ok || ok === undefined) && typeof $persistentStore !== 'undefined' && $persistentStore.write) {
      ok = $persistentStore.write(val, key);
    }
    return ok;
  } catch (e) {}
  return false;
}

// derive from dekt_cookie.js: Env polyfill minimal
function Env(t, e) {
  class s { constructor(t) { this.env = t } }
  return new class {
    constructor(t) {
      this.name = t;
      this.isQuanX = typeof $task !== 'undefined';
    }
    getdata(t) { return this.isQuanX ? $prefs.valueForKey(t) : ''; }
    setdata(t, e) { return this.isQuanX ? $prefs.setValueForKey(t, e) : ''; }
    msg(e = t, s = '', i = '', r) { this.isQuanX && $notify(e, s, i, r); }
    done(t = {}) { this.isQuanX && $done(t); }
  }(t, e);
}
