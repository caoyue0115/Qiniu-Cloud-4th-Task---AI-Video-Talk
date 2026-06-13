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

// 摄像头切换（含广角）
let videoDevices = [];      // 可用的后置摄像头 deviceId 列表
let curCamIdx = 0;          // 当前镜头索引
let switching = false;      // 切换中

// 模式：qa(默认问答) / nav(导航) / read(阅读) / chat(聊天)
let currentMode = 'qa';
let modeLoopTimer = null;   // 模式周期循环
let chatIdleTimer = null;   // 聊天空闲计时

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

// speakPrompt：提示/状态类播报。优先浏览器本地语音（即时）；
// 若没有可用的本地中文语音（很多手机如此），自动回退云端 CosyVoice，保证有声。
// 关键：无论如何都有超时兜底释放 ttsPlaying，绝不让 VAD 永久收不到音。
function speakPrompt(text, onend) {
  if (!text) { if (onend) onend(); return; }

  const voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  const hasLocalZh = !!zhVoice || voices.some(v => /zh|cmn|chinese/i.test(v.lang));

  // 没有本地中文语音 → 回退云端（和回答同一通道，有声保底）
  if (!window.speechSynthesis || !hasLocalZh) {
    ttsPlaying = true;
    speak(text, { interrupt: true });
    waitSpeechDone(() => { ttsPlaying = false; if (onend) onend(); });
    return;
  }

  // 本地语音
  try { speechSynthesis.cancel(); } catch (e) {}
  ttsPlaying = true;
  let released = false;
  const release = () => { if (released) return; released = true; ttsPlaying = false; if (onend) onend(); };
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN'; u.rate = 1.08;
  if (zhVoice) u.voice = zhVoice;
  u.onend = release; u.onerror = release;
  try { speechSynthesis.speak(u); } catch (e) { release(); return; }
  // 超时兜底：按字数从宽估算时长，仅在 onend 不触发时兜底，避免误打断正常播报
  setTimeout(release, 3000 + text.length * 300);
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
  speakPrompt(WELCOME_TEXT);   // 引导语走浏览器本地语音，即时可靠
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

// 在用户手势内解锁音频通道。手机浏览器要求音频/语音首次播放必须由用户交互触发，
// 否则之后所有云端语音(<audio>)和本地语音(speechSynthesis)都会被静音。
// 接通按钮不出提示音，但用一段无声音频解锁通道，保证后续回答能发声。
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const buf = encodeWav16k(new Float32Array(800), 16000);  // 约0.05秒静音
    ttsPlayer.src = 'data:audio/wav;base64,' + arrayBufferToBase64(buf);
    const p = ttsPlayer.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
  try {
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch (e) {}
}

async function startCall() {
  welcomed = true;   // 进入接通流程后不再念欢迎语
  unlockAudio();     // 必须在 await 之前（仍在点击手势内）解锁音频
  // 接通按钮本身不出提示音（屏幕阅读器旁白会朗读按钮）

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    speakPrompt('没有获得摄像头或麦克风权限。请刷新页面，在弹出的提示中点击允许。');
    showPermissionError(e);
    return;
  }

  // 切换到通话画面
  document.getElementById('startup').style.opacity = '0';
  setTimeout(() => { document.getElementById('startup').style.display = 'none'; }, 600);
  document.getElementById('call').style.display = 'block';

  video.srcObject = mediaStream;
  // 显式播放，修复部分手机首次进入黑屏（autoplay 不总是生效）
  try { await video.play(); } catch (e) {}

  startFrameCapture();
  startVAD();
  currentMode = 'qa'; setModeIndicator();
  setStatus('正在聆听…请说出你的问题', '#2ecc71');
  // 「正在聆听」提示走浏览器本地语音（即时，不受云端延迟影响）
  speakPrompt('正在聆听，请对准物品说出您的问题。可以说导航模式、阅读模式或聊天模式来切换。');

  // 枚举可用摄像头（含广角），决定是否显示切换按钮
  await setupCameras();
}

