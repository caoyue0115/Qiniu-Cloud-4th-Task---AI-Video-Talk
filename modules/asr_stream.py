"""流式语音识别：阿里云 Paraformer 实时识别。

边收音边识别，说完后约 0.2 秒即可拿到文字（相比一次性识别省约 1 秒）。
供 WebSocket 端点逐帧喂入 16k 单声道 PCM(int16) 音频。
"""
import threading
import dashscope
from dashscope.audio.asr import Recognition, RecognitionCallback

from utils import config

dashscope.api_key = config.DASHSCOPE_API_KEY


class _Collector(RecognitionCallback):
    def __init__(self):
        self.lock = threading.Lock()
        self.text = ""

    def on_event(self, result):
        try:
            s = result.get_sentence()
        except Exception:
            s = None
        if not s:
            return
        if isinstance(s, dict):
            s = [s]
        with self.lock:
            # 实时识别回调里 sentence 是逐步完善的当前句；取最新文本
            parts = [x.get("text", "") for x in s if isinstance(x, dict)]
            joined = "".join(parts).strip()
            if joined:
                self.text = joined


class StreamingASR:
    """一次发声的流式识别会话。"""

    def __init__(self, model: str = None, sample_rate: int = 16000):
        self.model = model or config.ASR_MODEL or "paraformer-realtime-v2"
        self.sample_rate = sample_rate
        self._cb = _Collector()
        self._rec = Recognition(
            model=self.model, format="pcm", sample_rate=sample_rate, callback=self._cb,
        )
        self._started = False

    def start(self):
        if not self._started:
            self._rec.start()
            self._started = True

    def feed(self, pcm_bytes: bytes):
        if self._started and pcm_bytes:
            try:
                self._rec.send_audio_frame(pcm_bytes)
            except Exception as e:
                print(f"[asr feed error] {e}")

    def finish(self) -> str:
        """停止并返回最终文本。"""
        if self._started:
            try:
                self._rec.stop()
            except Exception as e:
                print(f"[asr stop error] {e}")
            self._started = False
        with self._cb.lock:
            return self._cb.text
