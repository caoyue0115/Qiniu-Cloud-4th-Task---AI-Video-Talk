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
let bgBusy = false;         // 后台图像识别(导航/聊天)在途——不屏蔽麦克风，与语音识别并行

// 语速倍率（盲人常偏好快语速），范围 0.6~2.0，本地持久化
let speechRate = parseFloat(localStorage.getItem('speechRate') || '1') || 1;
speechRate = Math.min(2.0, Math.max(0.6, speechRate));

let lastAnswer = '';   // 上一次的 AI 回答，供「再说一遍」重播
const HELP_TEXT = '你可以直接说出问题，比如这是什么、这是什么颜色、帮我读验证码。' +
  '可以说导航模式、阅读模式、聊天模式来切换，说退出回到问答。' +
  '还可以说再说一遍来重听，说说快点或说慢点来调节语速。';

const SILENCE_THRESHOLD = 0.012;  // 音量阈值（RMS），低于视为静音
const SILENCE_HANG_MS = 850;      // 停顿多久算一句结束（越小越快触发）
const MIN_SPEECH_MS = 400;        // 至少说这么久才算有效（滤掉杂音）
const FRAME_INTERVAL_MS = 700;    // 抓帧间隔
const MAX_FRAMES = 3;             // 最多保留帧数

// 语音打断（barge-in）：AI 朗读时用户开口可打断
const BARGE_THRESHOLD = 0.05;     // 打断阈值（高于静音阈值，避开AI漏音）
const BARGE_HANG_MS = 240;        // 持续这么久的较大音量才算用户打断
let bargeMs = 0;
let aiSpeaking = false;            // AI 正在朗读回答/内容（可被打断；区别于"思考中"）

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

// 触觉反馈：盲人靠听+触确认状态，震动给非视觉提示（仅安卓支持，iOS 自动忽略）
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
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
let ttsAbort = false;   // 被打断时置位，丢弃在途/排队的播报

// 立即停止一切播报（语音打断时调用）
function stopAllSpeech() {
  ttsAbort = true;
  ttsQueue.length = 0;
  ttsBusy = false;
  try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
  try { ttsPlayer.pause(); } catch (e) {}
}

// speak: 朗读一句话。opts.interrupt=true 清空队列并打断当前。opts.onend 全部播完回调。
function speak(text, opts = {}) {
  if (!text) { if (opts.onend) opts.onend(); return; }
  ttsAbort = false;   // 新的主动播报，解除打断态
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
    if (ttsAbort) { ttsBusy = false; return; }   // 合成期间被打断，丢弃
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
    try { ttsPlayer.playbackRate = speechRate; } catch (e) {}   // 云端语音按倍率加速
    ttsPlayer.onended = resolve;
    ttsPlayer.onerror = resolve;
    ttsPlayer.play().catch(resolve);
  });
}

