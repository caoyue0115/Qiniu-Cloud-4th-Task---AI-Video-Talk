"""
AI视觉对话助手 - 主程序
面向视障人士的AI视觉助手
技术栈：Gradio + 阿里云通义千问
"""

import os
import tempfile
import gradio as gr
from dotenv import load_dotenv

from utils.vision import (
    compress_image, detect_color, image_to_base64,
    is_color_question, is_obstacle_question
)
from utils.ai_service import AIService
from utils.cost_tracker import CostTracker

# 加载环境变量
load_dotenv()

# ============================================================
# 初始化
# ============================================================
try:
    ai_service = AIService(api_key=os.getenv("DASHSCOPE_API_KEY"))
except ValueError as e:
    print(f"⚠️ {e}")
    print("⚠️ 请在项目根目录创建 .env 文件，添加: DASHSCOPE_API_KEY=sk-xxx")
    ai_service = None

cost_tracker = CostTracker()

# 全局状态
current_frame = None
conversation_history = []


# ============================================================
# 核心处理函数
# ============================================================

def process_question(video_frame, audio_file, question_text):
    """
    处理用户的问题
    流程：获取帧 → 语音识别 → 判断问题类型 → 端侧/云端处理 → TTS → 返回
    """
    global current_frame, conversation_history

    # 1. 检查摄像头
    if video_frame is None:
        return "⚠️ 请先打开摄像头", None, conversation_history, cost_tracker.get_stats_markdown()

    # 2. 压缩当前帧
    current_frame = compress_image(video_frame)

    # 3. 获取用户输入
    user_text = None

    if audio_file is not None:
        # 语音转文字
        if ai_service:
            user_text = ai_service.transcribe_audio(audio_file)
            cost_tracker.add_call("paraformer")
        else:
            return "⚠️ AI服务未配置，请设置API Key", None, conversation_history, cost_tracker.get_stats_markdown()

    if not user_text and question_text and question_text.strip():
        user_text = question_text.strip()

    if not user_text:
        return "请说话或输入文字", None, conversation_history, cost_tracker.get_stats_markdown()

    # 4. 判断问题类型，选择处理策略（端云协同）
    answer = None

    if is_color_question(user_text):
        # 端侧处理：颜色识别（成本=0）
        color = detect_color(current_frame)
        answer = f"我看到的是{color}。"
        cost_tracker.add_call("qwen_vl", cost=0)  # 端侧处理，成本为0

    elif is_obstacle_question(user_text):
        # 云端处理：障碍物检测（需要视觉理解）
        if ai_service:
            answer = ai_service.analyze_image(current_frame, user_text)
            cost_tracker.add_call("qwen_vl")
        else:
            answer = "障碍物检测需要AI服务支持"

    else:
        # 云端处理：通用视觉理解
        if ai_service:
            answer = ai_service.analyze_image(current_frame, user_text)
            cost_tracker.add_call("qwen_vl")
        else:
            answer = "AI服务未配置"

    # 5. 语音合成
    audio_response = None
    if ai_service and answer:
        audio_data = ai_service.text_to_speech(answer)
        cost_tracker.add_call("cosyvoice")
        if audio_data:
            # 保存为临时文件
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as f:
                f.write(audio_data)
                audio_response = f.name

    # 6. 更新对话历史
    conversation_history.append({"role": "user", "content": user_text})
    conversation_history.append({"role": "assistant", "content": answer})

    # 7. 格式化对话历史用于显示
    display_history = []
    for msg in conversation_history:
        if msg["role"] == "user":
            display_history.append(f"🧑 你：{msg['content']}")
        else:
            display_history.append(f"🤖 AI：{msg['content']}")

    return answer, audio_response, display_history, cost_tracker.get_stats_markdown()


def clear_conversation():
    """清除对话历史"""
    global conversation_history
    conversation_history = []
    if ai_service:
        ai_service.clear_history()
    return [], "对话已清除", cost_tracker.get_stats_markdown()


# ============================================================
# Gradio 界面
# ============================================================

CUSTOM_CSS = """
.gr-box { border-radius: 10px; }
h1 { text-align: center; }
"""

with gr.Blocks(
    title="AI视觉对话助手",
    theme=gr.themes.Soft(),
    css=CUSTOM_CSS
) as demo:
    # 标题
    gr.Markdown(
        """
        # 👁️ AI视觉对话助手
        ### 面向视障人士 — 用语音与AI对话，让AI帮你"看"世界
        """
    )

    with gr.Row():
        # 左列：输入区
        with gr.Column(scale=1):
            gr.Markdown("### 📷 摄像头")
            video = gr.Image(
                sources=["webcam"],
                streaming=True,
                label="摄像头画面",
                height=400
            )

            gr.Markdown("### 🎤 语音输入")
            audio = gr.Audio(
                sources=["microphone"],
                type="filepath",
                label="点击录音后提问"
            )

            gr.Markdown("### ⌨️ 文字输入（备选）")
            text_input = gr.Textbox(
                label="文字输入",
                placeholder="或者在这里打字提问...",
                lines=2
            )

            with gr.Row():
                submit_btn = gr.Button("🎤 提问", variant="primary", size="lg")
                clear_btn = gr.Button("🗑️ 清除对话", size="lg")

        # 右列：输出区
        with gr.Column(scale=1):
            gr.Markdown("### 💬 AI回答")
            answer_text = gr.Textbox(
                label="回答文字",
                lines=4,
                placeholder="AI的回答将显示在这里..."
            )

            gr.Markdown("### 🔊 语音回答")
            audio_output = gr.Audio(
                label="点击播放",
                type="filepath",
                autoplay=True
            )

            gr.Markdown("### 📝 对话历史")
            history = gr.Chatbot(
                label="对话记录",
                height=350,
                bubble_full_width=False
            )

            gr.Markdown("### 📊 成本统计")
            cost_display = gr.Markdown(
                cost_tracker.get_stats_markdown()
            )

    # 事件绑定
    submit_btn.click(
        fn=process_question,
        inputs=[video, audio, text_input],
        outputs=[answer_text, audio_output, history, cost_display]
    )

    clear_btn.click(
        fn=clear_conversation,
        inputs=[],
        outputs=[history, answer_text, cost_display]
    )

    # 底部信息
    gr.Markdown(
        """
        ---
        **提示**：
        - 支持的问题：物品识别、颜色识别、障碍物检测、文字阅读等
        - 颜色识别在本地处理（免费），其他问题调用云端AI
        - 建议在光线充足的环境下使用
        - 本应用为实训Demo，不构成医疗建议
        """
    )


# ============================================================
# 启动
# ============================================================

if __name__ == "__main__":
    print("=" * 50)
    print("  AI视觉对话助手 启动中...")
    print("  技术栈：Gradio + 阿里云通义千问")
    print("=" * 50)
    print()
    print("  🌐 本地访问: http://localhost:7860")
    print("  🌍 公网访问: 启动后查看 Gradio 生成的链接")
    print()
    print("  按 Ctrl+C 停止服务")
    print("=" * 50)

    demo.launch(
        server_name="0.0.0.0",
        server_port=7860,
        share=True,  # 生成公网链接
        debug=False
    )
