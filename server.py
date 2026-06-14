"""AI 视觉对话助手 —— 通话式 FastAPI 服务（面向视障人士）。

相比 Gradio 版（app.py），这一版提供"视频通话"体验：
  - 开机星空画面 + 大号接通按钮
  - 接通后自动开启摄像头麦克风，静音停顿自动触发识别（前端 VAD）
  - 仿通话界面，底部挂断键，无打字框
  - 复杂场景多帧识别（路由决定帧数）

后端逻辑 100% 复用 modules/。监听 0.0.0.0 以便 cloudflared 隧道转发到手机。

运行：
    python server.py
    # 本地：http://127.0.0.1:8000
    # 手机/分享：用 cloudflared 开隧道（见 README 部署说明）
"""
import sys
import base64
import io
import asyncio
import queue as _queue

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import numpy as np
from PIL import Image
from fastapi import FastAPI, Body, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import json as _json
import uvicorn

from utils import config
from modules.vision import VisionModule
from modules.speech import SpeechModule
from modules.color_detector import ColorDetector
from modules.router import ModelRouter
from modules.cache import ResponseCache
from modules.cost_tracker import CostTracker
from modules.context import ConversationContext
from modules.mode_prompts import MODE_PROMPTS, detect_mode_command, OMNI_INSTRUCTIONS
from modules.asr_stream import StreamingASR

vision = VisionModule()
speech = SpeechModule()
color_detector = ColorDetector()
router = ModelRouter()
cache = ResponseCache()
cost_tracker = CostTracker()
context = ConversationContext()

app = FastAPI(title="AI 视觉对话助手")
app.mount("/static", StaticFiles(directory="static"), name="static")


def _decode_data_url_image(data_url: str):
    """把前端的 data:image/jpeg;base64,... 解码成 RGB ndarray。"""
    if not data_url or "," not in data_url:
        return None
    try:
        b64 = data_url.split(",", 1)[1]
        raw = base64.b64decode(b64)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return np.array(img)
    except Exception as e:
        print(f"[image decode error] {e}")
        return None


def _fingerprint(image) -> str:
    if image is None:
        return "none"
    import hashlib
    small = image[::16, ::16]
    return hashlib.md5(small.tobytes()).hexdigest()[:16]


import os as _os

_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}


def _serve_html(path, jsfiles):
    """读 HTML，给引用的 js 自动加上 ?v=<文件修改时间> 强制刷新缓存，并禁用 HTML 缓存。"""
    with open(path, encoding="utf-8") as f:
        html = f.read()
    for js in jsfiles:
        try:
            mt = int(_os.path.getmtime(f"static/{js}"))
        except OSError:
            mt = 0
        html = html.replace(f'/static/{js}"', f'/static/{js}?v={mt}"')
    return HTMLResponse(html, headers=_NO_CACHE)


@app.get("/", response_class=HTMLResponse)
def showcase():
    """展示页（评委入口）：产品介绍 + 手机样机嵌入真实 app + 实时仪表盘。"""
    return _serve_html("static/showcase.html", ["showcase.js"])


@app.get("/app", response_class=HTMLResponse)
def app_page():
    """真实通话 app（嵌入展示页的手机样机 iframe 中运行）。"""
    return _serve_html("static/index.html", ["app.js"])


@app.get("/api/health")
def health():
    return {"ok": config.ensure_api_key()}


@app.post("/api/talk")
def talk(payload: dict = Body(...)):
    """核心通话接口。

    入参 JSON：
      - audio_wav_b64: 16k 单声道 WAV 的 base64（前端 VAD 切出的一句话）
      - frames: [data_url, ...] 最近若干帧画面
    返回：识别到的问题、AI 回答文本、回答语音(MP3 base64)、成本报告。
    """
    cost_tracker.new_request()

    # 1. 解析画面帧
    frames_in = payload.get("frames") or []
    frames = [_decode_data_url_image(f) for f in frames_in]
    frames = [f for f in frames if f is not None]
    latest = frames[-1] if frames else None

    # 2. 语音识别
    audio_b64 = payload.get("audio_wav_b64", "")
    user_text = ""
    if audio_b64:
        try:
            wav_bytes = base64.b64decode(audio_b64)
            user_text = speech.transcribe_wav_bytes(wav_bytes)
            cost_tracker.log("asr")
        except Exception as e:
            print(f"[talk asr error] {e}")

    if not user_text:
        msg = "我没有听清，请再说一遍。"
        return _reply("（未识别到）", msg, speak=False)

    context.add("user", user_text)

    # 3. 缓存
    cache_key = ResponseCache.make_key(user_text, _fingerprint(latest))
    cached = cache.get(cache_key)
    if cached:
        cost_tracker.log("cache_hit")
        context.add("assistant", cached)
        return _reply(user_text, cached)

    # 4. 路由：决定路径与帧数
    route = router.classify(user_text)
    if route == "color":
        # 颜色识别：真实摄像头下端侧 HSV 易受白平衡/反光干扰，改走云端 VL 更准
        result = vision.identify(latest, user_text, model="mini")
        cost_tracker.log("mini")
    elif route in ("text", "simple"):
        result = vision.identify(latest, user_text, model="mini")
        cost_tracker.log("mini")
    else:  # complex：用多帧（最多3帧）理解场景
        multi = frames[-3:] if len(frames) >= 2 else latest
        result = vision.identify(multi, user_text, model="full")
        cost_tracker.log("full")
        # 多帧额外计入图像成本（每多一帧约等于再走一次 full 的图像部分）
        extra = (len(multi) - 1) if isinstance(multi, list) else 0
        for _ in range(max(0, extra)):
            cost_tracker.log("full")

    cache.set(cache_key, result)
    context.add("assistant", result)
    context.set_image_desc(result)
    return _reply(user_text, result)


