# 👁️ AI 视觉对话助手 — 你的眼睛，随时在线

> 第 4 期七牛云暑期实训项目 · **AI 视频对话助手**赛题
> 面向 **1731 万中国视障人士**的公益向 AI 应用：只用「说话」，就能让 AI 帮他们**看**世界。

让视障人士通过纯语音对话，让 AI 帮忙**认物、辨色、读字、导航避障、阅读、陪聊**——随时可用，无需求人。

---

## 🌐 在线体验（评委直接点开）

### 👉 在线 Demo：**https://talk.ccyand.top:8443**

### 🎬 演示视频：**[给我光明 — 面向视障人士的 AI 视觉对话助手（Bilibili）](https://www.bilibili.com/video/BV1MVJp68EcK/)**

打开即是展示页：右侧手机样机里运行**真实 App**（点「接通」体验），左侧实时显示成本、对话记录、四大模式、端云协同架构。

> ⚠️ **说明**：在线 Demo 部署在云服务器 + cloudflared 隧道上，服务器持续运行期间可访问；**若链接失效，请观看上方演示视频，或按下方「本地运行」自行启动。**

📱 **手机访问增加切换镜头功能**：用手机浏览器打开同一地址，允许摄像头/麦克风，体验广角长焦镜头切换。

---

## ✨ 核心亮点

| 亮点 | 说明 |
|------|------|
| 🎙️ **纯语音交互** | 无需看屏、无需打字；说话即用，全程语音引导 + 震动反馈 |
| 🧭 **四大智能模式** | 问答 / 导航避障 / 文字朗读 / 聊天陪伴，一句话语音切换 |
| ⚡ **双对话引擎** | **稳定模式**（准确省成本）+ **实时模式**（Qwen-Omni 端到端秒回，首字约 0.3s） |
| 💰 **端云协同省成本** | 端侧实时检测 + 云端语义理解，单次成本较纯云端**降约 62%** |
| ♿ **全程无障碍设计** | 语音/点击打断、语速调节、再说一遍、屏幕阅读器适配、大按钮、无打字框 |
| 🇨🇳 **国产化全栈** | 阿里云百炼通义千问：VL 视觉 / Paraformer 识别 / CosyVoice 合成 / Omni 实时 |

---

## 🏗️ 系统架构

```
┌─────────────────── 浏览器（手机/电脑） ───────────────────┐
│  摄像头 + 麦克风 + 扬声器                                    │
│  · VAD 静音自动触发   · TensorFlow.js COCO-SSD 端侧实时检测  │
│  · Web Audio 16k 采样  · 语音/点击打断  · 震动反馈           │
└───────────────┬───────────────────────┬───────────────────┘
        稳定模式 │ HTTP/SSE          实时模式 │ WebSocket
                ▼                           ▼
┌─────────────────────── FastAPI 服务端 ───────────────────────┐
│  意图路由（端侧/小模型/大模型/模式指令）                       │
│  ├─ Paraformer 语音识别(ASR)                                  │
│  ├─ 通义千问 VL 视觉理解（plus 小模型 / max 大模型）           │
│  ├─ CosyVoice 语音合成(TTS)                                   │
│  ├─ Qwen-Omni-Realtime 中继（实时模式：音视频流 ↔ 语音流）     │
│  └─ 缓存 · 成本追踪 · 对话记忆                                 │
└──────────────────────────────────────────────────────────────┘
```

---

## 🧩 两种对话模式

| | 🛡️ 稳定模式 | ⚡ 实时模式 |
|---|---|---|
| 引擎 | Paraformer + 千问 VL + CosyVoice 三段式 | Qwen-Omni-Realtime 端到端 |
| 响应 | 约 3–5 秒 | **首字约 0.3 秒** |
| 优势 | 识别准、省成本、弱网更稳、四大模式齐全 | 像打电话一样自然、语义打断、长上下文 |
| 适合 | 认物辨色、阅读、导航等精确任务 | 连续对话、陪聊、需要秒回的实时交流 |
| 计费 | 按次（端云协同，单次约 ¥0.008–0.03） | 按 token（约 ¥0.1/分钟，前 90 天 100 万 token 免费） |

