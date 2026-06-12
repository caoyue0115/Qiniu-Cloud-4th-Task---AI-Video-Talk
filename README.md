# AI 视觉对话助手（面向视障人士）

第 4 期七牛云暑期实训项目 · AI 视频对话助手赛题

让视障人士通过**语音对话**让 AI 帮他们「看」世界：识别物体、辨别颜色、阅读文字、描述场景、识别验证码。

- **技术栈**：Python + Gradio + 阿里云百炼 DashScope（通义千问 VL / Paraformer ASR / CosyVoice TTS）
- **核心闭环**：语音输入 → 意图路由 → 视觉理解 / 端侧 CV → 语音输出
- **成本控制**：端云协同 + 模型分级路由 + 缓存 + 图像压缩，单次成本较纯云端降约 62.5%

## 快速开始

```bash
pip install -r requirements.txt
cp .env.example .env        # 然后填入你的 DASHSCOPE_API_KEY
python app.py
```

浏览器会自动打开 `http://127.0.0.1:7860`。

> API Key 申请：https://bailian.console.aliyun.com/ （阿里云百炼，有免费额度）

## 项目结构

```
app.py                  主程序（Gradio 界面 + 编排闭环）
modules/
  ├─ speech.py          ASR 语音识别 + TTS 语音合成
  ├─ vision.py          通义千问 VL 图像理解（max/plus 双档）
  ├─ color_detector.py  端侧 HSV 颜色识别（零 API 成本）
  ├─ router.py          意图路由（端侧/小模型/大模型）
  ├─ cache.py           精确缓存层
  ├─ cost_tracker.py    成本追踪与可视化
  └─ context.py         多轮对话上下文
utils/
  ├─ config.py          配置与密钥读取
  └─ image_utils.py     图像压缩/编码
设计文档.md             完整设计文档（用户故事、成本控制策略）
```

## 设计文档

详见 [`设计文档.md`](设计文档.md)，包含：

1. 计划实现哪些用户故事、最终实现了哪些
2. 想到了哪些控制运营成本的技巧、实际采用了哪些