function speakLocal(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; u.rate = Math.min(2, 1.05 * speechRate);
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
  ttsAbort = false;   // 新的主动播报，解除打断态

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
  u.lang = 'zh-CN'; u.rate = Math.min(2, 1.08 * speechRate);
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
  if (e.target && e.target.closest && (e.target.closest('#call-btn') || e.target.closest('#rt-btn'))) return;
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

// ===== 客户端语音指令（语速等，本地处理不走云端）=====
// 返回 true 表示已作为指令处理，调用方不再发给 AI。
function handleClientCommand(text) {
  if (!text) return false;
  const t = text.replace(/[，。！？、\s]/g, '');

  // 语速调节
  if (/(说快点|快一点|语速快|快点说|加快语速|再快点)/.test(t)) {
    speechRate = Math.min(2.0, speechRate + 0.25);
    localStorage.setItem('speechRate', String(speechRate));
    isProcessing = false; ttsPlaying = false;
    speakPrompt('好的，说快一点。', () => { ttsPlaying = false; });
    return true;
  }
  if (/(说慢点|慢一点|语速慢|慢点说|放慢语速|再慢点)/.test(t)) {
    speechRate = Math.max(0.6, speechRate - 0.25);
    localStorage.setItem('speechRate', String(speechRate));
    isProcessing = false; ttsPlaying = false;
    speakPrompt('好的，说慢一点。', () => { ttsPlaying = false; });
    return true;
  }
  if (/(正常语速|语速正常|恢复语速|语速复位)/.test(t)) {
    speechRate = 1.0;
    localStorage.setItem('speechRate', String(speechRate));
    isProcessing = false; ttsPlaying = false;
    speakPrompt('语速已恢复正常。', () => { ttsPlaying = false; });
    return true;
  }

  // 再说一遍：重播上一次回答
  if (/(再说一遍|再说一次|重复一遍|没听清|再读一遍|重听)/.test(t)) {
    isProcessing = false;
    if (lastAnswer) {
      speakPrompt(lastAnswer, () => { ttsPlaying = false; });
    } else {
      ttsPlaying = false;
      speakPrompt('还没有可以重复的内容，请先提问。', () => { ttsPlaying = false; });
    }
    return true;
  }

  // 帮助：语音列出功能
  if (/(我能做什么|能做什么|有什么功能|怎么用|帮助|使用说明|功能介绍)/.test(t)) {
    isProcessing = false;
    speakPrompt(HELP_TEXT, () => { ttsPlaying = false; });
    return true;
  }
  return false;
}

// 客户端识别模式进入/退出指令（与后端关键词一致），返回 'nav'|'read'|'chat'|'qa' 或 null
function detectModeCommand(text) {
  const t = (text || '').replace(/[，。！？、\s]/g, '');
  if (/(退出模式|退出导航|退出阅读|退出聊天|返回问答|普通模式|问答模式|结束模式|退出|返回)/.test(t)) return 'qa';
  if (/(导航模式|开始导航|进入导航|带我走|帮我导航)/.test(t)) return 'nav';
  if (/(阅读模式|朗读模式|进入阅读|读这一页|阅读这个)/.test(t)) return 'read';
  if (/(聊天模式|进入聊天|陪我聊|陪我说话|我们聊聊)/.test(t)) return 'chat';
  return null;
}

// 识别"让它看画面"的意图（聊天模式里据此调用看图说话，二者不对立）
function isVisionRequest(text) {
  const t = (text || '').replace(/[，。！？、\s]/g, '');
  return /(看看|看一下|看下|瞧瞧|帮我看|这是什么|那是什么|是什么东西|什么颜色|周围|前面|前方|有什么|读一下|念一下|描述|认一下|几个)/.test(t);
}

// ===== 模式状态机 =====
const MODE_NAMES = { qa: '问答模式', nav: '导航模式', read: '阅读模式', chat: '聊天模式' };

function setModeIndicator(override) {
  const el = document.getElementById('mode-indicator');
  if (el) el.textContent = override || MODE_NAMES[currentMode] || '问答模式';
}

function stopModeLoops() {
  if (modeLoopTimer) { clearInterval(modeLoopTimer); modeLoopTimer = null; }
  if (chatIdleTimer) { clearTimeout(chatIdleTimer); chatIdleTimer = null; }
  reading = false;
  navRunning = false;
  aiSpeaking = false; bargeMs = 0;
  bgBusy = false;
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
    speakPrompt('已进入阅读模式，请把摄像头对准文字，我会自动朗读。',
                () => { ttsPlaying = false; startReading(); });
  } else if (mode === 'nav') {
    speakPrompt('已进入导航模式，正在准备，我会提醒前方的人、车和危险。',
                () => { ttsPlaying = false; startNavigation(); });
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
    if (text) lastAnswer = text;   // 供「再说一遍」重听这一页
    // 端侧优先朗读（手机上云端语音常不出声/延迟），无本地语音再回退云端
    aiSpeaking = true;   // 朗读可被打断
    speakPrompt(text || '没有看到清晰的文字，请把摄像头对准文字内容。', () => {
      aiSpeaking = false;
      reading = false; isProcessing = false;
      if (currentMode === 'read' && text) {
        speakPrompt('这一页读完了，翻页后我会继续。', () => { ttsPlaying = false; });
      } else {
        ttsPlaying = false;
      }
    });
  } catch (e) {
    reading = false; isProcessing = false; ttsPlaying = false;
  }
}

