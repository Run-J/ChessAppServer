const express = require('express');     // 引入 express 框架
const cors = require('cors');           // 引入 cors 中间件
const { Engine } = require('node-uci'); // 引入 stockfish 引擎（通过 node-uci 调用系统可执行文件）

// 创建服务器实例，设置端口
const app = express();
const port = 3001;

// 中间件是对请求对象 req 和响应对象 res 进行处理的函数。可以链式调用。
app.use(cors());            // 第三方中间件：允许跨域访问
app.use(express.json());    // 内置中间件：支持解析 JSON 格式的请求体

// 定义服务端如何响应客户端请求
// POST /best-move - 获取 AI 走法; 响应前端发来的 /best-move 请求
app.post('/best-move', async (req, res) => {

    // 从请求体中提取 FEN 字符串 和 期待的 AI 难度等级
    const fen = req.body.fen;
    const aiLevel = req.body.level;

    if (!fen) {
        return res.status(400).json({ error: 'Missing FEN string' });
    }

    // 启动引擎（注意：通过 node-uci 调用系统已安装的 Stockfish 引擎
    const engine = new Engine('stockfish');

    try {
        // 按顺序发送 UCI 协议命令给引擎
        await engine.init();              // 初始化引擎
        await engine.isready();           // 等待引擎准备好
        await engine.position(fen);       // 设置当前棋盘状态（FEN）

        // 让引擎思考并返回最佳走法，depth 代表搜索深度
        const result = await engine.go({ depth: aiLevel });

        // 提取并响应最佳走法
        const bestMove = result.bestmove;
        res.json({ move: bestMove });

    } catch (err) {
        // 如果出错，打印错误并返回 500 响应
        console.error('Stockfish error:', err);
        res.status(500).json({ error: 'Engine error' });

    } finally {
        // 不管成功与否，都要退出引擎，释放资源
        await engine.quit();
    }
});

// 启动服务器
app.listen(port, () => {
    console.log(`Stockfish server is running at http://localhost:${port}`);
});