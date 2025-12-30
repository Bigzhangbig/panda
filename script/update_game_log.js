/**
 * Quantumult X 脚本：拦截 POST 上传并返回虚假成功响应
 * 匹配地址：https://a.opapp.cn/icwm/game/api/update_game_log
 */

const TARGET_ID = "gamescpandamaleprops";
let requestBody = $request.body;

if (requestBody) {
    try {
        let obj = JSON.parse(requestBody);

        // 严格匹配条件：
        // 1. enter_id 匹配
        // 2. obj.point.score 存在
        // 3. typeof 检查确保 score 是数字 (number)，而不是字符串 ("7")
        if (obj.enter_id === TARGET_ID &&
            obj.point &&
            typeof obj.point.score === 'number') {

            console.log(`检测到目标 ID: ${TARGET_ID}, 分数为: ${obj.point.score}。正在拦截并返回伪造响应...`);

            // 直接通过 $done 返回 response 对象，请求将不会发出，App 会收到以下结果
            $done({
                response: {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        // 补全跨域支持，防止 App 或 WebView 报错
                        "Access-Control-Allow-Origin": "https://v.opapp.cn",
                        "Access-Control-Allow-Credentials": "true",
                        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                        "Access-Control-Allow-Headers": "*"
                    },
                    body: JSON.stringify({
                        "code": 1,
                        "msg": "记录成功"
                    })
                }
            });
        } else {
            // 如果不匹配（比如 id 不同或者 score 格式不对），则让请求正常发出
            console.log("请求数据不匹配拦截条件，正常放行。");
            $done({});
        }
    } catch (e) {
        console.log("解析请求体 JSON 失败: " + e);
        $done({});
    }
} else {
    $done({});
}