def _reply(heard: str, text: str, speak: bool = True):
    """统一构造返回：含 TTS 语音字节。"""
    audio_b64 = ""
    if speak:
        audio_bytes = speech.synthesize_bytes(text)
        if audio_bytes:
            audio_b64 = base64.b64encode(audio_bytes).decode()
            cost_tracker.log("tts")
    return JSONResponse({
        "heard": heard,
        "answer": text,
        "audio_mp3_b64": audio_b64,
        "cost": cost_tracker.get_report(),
    })


@app.post("/api/talk_stream")
def talk_stream(payload: dict = Body(...)):
    """流式通话接口（SSE）。

    边生成边返回文本增量，前端用浏览器本地语音即时播报，大幅降低感知延迟。
    事件类型：
      {"type":"heard","text":...}    识别到的问题
      {"type":"delta","text":...}    回答文本增量
      {"type":"done","cost":...}     结束，附成本
      {"type":"error","text":...}    出错
    """
    cost_tracker.new_request()

    frames_in = payload.get("frames") or []
    frames = [_decode_data_url_image(f) for f in frames_in]
    frames = [f for f in frames if f is not None]
    latest = frames[-1] if frames else None

    # 优先用前端流式 ASR 已识别好的文字（省掉服务端再识别的~1秒）
    user_text = (payload.get("text") or "").strip()
    audio_b64 = payload.get("audio_wav_b64", "")
    if not user_text and audio_b64:
        try:
            user_text = speech.transcribe_wav_bytes(base64.b64decode(audio_b64))
            cost_tracker.log("asr")
        except Exception as e:
            print(f"[stream asr error] {e}")
    elif user_text:
        cost_tracker.log("asr")

    def gen():
        if not user_text:
            yield _sse({"type": "heard", "text": "（未识别到）"})
            yield _sse({"type": "delta", "text": "我没有听清，请再说一遍。"})
            yield _sse({"type": "done", "cost": cost_tracker.get_report()})
            return

        yield _sse({"type": "heard", "text": user_text})

        # 模式指令：命中则只发模式切换事件，不走问答
        mode_cmd = detect_mode_command(user_text)
        if mode_cmd is not None:
            yield _sse({"type": "mode", "mode": mode_cmd})
            yield _sse({"type": "done", "cost": cost_tracker.get_report()})
            return

        # 看图问答也带上最近对话记忆（与聊天共用同一 context），实现多轮追问、与聊天互通不割裂
        ctx_before = context.as_context_string()
        context.add("user", user_text)

        # 缓存命中：直接整段返回
        cache_key = ResponseCache.make_key(user_text, _fingerprint(latest))
        cached = cache.get(cache_key)
        if cached:
            cost_tracker.log("cache_hit")
            context.add("assistant", cached)
            yield _sse({"type": "delta", "text": cached})
            yield _sse({"type": "done", "cost": cost_tracker.get_report()})
            return

        # 路由决定模型与帧数
        route = router.classify(user_text)
        if route in ("color", "text", "simple"):
            model, img = "mini", latest
            cost_tracker.log("mini")
        else:
            model = "full"
            img = frames[-3:] if len(frames) >= 2 else latest
            cost_tracker.log("full")
            extra = (len(img) - 1) if isinstance(img, list) else 0
            for _ in range(max(0, extra)):
                cost_tracker.log("full")

        # 带上最近对话作为参考（支持"这个能吃吗""那再放几粒"等追问，并与聊天记忆互通）
        q = user_text
        if ctx_before:
            q = f"（参考最近对话：{ctx_before}）\n用户现在说：{user_text}"

        full = ""
        for delta in vision.identify_stream(img, q, model=model):
            full += delta
            yield _sse({"type": "delta", "text": delta})

        full = full.strip()
        if full:
            cache.set(cache_key, full)
            context.add("assistant", full)
            context.set_image_desc(full)
        yield _sse({"type": "done", "cost": cost_tracker.get_report()})

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/tts")
def tts(payload: dict = Body(...)):
    """文字转语音：返回 CosyVoice 合成的 MP3（base64）。

    供前端统一播报引导语与回答，音质自然。失败返回空串，前端可回退本地语音。
    """
    text = (payload.get("text") or "").strip()
    if not text:
        return JSONResponse({"audio_mp3_b64": ""})
    audio_bytes = speech.synthesize_bytes(text)
    if not audio_bytes:
        return JSONResponse({"audio_mp3_b64": ""})
    cost_tracker.log("tts")
    return JSONResponse({"audio_mp3_b64": base64.b64encode(audio_bytes).decode()})


