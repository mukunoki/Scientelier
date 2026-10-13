#!/bin/zsh
cd "${0:A:h}" || exit 1
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  print 'Node.js 24以上をインストールしてから、もう一度実行してください。'
  read 'reply?Enterで閉じます: '
  exit 1
fi
node scripts/setup.cjs
result=$?
read 'reply?Enterで閉じます: '
exit $result