---

## 🚀 本地运行

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 配置密钥：复制 .env.example 为 .env，填入阿里云百炼 API Key
#    DASHSCOPE_API_KEY=sk-xxxx
#    申请：https://bailian.console.aliyun.com/ （有免费额度）

# 3. 启动服务
python server.py
#    本地访问 http://127.0.0.1:8000
```

### 🔑 关于 API Key（重要）

- **用上方在线体验链接的评委：无需任何 Key**，链接已用作者的 key 跑在服务器上，开箱即用。
- **自己 clone 本地运行**：需在 `.env` 填入自己的 `DASHSCOPE_API_KEY`（[阿里云百炼](https://bailian.console.aliyun.com/) 注册，有免费额度）。
  - **稳定模式**：普通 key + 免费额度即可（用到 千问 VL / Paraformer / CosyVoice）。
  - **实时模式**：需 key 额外**开通 [Qwen-Omni-Realtime](https://help.aliyun.com/zh/model-studio/realtime)**（仅北京/新加坡区）。未开通时实时模式不可用，**稳定模式不受影响、照常使用**。

### 让手机/他人访问（cloudflared 隧道）

```bash
# 安装 cloudflared 后：
cloudflared tunnel --url http://127.0.0.1:8000
# 会输出一个 https://xxx.trycloudflare.com 公网地址，手机浏览器打开即可
```

> 摄像头/麦克风需要 **HTTPS**，故手机访问必须用隧道的 https 地址（localhost 本机除外）。

---

## 📁 项目结构

```
server.py                FastAPI 主服务（路由 + Omni 实时中继）
static/
  ├─ showcase.html/js    展示网站（评委入口，嵌入真实 App）
  ├─ index.html          通话式 App（开机星空画面 + 通话界面）
  ├─ app.js              前端核心：VAD/双模式/无障碍/端侧检测/播报
  ├─ vendor/             TensorFlow.js + COCO-SSD（本地托管，国内可用）
  └─ models/coco-ssd/    端侧检测模型权重
modules/
  ├─ vision.py           通义千问 VL 图像理解（plus/max 双档 + 流式）
  ├─ speech.py           Paraformer 识别 + CosyVoice 合成
  ├─ mode_prompts.py     四大模式 + 实时模式的「盲人优化」提示词与意图识别
  ├─ color_detector.py   端侧 HSV 颜色识别（零 API 成本）
  ├─ router.py           意图路由（端侧/小模型/大模型）
  ├─ cache.py            缓存层  ├─ cost_tracker.py 成本追踪  ├─ context.py 对话记忆
utils/  ├─ config.py 配置  └─ image_utils.py 图像压缩
设计文档.md              产品设计文档（用户故事 / 无障碍设计 / 成本控制）
技术实现路线.md          技术实现路线（架构 / 选型 / 分阶段实现）
CREDITS.md               第三方开源参考与致谢
```

---

## 📚 文档

- **[设计文档.md](设计文档.md)** — 产品经理视角：目标用户、用户故事（计划 vs 实现）、**面向视障的专门设计**、**运营成本控制**、关键决策。
- **[技术实现路线.md](技术实现路线.md)** — 技术选型、系统架构、分阶段实现、端云协同与实时模式的实现细节。
- **[CREDITS.md](CREDITS.md)** — 导航思路参考开源项目 [OpenAIglasses_for_Navigation](https://github.com/AI-FanGe/OpenAIglasses_for_Navigation)（MIT）等。

---

> 本项目为学习/竞赛用途，导航为「辅助提示」级，非医疗级避障。配图为公益学习展示，版权归原作者所有。
