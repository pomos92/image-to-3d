"""이미지 → 3D → 파일(GLB / OBJ(zip) / STL) 저장까지 한 번에."""
from __future__ import annotations

import os
import time
import zipfile
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import trimesh
from PIL import Image

from . import basic, cloud


@dataclass
class Result:
    glb: str
    obj_zip: str
    stl: str
    engine: str
    log: list[str] = field(default_factory=list)


def _load_as_mesh(path: str) -> trimesh.Trimesh | trimesh.Scene:
    loaded = trimesh.load(path, force=None)
    return loaded


def _to_single_mesh(obj: trimesh.Trimesh | trimesh.Scene) -> trimesh.Trimesh:
    if isinstance(obj, trimesh.Scene):
        meshes = [g for g in obj.dump() if isinstance(g, trimesh.Trimesh)] if hasattr(obj, "dump") else []
        if not meshes:
            meshes = [g for g in obj.geometry.values() if isinstance(g, trimesh.Trimesh)]
        return trimesh.util.concatenate(meshes)
    return obj


def _export_all(src: trimesh.Trimesh | trimesh.Scene, out_dir: str, stem: str, size_mm: float) -> tuple[str, str, str]:
    os.makedirs(out_dir, exist_ok=True)
    glb = os.path.join(out_dir, f"{stem}.glb")
    obj_zip = os.path.join(out_dir, f"{stem}_obj.zip")
    stl = os.path.join(out_dir, f"{stem}.stl")

    # GLB: 색/텍스처 그대로
    src.export(glb)

    mesh = _to_single_mesh(src)

    # OBJ (+ mtl, 텍스처) 를 zip 으로 묶음
    try:
        text, files = trimesh.exchange.obj.export_obj(
            mesh, include_texture=True, include_color=True, return_texture=True, mtl_name=f"{stem}.mtl"
        )
    except TypeError:  # 구버전 trimesh
        text, files = trimesh.exchange.obj.export_obj(mesh, include_texture=True, return_texture=True), {}
        if isinstance(text, tuple):
            text, files = text
    with zipfile.ZipFile(obj_zip, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{stem}.obj", text)
        for name, data in (files or {}).items():
            z.writestr(name, data)

    # STL: 3D 프린팅용. 가장 긴 변을 size_mm 로 맞춤, 바닥이 z=0
    printable = mesh.copy()
    # Y-up(GLB 관례) → Z-up(프린터 관례)
    printable.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    ext = printable.extents.max()
    if ext > 0:
        printable.apply_scale(size_mm / ext)
    b = printable.bounds
    printable.apply_translation([-(b[0][0] + b[1][0]) / 2, -(b[0][1] + b[1][1]) / 2, -b[0][2]])
    printable.export(stl)
    return glb, obj_zip, stl


def generate(
    image: str | Image.Image,
    engine: str = "auto",            # "auto" | "cloud" | "basic"
    cloud_model: str = "자동",
    hf_token: str | None = None,
    out_dir: str = "outputs",
    remove_bg: bool = True,
    resolution: int = 160,
    thickness: float = 0.5,
    size_mm: float = 100.0,
    log: Callable[[str], None] | None = None,
) -> Result:
    logs: list[str] = []

    def _log(msg: str) -> None:
        logs.append(msg)
        (log or print)(msg)

    if isinstance(image, str):
        src_path = image
        pil = Image.open(image)
    else:
        pil = image
        src_path = os.path.join(out_dir, "_input.png")
        os.makedirs(out_dir, exist_ok=True)
        pil.save(src_path)

    stem = time.strftime("model_%Y%m%d_%H%M%S")
    result_obj = None
    used = ""

    if engine in ("auto", "cloud"):
        try:
            path, used = cloud.generate(src_path, cloud_model, hf_token, _log)
            result_obj = _load_as_mesh(path)
            used = f"클라우드 AI ({used})"
        except Exception as e:
            _log(f"클라우드 AI 사용 불가: {str(e).splitlines()[0]}")
            if engine == "cloud":
                raise
            _log("오프라인 기본 엔진으로 전환합니다.")

    if result_obj is None:
        _log("오프라인 기본 엔진: 실루엣을 부풀려 3D 생성 중...")
        result_obj = basic.build_mesh(pil, remove_bg=remove_bg, resolution=resolution, thickness=thickness)
        used = "오프라인 기본 엔진"

    glb, obj_zip, stl = _export_all(result_obj, out_dir, stem, size_mm)
    _log(f"완료: {os.path.abspath(out_dir)} 에 저장했습니다.")
    return Result(glb, obj_zip, stl, used, logs)
