@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo [처음 실행] 필요한 프로그램을 설치합니다. 몇 분 걸릴 수 있어요...
  python -m venv .venv || (echo Python 이 설치되어 있지 않습니다. https://www.python.org/downloads/ & pause & exit /b)
  call .venv\Scripts\activate
  python -m pip install --upgrade pip
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate
)
python app.py
pause
