#!/bin/sh
# script-hub-web 启动脚本：幂等，已在跑则不重复启动。
# 用法: ./start.sh [PORT]    环境变量: PORT / PUBLIC_BASE_URL / HOST
cd "$(dirname "$0")" || exit 1

PORT="${1:-${PORT:-8082}}"
PID_FILE="server.pid"
LOG_FILE="server.log"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "script-hub-web already running (pid $OLD_PID, port $PORT)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# pid 文件不在但端口已被占用：多半是本服务在跑（或端口冲突），不重复启动
if ! node -e "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen($PORT,'0.0.0.0',()=>s.close(()=>process.exit(0)))" 2>/dev/null; then
  echo "port $PORT already in use, assuming script-hub-web is running; not starting another copy"
  exit 0
fi

PORT="$PORT" nohup node server.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "script-hub-web started (pid $(cat "$PID_FILE"), port $PORT, log: $LOG_FILE)"
else
  echo "script-hub-web FAILED to start, see $LOG_FILE"
  tail -20 "$LOG_FILE"
  exit 1
fi
