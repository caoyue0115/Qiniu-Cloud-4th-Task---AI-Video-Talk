"""流式语音识别：阿里云 Paraformer 实时识别。

边收音边识别，说完后短暂等待最终修正结果即可拿到文字（比一次性识别快）。
准确度优化：累积「已结束的句子」（Paraformer 对结束句会给出修正后的准确文本），
而非直接用逐字滚动的中间结果；finish 时再短暂等待最终结果到达。
供 WebSocket 端点逐帧喂入 16k 单声道 PCM(int16) 音频。
"""
import time
import threading
import dashscope
from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult

from utils import config

dashscope.api_key = config.DASHSCOPE_API_KEY


def _sentence_ended(sentence) -> bool:
    try:
        return bool(RecognitionResult.is_sentence_end(sentence))
    except Exception:
        return bool(isinstance(sentence, dict) and sentence.get("sentence_end"))


class _Collector(RecognitionCallback):
    def __init__(self):
        self.lock = threading.Lock()
        self.sentences = []   # 已结束的句子（修正后，准确）
        self.partial = ""     # 当前未结束句子的滚动文本
        self.got_final = False

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
            for x in s:
                if not isinstance(x, dict):
                    continue
                txt = (x.get("text") or "").strip()
                if not txt:
                    continue
                if _sentence_ended(x):
                    self.sentences.append(txt)
                    self.partial = ""
                    self.got_final = True
                else:
                    self.partial = txt

    def best_text(self) -> str:
        with self.lock:
            return ("".join(self.sentences) + self.partial).strip()


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

    def finish(self, max_wait: float = 0.6) -> str:
        """停止并返回最终文本。

        stop 后短暂等待最终修正结果到达（最多 max_wait 秒），提升准确度。
        """
        if self._started:
            try:
                self._rec.stop()
            except Exception as e:
                print(f"[asr stop error] {e}")
            self._started = False
        # 轮询等待句末修正结果；通常很快到达，没有则用现有最优文本
        deadline = max_wait
        waited = 0.0
        while waited < deadline:
            with self._cb.lock:
                if self._cb.got_final:
                    break
            time.sleep(0.05)
            waited += 0.05
        return self._cb.best_text()
