"""클라우드 AI 엔진: Hugging Face 의 무료 공개 데모(Space)에 이미지를 보내 3D를 받아온다.

내 컴퓨터에 GPU가 없어도 됨. 대신 인터넷이 필요하고, 공개 서버라 대기열/사용량 제한이 있을 수 있다.
HF 토큰(무료 가입 후 발급)을 넣으면 사용 한도가 늘어난다.

공개 Space 는 운영자가 API 를 바꾸기도 하므로, 여러 모델을 순서대로 시도한다.
  1) TRELLIS (Microsoft)      - 품질 좋음, 텍스처 포함 GLB
  2) Hunyuan3D-2 (Tencent)    - 형태 품질 좋음 (현재 색 없이 흰색 형태만)
  3) TripoSR (Stability/Tripo) - 빠름 (2026-11 기준 서버 고장)
"""
from __future__ import annotations

import os
import random
import shutil
import tempfile
from typing import Any, Callable

MESH_EXT = (".glb", ".gltf", ".obj", ".ply", ".stl")


class CloudError(RuntimeError):
    pass


def _find_mesh(result: Any) -> str | None:
    """Space 응답(문자열/튜플/딕셔너리 섞임)에서 3D 파일 경로를 찾아낸다."""
    found: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, str):
            if x.lower().endswith(MESH_EXT) and os.path.exists(x):
                found.append(x)
        elif isinstance(x, dict):
            for k in ("path", "value", "name", "url"):
                if k in x:
                    walk(x[k])
            for v in x.values():
                if isinstance(v, (list, tuple, dict)):
                    walk(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                walk(v)

    walk(result)
    # GLB 우선 (텍스처 포함)
    found.sort(key=lambda p: (not p.lower().endswith(".glb"), p))
    return found[0] if found else None


def _client(space: str, token: str | None):
    from gradio_client import Client

    kw = {}
    if token:
        # gradio_client 버전에 따라 인자 이름이 다름
        try:
            return Client(space, token=token, verbose=False)
        except TypeError:
            kw["hf_token"] = token
    try:
        return Client(space, verbose=False, **kw)
    except TypeError:
        return Client(space, **kw)


def _seed() -> int:
    return random.randint(0, 2**31 - 1)


# ---------------------------------------------------------------- 모델별 호출
def _trellis(image_path: str, token: str | None, log: Callable[[str], None]) -> str:
    from gradio_client import handle_file

    c = _client("trellis-community/TRELLIS", token)
    try:
        c.predict(api_name="/start_session")
    except Exception:
        pass
    img = handle_file(image_path)
    try:
        img = c.predict(image=img, api_name="/preprocess_image")
        img = handle_file(img if isinstance(img, str) else img["path"])
    except Exception as e:  # 전처리 실패해도 원본으로 계속
        log(f"TRELLIS 전처리 건너뜀: {e}")
        img = handle_file(image_path)
    log("TRELLIS: 3D 생성 중 (보통 20초~1분)...")
    res = c.predict(
        image=img,
        multiimages=[],
        seed=_seed(),
        ss_guidance_strength=7.5,
        ss_sampling_steps=12,
        slat_guidance_strength=3,
        slat_sampling_steps=12,
        multiimage_algo="stochastic",
        mesh_simplify=0.95,
        texture_size=1024,
        api_name="/generate_and_extract_glb",
    )
    path = _find_mesh(res)
    if not path:
        raise CloudError(f"TRELLIS 응답에 3D 파일이 없음: {res!r}"[:300])
    return path


def _hunyuan(image_path: str, token: str | None, log: Callable[[str], None]) -> str:
    from gradio_client import handle_file

    c = _client("tencent/Hunyuan3D-2", token)
    log("Hunyuan3D-2: 3D 생성 중 (보통 1~3분)...")
    common = dict(
        caption=None,
        image=handle_file(image_path),
        steps=30,
        guidance_scale=5,
        seed=_seed(),
        octree_resolution=256,
        check_box_rembg=True,
    )
    last: Exception | None = None
    for api in ("/shape_generation", "/generation_all"):  # generation_all(텍스처)은 현재 서버에서 고장
        for extra in ({"num_chunks": 8000, "randomize_seed": True}, {}):
            try:
                res = c.predict(**common, **extra, api_name=api)
                path = _find_mesh(res)
                if path:
                    return path
            except Exception as e:
                last = e
    raise CloudError(f"Hunyuan3D-2 실패: {last}")


def _triposr(image_path: str, token: str | None, log: Callable[[str], None]) -> str:
    from gradio_client import handle_file

    c = _client("stabilityai/TripoSR", token)
    log("TripoSR: 배경 제거 중...")
    pre = c.predict(handle_file(image_path), True, 0.85, api_name="/preprocess")
    pre_path = pre if isinstance(pre, str) else pre.get("path")
    log("TripoSR: 3D 생성 중...")
    res = c.predict(handle_file(pre_path), 256, api_name="/generate")
    path = _find_mesh(res)
    if not path:
        raise CloudError(f"TripoSR 응답에 3D 파일이 없음: {res!r}"[:300])
    return path


MODELS: dict[str, Callable[[str, str | None, Callable[[str], None]], str]] = {
    "TRELLIS": _trellis,
    "Hunyuan3D-2": _hunyuan,
    "TripoSR": _triposr,
}


def generate(
    image_path: str,
    model: str = "자동",
    token: str | None = None,
    log: Callable[[str], None] = print,
) -> tuple[str, str]:
    """이미지 → (3D 파일 경로, 사용한 모델 이름). 실패하면 CloudError."""
    token = token or os.environ.get("HF_TOKEN") or None
    order = list(MODELS) if model in ("자동", "auto", None) else [model]
    errors = []
    for name in order:
        try:
            log(f"{name} 서버에 연결 중...")
            path = MODELS[name](image_path, token, log)
            # gradio 임시폴더 파일이 지워지기 전에 복사
            out = os.path.join(tempfile.mkdtemp(prefix="img23d_"), "cloud" + os.path.splitext(path)[1])
            shutil.copy(path, out)
            return out, name
        except Exception as e:  # 다음 모델로
            msg = str(e).strip().splitlines()[0][:200] if str(e).strip() else type(e).__name__
            log(f"{name} 실패: {msg}")
            errors.append(f"{name}: {msg}")
    raise CloudError("모든 클라우드 모델이 실패했습니다.\n" + "\n".join(errors))
