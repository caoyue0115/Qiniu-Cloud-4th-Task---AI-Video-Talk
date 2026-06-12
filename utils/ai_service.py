"""
AI服务模块（阿里云通义千问版）
- 语音识别（Paraformer）
- 视觉理解（Qwen-VL-Plus）
- 语音合成（CosyVoice）
- 对话上下文管理
"""

import os
import base64
import json
from io import BytesIO
from PIL import Image
import httpx
import dashscope
from dashscope import MultiModalConversation, AudioTranscription, AudioResult
from dashscope.audio.tts import SpeechSynthesizer


class AIService:
    """AI服务封装 - 阿里云通义千问"""

    def __init__(self, api_key=None):
        """初始化AI服务"""
        self.api_key = api_key or os.getenv("DASHSCOPE_API_KEY")
        if not self.api_key:
            raise ValueError("请设置 DASHSCOPE_API_KEY 环境变量或在 .env 文件中配置")

        # 设置DashScope全局API Key
        dashscope.api_key = self.api_key

        self.conversation_history = []
        self.max_history = 6  # 保留最近3轮对话

        # 系统提示词
        self.system_prompt = """你是一个AI视觉助手，专门帮助视障人士理解他们周围的世界。
请根据用户看到的画面和用户的问题，用中文给出清晰、简洁的回答。

回答要求：
1. 语言简洁明了，适合语音播报，控制在50字以内
2. 描述准确，不确定时说明"我看到的可能是..."
3. 涉及安全问题时（如障碍物），给出明确提示
4. 识别药品时，说明药品名称和基本用途，但提醒"请遵医嘱"
5. 识别食物时，说明是什么以及是否可以食用
6. 回答要温暖、耐心，像朋友一样帮助用户"""

    def transcribe_audio(self, audio_file):
        """
        语音转文字（阿里云 Paraformer）
        参数：audio_file - 音频文件路径
        返回：识别后的文字
        """
        try:
            # 读取音频文件
            with open(audio_file, "rb") as f:
                audio_data = f.read()

            # 调用Paraformer语音识别
            result = AudioTranscription.async_call(
                model="paraformer-realtime-v2",
                audio_url=None,  # 直接传文件
                audio_data=audio_data,
                language="zh"
            )

            # 等待结果
            transcript = AudioResult.wait(result)
            if transcript and transcript.output:
                return transcript.output.get("text", "")

            return None

        except Exception as e:
            print(f"语音识别出错: {e}")
            # 降级方案：返回None，让用户用文字输入
            return None

    def analyze_image(self, image, user_text):
        """
        视觉理解 + 对话（通义千问 VL Plus）
        参数：
            image - numpy图像数组
            user_text - 用户输入的文字
        返回：AI回答文字
        """
        try:
            # 将图像转为base64
            img_base64 = self._image_to_base64(image)

            # 构建消息
            messages = [
                {"role": "system", "content": [{"text": self.system_prompt}]}
            ]

            # 添加上下文历史
            for msg in self.conversation_history[-self.max_history:]:
                messages.append(msg)

            # 添加当前用户消息（含图片）
            messages.append({
                "role": "user",
                "content": [
                    {"image": f"data:image/jpeg;base64,{img_base64}"},
                    {"text": user_text}
                ]
            })

            # 调用通义千问VL模型
            response = MultiModalConversation.call(
                model="qwen-vl-plus",  # 视觉理解模型
                messages=messages,
                max_tokens=200,
                temperature=0.7
            )

            if response.status_code == 200:
                # 解析返回结果
                answer = response.output.choices[0].message.content[0]["text"]

                # 更新对话历史（只保存文本）
                self.conversation_history.append({
                    "role": "user",
                    "content": [{"text": user_text}]
                })
                self.conversation_history.append({
                    "role": "assistant",
                    "content": [{"text": answer}]
                })

                return answer
            else:
                error_msg = f"API返回错误: {response.code} - {response.message}"
                print(error_msg)
                return f"抱歉，我遇到了一些问题"

        except Exception as e:
            print(f"AI分析出错: {e}")
            return f"抱歉，我遇到了一些问题：{str(e)[:50]}"

    def text_to_speech(self, text):
        """
        文字转语音（阿里云 CosyVoice）
        参数：text - 要朗读的文字
        返回：音频二进制数据（WAV格式）
        """
        try:
            # 调用CosyVoice语音合成
            result = SpeechSynthesizer.call(
                model="cosyvoice-v1",
                voice="longxiaochun",  # 温柔女声
                text=text,
                format="wav",
                sample_rate=16000
            )

            if result.get_audio_data():
                return result.get_audio_data()
            return None

        except Exception as e:
            print(f"语音合成出错: {e}")
            return None

    def _image_to_base64(self, image):
        """将numpy图像转为base64"""
        pil_img = Image.fromarray(image)
        buffer = BytesIO()
        pil_img.save(buffer, format="JPEG", quality=80)
        return base64.b64encode(buffer.getvalue()).decode('utf-8')

    def clear_history(self):
        """清除对话历史"""
        self.conversation_history = []

    def get_cost_estimate(self):
        """
        估算每次调用的成本
        通义千问 VL Plus: 免费额度内不收费
        Paraformer: 免费额度内不收费
        CosyVoice: 免费额度内不收费
        """
        return 0.0  # 阿里云有免费额度
