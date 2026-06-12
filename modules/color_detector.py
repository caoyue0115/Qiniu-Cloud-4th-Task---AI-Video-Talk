"""端侧颜色识别：HSV 色彩空间分析，零 API 成本。

对应用户故事 US-003。这是"端云协同"里最纯粹的端侧能力——
完全本地计算，不消耗任何云端调用。
"""
import cv2
import numpy as np

# HSV 颜色区间定义（H: 0-179, S: 0-255, V: 0-255）
COLOR_RANGES = [
    ("红色", [(0, 70, 50), (10, 255, 255)]),
    ("红色", [(170, 70, 50), (179, 255, 255)]),
    ("橙色", [(11, 70, 50), (25, 255, 255)]),
    ("黄色", [(26, 70, 50), (34, 255, 255)]),
    ("绿色", [(35, 70, 50), (77, 255, 255)]),
    ("青色", [(78, 70, 50), (99, 255, 255)]),
    ("蓝色", [(100, 70, 50), (124, 255, 255)]),
    ("紫色", [(125, 70, 50), (155, 255, 255)]),
    ("粉色", [(156, 70, 50), (169, 255, 255)]),
]


class ColorDetector:
    def detect(self, image: np.ndarray) -> str:
        """识别图像中心区域的主色调。"""
        if image is None or image.size == 0:
            return "我没有看到画面，请把摄像头对准物品。"

        # 取中心 50% 区域，避免背景干扰
        h, w = image.shape[:2]
        cx0, cx1 = int(w * 0.25), int(w * 0.75)
        cy0, cy1 = int(h * 0.25), int(h * 0.75)
        center = image[cy0:cy1, cx0:cx1]

        hsv = cv2.cvtColor(center, cv2.COLOR_RGB2HSV)
        h_chan, s_chan, v_chan = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

        mean_v = float(v_chan.mean())
        mean_s = float(s_chan.mean())

        # 先判断黑/白/灰（低饱和度）
        if mean_v < 50:
            return "这是黑色或很深的颜色。"
        if mean_s < 35:
            if mean_v > 200:
                return "这是白色。"
            return "这是灰色。"

        # 统计各颜色像素占比
        scores = {}
        for name, (lower, upper) in COLOR_RANGES:
            mask = cv2.inRange(hsv, np.array(lower), np.array(upper))
            scores[name] = scores.get(name, 0) + int(mask.sum())

        if not scores or max(scores.values()) == 0:
            return "颜色不太明显，建议拿到光线好的地方再试一次。"

        main_color = max(scores, key=scores.get)

        # 光线提示
        if mean_v < 90:
            return f"光线较暗，我看到的颜色是{main_color}，建议到亮处确认。"
        return f"这是{main_color}。"
