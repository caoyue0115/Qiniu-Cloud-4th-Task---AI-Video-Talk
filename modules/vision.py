"""视觉理解模块：调用通义千问 VL 系列（qwen-vl-max / qwen-vl-plus）。

对应用户故事 US-001（物体识别）、US-002（障碍物）、US-004（验证码）、US-005（文本阅读）。
"""
import dashscope
from dashscope import MultiModalConversation

from utils import config
from utils.image_utils import encode_image_to_base64

dashscope.api_key = config.DASHSCOPE_API_KEY

SYSTEM_PROMPT = """你是一个 AI 视觉助手，专门帮助视障人士理解他们看不到的内容。
请用简洁、清晰、口语化的中文回答，因为回答会通过语音播报给用户。
- 如果是物品：说出名称、颜色、用途；如果是药品，提醒咨询医生。
- 如果是文字：朗读文字内容，保持原有顺序。
- 如果是场景：描述关键信息，尤其是障碍物的方位和距离。
- 如果是验证码：直接读出字符。
回答控制在 2-3 句话以内，不要啰嗦，不要描述无关细节。"""


class VisionModule:
    def __init__(self):
        self.models = {
            "full": config.VISION_MODEL_FULL,
            "mini": config.VISION_MODEL_MINI,
        }

    def identify(self, image, user_text: str, model: str = "mini") -> str:
        """识别图像内容并结合用户问题回答。"""
        if image is None:
            return "我没有看到画面，请确认摄像头已经打开。"

        data_uri = encode_image_to_base64(image)
        messages = [
            {"role": "system", "content": [{"text": SYSTEM_PROMPT}]},
            {
                "role": "user",
                "content": [
                    {"image": data_uri},
                    {"text": user_text or "请描述你看到的内容。"},
                ],
            },
        ]

        try:
            response = MultiModalConversation.call(
                model=self.models.get(model, self.models["mini"]),
                messages=messages,
                api_key=config.DASHSCOPE_API_KEY,
            )
        except Exception as e:
            return f"视觉识别出错了：{e}"

        if response.status_code != 200:
            return f"识别失败（{response.code}）：{response.message}"

        try:
            content = response.output.choices[0].message.content
            # content 是 list，取其中的 text 字段
            if isinstance(content, list):
                texts = [c.get("text", "") for c in content if isinstance(c, dict)]
                return "".join(texts).strip() or "我看到了画面，但不太确定内容。"
            return str(content).strip()
        except (AttributeError, IndexError, KeyError):
            return "识别结果解析失败，请重试。"
