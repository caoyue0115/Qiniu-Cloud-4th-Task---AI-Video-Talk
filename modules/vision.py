"""视觉理解模块：调用通义千问 VL 系列（qwen-vl-max / qwen-vl-plus）。

对应用户故事 US-001（物体识别）、US-002（障碍物）、US-004（验证码）、US-005（文本阅读）。
"""
import dashscope
from dashscope import MultiModalConversation

from utils import config
from utils.image_utils import encode_image_to_base64

dashscope.api_key = config.DASHSCOPE_API_KEY

SYSTEM_PROMPT = """你是视障人士的 AI 视觉助手，回答会用语音播报给看不见的用户。
铁律：极简、口语、直接说结论，绝不展开。
- 物品：一句话说名称+颜色+用途。药品提醒遵医嘱。
- 文字/验证码：直接念内容，不解释。
- 场景/障碍物：只说关键信息和方位距离。
严格控制在 1-2 句话、40 字以内。禁止分点、禁止小标题、禁止背景知识或文化延伸。
例：问"这是什么颜色"，只答"这是红色。"——不要任何多余的话。"""

MAX_TOKENS = 120


class VisionModule:
    def __init__(self):
        self.models = {
            "full": config.VISION_MODEL_FULL,
            "mini": config.VISION_MODEL_MINI,
        }

    def _build_messages(self, frames, user_text):
        content = [{"image": encode_image_to_base64(f)} for f in frames]
        if len(frames) > 1:
            content.append({
                "text": (user_text or "请描述你看到的内容。")
                + f"（以上是连续 {len(frames)} 帧画面，请综合理解场景，重点描述障碍物和变化。）"
            })
        else:
            content.append({"text": user_text or "请描述你看到的内容。"})
        return [
            {"role": "system", "content": [{"text": SYSTEM_PROMPT}]},
            {"role": "user", "content": content},
        ]

    def identify(self, image, user_text: str, model: str = "mini") -> str:
        """识别图像内容并结合用户问题回答。

        image: 单帧 ndarray，或多帧 list[ndarray]（连续画面，复杂场景用）。
        """
        if image is None:
            return "我没有看到画面，请确认摄像头已经打开。"

        frames = image if isinstance(image, list) else [image]
        frames = [f for f in frames if f is not None]
        if not frames:
            return "我没有看到画面，请确认摄像头已经打开。"

        messages = self._build_messages(frames, user_text)

        try:
            response = MultiModalConversation.call(
                model=self.models.get(model, self.models["mini"]),
                messages=messages,
                api_key=config.DASHSCOPE_API_KEY,
                max_tokens=MAX_TOKENS,
            )
        except Exception as e:
            return f"视觉识别出错了：{e}"

        if response.status_code != 200:
            return f"识别失败（{response.code}）：{response.message}"

        try:
            content = response.output.choices[0].message.content
            if isinstance(content, list):
                texts = [c.get("text", "") for c in content if isinstance(c, dict)]
                return "".join(texts).strip() or "我看到了画面，但不太确定内容。"
            return str(content).strip()
        except (AttributeError, IndexError, KeyError):
            return "识别结果解析失败，请重试。"

    def identify_stream(self, image, user_text: str, model: str = "mini"):
        """流式识别：逐段 yield 文本增量，供边生成边播报。"""
        if image is None:
            yield "我没有看到画面，请确认摄像头已经打开。"
            return
        frames = image if isinstance(image, list) else [image]
        frames = [f for f in frames if f is not None]
        if not frames:
            yield "我没有看到画面，请确认摄像头已经打开。"
            return

        messages = self._build_messages(frames, user_text)
        try:
            responses = MultiModalConversation.call(
                model=self.models.get(model, self.models["mini"]),
                messages=messages,
                api_key=config.DASHSCOPE_API_KEY,
                max_tokens=MAX_TOKENS,
                stream=True,
                incremental_output=True,
            )
            for r in responses:
                if r.status_code != 200:
                    continue
                try:
                    content = r.output.choices[0].message.content
                    if isinstance(content, list):
                        txt = "".join(c.get("text", "") for c in content if isinstance(c, dict))
                    else:
                        txt = str(content)
                    if txt:
                        yield txt
                except (AttributeError, IndexError, KeyError):
                    continue
        except Exception as e:
            yield f"识别出错了：{e}"