// ===== 导航模式：端侧 TF.js 实时检测 + 千问周期补充 =====
// 实时检测/告警逻辑参考开源项目 OpenAIglasses_for_Navigation 的
// 「方位分区 + 去重播报」思路（MIT, AI-FanGe，详见 CREDITS.md），为 Web 重新实现。

let cocoModel = null;
let cocoLoading = null;
let navRunning = false;
let navDetecting = false;
const navLastAlert = {};   // key=类别+方位 -> 时间戳，用于去重
let navQwenLast = '';

// COCO 类别 → 中文 + 是否危险目标
const NAV_CLASSES = {
  person: '行人', car: '汽车', bus: '公交车', truck: '卡车',
  motorcycle: '摩托车', bicycle: '自行车', 'traffic light': '红绿灯',
  'stop sign': '停车标志', 'fire hydrant': '消防栓', bench: '长椅',
};

// 懒加载 TF.js + COCO-SSD（CDN，仅进入导航模式时下载）
function loadCocoSsd() {
  if (cocoModel) return Promise.resolve(cocoModel);
  if (cocoLoading) return cocoLoading;
  cocoLoading = new Promise(async (resolve, reject) => {
    try {
      // 全部从本地加载（经隧道由我们服务器提供），不依赖 Google/jsdelivr，国内可用
      await loadScript('/static/vendor/tf.min.js');
      await loadScript('/static/vendor/coco-ssd.min.js');
      cocoModel = await window.cocoSsd.load({ modelUrl: '/static/models/coco-ssd/model.json' });
      resolve(cocoModel);
    } catch (e) { reject(e); }
  });
  return cocoLoading;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function zoneOf(centerXRatio) {
  if (centerXRatio < 0.34) return '左前方';
  if (centerXRatio > 0.66) return '右前方';
  return '正前方';
}

async function startNavigation() {
  navRunning = true;
  navQwenLast = '';
  for (const k in navLastAlert) delete navLastAlert[k];
  // 加载端侧模型
  try {
    await loadCocoSsd();
    if (currentMode !== 'nav') return;
    speakPrompt('导航已就绪。');
  } catch (e) {
    console.warn('COCO-SSD 加载失败，仅用云端导航', e);
    speakPrompt('实时检测加载失败，将用云端导航提示。');
  }
  // 实时检测循环（独立运行，不被千问调用阻塞）
  navDetectLoop();
  // 千问周期补充（楼梯/指示牌/路况，COCO 检测不到的），频率放低避免抢占
  modeLoopTimer = setInterval(navQwenTick, 6000);
}

let navLastAnyAlert = 0;     // 上次任意告警时间（防止告警过密）

async function navDetectLoop() {
  if (!navRunning || currentMode !== 'nav') return;
  // 检测持续运行：只跳过「上一帧还没检测完」和「画面没就绪」，不被语音/千问阻塞
  if (cocoModel && !navDetecting && video.videoWidth) {
    navDetecting = true;
    try {
      const preds = await cocoModel.detect(video, 6);
      handleDetections(preds);
    } catch (e) {}
    navDetecting = false;
  }
  if (navRunning) setTimeout(navDetectLoop, 350);
}

function handleDetections(preds) {
  if (!preds || !preds.length) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const frameArea = vw * vh;
  let best = null;
  for (const p of preds) {
    const cn = NAV_CLASSES[p.class];
    if (!cn || p.score < 0.5) continue;
    const [x, y, w, h] = p.bbox;
    const areaRatio = (w * h) / frameArea;
    if (areaRatio < 0.035) continue;   // 太小/太远，忽略
    const cx = (x + w / 2) / vw;
    const score = areaRatio + (Math.abs(cx - 0.5) < 0.2 ? 0.1 : 0);
    if (!best || score > best.score2) {
      best = { cn, zone: zoneOf(cx), areaRatio, score2: score };
    }
  }
  if (!best) return;
  const now = nowMs();
  // 全局最小间隔 2.5 秒，防止告警叠太密互相打断
  if (now - navLastAnyAlert < 2500) return;
  const key = best.cn + best.zone;
  if (navLastAlert[key] && now - navLastAlert[key] < 4000) return;  // 同类同方位 4 秒不重复
  navLastAlert[key] = now;
  navLastAnyAlert = now;
  const isNear = best.areaRatio > 0.22;
  buzz(isNear ? [0, 90, 50, 90] : 50);   // 近距离危险用急促双震，远处单震
  const near = isNear ? '很近，' : '';
  speakPrompt(`${best.zone}${near}有${best.cn}`);   // 实时告警走端侧语音，即时
}

// 单调时钟（避免依赖 Date）
let _navT0 = null;
function nowMs() {
  if (performance && performance.now) return performance.now();
  if (_navT0 == null) _navT0 = 0;
  return (_navT0 += 450);
}

async function navQwenTick() {
  // 用 bgBusy 而非 isProcessing：后台识别不屏蔽麦克风，用户随时能说话/退出
  if (currentMode !== 'nav' || bgBusy || isProcessing || recording || ttsPlaying) return;
  const frame = captureFrameNow();
  if (!frame) return;
  bgBusy = true;
  try {
    const resp = await fetch('/api/scene', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'nav', frames: [frame] })
    });
    const data = await resp.json();
    if (data.cost) costPanel.textContent = data.cost;
    const text = (data.text || '').trim();
    bgBusy = false;
    // 用户此刻在说话/提问/播报中，就不抢话；并过滤"前方安全"和重复
    const busy = isProcessing || recording || ttsPlaying || aiSpeaking;
    if (text && !busy && !/前方安全|安全|没有/.test(text) && text !== navQwenLast && currentMode === 'nav') {
      navQwenLast = text;
      answerBox.style.display = 'block';
      answerBox.innerHTML = '<div class="ans"></div>';
      answerBox.querySelector('.ans').textContent = text;
      speakPrompt(text);
    }
  } catch (e) { bgBusy = false; }
}

