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
const ENGINE_POOL_SIZE = 1; // 可根据机器性能调整并发量
const enginePool = [];       // 引擎池本体
const waitingQueue = [];     // 等待队列

// 初始化引擎池
(async () => {
    for (let i = 0; i < ENGINE_POOL_SIZE; i++) {
        const engine = new Engine('stockfish');
        await engine.init();
        await engine.isready();
        enginePool.push(engine);

        // 👇 打印 Stockfish 子进程 PID（node-uci 内部有 child_process）
        const stockfishPid = engine.engineProcess?.pid;
        console.log(`♟️ 引擎 ${i} PID: ${stockfishPid}`);
    }
    
    console.log(`✅ 引擎池已初始化，大小：${ENGINE_POOL_SIZE}`);
    console.log("🧠 Node 后端 PID:", process.pid);
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

// roomId -> { players: [ws, ws], fen: string, turn: 'w' | 'b' }
const rooms = new Map();

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

wss.on('connection', (ws) => {
    console.log('新客户端已连接');

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            const { type, roomId, payload } = data;

            switch (type) {
                case 'join': {
                    if (!rooms.has(roomId)) {
                        rooms.set(roomId, {
                            players: [],
                            fen: INITIAL_FEN,
                            turn: 'w',
                        });
                    }

                    const room = rooms.get(roomId);
                    if (room.players.length >= 2) {
                        ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
                        return;
                    }

                    const color = room.players.length === 0 ? 'w' : 'b';
                    ws.color = color;
                    ws.roomId = roomId;
                    room.players.push(ws);

                    console.log(`发送给玩家的房间状态:`, room); // ✅ 调试输出

                    ws.send(JSON.stringify({
                        type: 'joined',
                        color,
                        fen: room.fen,
                        turn: room.turn,
                    }));

                    console.log(`玩家加入房间 ${roomId}, 颜色：${color}`);
                    break;
                }

                case 'move': {
                    const room = rooms.get(roomId);
                    if (!room) return;

                    const { from, to, newFen } = payload;
                    if (ws.color !== room.turn) {
                        ws.send(JSON.stringify({ type: 'error', message: '还没轮到你走' }));
                        return;
                    }

                    // 更新房间状态
                    console.log('服务器收到来自客户端的newFen在move:', newFen);
                    room.fen = newFen;
                    room.turn = room.turn === 'w' ? 'b' : 'w';

                    console.log(`[MOVE] ${ws.color} 在房间 ${roomId} 走棋: ${from} -> ${to}`);

                    // 广播给对手
                    room.players.forEach((client) => {
                        if (client !== ws) {
                            client.send(JSON.stringify({
                                type: 'opponentMove',
                                payload: {
                                    from,
                                    to,
                                    newFen: room.fen,
                                }
                            }));
                        }
                    });
                    break;
                }

                case 'leave': {
                    const room = rooms.get(roomId);
                    if (!room) return;

                    console.log(`一名玩家手动退出房间 ${roomId}`);
                    room.players = room.players.filter((p) => p !== ws);
                    if (room.players.length === 0) {
                        rooms.delete(roomId);
                        console.log(`房间 ${roomId} 已清空并删除`);
                    }
                    break;
                }

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
        const room = rooms.get(roomId);
        if (room) {
        room.players = room.players.filter(p => p !== ws);

        console.log(`一名玩家与房间 断开连接 ${roomId}`);

        // 如果房间没人了，清空整个房间
        if (room.players.length === 0) {
            rooms.delete(roomId);
            console.log(`房间 ${roomId} 已清空`);
        }
        }
    }
    });

});


// 启动服务器
server.listen(port, () => {
    console.log(`🚀 Stockfish server is running at http://localhost:${port}`);
});