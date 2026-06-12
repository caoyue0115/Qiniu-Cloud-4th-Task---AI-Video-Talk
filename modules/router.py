"""模型路由：根据用户问题判断走哪条处理路径。

成本控制核心策略之一——简单问题走端侧或小模型，复杂问题才走大模型。
对应设计文档"模型路由"与"场景感知的模型选择"。
"""

# 端侧可完成（零成本）：颜色识别
COLOR_KEYWORDS = ["颜色", "什么色", "几个色", "色号", "什么颜色"]

# 文本/阅读类：需要 OCR + 视觉，走小模型即可
TEXT_KEYWORDS = ["写了什么", "写的什么", "念", "读一下", "读一读", "字", "说明书",
                 "标签", "菜单", "验证码", "上面是什么"]

# 简单物体识别：走小模型
SIMPLE_KEYWORDS = ["这是什么", "是什么东西", "这是啥", "什么物品", "什么东西"]

# 复杂场景理解：走大模型
COMPLEX_KEYWORDS = ["周围", "环境", "场景", "前面有什么", "障碍", "描述一下",
                    "帮我看看周围", "我在哪", "怎么走", "安全吗", "几个人", "在干什么"]


class ModelRouter:
    def classify(self, text: str) -> str:
        """返回路径：'color' | 'text' | 'simple' | 'complex'。"""
        if not text:
            return "simple"
        t = text.strip()

        if any(k in t for k in COLOR_KEYWORDS):
            return "color"
        if any(k in t for k in COMPLEX_KEYWORDS):
            return "complex"
        if any(k in t for k in TEXT_KEYWORDS):
            return "text"
        if any(k in t for k in SIMPLE_KEYWORDS):
            return "simple"

        # 默认：短问题走小模型，长问题走大模型
        return "simple" if len(t) <= 12 else "complex"
