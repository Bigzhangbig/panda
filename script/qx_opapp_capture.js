/*
qx_opapp_capture.js
用于 Quantumult X / Surge / Loon
抓取 opapp 的 Cookie 与 X-CSRF-Token，并保存到持久存储
规则示例 (Quantumult X):
  [rewrite_local]
  ^https?:\/\/g\.opapp\.cn\/pet\/api\/(login|init)\.php url script-request-body,qx_opapp_capture.js
或分别使用 script-request-header 与 script-response-body
*/

const setValue = (val, key) => {
  try {
    if (typeof $prefs !== 'undefined' && $prefs.setValueForKey) {
      $prefs.setValueForKey(val, key);
      return true;
    }
    if (typeof $persistentStore !== 'undefined' && $persistentStore.write) {
      $persistentStore.write(val, key);
      return true;
    }
  } catch (e) {}
  return false;
};

try {
  if (typeof $request !== 'undefined' && $request) {
    // 在请求阶段抓取请求头的 Cookie 与 X-CSRF-Token
    let req = $request.headers || {};
    let cookie = req['Cookie'] || req['cookie'];
    let csrf = req['X-CSRF-Token'] || req['x-csrf-token'];
    if (cookie) setValue(cookie, 'opapp_cookie');
    if (csrf) setValue(csrf, 'opapp_csrf');
  }

  if (typeof $response !== 'undefined' && $response) {
    // 在响应阶段尝试从响应体中解析 csrf_token 字段
    let body = $response.body || '';
    try {
      let j = JSON.parse(body);
      if (j && (j.csrf_token || j.csrf || j.token)) {
        setValue(j.csrf_token || j.csrf || j.token, 'opapp_csrf');
      }
    } catch (e) {
      // 响应可能包含多段或非纯 JSON，尝试正则匹配
      let m = body.match(/csrf_token["']?\s*[:=]\s*["']?([0-9a-f|]+)["']?/i);
      if (m && m[1]) setValue(m[1], 'opapp_csrf');
    }
  }
} catch (e) {
  // ignore
}

if (typeof $done === 'function') $done({});
