"""이미지 한 장으로 3D 모델(GLB/OBJ/STL)을 만드는 패키지."""
import sys

if sys.platform == "win32":  # 검은 창에서 한글이 깨지지 않게 UTF-8 코드페이지로
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    except Exception:
        pass

# 윈도우 콘솔(cp949/cp1252 등)에서 한글·기호 출력 때문에 죽지 않도록
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from .pipeline import generate  # noqa: F401
