#!/usr/bin/env bash
# 一键生成《夙与愿》宣传片：字体 → 配乐 → 逐帧渲染 → 合成。
# 依赖：python3 + numpy + scipy、node + playwright（Chromium）、ffmpeg。
set -euo pipefail
cd "$(dirname "$0")"
[ -f build/fonts/local.css ] || ./fetch_fonts.sh
python3 music.py build/music.wav
NODE_PATH="$(npm root -g)" node render.js video

# 响度两遍处理：先测量，再按线性增益统一到 -16 LUFS，不改变段落间的起伏。
TARGET="I=-16:TP=-1.5:LRA=20"
STATS=$(ffmpeg -hide_banner -nostats -i build/music.wav -af "loudnorm=$TARGET:print_format=json" -f null - 2>&1 |
  python3 -c 'import sys,json,re; t=sys.stdin.read(); d=json.loads(re.search(r"\{[^{}]*\}", t, re.S).group(0)); print(":".join(f"{k}={d[v]}" for k,v in [("measured_I","input_i"),("measured_TP","input_tp"),("measured_LRA","input_lra"),("measured_thresh","input_thresh"),("offset","target_offset")]))')
ffmpeg -y -loglevel error -i build/video.mp4 -i build/music.wav \
  -map 0:v -map 1:a -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -c:a aac -b:a 256k -ar 48000 \
  -af "loudnorm=$TARGET:$STATS:linear=true" -movflags +faststart -shortest \
  夙与愿_宣传片.mp4
echo "完成：夙与愿_宣传片.mp4"