// 从镜头标签推断类型。手机广角/长焦在 label 里常有关键词；拿不到则返回空。
function lensName(label) {
  const s = label || '';
  if (/超广|ultra.?wide|ultrawide|0\.5\s*x?/i.test(s)) return '广角镜头';
  if (/广角/.test(s)) return '广角镜头';
  if (/长焦|tele|telephoto|[2-9]\s*[xX×]/.test(s)) return '长焦镜头';
  if (/主摄|\bmain\b/i.test(s)) return '主摄像头';
  return '';
}

// 枚举后置摄像头（保存 id+label 以判断镜头类型）。手机广角是独立镜头，靠切换 deviceId 访问。
async function setupCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const back = cams.filter(d => /back|rear|后|environment/i.test(d.label));
    const pool = (back.length ? back : cams).filter(d => d.deviceId);
    // 去重
    const seen = new Set();
    videoDevices = [];
    for (const d of pool) {
      if (seen.has(d.deviceId)) continue;
      seen.add(d.deviceId);
      videoDevices.push({ id: d.deviceId, label: d.label || '' });
    }

    // 当前正在用的镜头排到索引 0
    const curId = mediaStream.getVideoTracks()[0]?.getSettings?.().deviceId;
    const i = videoDevices.findIndex(d => d.id === curId);
    if (i > 0) { const [cur] = videoDevices.splice(i, 1); videoDevices.unshift(cur); }
    curCamIdx = 0;

    const btn = document.getElementById('cam-btn');
    if (btn) btn.style.display = videoDevices.length > 1 ? 'block' : 'none';
  } catch (e) {
    console.warn('enumerateDevices 失败', e);
  }
}

// 切换镜头：只换视频轨，保留麦克风与 VAD 不中断。提示音走浏览器本地语音（即时可靠）。
async function switchCamera() {
  if (switching || videoDevices.length < 2) return;
  switching = true;
  curCamIdx = (curCamIdx + 1) % videoDevices.length;
  const dev = videoDevices[curCamIdx];
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: dev.id }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    mediaStream.getVideoTracks().forEach(t => { t.stop(); mediaStream.removeTrack(t); });
    mediaStream.addTrack(newStream.getVideoTracks()[0]);
    video.srcObject = mediaStream;
    try { await video.play(); } catch (e) {}
    // 能从标签判断就报具体类型，判断不出就只报第几个镜头（不瞎猜广角）
    const name = lensName(dev.label) || ('第' + (curCamIdx + 1) + '个镜头');
    speakPrompt('已切换到' + name);
  } catch (e) {
    console.warn('切换镜头失败', e);
    speakPrompt('这个镜头切换失败了，请再点一次试试其他镜头');
  }
  switching = false;
}

// ===== 模式状态机 =====
const MODE_NAMES = { qa: '问答模式', nav: '导航模式', read: '阅读模式', chat: '聊天模式' };

function setModeIndicator() {
  const el = document.getElementById('mode-indicator');
  if (el) el.textContent = MODE_NAMES[currentMode] || '问答模式';
}

function stopModeLoops() {
  if (modeLoopTimer) { clearInterval(modeLoopTimer); modeLoopTimer = null; }
  if (chatIdleTimer) { clearTimeout(chatIdleTimer); chatIdleTimer = null; }
  reading = false;
}

function enterMode(mode) {
  if (!MODE_NAMES[mode]) mode = 'qa';
  stopModeLoops();
  currentMode = mode;
  setModeIndicator();

  if (mode === 'qa') {
    speakPrompt('已退出，回到问答模式。请直接说出您的问题。');
  } else if (mode === 'chat') {
    speakPrompt('已进入聊天模式，我们随便聊聊。', () => { ttsPlaying = false; scheduleChat(2000); });
  } else if (mode === 'read') {
    speakPrompt('已进入阅读模式，请把摄像头对准文字。');   // PR-B 接入循环
  } else if (mode === 'read') {
    speakPrompt('已进入阅读模式，请把摄像头对准文字，我会自动朗读。',
                () => { ttsPlaying = false; startReading(); });
  } else if (mode === 'nav') {
    speakPrompt('已进入导航模式，我会提醒前方的危险。');   // PR-C 接入循环
  }
}

