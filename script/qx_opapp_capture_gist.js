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
  gistFilenameKey: 'opapp_gist_filename'
};

(async () => {
  try {
    await handleCapture();
  } catch (e) {
    console.log(`[${$.name}] 执行异常: ${e}`);
  }
  $done({});
})();

async function handleCapture() {
  // 保存到本地持久化（兼容 QX/Surge/Loon）
  let req = (typeof $request !== 'undefined' && $request) ? $request : null;
  let resp = (typeof $response !== 'undefined' && $response) ? $response : null;

  // Capture request headers
  if (req) {
    const headers = req.headers || {};
    const cookie = headers['Cookie'] || headers['cookie'];
    const csrf = headers['X-CSRF-Token'] || headers['x-csrf-token'];
    const origin = headers['Origin'] || headers['origin'] || headers['Referer'] || headers['referer'] || 'https://g.opapp.cn';
    if (cookie) setValue(cookie, CONFIG.cookieKey);
    if (csrf) setValue(csrf, CONFIG.csrfKey);

    // 尝试收集 Set-Cookie（若存在于请求阶段则忽略，此处以响应阶段为主）
    const reqSetCookie = headers['Set-Cookie'] || headers['set-cookie'] || null;

    if (cookie) {
      // 构造 JSON 并尝试上传到 Gist
      const payload = await buildPayload({ requestCookie: cookie, setCookieHeader: reqSetCookie, originHeader: origin });
      await syncToGist(payload);
    }
  }

  // Capture response body for csrf
  if (resp) {
    let body = resp.body || '';
    const respHeaders = resp.headers || {};
    // 优先从响应体中解析 csrf
    try {
      const j = JSON.parse(body);
      const csrfVal = j.csrf_token || j.csrf || j.token;
      if (csrfVal) setValue(csrfVal, CONFIG.csrfKey);

      // 如果响应包含 localStorage 结构或类似结构，尝试提取
      if (j && (j.localStorage || j.localstorage || j.storage)) {
        const storageRaw = j.localStorage || j.localstorage || j.storage;
        const origin = (req && (req.headers && (req.headers['Origin'] || req.headers['origin']))) || 'https://g.opapp.cn';
        const localArr = parseLocalStorage(storageRaw);
        if (localArr.length > 0) {
          const payload = await buildPayload({ responseLocalStorage: localArr, setCookieHeader: respHeaders['Set-Cookie'] || respHeaders['set-cookie'], originHeader: origin });
          await syncToGist(payload);
        }
      }
    } catch (e) {
      const m = body.match(/csrf_token["']?\s*[:=]\s*["']?([0-9a-f|]+)["']?/i);
      if (m && m[1]) setValue(m[1], CONFIG.csrfKey);
    }

    // 如果响应头包含 Set-Cookie，则解析并上传（以覆盖 request 阶段简单 cookie）
    try {
      const setCookieHeader = respHeaders['Set-Cookie'] || respHeaders['set-cookie'] || null;
      if (setCookieHeader) {
        const origin = (req && (req.headers && (req.headers['Origin'] || req.headers['origin']))) || 'https://g.opapp.cn';
        const payload = await buildPayload({ setCookieHeader: setCookieHeader, originHeader: origin });
        await syncToGist(payload);
      }
    } catch (e) {}
  }
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
  // 获取 token / gist id / filename: 优先 BoxJS -> auth.json raw
  const boxToken = $.getdata(CONFIG.githubTokenKey);
  const boxGistId = $.getdata(CONFIG.gistIdKey);
  const boxFilename = $.getdata(CONFIG.gistFilenameKey) || 'opapp_cookies.json';

  let token = boxToken;
  let gistId = boxGistId;
  let filename = boxFilename;

  if (!token || !gistId) {
    console.log(`[${$.name}] 未配置 GitHub Token 或 Gist ID（仅使用 BoxJS 配置），跳过同步`);
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
        console.log(`[${$.name}] Gist 同步响应: ${resp.statusCode}`);
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          console.log(`[${$.name}] Gist 同步成功`);
          resolve(true);
        } else {
          console.log(`[${$.name}] Gist 同步失败: ${resp.body}`);
          resolve(false);
        }
      }, err => {
        console.log(`[${$.name}] Gist 同步出错: ${err}`);
        resolve(false);
      });
    } else {
      console.log(`[${$.name}] 当前环境不支持网络请求`);
      resolve(false);
    }
  });
}

// note: no fallback to auth.json; only BoxJS config is used

// 兼容持久化写入
function setValue(val, key) {
  try {
    if (typeof $prefs !== 'undefined' && $prefs.setValueForKey) {
      return $prefs.setValueForKey(val, key);
    }
    if (typeof $persistentStore !== 'undefined' && $persistentStore.write) {
      return $persistentStore.write(val, key);
    }
  } catch (e) {}
  return false;
}

// derive from dekt_cookie.js: Env polyfill minimal
function Env(t, e) { class s { constructor(t) { this.env = t } } return new class { constructor(t) { this.name = t, this.isQuanX = typeof $task !== 'undefined' } getdata(t) { return this.isQuanX ? $prefs.valueForKey(t) : '' } setdata(t, e) { return this.isQuanX ? $prefs.setValueForKey(t, e) : '' } msg(e = t, s = '', i = '', r) { this.isQuanX && $notify(e, s, i, r) } done(t = {}) { this.isQuanX && $done(t) } }(t, e)
