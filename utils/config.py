"""配置管理：从 .env 读取 API Key 与模型名。"""
import os
from dotenv import load_dotenv

load_dotenv()

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "").strip()

VISION_MODEL_FULL = os.getenv("VISION_MODEL_FULL", "qwen-vl-max")
VISION_MODEL_MINI = os.getenv("VISION_MODEL_MINI", "qwen-vl-plus")
CHAT_MODEL = os.getenv("CHAT_MODEL", "qwen-plus")
ASR_MODEL = os.getenv("ASR_MODEL", "paraformer-realtime-v2")
TTS_MODEL = os.getenv("TTS_MODEL", "cosyvoice-v1")
TTS_VOICE = os.getenv("TTS_VOICE", "longxiaochun")

# 实时模式（Qwen-Omni-Realtime）
OMNI_MODEL = os.getenv("OMNI_MODEL", "qwen3.5-omni-flash-realtime")
OMNI_VOICE = os.getenv("OMNI_VOICE", "Ethan")   # 可选 Ethan / Serena / Dylan


def ensure_api_key() -> bool:
    return bool(DASHSCOPE_API_KEY) and DASHSCOPE_API_KEY.startswith("sk-")
