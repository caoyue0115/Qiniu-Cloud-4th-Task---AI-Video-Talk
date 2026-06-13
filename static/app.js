// AI 视觉对话助手 —— 通话式前端逻辑
// 关键能力：星空动画、摄像头/麦克风、VAD 静音停顿自动触发、16k WAV 封装、持续抓帧

// ===== 星空生成 =====
function makeStars(layerId, count, sizeMax) {
  const layer = document.getElementById(layerId);
  for (let i = 0; i < count; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const size = Math.random() * sizeMax + 0.5;
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.setProperty('--dur', (Math.random() * 3 + 1.5) + 's');
    layer.appendChild(s);
  }
}
makeStars('stars', 80, 2);
makeStars('stars2', 40, 3);
makeStars('stars3', 20, 4);

// ===== 全局状态 =====
let mediaStream = null;
let audioCtx = null;
let analyser = null;
let recorderNode = null;
let frameTimer = null;
let recentFrames = [];      // 最近若干帧 data URL
let isProcessing = false;   // 正在请求后端
let ttsPlaying = false;     // TTS 播放中，避免自我触发
let pcmBuffer = [];         // 当前句的 PCM 累积
let recording = false;      // 是否正在累积有效语音
let silenceMs = 0;
let speechMs = 0;
let micSampleRate = 48000;

const SILENCE_THRESHOLD = 0.012;  // 音量阈值（RMS），低于视为静音
const SILENCE_HANG_MS = 1300;     // 停顿多久算一句结束
const MIN_SPEECH_MS = 400;        // 至少说这么久才算有效（滤掉杂音）
const FRAME_INTERVAL_MS = 700;    // 抓帧间隔
const MAX_FRAMES = 3;             // 最多保留帧数

const video = document.getElementById('video');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');
const answerBox = document.getElementById('answer-box');
const costPanel = document.getElementById('cost-panel');
const ttsPlayer = document.getElementById('tts-player');

function setStatus(text, color) {
  statusText.textContent = text;
  if (color) statusDot.style.background = color;
}

// ===== 语音播报：优先云端 CosyVoice（自然），失败回退浏览器本地语音 =====
let zhVoice = null;
function pickVoice() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  zhVoice = voices.find(v => /zh|chinese|cmn/i.test(v.lang) && /female|woman|xiao|mei|ting/i.test(v.name))
         || voices.find(v => /zh|chinese|cmn/i.test(v.lang))
         || voices[0] || null;
}
if (window.speechSynthesis) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

// 播报队列：CosyVoice 合成有延迟，用队列保证多句按序播放、不重叠
const ttsQueue = [];
let ttsBusy = false;

// speak: 朗读一句话。opts.interrupt=true 清空队列并打断当前。opts.onend 全部播完回调。
function speak(text, opts = {}) {
  if (!text) { if (opts.onend) opts.onend(); return; }
  if (opts.interrupt) {
    ttsQueue.length = 0;
    if (window.speechSynthesis) speechSynthesis.cancel();
    try { ttsPlayer.pause(); } catch (e) {}
  }
  ttsQueue.push({ text, onend: opts.onend });
  pumpQueue();
}

async function pumpQueue() {
  if (ttsBusy) return;
  const item = ttsQueue.shift();
  if (!item) return;
  ttsBusy = true;
  try {
    const mp3 = await synthCosyVoice(item.text);
    if (mp3) {
      await playMp3(mp3);
    } else {
      await speakLocal(item.text);   // 回退浏览器本地语音
    }
  } catch (e) {
    await speakLocal(item.text).catch(() => {});
  }
  ttsBusy = false;
  if (item.onend && ttsQueue.length === 0) item.onend();
  if (ttsQueue.length) pumpQueue();
}

// 调后端 CosyVoice，返回 mp3 base64（失败返回空）
async function synthCosyVoice(text) {
  try {
    const resp = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await resp.json();
    return data.audio_mp3_b64 || '';
  } catch (e) { return ''; }
}

function playMp3(b64) {
  return new Promise((resolve) => {
    ttsPlayer.src = 'data:audio/mp3;base64,' + b64;
    ttsPlayer.onended = resolve;
    ttsPlayer.onerror = resolve;
    ttsPlayer.play().catch(resolve);
  });
}