@app.post("/api/asr")
def asr(payload: dict = Body(...)):
    """一次性语音识别：接收 16k 单声道 WAV(base64)，返回识别文字。

    稳定可靠（不依赖长连接），供前端拿到文字后做模式分流。
    """
    audio_b64 = payload.get("audio_wav_b64", "")
    if not audio_b64:
        return JSONResponse({"text": ""})
    try:
        text = speech.transcribe_wav_bytes(base64.b64decode(audio_b64))
        cost_tracker.log("asr")
        return JSONResponse({"text": text or ""})
    except Exception as e:
        print(f"[api asr error] {e}")
        return JSONResponse({"text": ""})


@app.post("/api/scene")
def scene(payload: dict = Body(...)):
    """模式场景理解：按 mode 用不同 prompt 描述画面。

    入参：{mode: 'nav'|'read'|'chat', frames: [data_url,...]}
    返回：{text, cost}。导航无危险时 text 可能为空字符串。
    """
    cost_tracker.new_request()
    mode = payload.get("mode", "")
    prompt = MODE_PROMPTS.get(mode)
    if not prompt:
        return JSONResponse({"text": "", "cost": cost_tracker.get_report()})

    frames_in = payload.get("frames") or []
    frames = [_decode_data_url_image(f) for f in frames_in]
    frames = [f for f in frames if f is not None]
    if not frames:
        return JSONResponse({"text": "", "cost": cost_tracker.get_report()})

    # 全部用小模型(qwen-vl-plus)：延迟更低更省；OCR/聊天/导航精度足够
    if mode == "read":
        model, mx = "mini", 400
    elif mode == "chat":
        model, mx = "mini", 120
    else:  # nav
        model, mx = "mini", 80

    # 聊天：区分「用户说话→自然回应」与「主动找话题」
    user_hint = ""
    if mode == "chat":
        ctx = context.as_context_string()
        user_said = (payload.get("text") or "").strip()
        if user_said:
            context.add("user", user_said)
            user_hint = (f"用户刚对你说：「{user_said}」。请像朋友聊天一样自然地接住他这句话、聊下去，"
                         f"重点是回应他说的内容（可以结合你看到的画面，但不要只描述画面），"
                         f"1到2句，口语化，可以反问。最近对话：{ctx}")
        else:
            user_hint = f"主动找个轻松话题或评论眼前画面，引导聊下去，别重复之前说过的。最近对话：{ctx}"

    text = vision.describe(frames if mode == "nav" else frames[-1],
                           user_hint, prompt, model=model, max_tokens=mx)
    cost_tracker.log("full" if model == "full" else "mini")

    # 导航的"前方安全"不必每次播报，交给前端去重；这里原样返回
    if mode == "chat" and text:
        context.add("assistant", text)
    return JSONResponse({"text": text or "", "cost": cost_tracker.get_report()})


@app.websocket("/ws/asr")
async def ws_asr(ws: WebSocket):
    """流式语音识别。

    前端在用户开始说话时连上，逐帧发送 16k 单声道 PCM(int16) 二进制；
    说完发送文本消息 "end"，服务端返回 {"type":"final","text":...}。
    边说边识别，说完即拿到文字，省掉服务端一次性识别的约 1 秒。
    """
    await ws.accept()
    asr = None
    try:
        while True:
            msg = await ws.receive()
            if "bytes" in msg and msg["bytes"] is not None:
                if asr is None:
                    asr = StreamingASR()
                    asr.start()
                asr.feed(msg["bytes"])
            elif "text" in msg and msg["text"] is not None:
                cmd = msg["text"]
                if cmd == "end":
                    text = asr.finish() if asr else ""
                    asr = None
                    await ws.send_text(_json.dumps({"type": "final", "text": text}, ensure_ascii=False))
                elif cmd == "close":
                    break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[ws_asr error] {e}")
    finally:
        if asr is not None:
            try:
                asr.finish()
            except Exception:
                pass


