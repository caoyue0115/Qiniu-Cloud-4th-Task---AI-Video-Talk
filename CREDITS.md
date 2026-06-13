# 致谢与第三方参考（CREDITS）

本项目在实现「导航 / 阅读 / 聊天」多模式功能时，参考了以下开源项目的设计思路，特此致谢并标明出处。

## OpenAIglasses_for_Navigation

- 项目：**OpenAIglasses_for_Navigation**（AI 智能盲人眼镜系统）
- 作者：**AI-FanGe**
- 地址：https://github.com/AI-FanGe/OpenAIglasses_for_Navigation
- 许可证：**MIT License**（Copyright (c) 2025 AI-FanGe）

### 我们参考/借鉴的内容
- **导航引导的整体思路**：用大模型（通义千问）理解场景 + 轻量检测做实时提示的分工方式。
- **主动告警的逻辑模式**：参考其 `crosswalk_awareness.py` 的「面积阈值分级 + 方位分区（左/中/右）+ 去重播报」思想，用于我们导航模式的告警节流。
- **过马路 / 导航语音话术**：如「正在接近斑马线，为您对准方向」「已到达斑马线，请等待红绿灯」等播报风格。
- **语音意图切换的概念**：通过关键词识别进入/退出不同模式。

### 我们的不同实现（重要说明）
- 原项目为**重型服务端架构**：依赖 GPU(CUDA)、PyTorch、自训练 YOLO 分割模型、ESP32 硬件眼镜、WebSocket 推流。
- 本项目为**纯 Web 架构**（FastAPI + 浏览器端摄像头/麦克风，无 GPU），因此**没有复制其模型与 GPU/YOLO 代码**，而是基于上述思路用**通义千问 VL + 浏览器端 TensorFlow.js** 重新实现。
- 导航的实时检测改用浏览器端 **TensorFlow.js COCO-SSD**（见下），千问负责楼梯/指示牌/路况等语义补充。

> 原项目声明「仅为交流学习使用，请勿直接给视障人群使用」。本项目同为学习/竞赛用途，导航为「辅助提示」级，非医疗级避障。

## TensorFlow.js COCO-SSD（导航模式实时检测，PR-C 引入）

- 库：`@tensorflow/tfjs`、`@tensorflow-models/coco-ssd`
- 许可证：Apache-2.0
- 用途：在浏览器端实时检测行人、车辆、红绿灯等 COCO 类别，做即时语音告警。

## 阿里云百炼 DashScope

- 通义千问 VL（视觉理解）、Paraformer（语音识别）、CosyVoice（语音合成）。