function speakLocal(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; u.rate = 1.05;
    if (zhVoice) u.voice = zhVoice;
    u.onend = resolve; u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

// ===== 接通 =====
const callBtn = document.getElementById('call-btn');
callBtn.addEventListener('click', startCall);

// 进入网页的引导。浏览器自动播放策略：用户首次交互前禁止出声，
// 故采用「视觉提示常驻（HTML 里的闪烁文字）+ 首次触摸即语音欢迎」双保险。
const WELCOME_TEXT = '欢迎使用 AI 视觉助手。请点击屏幕中间的接通按钮，开始通话。';
let welcomed = false;

function announceWelcome() {
  if (welcomed) return;
  welcomed = true;
  speak(WELCOME_TEXT, { interrupt: true });
}

// 先尝试直接发声（部分桌面浏览器允许）；移动端会被拦截，等首次触摸兜底
window.addEventListener('load', () => {
  setTimeout(() => { if (!welcomed) announceWelcome(); }, 300);
});

// 首次触摸兜底：若自动播放被拦，用户第一次碰屏幕即补播欢迎语。
// 若首次碰的就是「接通」按钮，则交给 startCall，不重复念欢迎语。
function firstInteractionFallback(e) {
  if (welcomed) return;
  if (e.target && e.target.closest && e.target.closest('#call-btn')) return;
  announceWelcome();
}
window.addEventListener('pointerdown', firstInteractionFallback);

async function startCall() {
  welcomed = true;   // 进入接通流程后不再念欢迎语
  // 点击反馈：告知正在请求权限，并提示在同一位置再次点击允许
  speak('正在开启摄像头和麦克风。如果弹出权限提示，请点击允许。', { interrupt: true });

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    speak('没有获得摄像头或麦克风权限。请刷新页面，在弹出的提示中点击允许。', { interrupt: true });
    showPermissionError(e);
    return;
  }

  // 切换到通话画面
  document.getElementById('startup').style.opacity = '0';
  setTimeout(() => { document.getElementById('startup').style.display = 'none'; }, 600);
  document.getElementById('call').style.display = 'block';

  video.srcObject = mediaStream;

  startFrameCapture();
  startVAD();
  setStatus('正在聆听…请说出你的问题', '#2ecc71');
  // 成功进入通话界面的语音提示
  speak('已接通。现在可以对准物品，直接说出你的问题，比如：这是什么。说完停顿一下，我就会回答。', { interrupt: true });
}

function showPermissionError(e) {
  const hint = document.getElementById('permission-hint');
  const msg = document.getElementById('permission-msg');
  let text = '需要摄像头和麦克风权限才能使用。<br>请在浏览器弹窗中点「允许」。';
  if (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    text += '<br><br>⚠️ 当前是 HTTP 访问，手机浏览器会禁用摄像头。<br>请改用 HTTPS 地址（如 cloudflared 隧道链接）。';
  }
  text += '<br><br><small>' + (e && e.name ? e.name : '') + '</small>';
  msg.innerHTML = text;
  hint.style.display = 'flex';
}

// ===== 持续抓帧 =====
function startFrameCapture() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  frameTimer = setInterval(() => {
    if (!video.videoWidth) return;
    // 缩放到 512 宽，降低上传体积与延迟
    const w = 512, h = Math.round(video.videoHeight * 512 / video.videoWidth);
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const url = canvas.toDataURL('image/jpeg', 0.72);
    recentFrames.push(url);
    if (recentFrames.length > MAX_FRAMES) recentFrames.shift();
  }, FRAME_INTERVAL_MS);
}

// ===== VAD：Web Audio 实时音量检测 =====
function startVAD() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  micSampleRate = audioCtx.sampleRate;
  const source = audioCtx.createMediaStreamSource(mediaStream);
  const processor = audioCtx.createScriptProcessor(2048, 1, 1);
  recorderNode = processor;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    // 计算 RMS 音量
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const frameMs = (input.length / micSampleRate) * 1000;

    // TTS 播放中或正在请求时不收音，避免自我触发
    if (ttsPlaying || isProcessing) { pcmBuffer = []; recording = false; speechMs = 0; silenceMs = 0; return; }

    if (rms > SILENCE_THRESHOLD) {
      // 有声音
      if (!recording) { recording = true; speechMs = 0; pcmBuffer = []; setStatus('正在聆听…', '#f1c40f'); }
      pcmBuffer.push(new Float32Array(input));
      speechMs += frameMs;
      silenceMs = 0;
    } else if (recording) {
      // 说话后的静音
      pcmBuffer.push(new Float32Array(input));
      silenceMs += frameMs;
      if (silenceMs >= SILENCE_HANG_MS) {
        // 一句话结束
        if (speechMs >= MIN_SPEECH_MS) {
          finalizeUtterance();
        } else {
          pcmBuffer = []; setStatus('正在聆听…请说出你的问题', '#2ecc71');
        }
        recording = false; speechMs = 0; silenceMs = 0;
      }
    }
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
}

