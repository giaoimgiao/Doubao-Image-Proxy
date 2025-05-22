# 🍥 Doubao Image Proxy

> **A minimal self‑hosted Node.js service that turns Doubao AI’s *mysterious* SSE image stream into ordinary PNG/URL you can save or embed.**
> 完整抓包 + SSE 解析 + 跨格式转码，一次跑通！

---

## ✨  Features

| 功能                        | 说明                                                                     |
| ------------------------- | ---------------------------------------------------------------------- |
| 🎨 **Prompt → URL / PNG** | 提示词一键生成图片 URL，或本地 `pic.png`                                            |
| ♻️ **SSE 解析**             | 全量解析 `event: 2001/2003` 字段，自动捕获 `content_type 2074` 中的 `status = 2` 图链 |
| 🛟 **轮询兜底**               | 若 SSE 漏图，自动用 `node_id` 走官方 *message\_node\_info* 轮询接口重试                |
| 🪄 **格式兼容**               | 下载任意 `webp / avif / jpeg / png` 并用 **sharp** 转为 PNG                    |
| 🖥️ **前端零依赖**             | 自带超简 `index.html`，浏览器直接输入提示词即可                                         |

---

## 🚀 Quick Start

```bash
# 1. clone & install
npm i

# 2. 准备 .env（👇见下一节）
cp .env.example .env   # 然后填值

# 3. run
node server.js
# => http://localhost:3000  ✨
```

打开浏览器 → 输入提示词 → 等待控制台打印 `✅ 找到图片真实URL` → 成功！

---

## ⚙️  Required .env

```dotenv
COOKIE=xxx             # 全站 Cookie 字符串
X_MS_TOKEN=xxx         # 请求头 x-ms-token（SSE 必带）
DEVICE_ID=7507...      # 抓包得来的 device_id
TEA_UUID=7507...       # tea_uuid 同上
WEB_ID=7507...         # web_id
MS_TOKEN=lrmtE...      # querystring msToken
A_BOGUS=YfU5g...       # querystring a_bogus
ROOM_ID=7338...        # 浏览器 chat/{ROOM_ID} 里的数字
PORT=3000              # 可选，默认 3000
```

> **怎么抓？** 打开 `doubao.com`, F12 ➜ Network ➜ 过滤 `completion?` 请求，复制 *Request Headers* / *cookie* / URL 参数即可。

---

## 🧩  Project Structure

```
.
├── server.js      # 核心代理
├── index.html     # 超简前端
├── /public
│   └── pic.png    # 最新生成的 PNG
└── .env           # 私有令牌
```

---

## 🛠️  How It Works

1. **POST /generate** 接收提示词 → 转成官方聊天接口 payload
2. **SSE 流**：

   * 监听 `event_type 2001`，定位 `content_type 2074` 消息
   * 解析 `creations[]`，筛 `image.status === 2`
3. 若 SSE 漏图 → **轮询** `/message_node_info` 直到拿到 `status 2`
4. **下载** `image_ori ⇢ image_raw ⇢ thumb`（按优先级）
5. **sharp** 转 PNG → `public/pic.png`
6. 响应 `{ url: "/pic.png", urls: [..] }`

---

## 🐛  Troubleshooting

| 现象                            | 解决                                          |
| ----------------------------- | ------------------------------------------- |
| 控制台刷 `type=2001` 无 `status=2` | 确认 **COOKIE / TOKEN** 未过期；必要时清理 `.env` 重新抓包 |
| 轮询 5 次仍失败                     | Doubao 后端卡住了… 重发提示词或降级提示词内容                 |
| `sharp` 报格式不支持                | 自动 fallback 写原图；请升级 sharp 或安装系统依赖           |

---

## 📜  License

[MIT](LICENSE) – 不喜请自便。

> *Made with coffee ☕ + infinite patience.*
