"""成本追踪：记录每次请求走了哪条路径、花了多少钱。

这是设计文档里"运营成本控制"叙事的数据来源——让每一次调用的
成本可见，从而验证端云协同、模型路由、缓存等策略的实际效果。
"""
from dataclasses import dataclass, field
from threading import Lock


# 各路径单次成本估算（人民币元）。数值为粗略估计，便于演示成本结构。
COST_TABLE = {
    "cache_hit": 0.0,      # 命中缓存，零成本
    "edge": 0.0,           # 端侧处理（颜色识别等），不调云
    "mini": 0.012,         # 小模型 qwen-vl-plus
    "full": 0.030,         # 大模型 qwen-vl-max
    "chat": 0.002,         # 纯文本对话
    "asr": 0.005,          # 语音识别
    "tts": 0.003,          # 语音合成
}

PATH_LABEL = {
    "cache_hit": "缓存命中",
    "edge": "端侧处理",
    "mini": "小模型(qwen-vl-plus)",
    "full": "大模型(qwen-vl-max)",
    "chat": "文本对话",
    "asr": "语音识别",
    "tts": "语音合成",
}


@dataclass
class CostTracker:
    counts: dict = field(default_factory=dict)
    total_cost: float = 0.0
    total_requests: int = 0
    _lock: Lock = field(default_factory=Lock)

    def log(self, path: str) -> None:
        with self._lock:
            self.counts[path] = self.counts.get(path, 0) + 1
            self.total_cost += COST_TABLE.get(path, 0.0)

    def new_request(self) -> None:
        with self._lock:
            self.total_requests += 1

    def get_report(self) -> str:
        with self._lock:
            lines = ["📊 成本统计", "─" * 28]
            for path, n in sorted(self.counts.items()):
                label = PATH_LABEL.get(path, path)
                unit = COST_TABLE.get(path, 0.0)
                lines.append(f"{label:<20} ×{n:<4} ¥{unit * n:.3f}")
            lines.append("─" * 28)
            lines.append(f"总请求次数：{self.total_requests}")
            lines.append(f"累计成本：¥{self.total_cost:.3f}")
            if self.total_requests > 0:
                avg = self.total_cost / self.total_requests
                lines.append(f"单次平均：¥{avg:.4f}")
            # 端侧+缓存占比（成本节省的核心指标）
            saved = self.counts.get("edge", 0) + self.counts.get("cache_hit", 0)
            total_paths = sum(self.counts.get(k, 0) for k in ("edge", "cache_hit", "mini", "full"))
            if total_paths > 0:
                lines.append(f"端侧+缓存占比：{saved / total_paths * 100:.0f}%")
            return "\n".join(lines)
