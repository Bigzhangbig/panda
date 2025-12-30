/**
 * Quantumult X 脚本：指定 ID 修改游戏任务状态
 * 匹配：https://a.opapp.cn/icwm/game/info/coupon_info_enter
 */

// 定义需要匹配的目标 ID
const TARGET_ID = "gamescpandamalemission";

let body = $response.body;

if (!body) {
    $done({});
} else {
    try {
        let obj = JSON.parse(body);

        // 1. 检查 data 对象中是否包含目标 ID
        if (obj.data && obj.data[TARGET_ID]) {
            
            // 2. 确保 showModal.mission 结构存在
            if (obj.showModal && obj.showModal.mission) {
                
                // 修改 count 为 1
                obj.showModal.mission.count = 1;

                // 3. 遍历修改 props 数组中的所有 num 为 2
                if (Array.isArray(obj.showModal.mission.props)) {
                    obj.showModal.mission.props.forEach(item => {
                        item.num = 2;
                    });
                }
                
                console.log(`成功匹配 ID: ${TARGET_ID}，已修改数据`);
            }
        } else {
            console.log(`未发现匹配 ID: ${TARGET_ID}，跳过修改`);
        }

        $done({ body: JSON.stringify(obj) });
    } catch (e) {
        console.log("解析响应体失败: " + e);
        $done({});
    }
}