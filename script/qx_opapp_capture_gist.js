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
  uaKey: 'opapp_ua',
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

  // --- 逻辑 2：修改有效期 (响应阶段) ---
  if (typeof $response !== "undefined") {
    let setCookie = $response.headers["Set-Cookie"] || $response.headers["set-cookie"];
    if (setCookie && setCookie.indexOf("PHPSESSID") != -1) {
      // 核心修改：通过正则匹配，在 path=/ 后面强行插入 Expires 属性
      // 将原本的会话 Cookie 伪装成持久 Cookie
      let longLiveCookie = setCookie.replace(/path=\/;/gi, "path=/; Expires=Sat, 26 Dec 2026 18:00:00 GMT;");
      $done({
        headers: {
          ...$response.headers,
          "Set-Cookie": longLiveCookie // 返回给小程序的 headers 已被篡改
        }
      });
      return;
    }
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
  // User-Agent
  const userAgent = reqHeaders['User-Agent'] || reqHeaders['user-agent'] || '';

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
  if (userAgent) setValue(userAgent, CONFIG.uaKey);

  // 读取 gist 以对比
  const gistResult = await getGistOpapp();
  const gistData = gistResult && gistResult.ok ? (gistResult.data || null) : null;
  if (gistResult && gistResult.failed) {
    $.msg($.name, '获取 Gist 失败', gistResult.message || '无法获取远端数据，请检查配置或网络');
  }

  // 验证并解析 Cookie 有效期
  const validation = validateAndParseCookies(cookie, setCookieHeader);

  // 构造本地最新 payload
  const localPayload = await buildPayload({ 
      requestCookie: cookie, 
      setCookieHeader, 
      originHeader: origin,
      tokenExpire: validation.tokenExpire,
      userAgent
  });
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
  if (!ok) safeNotify($.name, '凭证更新失败', '同步到 Gist 失败，请查看日志');
  else log(`[${$.name}] 已上传Gist: ${ok}`);
}

function validateAndParseCookies(cookieStr, setCookieHeader) {
  const result = { valid: false, missing: [], tokenExpire: 0 };
  if (!cookieStr) {
    result.missing.push('CookieString');
    return result;
  }
  
  // 检查关键字段
  const hasPhpSessId = /PHPSESSID=/i.test(cookieStr) || (setCookieHeader && /PHPSESSID=/i.test(String(setCookieHeader)));
  const hasToken = /token=/i.test(cookieStr) || (setCookieHeader && /token=/i.test(String(setCookieHeader)));

  if (!hasPhpSessId) result.missing.push('PHPSESSID');
  if (!hasToken) result.missing.push('token');

  if (result.missing.length === 0) result.valid = true;

  // 解析 token 有效期 (从 Set-Cookie 中查找)
  if (setCookieHeader) {
    const scs = Array.isArray(setCookieHeader) ? setCookieHeader : String(setCookieHeader).split(/,(?=[^;]+=)/);
    for (const sc of scs) {
      if (sc.trim().startsWith('token=')) {
        const maxAgeMatch = sc.match(/Max-Age=(\d+)/i);
        if (maxAgeMatch) {
          const maxAge = parseInt(maxAgeMatch[1], 10);
          result.tokenExpire = Date.now() + (maxAge * 1000);
        } else {
            // 如果没有 Max-Age，尝试 Expires
            const expiresMatch = sc.match(/Expires=([^;]+)/i);
            if (expiresMatch) {
                const expires = Date.parse(expiresMatch[1]);
                if (!isNaN(expires)) result.tokenExpire = expires;
            }
        }
      }
    }
  }
  // 如果没有从 Set-Cookie 解析到过期时间，且 Cookie 中有 token，默认给一个较短的有效期或者不更新
  if (!result.tokenExpire && hasToken) {
     // 无法准确判断，不设置，由任务脚本自行处理或默认不过期
  }

  return result;
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
  // opts: { requestCookie, setCookieHeader, responseLocalStorage, originHeader, userAgent }
  const requestCookie = opts.requestCookie || '';
  const setCookieHeader = opts.setCookieHeader || null;
  const responseLocalStorage = opts.responseLocalStorage || [];
  const originHeader = opts.originHeader || 'https://g.opapp.cn';
  const userAgent = opts.userAgent || '';

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
      // 检查是否需要应用 "强制延期" 逻辑 (针对 PHPSESSID)
      let finalSc = sc;
      if (sc.indexOf("PHPSESSID") != -1 && sc.indexOf("Expires=") == -1 && sc.indexOf("Max-Age=") == -1) {
          // 模拟 Logic 2 的行为：如果原始 Set-Cookie 没有过期时间，强制加上 2026 年
          finalSc = sc.replace(/path=\/;/gi, "path=/; Expires=Sat, 26 Dec 2026 18:00:00 GMT;");
      }

      const parts = finalSc.split(/;\s*/).filter(Boolean);
      if (parts.length === 0) continue;
      const nv = parts[0];
      const idx = nv.indexOf('=');
      if (idx < 0) continue;
      const name = nv.slice(0, idx).trim();
      const value = nv.slice(idx + 1).trim();
      let domain = 'g.opapp.cn';
      let path = '/';
      let expires = null;
      let maxAge = null;

      for (let i = 1; i < parts.length; i++) {
        const kv = parts[i];
        const kidx = kv.indexOf('=');
        const k = kidx >= 0 ? kv.slice(0, kidx).trim().toLowerCase() : kv.trim().toLowerCase();
        const v = kidx >= 0 ? kv.slice(kidx + 1).trim() : '';
        if (k === 'domain' && v) domain = v;
        if (k === 'path' && v) path = v;
        if (k === 'expires' && v) expires = v;
        if (k === 'max-age' && v) maxAge = v;
      }
      
      const cookieObj = { name, value, domain, path };
      if (expires) cookieObj.expires = expires;
      if (maxAge) cookieObj.maxAge = maxAge;
      
      cookieMap.set(name, cookieObj);
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

  // 拼接 opapp_cookie
  const opapp_cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  // 自动提取 csrf/token
  let opapp_csrf = '';
  for (const c of cookies) {
    if (c.name.toLowerCase().includes('csrf')) opapp_csrf = c.value;
    if (c.name.toLowerCase() === 'token') opapp_csrf = c.value;
  }
  // 兼容 header/body 直接传入
  if (opts && opts.csrf) opapp_csrf = opts.csrf;
  
  // 提取传入的 tokenExpire (如果有)
  let opapp_token_expire = 0;
  if (opts && opts.tokenExpire) opapp_token_expire = opts.tokenExpire;

  return { cookies, origins, opapp_cookie, opapp_csrf, userAgent, opapp_token_expire };
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
