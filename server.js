const WebSocket = require('ws');
const http = require('http');

// ========== CẤU HÌNH ==========
const WS_URL = "wss://p6v9aiuvb60me.cq.qnwxdhwica.com/";
const PORT = 3001;

// ========== LƯU TRỮ ==========
let latestResult = null;
let lastSession = 0;
let ws = null;
let heartbeatInterval = null;
let watchdogTimer = null;
let lastResultTime = Date.now();
const WATCHDOG_SECONDS = 45;

const GAME_END_ROUTE = Buffer.from('mnsbgameend');
const GAME_START_ROUTE = Buffer.from('mnsbgamestart');

function findRouteEnd(buf, route) {
    for (let i = 4; i < buf.length - route.length; i++) {
        let found = true;
        for (let j = 0; j < route.length; j++) {
            if (buf[i + j] !== route[j]) { found = false; break; }
        }
        if (found) return i + route.length;
    }
    return -1;
}

function readVarint(bytes, offset) {
    let result = 0, shift = 0;
    while (offset < bytes.length) {
        let b = bytes[offset++];
        result |= (b & 0x7F) << shift;
        if (!(b & 0x80)) return { value: result, newOffset: offset };
        shift += 7;
    }
    return { value: result, newOffset: offset };
}

function getPomeloBody(bytes) {
    if (bytes.length < 5) return null;
    let type = bytes[0];
    if (type !== 4 && type !== 1) return null;
    let flag = bytes[4], msgType = flag >> 1, isCompressRoute = flag & 1, offset = 5;
    if (msgType === 2) {
        let res = 0, shift = 0;
        while (offset < bytes.length) {
            let b = bytes[offset++]; res |= (b & 0x7F) << shift;
            if (!(b & 0x80)) break; shift += 7;
        }
    } else if (msgType === 3) {
        if (isCompressRoute) offset += 2;
        else { let rLen = bytes[offset++]; offset += rLen; }
    }
    return offset < bytes.length ? offset : null;
}

function saveResult(session, dice1, dice2, dice3) {
    lastResultTime = Date.now();
    const total = dice1 + dice2 + dice3;
    let result = total > 10 ? "TÀI" : "XỈU";
    const isBao = (dice1 === dice2 && dice2 === dice3);
    if (isBao) result = "BÃO";

    const now = new Date();
    const vnTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (7 * 3600000));
    const timeString = vnTime.toLocaleString("vi-VN", { hour12: false });

    latestResult = {
        phien: session,
        xuc_xac_1: dice1,
        xuc_xac_2: dice2,
        xuc_xac_3: dice3,
        tong: total,
        ket_qua: result,
        thoi_gian: timeString,
        timestamp: Date.now()
    };

    console.log(`🎲 Phiên #${session} | ${dice1}-${dice2}-${dice3} | Tổng: ${total} | ${result}`);
}

function processPomeloPacket(pkgType, pack, ws) {
    if (pkgType === 4) {
        let protoStart = findRouteEnd(pack, GAME_END_ROUTE);
        if (protoStart < 0) protoStart = findRouteEnd(pack, GAME_START_ROUTE);

        if (protoStart > 0) {
            let pOffset = protoStart;
            let foundSession = 0;
            let diceArr = [];

            try {
                while (pOffset < pack.length) {
                    let info = readVarint(pack, pOffset);
                    if (info.newOffset >= pack.length) break;
                    let wireType = info.value & 7;
                    pOffset = info.newOffset;

                    if (wireType === 0) {
                        let vInfo = readVarint(pack, pOffset);
                        pOffset = vInfo.newOffset;
                        if (vInfo.value > 100000 && foundSession === 0) {
                            foundSession = vInfo.value;
                        }
                    } else if (wireType === 2) {
                        let lenInfo = readVarint(pack, pOffset);
                        let len = lenInfo.value;
                        pOffset = lenInfo.newOffset;
                        if (len === 3 && diceArr.length === 0) {
                            let v1 = pack[pOffset], v2 = pack[pOffset + 1], v3 = pack[pOffset + 2];
                            if (v1 >= 1 && v1 <= 12 && v2 >= 1 && v2 <= 12 && v3 >= 1 && v3 <= 12) {
                                let doubled = (v1 % 2 === 0 && v2 % 2 === 0 && v3 % 2 === 0 && v1 <= 12 && v2 <= 12 && v3 <= 12);
                                diceArr = doubled ? [v1 / 2, v2 / 2, v3 / 2] : [v1, v2, v3];
                            }
                        }
                        pOffset += len;
                    } else if (wireType === 1) { pOffset += 8; }
                    else if (wireType === 5) { pOffset += 4; }
                    else break;
                }
            } catch (e) { }

            if (foundSession > 0 && diceArr.length === 3) {
                let sNum = foundSession > 500000 ? Math.round(foundSession / 2) : foundSession;
                if (sNum !== lastSession) {
                    lastSession = sNum;
                    saveResult(sNum, diceArr[0], diceArr[1], diceArr[2]);
                }
                return;
            }
        }

        let coreOffset = getPomeloBody(pack);
        if (coreOffset) {
            let pOffset = coreOffset;
            let foundSession = 0;
            let d1 = 0, d2 = 0, d3 = 0;

            while (pOffset < pack.length) {
                let info = readVarint(pack, pOffset);
                let tag = info.value >> 3;
                let wireType = info.value & 7;
                pOffset = info.newOffset;

                if (wireType === 0) {
                    let vInfo = readVarint(pack, pOffset);
                    pOffset = vInfo.newOffset;
                    if (tag === 7 && vInfo.value > 100000) {
                        foundSession = (vInfo.value / 2);
                    }
                } else if (wireType === 2) {
                    let lenInfo = readVarint(pack, pOffset);
                    let length = lenInfo.value;
                    pOffset = lenInfo.newOffset;
                    if (tag === 4 && length === 3) {
                        let v1 = pack[pOffset];
                        let v2 = pack[pOffset + 1];
                        let v3 = pack[pOffset + 2];
                        if (v1 <= 12 && v2 <= 12 && v3 <= 12) {
                            d1 = v1 / 2; d2 = v2 / 2; d3 = v3 / 2;
                        }
                    }
                    pOffset += length;
                } else if (wireType === 1) pOffset += 8;
                else if (wireType === 5) pOffset += 4;
                else break;
            }

            if (foundSession > 0 && d1 > 0 && d2 > 0 && d3 > 0) {
                let realSession = foundSession - 1;
                if (realSession !== lastSession) {
                    lastSession = realSession;
                    saveResult(realSession, d1, d2, d3);
                }
            }
        }
    }
}