// ===== 一句话结束：封装 WAV 并流式发送 =====
async function finalizeUtterance() {
  const chunks = pcmBuffer;
  pcmBuffer = [];
  if (!chunks.length) return;

  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }

  const wav16k = encodeWav16k(merged, micSampleRate);
  const b64 = arrayBufferToBase64(wav16k);

  isProcessing = true;
  ttsPlaying = true;   // 占用收音，避免边问边触发
  setStatus('正在看 · 正在思考…', '#3498db');
  answerBox.style.display = 'block';
  answerBox.innerHTML = '<div class="heard">🗣️ …</div><div class="ans"></div>';
  const ansEl = answerBox.querySelector('.ans');
  const heardEl = answerBox.querySelector('.heard');

  let spokenUpto = 0;   // 已朗读到的字符位置
  let fullAnswer = '';
  let answered = false;

  // 把已累积、未朗读、且以句末标点结尾的整句念出来
  function flushSpeech(force) {
    const pending = fullAnswer.slice(spokenUpto);
    if (!pending) return;
    // 找最后一个句末标点
    const m = pending.match(/^[\s\S]*[。！？!?，,；;\n]/);
    let seg = '';
    if (m) seg = m[0];
    else if (force) seg = pending;
    if (seg) {
      spokenUpto += seg.length;
      const clean = seg.replace(/[*#`>\-]/g, '').trim();
      if (clean) {
        setStatus('正在回答…', '#9b59b6');
        speak(clean);
      }
    }
  }

  try {
    const resp = await fetch('/api/talk_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_wav_b64: b64, frames: recentFrames.slice() })
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();   // 末尾可能是半条
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }

        if (evt.type === 'heard') {
          heardEl.textContent = '🗣️ ' + (evt.text || '');
        } else if (evt.type === 'delta') {
          answered = true;
          fullAnswer += evt.text;
          ansEl.textContent = fullAnswer;
          flushSpeech(false);
        } else if (evt.type === 'done') {
          flushSpeech(true);   // 念完剩余
          if (evt.cost) costPanel.textContent = evt.cost;
        } else if (evt.type === 'error') {
          ansEl.textContent = evt.text || '出错了';
          speak(evt.text || '出错了');
        }
      }
    }
  } catch (e) {
    console.error(e);
    setStatus('网络出错，请重试', '#e74c3c');
    speak('网络好像出问题了，请再说一遍。');
  }

  // 等浏览器把话说完再恢复收音，避免把自己的声音当成提问
  waitSpeechDone(() => {
    ttsPlaying = false; isProcessing = false;
    setStatus('正在聆听…请继续提问', '#2ecc71');
  });
}

// 轮询直到所有播报（CosyVoice 队列 + 浏览器本地）都结束
function waitSpeechDone(cb) {
  const timer = setInterval(() => {
    const localBusy = window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending);
    const queueBusy = ttsBusy || ttsQueue.length > 0;
    if (!localBusy && !queueBusy) {
      clearInterval(timer); cb();
    }
  }, 250);
  // 兜底：最多等 15 秒
  setTimeout(() => { clearInterval(timer); cb(); }, 15000);
}

// ===== WAV 编码（重采样到 16k 单声道 PCM16） =====
function encodeWav16k(samples, inRate) {
  const outRate = 16000;
  let data = samples;
  if (inRate !== outRate) {
    const ratio = inRate / outRate;
    const newLen = Math.round(samples.length / ratio);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const idx = i * ratio;
      const lo = Math.floor(idx), hi = Math.min(lo + 1, samples.length - 1);
      out[i] = samples[lo] + (samples[hi] - samples[lo]) * (idx - lo);
    }
    data = out;
  }
  const buffer = new ArrayBuffer(44 + data.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + data.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, data.length * 2, true);
  let off = 44;
  for (let i = 0; i < data.length; i++) {
    let s = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ===== 挂断 =====
document.getElementById('hangup-btn').addEventListener('click', hangup);
function hangup() {
  if (frameTimer) clearInterval(frameTimer);
  if (recorderNode) { try { recorderNode.disconnect(); } catch (e) {} }
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  document.getElementById('call').style.display = 'none';
  const su = document.getElementById('startup');
  su.style.display = 'flex';
  su.style.opacity = '1';
  recentFrames = []; pcmBuffer = []; recording = false; isProcessing = false; ttsPlaying = false;
  answerBox.style.display = 'none';
  // 挂断语音提示
  speak('通话已结束。需要时请再次点击接通按钮。', { interrupt: true });
}

// ===== 成本面板开关 =====
document.getElementById('cost-toggle').addEventListener('click', () => {
  costPanel.style.display = costPanel.style.display === 'block' ? 'none' : 'block';
});
