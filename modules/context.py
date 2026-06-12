"""对话上下文管理：多轮对话记忆（US-006）。

保留最近若干轮对话摘要而非完整历史，控制 token 消耗
（对应成本策略"对话上下文压缩"）。
"""
import time


class ConversationContext:
    def __init__(self, max_turns: int = 6, ttl_seconds: int = 300):
        self.history = []  # [(role, text)]
        self.last_active = time.time()
        self.last_image_desc = ""  # 最近一次视觉识别的结果，供追问复用
        self._max = max_turns
        self._ttl = ttl_seconds

    def _maybe_reset(self):
        if time.time() - self.last_active > self._ttl:
            self.history.clear()
            self.last_image_desc = ""

    def add(self, role: str, text: str):
        self._maybe_reset()
        self.history.append((role, text))
        self.history = self.history[-self._max * 2:]
        self.last_active = time.time()

    def set_image_desc(self, desc: str):
        self.last_image_desc = desc

    def as_context_string(self) -> str:
        self._maybe_reset()
        if not self.history:
            return ""
        lines = []
        for role, text in self.history[-self._max:]:
            speaker = "用户" if role == "user" else "助手"
            lines.append(f"{speaker}：{text}")
        return "\n".join(lines)
