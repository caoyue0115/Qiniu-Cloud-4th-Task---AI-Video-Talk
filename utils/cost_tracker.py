"""
成本追踪模块
- 记录API调用次数
- 估算成本
- 生成统计报告
"""

import time
from collections import deque


class CostTracker:
    """成本追踪器"""

    def __init__(self):
        self.total_calls = 0
        self.total_cost = 0.0
        self.call_history = deque(maxlen=1000)  # 保留最近1000次调用记录
        self.start_time = time.time()

        # 各服务的单价（元/次）- 阿里云免费额度内为0
        # 新用户送 100万 tokens，有效期6个月
        self.prices = {
            "paraformer": 0.0,    # 免费额度内
            "qwen_vl": 0.0,       # 免费额度内
            "cosyvoice": 0.0,     # 免费额度内
        }

    def add_call(self, service_type="qwen_vl", cost=None):
        """
        记录一次API调用
        参数：
            service_type - 服务类型
            cost - 实际成本（如果已知），否则自动估算
        """
        self.total_calls += 1

        if cost is None:
            cost = self.prices.get(service_type, 0.0)

        self.total_cost += cost
        self.call_history.append({
            "time": time.time(),
            "type": service_type,
            "cost": cost
        })

    def get_stats(self):
        """获取统计信息"""
        elapsed = time.time() - self.start_time
        hours = elapsed / 3600

        return {
            "总调用次数": self.total_calls,
            "总成本(元)": round(self.total_cost, 4),
            "平均单次成本(元)": round(self.total_cost / max(self.total_calls, 1), 6),
            "运行时长(小时)": round(hours, 1),
        }

    def get_stats_markdown(self):
        """获取Markdown格式的统计信息"""
        stats = self.get_stats()
        md = "### 📊 成本统计\n\n"
        md += f"| 指标 | 数值 |\n"
        md += f"|------|------|\n"
        md += f"| 总调用次数 | {stats['总调用次数']} |\n"
        md += f"| 总成本 | ¥{stats['总成本(元)']} |\n"
        md += f"| 平均单次成本 | ¥{stats['平均单次成本(元)']} |\n"
        md += f"| 运行时长 | {stats['运行时长(小时)']}h |\n"
        md += f"| 免费额度 | 新用户100万tokens |\n"
        return md

    def reset(self):
        """重置统计"""
        self.total_calls = 0
        self.total_cost = 0.0
        self.call_history.clear()
        self.start_time = time.time()
