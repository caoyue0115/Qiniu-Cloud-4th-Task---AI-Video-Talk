// 展示页：轮询同源 iframe(/app) 的真实状态，更新左侧仪表盘。
// 因 / 与 /app 同源，可直接读取 iframe 内的 DOM 与 window 变量，App 逻辑零改动。

const iframe = document.querySelector('.phone iframe');
const $ = (id) => document.getElementById(id);

let lastHeard = '', lastAns = '';

function idoc() { try { return iframe.contentDocument; } catch (e) { return null; } }
function iwin() { try { return iframe.contentWindow; } catch (e) { return null; } }

// 解析 App 成本面板文本 → 结构化展示
function updateCost(raw) {
  if (!raw) return;
  const rows = [];
  let total = '', saved = '';
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || /成本统计|^─+$|总请求次数|单次平均/.test(t)) continue;
    if (t.startsWith('累计成本')) { total = t.split('：')[1] || ''; continue; }
    if (t.startsWith('端侧+缓存占比')) { saved = t.split('：')[1] || ''; continue; }
    // 形如 "语音识别  ×1  ¥0.005"
    const m = t.match(/^(.+?)\s*×(\d+)\s*¥([\d.]+)/);
    if (m) rows.push({ name: m[1].trim(), n: m[2], cost: m[3] });
  }
  if (rows.length) {
    $('cost-rows').innerHTML = rows.map(r =>
      `<div class="cost-row"><span>${r.name} ×${r.n}</span><span>¥${r.cost}</span></div>`).join('');
  }
  if (total) $('cost-total').textContent = '¥' + total.replace('¥', '');
  if (saved) $('cost-saved').textContent = `💡 端侧+缓存占比 ${saved}　·　端云协同大幅降低云端调用成本`;
}

// 对话记录：检测 App 答题框变化，追加气泡
function updateTranscript(doc) {
  const box = doc.getElementById('answer-box');
  if (!box || box.style.display === 'none') return;
  const heard = (box.querySelector('.heard')?.textContent || '').replace(/^🗣️\s*/, '').trim();
  const ans = (box.querySelector('.ans')?.textContent || '').trim();
  const tr = $('transcript');
  if (heard && heard !== lastHeard && !heard.includes('…') && !heard.includes('（')) {
    lastHeard = heard;
    appendBubble('user', '我说', heard, tr);
  }
  if (ans && ans !== lastAns && ans.length > 1) {
    lastAns = ans;
    appendBubble('ai', 'AI', ans, tr);
  }
}
function appendBubble(cls, who, text, tr) {
  if (tr.children.length === 1 && tr.children[0].textContent.includes('接通后')) tr.innerHTML = '';
  const b = document.createElement('div');
  b.className = 'bubble ' + cls;
  b.innerHTML = `<div class="who">${who}</div>${text}`;
  tr.appendChild(b);
  tr.scrollTop = tr.scrollHeight;
  while (tr.children.length > 12) tr.removeChild(tr.firstChild);
}

// 架构流程高亮：按 App 状态/模式点亮当前环节
function highlightArch(statusText, mode) {
  const ids = ['n-mic', 'n-edge', 'n-route', 'n-cloud', 'n-tts'];
  ids.forEach(id => $(id).classList.remove('active'));
  const s = statusText || '';
  if (/聆听|聆听中|请说/.test(s)) $('n-mic').classList.add('active');
  else if (/识别/.test(s)) { $('n-mic').classList.add('active'); }
  else if (/看|思考|识别/.test(s)) { $('n-route').classList.add('active'); $('n-cloud').classList.add('active'); }
  else if (/回答/.test(s)) $('n-tts').classList.add('active');
  if (mode && mode.includes('导航')) $('n-edge').classList.add('active');  // 导航：端侧实时检测常亮
}

function tick() {
  const doc = idoc(), win = iwin();
  if (!doc) return;
  try {
    // 成本
    const cp = doc.getElementById('cost-panel');
    if (cp) updateCost(cp.textContent);
    // 模式
    const mi = doc.getElementById('mode-indicator');
    const mode = mi ? mi.textContent.trim() : '问答模式';
    if (mode) $('mode-tag').textContent = mode;
    // 对话
    updateTranscript(doc);
    // 架构高亮
    const st = doc.getElementById('status-text');
    highlightArch(st ? st.textContent : '', mode);
  } catch (e) {}
}

setInterval(tick, 600);
