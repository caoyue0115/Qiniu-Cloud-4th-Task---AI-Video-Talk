"""缓存层：精确匹配缓存，降低重复调用成本。

对应设计文档"缓存策略"。这里实现 L1 精确缓存（内存版，
演示用；生产环境替换为 Redis）。缓存键 = 问题文本 + 图像指纹。
"""
import hashlib
import time
from collections import OrderedDict
from threading import Lock


class ResponseCache:
    def __init__(self, max_size: int = 256, ttl_seconds: int = 600):
        self._store = OrderedDict()
        self._max = max_size
        self._ttl = ttl_seconds
        self._lock = Lock()

    @staticmethod
    def make_key(text: str, image_fingerprint: str) -> str:
        raw = f"{text.strip()}::{image_fingerprint}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def get(self, key: str):
        with self._lock:
            item = self._store.get(key)
            if item is None:
                return None
            value, ts = item
            if time.time() - ts > self._ttl:
                del self._store[key]
                return None
            self._store.move_to_end(key)
            return value

    def set(self, key: str, value: str) -> None:
        with self._lock:
            self._store[key] = (value, time.time())
            self._store.move_to_end(key)
            while len(self._store) > self._max:
                self._store.popitem(last=False)
