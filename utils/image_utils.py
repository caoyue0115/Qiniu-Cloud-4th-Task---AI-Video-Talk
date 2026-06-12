"""图像处理工具：numpy <-> base64，压缩。"""
import base64
import io
import numpy as np
from PIL import Image


def numpy_to_pil(image: np.ndarray) -> Image.Image:
    if image.dtype != np.uint8:
        image = np.clip(image, 0, 255).astype(np.uint8)
    return Image.fromarray(image)


def encode_image_to_base64(image: np.ndarray, max_size: int = 720, quality: int = 80) -> str:
    """压缩并编码为 base64 data URI。成本优化：限制分辨率与质量。"""
    pil_img = numpy_to_pil(image)
    w, h = pil_img.size
    if max(w, h) > max_size:
        scale = max_size / max(w, h)
        pil_img = pil_img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buffer = io.BytesIO()
    pil_img.convert("RGB").save(buffer, format="JPEG", quality=quality)
    b64 = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}"


def frame_difference(img_a: np.ndarray, img_b: np.ndarray) -> float:
    """计算两帧差异度（0-1）。用于智能跳帧。"""
    if img_a is None or img_b is None:
        return 1.0
    if img_a.shape != img_b.shape:
        return 1.0
    a = img_a.astype(np.float32)
    b = img_b.astype(np.float32)
    diff = np.abs(a - b).mean() / 255.0
    return float(diff)