function connect() {
    console.log("🌐 Đang kết nối WebSocket Bàn Xanh...");

    const options = {
        rejectUnauthorized: false,
        headers: {
            'Origin': 'https://68gbvn88.bar',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'vi-VN,vi;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        }
    };

    ws = new WebSocket(WS_URL, options);

    ws.on('open', () => {
        console.log("✅ Đã kết nối!");
        ws.send(Buffer.from('AQAAcnsic3lzIjp7InBsYXRmb3JtIjoianMtd2Vic29ja2V0IiwiY2xpZW50QnVpbGROdW1iZXIiOiIwLjAuMSIsImNsaWVudFZlcnNpb24iOiIwYTIxNDgxZDc0NmY5MmY4NDI4ZTFiNmRlZWI3NmZlYSJ9fQ==', 'base64'));
    });

    let isHandshakeDone = false;

    ws.on('message', (data) => {
        try {
            const buffer = new Uint8Array(data);
            let offset = 0;
            while (offset < buffer.length) {
                let pkgType = buffer[offset];
                let length = (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
                let pack = buffer.slice(offset, offset + 4 + length);
                offset += 4 + length;

                if (pkgType === 1) {
                    if (!isHandshakeDone) {
                        isHandshakeDone = true;
                        console.log("🤝 Handshake thành công!");
                        ws.send(Buffer.from([0x02, 0x00, 0x00, 0x00]));

                        if (heartbeatInterval) clearInterval(heartbeatInterval);
                        heartbeatInterval = setInterval(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(Buffer.from([0x03, 0x00, 0x00, 0x00]));
                            }
                        }, 3000);

                        console.log("🔑 Đang gửi lệnh vào bàn...");

                        setTimeout(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(Buffer.from('BAAATQEnAAEIAhDKARpAOTViOTIyMTJhNGE4NDgzZGI2NGQ0N2JlYWE0Yjg1NWUxZGIyNjU0N2IzNTc0YzRmODg5MTU3OGU2ZjRjOWIzZkIA', 'base64'));
                            }
                        }, 500);

                        setTimeout(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(Buffer.from('BAAAKwAoKG1uc2hhaWJhby5tbnNoYWliYW9oYW5kbGVyLmVudGVyZ2FtZXJvb20=', 'base64'));
                            }
                        }, 1000);

                        setTimeout(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(Buffer.from('BAAAKgApJ21uc2hhaWJhby5tbnNoYWliYW9oYW5kbGVyLmdldGdhbWVzY2VuZQ==', 'base64'));
                            }
                        }, 1500);

                        setTimeout(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(Buffer.from('BAAAKgAqJ21uc2hhaWJhby5tbnNoYWliYW9oYW5kbGVyLnJlcXBva2VyaW5mbw==', 'base64'));
                            }
                        }, 2000);

                        setTimeout(() => {
                            lastResultTime = Date.now();
                            if (watchdogTimer) clearInterval(watchdogTimer);
                            watchdogTimer = setInterval(() => {
                                const elapsed = Math.round((Date.now() - lastResultTime) / 1000);
                                if (elapsed >= WATCHDOG_SECONDS) {
                                    console.log(`⏰ ${elapsed}s không có kết quả! Reconnect...`);
                                    clearInterval(watchdogTimer);
                                    watchdogTimer = null;
                                    if (ws) ws.terminate();
                                }
                            }, 5000);
                        }, 3000);
                    }
                } else if (pkgType === 3) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(Buffer.from([0x03, 0x00, 0x00, 0x00]));
                    }
                } else if (pkgType === 5) {
                    console.log("🛑 Bị kick khỏi server!");
                } else if (pkgType === 4) {
                    processPomeloPacket(pkgType, pack, ws);
                }
            }
        } catch (e) {
            console.error("Lỗi xử lý packet:", e.message);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`❌ Mất kết nối (${code}). Reconnect sau 3 giây...`);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (watchdogTimer) clearInterval(watchdogTimer);
        setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
        console.error("Lỗi WebSocket:", err.message);
    });
}

// ========== HTTP API SERVER ==========
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    
    if (req.url === '/api/68/xanh') {
        res.writeHead(200);
        res.end(JSON.stringify(latestResult || { error: "Chưa có dữ liệu" }, null, 2));
    } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found. Use /api/68/xanh" }));
    }
});

// ========== KHỞI ĐỘNG ==========
console.clear();
console.log("🎲 68GB BÀN XANH API");
console.log(`🌐 http://localhost:${PORT}/api/68/xanh`);
console.log("==========================================\n");

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server chạy trên port ${PORT}`);
    connect();
});
