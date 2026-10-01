#!/usr/bin/env bash
# 下载宣传片用到的字体（Google Fonts，均为 SIL OFL 开源授权）到 build/fonts/，
# 并生成指向本地文件的 local.css。字体不入库。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/fonts
cd build/fonts
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
curl -sS -A "$UA" -o fonts.css \
  "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700;900&family=Noto+Sans+SC:wght@400;900&family=Cinzel:wght@400;700&display=block"
grep -oE "https://fonts.gstatic.com/[^)]+" fonts.css | sort -u |
  xargs -P 16 -I{} sh -c 'f=$(echo "{}" | sed "s#https://fonts.gstatic.com/##; s#/#_#g"); [ -s "$f" ] || curl -sS --max-time 60 -o "$f" "{}"'
perl -pe 's#url\(https://fonts.gstatic.com/([^)]+)\)#my $p=$1; $p=~s{/}{_}g; "url($p)"#ge' fonts.css > local.css
echo "fonts: $(ls *.woff2 | wc -l) files"