// ===== 聊天模式：AI 主动找话题 =====
function scheduleChat(delay) {
  if (currentMode !== 'chat') return;
  chatIdleTimer = setTimeout(runChatTopic, delay);
}

// 聊天模式：自然回应用户说的话（带对话记忆），而不是描述画面
async function chatReplyTo(userText) {
  if (chatIdleTimer) { clearTimeout(chatIdleTimer); chatIdleTimer = null; }
  isProcessing = true;
  setStatus('正在回应…', '#9b59b6');
  const frame = captureFrameNow();
  try {
    const resp = await fetch('/api/scene', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', text: userText, frames: frame ? [frame] : [] })
    });
    const data = await resp.json();
    if (data.cost) costPanel.textContent = data.cost;
    const text = (data.text || '').trim() || '嗯，我在听，你接着说。';
    answerBox.style.display = 'block';
    answerBox.innerHTML = '<div class="heard">🗣️ ' + userText + '</div><div class="ans"></div>';
    answerBox.querySelector('.ans').textContent = text;
    lastAnswer = text;
    buzz(60);
    aiSpeaking = true;
    speakPrompt(text, () => {
      aiSpeaking = false; ttsPlaying = false; isProcessing = false;
      setStatus('正在聆听…', '#2ecc71');
      scheduleChat(9000);   // 回应完，过会儿可继续主动找话题
    });
  } catch (e) {
    isProcessing = false; ttsPlaying = false;
    speakPrompt('网络好像有点问题，再说一遍好吗？', () => { ttsPlaying = false; });
  }
}