// ===== 阅读模式：自动朗读 + 翻页检测 =====
const _sigCanvas = document.createElement('canvas');
const _sigCtx = _sigCanvas.getContext('2d');
let readLastSig = null;     // 上次朗读那一帧的指纹
let readPrevSig = null;     // 上一 tick 的指纹（判稳定）
let reading = false;        // 正在朗读

// 取当前画面的低分辨率灰度指纹（用于翻页检测）
function videoSignature() {
  if (!video.videoWidth) return null;
  const S = 32;
  _sigCanvas.width = S; _sigCanvas.height = S;
  _sigCtx.drawImage(video, 0, 0, S, S);
  const d = _sigCtx.getImageData(0, 0, S, S).data;
  const g = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  }
  return g;
}

function sigDiff(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length / 255;   // 0~1
}

function startReading() {
  readLastSig = null; readPrevSig = null;
  // 立即读一次，然后周期检测翻页
  readPage();
  modeLoopTimer = setInterval(() => {
    if (currentMode !== 'read' || reading || isProcessing) return;
    const sig = videoSignature();
    if (!sig) return;
    const changedVsRead = sigDiff(sig, readLastSig);   // 和已读那页比
    const stableNow = sigDiff(sig, readPrevSig) < 0.04; // 当前画面稳定（翻完了）
    readPrevSig = sig;
    // 画面相对已读页大幅变化 且 已稳定 → 翻页了，重新朗读
    if (changedVsRead > 0.14 && stableNow) {
      speakPrompt('检测到翻页，正在朗读', () => { ttsPlaying = false; readPage(); });
    }
  }, 1200);
}

async function readPage() {
  if (currentMode !== 'read' || reading) return;
  const frame = captureFrameNow();
  if (!frame) return;
  reading = true; isProcessing = true; ttsPlaying = true;
  readLastSig = videoSignature();   // 记录这一页指纹
  setStatus('正在朗读…', '#9b59b6');
  try {
    const resp = await fetch('/api/scene', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'read', frames: [frame] })
    });
    const data = await resp.json();
    if (data.cost) costPanel.textContent = data.cost;
    const text = (data.text || '').trim();
    answerBox.style.display = 'block';
    answerBox.innerHTML = '<div class="ans"></div>';
    answerBox.querySelector('.ans').textContent = text || '没有看到清晰的文字';
    // 阅读用云端 CosyVoice（长文更清晰自然）
    speak(text || '没有看到清晰的文字，请把摄像头对准文字内容。', { interrupt: true });
    waitSpeechDone(() => {
      reading = false; isProcessing = false; ttsPlaying = false;
      if (currentMode === 'read' && text) {
        speakPrompt('这一页读完了，翻页后我会继续。', () => { ttsPlaying = false; });
      }
    });
  } catch (e) {
    reading = false; isProcessing = false; ttsPlaying = false;
  }
}

// ===== 聊天模式：AI 主动找话题 =====
function scheduleChat(delay) {
  if (currentMode !== 'chat') return;
  chatIdleTimer = setTimeout(runChatTopic, delay);
}

async function runChatTopic() {
  if (currentMode !== 'chat' || isProcessing) { scheduleChat(4000); return; }
  const frame = captureFrameNow();
  if (!frame) { scheduleChat(3000); return; }
  isProcessing = true; ttsPlaying = true;
  try {
    const resp = await fetch('/api/scene', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', frames: [frame] })
    });
    const data = await resp.json();
    if (data.cost) costPanel.textContent = data.cost;
    const text = (data.text || '').trim();
    if (text && currentMode === 'chat') {
      answerBox.style.display = 'block';
      answerBox.innerHTML = '<div class="ans"></div>';
      answerBox.querySelector('.ans').textContent = text;
      speak(text, { interrupt: true });   // 聊天用云端 CosyVoice，更自然
      waitSpeechDone(() => { ttsPlaying = false; isProcessing = false; scheduleChat(9000); });
    } else {
      ttsPlaying = false; isProcessing = false; scheduleChat(6000);
    }
  } catch (e) {
    ttsPlaying = false; isProcessing = false; scheduleChat(8000);
  }
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

