#!/bin/sh
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "[처음 실행] 필요한 프로그램을 설치합니다. 몇 분 걸릴 수 있어요..."
  python3 -m venv .venv || { echo "Python 3 가 필요합니다: https://www.python.org/downloads/"; exit 1; }
  . .venv/bin/activate
  pip install --upgrade pip
  pip install -r requirements.txt
else
  . .venv/bin/activate
fi
python app.py
