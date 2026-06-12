"""端侧颜色识别：HSV 色彩空间分析，零 API 成本。

对应用户故事 US-003。这是"端云协同"里最纯粹的端侧能力——
完全本地计算，不消耗任何云端调用。

用中位数（而非均值）判断主色调，抗背景/反光干扰；取画面正中小区域，
假定用户把物品对准镜头中心。
"""
import cv2
import numpy as np

# 色调(H, OpenCV 范围 0-179)到颜色名的映射区间
HUE_NAMES = [
    (0, 8, "红色"),
    (9, 22, "橙色"),
    (23, 33, "黄色"),
    (34, 78, "绿色"),
    (79, 99, "青色"),
    (100, 124, "蓝色"),
    (125, 150, "紫色"),
    (151, 169, "粉色"),
    (170, 179, "红色"),
]


def _hue_to_name(h: float) -> str:
    for lo, hi, name in HUE_NAMES:
        if lo <= h <= hi:
            return name
    return "红色"


class ColorDetector:
    def detect(self, image: np.ndarray) -> str:
        """识别画面中心物品的主色调。"""
        if image is None or image.size == 0:
            return "我没有看到画面，请把摄像头对准物品。"

        # 取正中 36% 边长的小区域（约画面中心 1/8 面积），聚焦被对准的物品
        h, w = image.shape[:2]
        cx0, cx1 = int(w * 0.32), int(w * 0.68)
        cy0, cy1 = int(h * 0.32), int(h * 0.68)
        center = image[cy0:cy1, cx0:cx1]
        if center.size == 0:
            center = image

        hsv = cv2.cvtColor(center, cv2.COLOR_RGB2HSV)
        h_chan = hsv[:, :, 0].reshape(-1)
        s_chan = hsv[:, :, 1].reshape(-1)
        v_chan = hsv[:, :, 2].reshape(-1)

        med_s = float(np.median(s_chan))
        med_v = float(np.median(v_chan))

        # 1. 明暗/灰度判定（低饱和度时谈不上彩色）
        if med_v < 45:
            return "这是黑色或很深的颜色。"
        if med_s < 40:
            if med_v > 205:
                return "这是白色。"
            if med_v > 120:
                return "这是灰色。"
            return "这是深灰色或黑色。"

        # 2. 只在"足够鲜艳"的像素上取色调中位数，避免背景灰像素拉偏
        colorful = (s_chan >= max(40, med_s * 0.6)) & (v_chan >= 45)
        hues = h_chan[colorful]
        if hues.size < 10:
            hues = h_chan
        # 色调是环形的，红色横跨 0/179：先把接近 180 的归并到 0 附近再取中位
        hues = hues.astype(np.float32)
        if (hues > 160).mean() > 0.3 and (hues < 20).mean() > 0.1:
            hues = np.where(hues > 160, hues - 180, hues)
        med_h = float(np.median(hues)) % 180

        name = _hue_to_name(med_h)

        if med_v < 80:
            return f"光线较暗，我看到的颜色像是{name}，建议到亮处再确认一次。"
        return f"这是{name}。"