// ===== 抓帧 =====
const _capCanvas = document.createElement('canvas');
const _capCtx = _capCanvas.getContext('2d');

// 抓当前这一刻的画面，返回 data URL（拿不到画面返回 null）
function captureFrameNow() {
  if (!video.videoWidth) return null;
  const w = 640, h = Math.round(video.videoHeight * 640 / video.videoWidth);
  _capCanvas.width = w; _capCanvas.height = h;
  _capCtx.drawImage(video, 0, 0, w, h);
  return _capCanvas.toDataURL('image/jpeg', 0.78);
}

function startFrameCapture() {
  frameTimer = setInterval(() => {
    const url = captureFrameNow();
    if (!url) return;
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

  let fullAnswer = '';
  let errored = false;
  let modeSwitch = null;   // 收到模式切换指令

  // 当前模式参与请求（后端据此识别指令上下文）
  // 抓「此刻」的画面作为主画面，保证所见即所问（避免用到旧帧导致答非所见）
  const freshFrame = captureFrameNow();
  const framesToSend = recentFrames.slice();
  if (freshFrame) framesToSend.push(freshFrame);   // 放最后 = 服务端取的 latest

  try {
    const resp = await fetch('/api/talk_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_wav_b64: b64, frames: framesToSend })
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
        } else if (evt.type === 'mode') {
          modeSwitch = evt.mode;
        } else if (evt.type === 'delta') {
          fullAnswer += evt.text;
          ansEl.textContent = fullAnswer;   // 文字实时显示
        } else if (evt.type === 'done') {
          if (evt.cost) costPanel.textContent = evt.cost;
        } else if (evt.type === 'error') {
          errored = true;
          ansEl.textContent = evt.text || '出错了';
          fullAnswer = evt.text || '出错了';
        }
      }
    }
  } catch (e) {
    console.error(e);
    errored = true;
    setStatus('网络出错，请重试', '#e74c3c');
    fullAnswer = '网络好像出问题了，请再说一遍。';
  }

  // 收到模式切换指令：切换模式，不走问答播报
  if (modeSwitch) {
    isProcessing = false;
    enterMode(modeSwitch);
    waitSpeechDone(() => { ttsPlaying = false; });
    return;
  }

  // 回答整段一次性播报：端侧优先（更快），无本地语音时自动回退云端。
  // 播完后提示「可继续提问」，再恢复收音。
  const toSpeak = fullAnswer.replace(/[*#`>\-]/g, '').trim() || '我没有看清，请再说一遍。';
  if (!errored) setStatus('正在回答…', '#9b59b6');
  speakPrompt(toSpeak, () => {
    isProcessing = false;
    setStatus('正在聆听…请继续提问', '#2ecc71');
    speakPrompt('您可以继续提问', () => { ttsPlaying = false; });
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
  stopModeLoops(); currentMode = 'qa'; setModeIndicator();
  recentFrames = []; pcmBuffer = []; recording = false; isProcessing = false; ttsPlaying = false;
  videoDevices = []; curCamIdx = 0; switching = false;
  answerBox.style.display = 'none';
  // 挂断不出提示音（屏幕阅读器旁白会朗读按钮状态）
  if (window.speechSynthesis) speechSynthesis.cancel();
}

// ===== 成本面板开关 =====
document.getElementById('cost-toggle').addEventListener('click', () => {
  costPanel.style.display = costPanel.style.display === 'block' ? 'none' : 'block';
});

// ===== 切换镜头（含广角） =====
const camBtn = document.getElementById('cam-btn');
if (camBtn) camBtn.addEventListener('click', switchCamera);
