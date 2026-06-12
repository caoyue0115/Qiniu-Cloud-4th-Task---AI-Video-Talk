"""语音模块：ASR（语音转文字）+ TTS（文字转语音），均走阿里云 DashScope。

ASR：Paraformer 实时识别（Recognition.call 需要本地文件路径，16k 单声道 WAV）。
TTS：CosyVoice v2 合成，返回音频字节。
Gradio 麦克风给出的是 (sample_rate, numpy_array)。
"""
import io
import os
import json
import tempfile
import numpy as np
import soundfile as sf
import dashscope

from utils import config

dashscope.api_key = config.DASHSCOPE_API_KEY

ASR_SAMPLE_RATE = 16000


def _write_wav_16k_mono(audio) -> str:
    """把 Gradio 的 (sample_rate, ndarray) 重采样为 16k 单声道，写入临时 WAV，返回路径。"""
    sample_rate, data = audio
    data = np.asarray(data)
    # 整型 PCM 转 float32 [-1, 1]
    if data.dtype.kind in ("i", "u"):
        max_val = np.iinfo(data.dtype).max
        data = data.astype(np.float32) / max_val
    else:
        data = data.astype(np.float32)
    # 多声道转单声道
    if data.ndim > 1:
        data = data.mean(axis=1)
    # 重采样到 16k（线性插值，够用且无额外依赖）
    if sample_rate != ASR_SAMPLE_RATE and len(data) > 0:
        duration = len(data) / sample_rate
        new_len = int(duration * ASR_SAMPLE_RATE)
        if new_len > 0:
            x_old = np.linspace(0, 1, len(data))
            x_new = np.linspace(0, 1, new_len)
            data = np.interp(x_new, x_old, data).astype(np.float32)
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    sf.write(path, data, ASR_SAMPLE_RATE, subtype="PCM_16")
    return path


def _parse_asr_result(result) -> str:
    """从 RecognitionResult 中提取文本，兼容不同返回结构。"""
    try:
        sentences = result.get_sentence()
    except Exception:
        sentences = None
    if not sentences:
        return ""
    # sentences 可能是 list[dict] 或单个 dict
    if isinstance(sentences, dict):
        sentences = [sentences]
    texts = []
    for s in sentences:
        if isinstance(s, dict):
            texts.append(s.get("text", ""))
    return "".join(texts).strip()


class SpeechModule:
    def __init__(self):
        self.asr_model = config.ASR_MODEL
        self.tts_model = config.TTS_MODEL
        self.tts_voice = config.TTS_VOICE

    def transcribe(self, audio) -> str:
        """语音转文字。audio 为 Gradio (sample_rate, ndarray)。"""
        if audio is None:
            return ""
        path = None
        try:
            from dashscope.audio.asr import Recognition

            path = _write_wav_16k_mono(audio)
            recognition = Recognition(
                model=self.asr_model,
                format="wav",
                sample_rate=ASR_SAMPLE_RATE,
                callback=None,
            )
            result = recognition.call(path)
            return _parse_asr_result(result)
        except Exception as e:
            print(f"[ASR error] {e}")
            return ""
        finally:
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass

    def synthesize(self, text: str):
        """文字转语音，返回 (sample_rate, ndarray) 供 Gradio 播放。失败返回 None。"""
        if not text:
            return None
        try:
            from dashscope.audio.tts_v2 import SpeechSynthesizer

            synthesizer = SpeechSynthesizer(model=self.tts_model, voice=self.tts_voice)
            audio_bytes = synthesizer.call(text)
            if not audio_bytes:
                return None
            data, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
            return (sr, data)
        except Exception as e:
            print(f"[TTS error] {e}")
            return None
