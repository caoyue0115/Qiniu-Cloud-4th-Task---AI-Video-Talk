#!/bin/bash
# AI 视觉对话助手 — Ubuntu 一键部署脚本
# 用法（在服务器 /root/aieye 目录内运行）：bash deploy.sh
# 通过 cloudflared 隧道走出站连接，无需备案、无需开放 80/443 端口。
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo ">>> [1/6] 安装系统依赖..."
apt-get update -y
apt-get install -y python3 python3-pip python3-venv libsndfile1 libgl1 libglib2.0-0 curl

echo ">>> [2/6] 配置密钥 .env..."
if [ ! -f .env ]; then
  echo ""
  echo "请粘贴你的 DASHSCOPE_API_KEY（sk- 开头），然后回车："
  read -r KEY
  echo "DASHSCOPE_API_KEY=$KEY" > .env
  echo "已写入 .env"
else
  echo ".env 已存在，跳过"
fi

echo ">>> [3/6] 安装 Python 依赖（约 2-4 分钟）..."
python3 -m venv venv
./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -q -r requirements.txt

echo ">>> [4/6] 配置后端服务自启 (systemd)..."
cat > /etc/systemd/system/aieye.service <<SVCEOF
[Unit]
Description=AI Eye App
After=network.target
[Service]
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/venv/bin/python server.py
Restart=always
RestartSec=3
User=root
[Install]
WantedBy=multi-user.target
SVCEOF
systemctl daemon-reload
systemctl enable --now aieye

echo ">>> [5/6] 安装 cloudflared 隧道..."
if [ ! -x /usr/local/bin/cloudflared ]; then
  curl -L -o /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /usr/local/bin/cloudflared
fi
cat > /etc/systemd/system/aieye-tunnel.service <<'TUNEOF'
[Unit]
Description=AI Eye Tunnel
After=network.target aieye.service
[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate
Restart=always
RestartSec=5
User=root
[Install]
WantedBy=multi-user.target
TUNEOF
systemctl daemon-reload
systemctl restart aieye-tunnel
systemctl enable aieye-tunnel

echo ">>> [6/6] 等待隧道分配公网地址..."
sleep 16
echo ""
echo "==================== 部署完成 ===================="
echo "本地: http://127.0.0.1:8000   （后端服务: systemctl status aieye）"
echo "公网访问地址（发给评委）："
journalctl -u aieye-tunnel --no-pager 2>/dev/null | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1
echo "（若上面为空，等几秒后运行： journalctl -u aieye-tunnel | grep trycloudflare ）"
echo "=================================================="
