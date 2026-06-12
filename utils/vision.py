"""
视觉处理模块
- 帧采样与压缩
- 端侧颜色识别（HSV）
- 端侧物品检测（YOLO）
- 图像编码
"""

import cv2
import numpy as np
from PIL import Image
import base64
import io
import hashlib


def compress_image(image, max_size=720):
    """压缩图片以减少API调用成本"""
    if image is None:
        return None
    h, w = image.shape[:2]
    if max(h, w) > max_size:
        scale = max_size / max(h, w)
        new_size = (int(w * scale), int(h * scale))
        image = cv2.resize(image, new_size)
    return image


def detect_color(image):
    """
    端侧颜色识别（HSV色彩空间）
    返回：颜色名称（中文）
    """
    if image is None:
        return "无法识别"

    # 确保图像是RGB格式
    if len(image.shape) == 3 and image.shape[2] == 3:
        hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    else:
        return "无法识别"

    # 定义基本颜色范围（HSV）
    color_ranges = {
        '红色': [(0, 50, 50), (10, 255, 255)],
        '橙色': [(11, 50, 50), (25, 255, 255)],
        '黄色': [(26, 50, 50), (35, 255, 255)],
        '绿色': [(36, 50, 50), (85, 255, 255)],
        '蓝色': [(86, 50, 50), (125, 255, 255)],
        '紫色': [(126, 50, 50), (155, 255, 255)],
        '粉色': [(156, 50, 50), (170, 255, 255)],
        '白色': [(0, 0, 200), (180, 30, 255)],
        '灰色': [(0, 0, 50), (180, 30, 200)],
        '黑色': [(0, 0, 0), (180, 255, 50)],
        '棕色': [(10, 50, 50), (20, 200, 150)],
    }

    max_pixels = 0
    detected_color = "未知"

    for color_name, (lower, upper) in color_ranges.items():
        mask = cv2.inRange(hsv, np.array(lower), np.array(upper))
        pixels = cv2.countNonZero(mask)
        if pixels > max_pixels:
            max_pixels = pixels
            detected_color = color_name

    # 如果最大像素占比太小，返回"未知"
    total_pixels = image.shape[0] * image.shape[1]
    if max_pixels / total_pixels < 0.1:
        return "多种颜色混合"

    return detected_color


def image_to_base64(image, quality=80):
    """将numpy图像转为base64字符串"""
    if image is None:
        return None
    pil_img = Image.fromarray(image)
    buffer = io.BytesIO()
    pil_img.save(buffer, format="JPEG", quality=quality)
    return base64.b64encode(buffer.getvalue()).decode('utf-8')


def get_image_hash(image):
    """计算图像哈希值（用于缓存）"""
    if image is None:
        return None
    return hashlib.md5(image.tobytes()).hexdigest()[:16]


def detect_objects_yolo(image, model=None):
    """
    端侧YOLO物品检测
    需要安装 ultralytics 包
    返回：检测到的物品列表
    """
    if model is None:
        return []

    try:
        results = model(image)
        detections = []
        for r in results:
            for box in r.boxes:
                cls = int(box.cls[0])
                conf = float(box.conf[0])
                if conf > 0.5:
                    detections.append({
                        'name': model.names[cls],
                        'confidence': round(conf, 2)
                    })
        return detections
    except Exception as e:
        print(f"YOLO检测出错: {e}")
        return []


def is_color_question(text):
    """判断用户是否在问颜色"""
    keywords = ["颜色", "什么颜色", "啥颜色", "什么色", "啥色"]
    return any(kw in text for kw in keywords)


def is_obstacle_question(text):
    """判断用户是否在问障碍物"""
    keywords = ["障碍", "前面", "有东西", "有物体", "看看路", "能走吗", "台阶", "楼梯"]
    return any(kw in text for kw in keywords)