async function runChatTopic() {
  // 用 bgBusy：后台找话题不屏蔽麦克风，用户随时能说话/退出/打断
  if (currentMode !== 'chat' || bgBusy || isProcessing || recording || ttsPlaying) { scheduleChat(4000); return; }
  const frame = captureFrameNow();
  if (!frame) { scheduleChat(3000); return; }
  bgBusy = true;
  try {
    const resp = await fetch('/api/scene', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', frames: [frame] })
    });
    const data = await resp.json();
    if (data.cost) costPanel.textContent = data.cost;
    const text = (data.text || '').trim();
    bgBusy = false;
    // 用户此刻在说话/提问/播报中，跳过这次主动话题
    const busy = isProcessing || recording || ttsPlaying || aiSpeaking;
    if (text && currentMode === 'chat' && !busy) {
      answerBox.style.display = 'block';
      answerBox.innerHTML = '<div class="ans"></div>';
      answerBox.querySelector('.ans').textContent = text;
      lastAnswer = text;   // 供「再说一遍」
      aiSpeaking = true; ttsPlaying = true;   // 聊天播报可被打断
      speakPrompt(text, () => { aiSpeaking = false; ttsPlaying = false; scheduleChat(9000); });
    } else {
      scheduleChat(6000);
    }
  } catch (e) {
    bgBusy = false; scheduleChat(8000);
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
  const url = _capCanvas.toDataURL('image/jpeg', 0.78);
  try { window.__lastFrame = url; } catch (e) {}   // 暴露给外层展示页显示"AI看到的画面"
  return url;
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

    // AI 朗读时允许打断：持续较大音量视为用户开口（阈值高+回声消除，避开AI漏音）
    if (aiSpeaking) {
      if (rms > BARGE_THRESHOLD) {
        bargeMs += frameMs;
        if (bargeMs >= BARGE_HANG_MS) {
          // 用户打断：停掉播报，立刻转入收音
          stopAllSpeech();
          aiSpeaking = false; ttsPlaying = false; isProcessing = false;
          bargeMs = 0; buzz(25);
          // 不 return，落到下面的录音逻辑，把这一帧当作说话开始
        } else {
          return;   // 还没达到打断时长，继续等
        }
      } else {
        bargeMs = 0;
        return;     // AI 在说话且没人打断，不收音
      }
    } else if (ttsPlaying || isProcessing) {
      // 思考中或播提示音（不可打断）：不收音，避免自我触发
      pcmBuffer = []; recording = false; speechMs = 0; silenceMs = 0; return;
    }

    if (rms > SILENCE_THRESHOLD) {
      // 有声音
      if (!recording) { recording = true; speechMs = 0; pcmBuffer = []; buzz(25); setStatus('正在聆听…', '#f1c40f'); }
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

// 一次性识别：上传 WAV，返回文字（失败返回空）
async function asrOnce(wavB64) {
  try {
    const resp = await fetch('/api/asr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_wav_b64: wavB64 })
    });
    const data = await resp.json();
    return (data.text || '').trim();
  } catch (e) { return ''; }
}

// ===== 一句话结束：一次性识别（稳定可靠），拿到文字后做模式分流 =====
async function finalizeUtterance() {
  const chunks = pcmBuffer;
  pcmBuffer = [];
  if (!chunks.length) return;

  isProcessing = true;
  ttsPlaying = true;   // 占用收音，避免边问边触发
  setStatus('正在识别…', '#3498db');

  // 合成 16k WAV
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const wavB64 = arrayBufferToBase64(encodeWav16k(merged, micSampleRate));

  // 一次性识别（可靠），并自动重试一次，避免偶发失败
  let userText = await asrOnce(wavB64);
  if (!userText) userText = await asrOnce(wavB64);

  if (!userText) {
    // 实在没识别到：提示重说，恢复收音
    isProcessing = false; ttsPlaying = false;
    setStatus('没听清，请再说一遍', '#e74c3c');
    speakPrompt('没听清，请再说一遍。', () => { ttsPlaying = false; });
    return;
  }

  setStatus('正在思考…', '#3498db');

  // 客户端语音指令（语速/重播/帮助）：命中则本地处理，不发给 AI
  if (userText && handleClientCommand(userText)) return;

  // 模式感知分流：按当前模式决定怎么处理用户这句话
  // 1) 任何模式下先识别"进入/退出模式"指令
  if (userText) {
    const mc = detectModeCommand(userText);
    if (mc) { isProcessing = false; ttsPlaying = false; enterMode(mc); return; }
  }
  // 2) 阅读模式：任何说话都当作"重新朗读当前内容"（如"我翻页了""读一下"），绝不走看图问答
  if (currentMode === 'read') {
    isProcessing = false; ttsPlaying = false;
    readPage();
    return;
  }
  // 3) 聊天模式：要它看画面就走看图问答，否则自然闲聊（二者不对立）
  if (currentMode === 'chat') {
    if (userText && isVisionRequest(userText)) {
      // 落到下面的 talk_stream 看图回答
    } else if (userText) {
      await chatReplyTo(userText); return;
    } else {
      isProcessing = false; ttsPlaying = false; setStatus('正在聆听…', '#2ecc71');
      return;
    }
  }
  // 4) nav / qa 模式（及聊天里的看图请求）：走看图问答（下面的 talk_stream）

  answerBox.style.display = 'block';
  answerBox.innerHTML = '<div class="heard">🗣️ …</div><div class="ans"></div>';
  const ansEl = answerBox.querySelector('.ans');
  const heardEl = answerBox.querySelector('.heard');

  let fullAnswer = '';
  let errored = false;
  let modeSwitch = null;   // 收到模式切换指令

  // 只发「此刻」这一帧：手机上传 4 帧很慢，单帧足够且所见即所问，大幅降低延迟
  const freshFrame = captureFrameNow();
  const framesToSend = freshFrame ? [freshFrame] : recentFrames.slice(-1);

  try {
    const resp = await fetch('/api/talk_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: userText, audio_wav_b64: wavB64, frames: framesToSend })
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

  // 回答整段一次性播报：端侧优先（更快）。播完立即恢复收音，不再加额外提示，降低对话循环延迟。
  const toSpeak = fullAnswer.replace(/[*#`>\-]/g, '').trim() || '我没有看清，请再说一遍。';
  if (!errored) lastAnswer = toSpeak;   // 供「再说一遍」
  buzz(60);   // 答案就绪：震动提示（非视觉确认）
  if (!errored) setStatus('正在回答…（说话可打断）', '#9b59b6');
  aiSpeaking = true;   // 回答可被用户打断
  speakPrompt(toSpeak, () => {
    aiSpeaking = false;
    isProcessing = false; ttsPlaying = false;
    setStatus('正在聆听…请继续提问', '#2ecc71');
    if (currentMode === 'chat') scheduleChat(10000);   // 聊天里看完图，过会儿继续主动找话题
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
  stopRealtime();   // 若在实时模式，一并清理
  document.getElementById('call').style.display = 'none';
  const su = document.getElementById('startup');
  su.style.display = 'flex';
  su.style.opacity = '1';
  stopModeLoops(); currentMode = 'qa'; setModeIndicator();
  aiSpeaking = false; bargeMs = 0;
  recentFrames = []; pcmBuffer = []; recording = false; isProcessing = false; ttsPlaying = false;
  videoDevices = []; curCamIdx = 0; switching = false;
  answerBox.style.display = 'none';
  // 挂断不出提示音（屏幕阅读器旁白会朗读按钮状态）
  if (window.speechSynthesis) speechSynthesis.cancel();
}

// ===== ⚡ 实时模式（Qwen-Omni-Realtime）=====
let rtActive = false, rtWS = null, rtMicCtx = null, rtMicNode = null;
let rtPlayCtx = null, rtPlayHead = 0, rtSources = [], rtFrameTimer = null;
let rtCostTimer = null, rtStartMs = 0;
const RT_RATE_PER_MIN = 0.1;   // flash-realtime 按token估算约¥0.1/分钟（输入音频+图片+输出音频）；前90天有100万token免费额度
const rtCanvas = document.createElement('canvas'), rtCtx2d = rtCanvas.getContext('2d');

// 实时模式按通话时长更新成本面板（让仪表盘可读，区别于稳定模式的按次成本）
function rtUpdateCost() {
  const sec = Math.max(0, Math.floor((perfNow() - rtStartMs) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  const cost = (sec / 60 * RT_RATE_PER_MIN).toFixed(3);
  costPanel.textContent =
    '📊 成本统计（实时模式）\n────────────────────────────\n' +
    '实时对话 ×1 ¥' + cost + '\n' +
    '────────────────────────────\n' +
    '计费方式：按token(音频+图片)，约¥' + RT_RATE_PER_MIN + '/分钟\n' +
    '已通话：' + mm + ':' + ss + '\n' +
    '累计成本：¥' + cost + '（前90天100万token免费）';
}
function perfNow() { return (performance && performance.now) ? performance.now() : 0; }

document.getElementById('rt-btn').addEventListener('click', startRealtime);

async function startRealtime() {
  welcomed = true;
  if (window.speechSynthesis) speechSynthesis.cancel();
  rtActive = true;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) { rtActive = false; showPermissionError(e); return; }

  document.getElementById('startup').style.opacity = '0';
  setTimeout(() => { document.getElementById('startup').style.display = 'none'; }, 600);
  document.getElementById('call').style.display = 'block';
  video.srcObject = mediaStream;
  try { await video.play(); } catch (e) {}
  currentMode = 'qa'; setModeIndicator('⚡ 实时模式');
  setStatus('正在连接实时对话…', '#3498db');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  rtWS = new WebSocket(`${proto}://${location.host}/ws/realtime`);
  rtWS.onopen = () => {
    rtStartMic(); rtStartFrames();
    rtStartMs = perfNow();
    rtUpdateCost();
    rtCostTimer = setInterval(rtUpdateCost, 1000);   // 按时长实时更新成本
  };
  rtWS.onmessage = (ev) => rtHandle(JSON.parse(ev.data));
  rtWS.onclose = () => { if (rtActive) setStatus('实时连接已断开', '#e74c3c'); };
  rtWS.onerror = () => {};
  rtPlayCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  rtPlayHead = 0;
}

// 麦克风 → 16k PCM16 → WS（持续流式，turn detection 由服务端 VAD 负责）
function rtStartMic() {
  rtMicCtx = new (window.AudioContext || window.webkitAudioContext)();
  const inRate = rtMicCtx.sampleRate;
  const src = rtMicCtx.createMediaStreamSource(mediaStream);
  const proc = rtMicCtx.createScriptProcessor(2048, 1, 1);
  rtMicNode = proc;
  proc.onaudioprocess = (e) => {
    if (!rtWS || rtWS.readyState !== WebSocket.OPEN) return;
    let data = e.inputBuffer.getChannelData(0);
    if (inRate !== 16000) {
      const ratio = inRate / 16000, n = Math.round(data.length / ratio), out = new Float32Array(n);
      for (let i = 0; i < n; i++) { const idx = i * ratio, lo = Math.floor(idx), hi = Math.min(lo + 1, data.length - 1); out[i] = data[lo] + (data[hi] - data[lo]) * (idx - lo); }
      data = out;
    }
    const buf = new ArrayBuffer(data.length * 2), view = new DataView(buf);
    for (let i = 0; i < data.length; i++) { let s = Math.max(-1, Math.min(1, data[i])); view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); }
    rtWS.send(JSON.stringify({ type: 'audio', data: arrayBufferToBase64(buf) }));
  };
  src.connect(proc); proc.connect(rtMicCtx.destination);
  setStatus('实时通话中 · 请直接说话', '#2ecc71');
}

// 每秒发一帧画面作为视觉上下文
function rtStartFrames() {
  rtFrameTimer = setInterval(() => {
    if (!rtWS || rtWS.readyState !== WebSocket.OPEN || !video.videoWidth) return;
    const w = 512, h = Math.round(video.videoHeight * 512 / video.videoWidth);
    rtCanvas.width = w; rtCanvas.height = h;
    rtCtx2d.drawImage(video, 0, 0, w, h);
    const url = rtCanvas.toDataURL('image/jpeg', 0.6);
    try { window.__lastFrame = url; } catch (e) {}
    rtWS.send(JSON.stringify({ type: 'video', data: url.split(',')[1] }));
  }, 1000);
}

function rtHandle(msg) {
  if (msg.type === 'audio') { rtPlayChunk(msg.data); }
  else if (msg.type === 'ai_text') {
    answerBox.style.display = 'block';
    if (!answerBox.querySelector('.ans')) answerBox.innerHTML = '<div class="heard"></div><div class="ans"></div>';
    answerBox.querySelector('.ans').textContent += msg.delta || '';
    setStatus('实时通话中 · AI 正在回答', '#9b59b6');
  } else if (msg.type === 'user_text') {
    answerBox.style.display = 'block';
    if (!answerBox.querySelector('.heard')) answerBox.innerHTML = '<div class="heard"></div><div class="ans"></div>';
    answerBox.querySelector('.heard').textContent = '🗣️ ' + (msg.text || '');
    answerBox.querySelector('.ans').textContent = '';   // 新一轮，清空上一条回答
  } else if (msg.type === 'user_speaking') {
    rtStopPlayback();   // 用户开口 → 立即停掉 AI 正在播的语音（打断）
    buzz(25);
    setStatus('实时通话中 · 正在听你说', '#f1c40f');
  } else if (msg.type === 'done') {
    setStatus('实时通话中 · 请继续说', '#2ecc71');
  } else if (msg.type === 'error') {
    // 不再误导用户挂断；显示真实错误，便于排查（同时服务端日志也会记录）
    const m = msg.message || '未知错误';
    console.warn('[realtime error]', m);
    answerBox.style.display = 'block';
    if (!answerBox.querySelector('.ans')) answerBox.innerHTML = '<div class="heard"></div><div class="ans"></div>';
    answerBox.querySelector('.ans').textContent = '⚠️ 实时出错：' + m;
    setStatus('实时出错（详见上方）', '#e74c3c');
  }
}

// 播放一段 24k PCM16（base64）：解码后排到播放队列尾部，连续无缝播放
function rtPlayChunk(b64) {
  if (!rtPlayCtx) return;
  const bin = atob(b64), len = bin.length / 2, f32 = new Float32Array(len);
  const dv = new DataView(new ArrayBuffer(2));
  for (let i = 0; i < len; i++) {
    dv.setUint8(0, bin.charCodeAt(i * 2)); dv.setUint8(1, bin.charCodeAt(i * 2 + 1));
    f32[i] = dv.getInt16(0, true) / 32768;
  }
  const ab = rtPlayCtx.createBuffer(1, len, 24000);
  ab.getChannelData(0).set(f32);
  const node = rtPlayCtx.createBufferSource();
  node.buffer = ab; node.connect(rtPlayCtx.destination);
  const now = rtPlayCtx.currentTime;
  if (rtPlayHead < now) rtPlayHead = now;
  node.start(rtPlayHead);
  rtPlayHead += ab.duration;
  rtSources.push(node);
  node.onended = () => { const i = rtSources.indexOf(node); if (i >= 0) rtSources.splice(i, 1); };
}

function rtStopPlayback() {
  rtSources.forEach(n => { try { n.stop(); } catch (e) {} });
  rtSources = [];
  if (rtPlayCtx) rtPlayHead = rtPlayCtx.currentTime;
}

function stopRealtime() {
  if (!rtActive) return;
  rtActive = false;
  if (rtFrameTimer) { clearInterval(rtFrameTimer); rtFrameTimer = null; }
  if (rtCostTimer) { clearInterval(rtCostTimer); rtCostTimer = null; }
  rtStopPlayback();
  if (rtMicNode) { try { rtMicNode.disconnect(); } catch (e) {} rtMicNode = null; }
  if (rtMicCtx) { try { rtMicCtx.close(); } catch (e) {} rtMicCtx = null; }
  if (rtPlayCtx) { try { rtPlayCtx.close(); } catch (e) {} rtPlayCtx = null; }
  if (rtWS) { try { rtWS.send(JSON.stringify({ type: 'close' })); rtWS.close(); } catch (e) {} rtWS = null; }
}

// ===== 成本面板开关 =====
document.getElementById('cost-toggle').addEventListener('click', () => {
  costPanel.style.display = costPanel.style.display === 'block' ? 'none' : 'block';
});

// ===== 切换镜头（含广角） =====
const camBtn = document.getElementById('cam-btn');
if (camBtn) camBtn.addEventListener('click', switchCamera);

// ===== 点击画面打断 =====
// 盲人摸到屏幕一点即可打断 AI 朗读（比语音打断更可靠的兜底）
function interruptSpeech() {
  if (!aiSpeaking) return;
  stopAllSpeech();
  aiSpeaking = false; ttsPlaying = false; isProcessing = false; bargeMs = 0;
  buzz(25);
  setStatus('已打断，请说', '#2ecc71');
}
video.addEventListener('click', interruptSpeech);
