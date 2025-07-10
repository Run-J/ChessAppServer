const express = require('express');     // 引入 express 框架
const cors = require('cors');           // 引入 cors 中间件
const { Engine } = require('node-uci'); // 引入 stockfish 引擎（通过 node-uci 调用系统可执行文件）
const { WebSocketServer } = require('ws');
const http = require('http');

// 创建服务器实例，设置端口
const app = express();
const server = http.createServer(app);
const port = 3001;

app.use(cors());             // 允许跨域访问
app.use(express.json());     // 支持解析 JSON 格式的请求体

// ================= 引擎池配置 =================
const ENGINE_POOL_SIZE = 20; // 可根据机器性能调整并发量
const enginePool = [];       // 引擎池本体
const waitingQueue = [];     // 等待队列

// 初始化引擎池
(async () => {
    for (let i = 0; i < ENGINE_POOL_SIZE; i++) {
        const engine = new Engine('stockfish');
        await engine.init();
        await engine.isready();
        enginePool.push(engine);
    }
    console.log(`✅ 引擎池已初始化，大小：${ENGINE_POOL_SIZE}`);
})();

// 从池中借用引擎（如果没有可用引擎则等待
function acquireEngine() {
    return new Promise((resolve) => {
        if (enginePool.length > 0) {
            resolve(enginePool.pop());
        } else {
            waitingQueue.push(resolve);
        }
    });
}

// 将引擎归还到池中（如果有人在等待就立刻借出）
function releaseEngine(engine) {
    if (waitingQueue.length > 0) {
        const resolve = waitingQueue.shift();
        resolve(engine);
    } else {
        enginePool.push(engine);
    }
}

// ================= 路由：AI走法接口 =================
app.post('/best-move', async (req, res) => {
    const fen = req.body.fen;
    const aiLevel = req.body.level;

    if (!fen) {
        return res.status(400).json({ error: 'Missing FEN string' });
    }

    const engine = await acquireEngine(); // 从池中获取引擎
    const label = `Stockfish-depth-${aiLevel}-${Date.now()}-${Math.random()}`;

    try {
        await engine.position(fen);       // 设置当前棋盘状态（FEN）

        // 让引擎思考并返回最佳走法，depth 代表搜索深度
        console.time(label);
        const result = await engine.go({ depth: aiLevel });
        console.timeEnd(label);

        const bestMove = result.bestmove;
        res.json({ move: bestMove });
    } catch (err) {
        console.error('Stockfish error:', err);
        res.status(500).json({ error: 'Engine error' });
    } finally {
        releaseEngine(engine); // 用完引擎要归还！
    }
});


// =========== WebSocket 对战逻辑 =====
const wss = new WebSocketServer({ server });

const rooms = new Map(); // roomId -> [socketA, socketB]

wss.on('connection', (ws) => {
    console.log('新客户端已连接');

    ws.on('message', (msg) => {
        console.log('[服务器收到原始消息]', msg.toString());

        try {
            const data = JSON.parse(msg);
            const { type, roomId, payload } = data;

            switch (type) {
                case 'join':
                    if (!rooms.has(roomId)) rooms.set(roomId, []);
                    const player = rooms.get(roomId);

                    if (player.length >= 2) {
                        ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
                        return;
                    }

                    const color = player.length === 0 ? 'w' : 'b';
                    ws.color = color;
                    ws.roomId = roomId;

                    player.push(ws);
                    ws.send(JSON.stringify({ type: 'joined', color }));

                    console.log(`玩家加入房间 ${roomId}, 身份：${color}`);
                    break;

                case 'move':
                    console.log(`[MOVE] 来自房间 ${roomId} 的玩家下了一步: ${payload}`);
                    const others = rooms.get(roomId)?.filter((client) => client !== ws);
                    if (others?.length) {
                        others.forEach((client) =>
                            client.send(JSON.stringify({ type: 'opponentMove', payload }))
                        );
                    }
                    break;

                case 'leave':
                    const players = rooms.get(roomId);
                    if (players) {
                        rooms.set(roomId, players.filter((client) => client !== ws));
                        console.log(`玩家手动退出房间 ${roomId}`);
                        if (rooms.get(roomId)?.length === 0) {
                            rooms.delete(roomId);
                        }
                    }
                    break;

                default:
                    ws.send(JSON.stringify({ type: 'error', message: '未知消息类型' }));
            }
        } catch (err) {
            console.error('解析消息出错:', err);
        }
    });

    ws.on('close', () => {
        const roomId = ws.roomId;
        if (roomId && rooms.has(roomId)) {
            const updated = rooms.get(roomId)?.filter((client) => client !== ws);
            if (updated?.length === 0) {
                rooms.delete(roomId);
            } else {
                rooms.set(roomId, updated);
            }
            console.log(`玩家离开房间 ${roomId}`);
        }
    });
});

// 启动服务器
server.listen(port, () => {
    console.log(`🚀 Stockfish server is running at http://localhost:${port}`);
});