@app.websocket("/ws/realtime")
async def ws_realtime(ws: WebSocket):
    """实时模式：浏览器 ↔ 本服务 ↔ 通义千问 Omni-Realtime 的 WebSocket 中继。

    浏览器持续发送 {type:'audio'|'video', data:<base64>} 与控制消息；
    服务端转发给 Omni（输入 16k PCM、JPEG 帧），并把 Omni 的流式
    文字/音频/转写事件回传浏览器。API Key 只在服务端，不暴露给前端。
    """
    from dashscope.audio.qwen_omni import (
        OmniRealtimeConversation, OmniRealtimeCallback, MultiModality, AudioFormat)

    await ws.accept()
    outq = _queue.Queue()      # Omni 回调线程 → 浏览器（线程安全）
    state = {"closed": False}

    class CB(OmniRealtimeCallback):
        def on_open(self):
            outq.put({"type": "ready"})
        def on_close(self, *a):
            outq.put({"type": "omni_closed"})
        def on_event(self, e):
            et = e.get("type", "")
            if et == "response.audio.delta":
                outq.put({"type": "audio", "data": e.get("delta", "")})
            elif et == "response.audio_transcript.delta":
                outq.put({"type": "ai_text", "delta": e.get("delta", "")})
            elif et == "conversation.item.input_audio_transcription.completed":
                outq.put({"type": "user_text", "text": e.get("transcript", "")})
            elif et == "input_audio_buffer.speech_started":
                outq.put({"type": "user_speaking"})   # 用户开口 → 前端可停播打断
            elif et == "input_audio_buffer.committed":
                state["frame"] = None   # 本轮已提交，丢弃残留画面帧，下一轮重新音频先行
            elif et == "response.done":
                outq.put({"type": "done"})
            elif "error" in et.lower():
                print(f"[omni ERROR] {e}", flush=True)   # 完整错误打进日志便于排查
                outq.put({"type": "error", "message": str(e.get("error", e))})
            else:
                print(f"[omni event] {et}", flush=True)   # 其他事件类型，帮助确认模型是否在产出

    async def drain():
        while not state["closed"]:
            sent = False
            try:
                while True:
                    await ws.send_json(outq.get_nowait())
                    sent = True
            except _queue.Empty:
                pass
            await asyncio.sleep(0.005 if sent else 0.02)

    conv = None
    drain_task = asyncio.create_task(drain())
    try:
        conv = OmniRealtimeConversation(
            model=config.OMNI_MODEL, callback=CB(), api_key=config.DASHSCOPE_API_KEY)
        conv.connect()
        conv.update_session(
            output_modalities=[MultiModality.TEXT, MultiModality.AUDIO],
            voice=config.OMNI_VOICE,
            input_audio_format=AudioFormat.PCM_16000HZ_MONO_16BIT,
            output_audio_format=AudioFormat.PCM_24000HZ_MONO_16BIT,
            enable_input_audio_transcription=True,
            enable_turn_detection=True,
            turn_detection_type="server_vad",
            instructions=OMNI_INSTRUCTIONS,
        )
        cost_tracker.new_request()
        cost_tracker.log("full")   # 实时会话计一次（粗略，便于成本面板展示）
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            txt = msg.get("text")
            if not txt:
                continue
            d = _json.loads(txt)
            t = d.get("type")
            if t == "audio":
                conv.append_audio(d.get("data", ""))
                # 紧跟最近一帧画面：图像总排在音频之后、进同一缓冲区，
                # 结构性避开"缓冲区刚提交→committed 事件尚未回传"窗口里图像先于音频的竞态
                vid = state.get("frame")
                if vid:
                    conv.append_video(vid)
                    state["frame"] = None
            elif t == "video":
                state["frame"] = d.get("data", "")   # 仅暂存，待下一个音频到达再一并发出
            elif t == "cancel":
                try: conv.cancel_response()
                except Exception: pass
            elif t == "close":
                break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[ws_realtime error] {e}")
    finally:
        state["closed"] = True
        drain_task.cancel()
        if conv is not None:
            try: conv.close()
            except Exception: pass


def _sse(obj: dict) -> str:
    return "data: " + _json.dumps(obj, ensure_ascii=False) + "\n\n"


if __name__ == "__main__":
    if not config.ensure_api_key():
        print("⚠️ 未检测到有效的 DASHSCOPE_API_KEY，请在 .env 中配置后重启。")
    print("启动通话服务：http://127.0.0.1:8000")
    print("（手机访问请用 cloudflared 开隧道，见 README 部署说明）")
    uvicorn.run(app, host="0.0.0.0", port=8000)
