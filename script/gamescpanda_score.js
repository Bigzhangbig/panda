// Quantumult X Rewrite Script
// 
// [rewrite_local]
// ^https:\/\/a\.opapp\.cn\/icwm\/game\/api\/get_coupon_random url script-request-body script/gamescpanda_score.js
// 
// [mitm]
// hostname = a.opapp.cn

let body = $request.body;

try {
    let obj = JSON.parse(body);

    if (obj.enterId === "gamescpandascore2" && obj.point) {
        // Generate random score between 9000 and 10000
        // Math.random() * (max - min + 1) + min
        const randomScore = Math.floor(Math.random() * (10000 - 9000 + 1)) + 9000;
        
        obj.point.score = randomScore;
        
        console.log(`gamescpanda_score: 匹配到 enterId=gamescpandascore2, 分数已修改为 ${randomScore}`);
        
        body = JSON.stringify(obj);
    }
} catch (e) {
    console.log("gamescpanda_score error: " + e);
}

$done({body});
