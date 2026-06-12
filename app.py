"""AI 视觉对话助手 —— 面向视障人士的语音视觉助手。

核心闭环：语音输入 → 视觉理解 → 语音输出
端云协同：颜色识别走端侧；简单问题走小模型；复杂场景走大模型；命中缓存零成本。

运行：
    1. 复制 .env.example 为 .env，填入你的 DASHSCOPE_API_KEY
    2. pip install -r requirements.txt
    3. python app.py
"""
import sys
import hashlib

# Windows 控制台默认 GBK，强制 UTF-8 避免中文/emoji 打印崩溃
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import gradio as gr

from utils import config
from modules.vision import VisionModule
from modules.speech import SpeechModule
from modules.color_detector import ColorDetector
from modules.router import ModelRouter
from modules.cache import ResponseCache
from modules.cost_tracker import CostTracker
from modules.context import ConversationContext

vision = VisionModule()
speech = SpeechModule()
color_detector = ColorDetector()
router = ModelRouter()
cache = ResponseCache()
cost_tracker = CostTracker()
context = ConversationContext()


def _image_fingerprint(image) -> str:
    if image is None:
        return "none"
    small = image[::16, ::16]  # 降采样后做指纹，相近画面命中同一缓存
    return hashlib.md5(small.tobytes()).hexdigest()[:16]


def process_request(audio, image):
    """核心处理函数。返回 (回答文本, 语音输出, 成本报告)。"""
    cost_tracker.new_request()

    # 1. 语音转文字
    user_text = speech.transcribe(audio) if audio is not None else ""
    if audio is not None:
        cost_tracker.log("asr")
    if not user_text:
        msg = "我没有听清，请再说一次。"
        return msg, speech.synthesize(msg), cost_tracker.get_report()

    context.add("user", user_text)

    # 2. 检查缓存
    cache_key = ResponseCache.make_key(user_text, _image_fingerprint(image))
    cached = cache.get(cache_key)
    if cached:
        cost_tracker.log("cache_hit")
        context.add("assistant", cached)
        return cached, speech.synthesize(cached), cost_tracker.get_report()

    # 3. 路由：判断走哪条路径
    route = router.classify(user_text)

    if route == "color":
        result = color_detector.detect(image)
        cost_tracker.log("edge")
    elif route == "text":
        result = vision.identify(image, user_text, model="mini")
        cost_tracker.log("mini")
    elif route == "simple":
        result = vision.identify(image, user_text, model="mini")
        cost_tracker.log("mini")
    else:  # complex
        result = vision.identify(image, user_text, model="full")
        cost_tracker.log("full")

    # 4. 写入缓存 + 上下文
    cache.set(cache_key, result)
    context.add("assistant", result)
    context.set_image_desc(result)

    # 5. 文字转语音
    audio_output = speech.synthesize(result)
    cost_tracker.log("tts")

    return result, audio_output, cost_tracker.get_report()


def build_ui():
    with gr.Blocks(title="AI 视觉对话助手", theme=gr.themes.Soft()) as demo:
        gr.Markdown(
            "# 👁️ AI 视觉对话助手 —— 你的眼睛，随时在线\n"
            "面向视障人士：**说出问题** + **对准摄像头**，AI 帮你「看」世界。\n"
            "支持物体识别、颜色辨别、文字阅读、场景描述、验证码识别。"
        )

        if not config.ensure_api_key():
            gr.Markdown(
                "⚠️ **未检测到有效的 DASHSCOPE_API_KEY**。"
                "请复制 `.env.example` 为 `.env` 并填入你的阿里云百炼 API Key 后重启。"
            )

        with gr.Row():
            with gr.Column():
                audio_input = gr.Audio(
                    sources=["microphone"], type="numpy", label="🎤 说出你的问题"
                )
                camera = gr.Image(
                    sources=["webcam"], type="numpy", label="📷 摄像头画面"
                )
                submit_btn = gr.Button("🚀 开始识别", variant="primary")

            with gr.Column():
                text_output = gr.Textbox(label="💬 AI 回答", lines=4)
                audio_output = gr.Audio(label="🔊 语音播报", autoplay=True)
                cost_display = gr.Textbox(label="📊 成本统计", lines=12)

        gr.Markdown(
            "### 试试这些问法\n"
            "- 「这是什么颜色」→ 端侧处理，零成本\n"
            "- 「这是什么」「这是什么药」→ 小模型\n"
            "- 「帮我看看周围」「前面有障碍物吗」→ 大模型\n"
            "- 「这上面写了什么」「帮我读验证码」→ 文字识别"
        )

        submit_btn.click(
            fn=process_request,
            inputs=[audio_input, camera],
            outputs=[text_output, audio_output, cost_display],
        )

    return demo


if __name__ == "__main__":
    app = build_ui()
    app.launch(share=False, inbrowser=True)
