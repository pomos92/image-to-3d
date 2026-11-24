"""오프라인 기본 엔진 (AI 없이, GPU 없이, 인터넷 없이 동작).

원리
1. 물체와 배경을 분리해 실루엣(마스크)을 만든다.
2. 실루엣 가장자리에서 안쪽으로 갈수록 두꺼워지도록 '부풀린' 두께 지도를 만든다.
   (단면이 둥근 모양이 되도록 원형 프로파일 사용)
3. 보이지 않는 뒷면은 앞면을 거울처럼 대칭이라고 가정한다.
4. 복셀(3D 픽셀)로 채운 뒤 마칭 큐브로 막힌(watertight) 메쉬를 만든다.
5. 원본 이미지 색을 정점 색으로 입힌다.

AI 엔진보다 정확도는 낮지만, 인형/캐릭터/로고/과일처럼 둥근 물체는 그럴듯하게 나온다.
"""
from __future__ import annotations

import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
from skimage import measure
from skimage.morphology import medial_axis


# ---------------------------------------------------------------- 배경 제거
def _mask_from_alpha(img: Image.Image) -> np.ndarray | None:
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        a = np.asarray(img.convert("RGBA"))[..., 3]
        if (a < 128).mean() > 0.02:  # 실제로 투명한 영역이 있을 때만
            return a >= 128
    return None


def _mask_with_rembg(img: Image.Image) -> np.ndarray | None:
    try:
        from rembg import remove  # type: ignore
    except Exception:
        return None
    try:
        out = remove(img.convert("RGB"))
        return np.asarray(out)[..., 3] >= 128
    except Exception:
        return None


def _mask_from_border_color(img: Image.Image) -> np.ndarray:
    """테두리 색을 배경으로 보고 비슷한 색을 지운다 (단색 배경 사진에 적합)."""
    rgb = np.asarray(img.convert("RGB")).astype(np.float32)
    h, w, _ = rgb.shape
    b = max(2, min(h, w) // 50)
    border = np.concatenate(
        [rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3),
         rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3)]
    )
    bg = np.median(border, axis=0)
    spread = np.percentile(np.linalg.norm(border - bg, axis=1), 90)
    thr = max(30.0, spread * 1.8)
    dist = np.linalg.norm(rgb - bg, axis=2)
    return dist > thr


def _clean_mask(mask: np.ndarray) -> np.ndarray:
    mask = ndimage.binary_opening(mask, iterations=1)
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool)
    biggest = sizes.max()
    keep[1:] = sizes >= biggest * 0.15  # 큰 덩어리만 남김
    mask = keep[lab]
    return ndimage.binary_fill_holes(mask)


def extract_mask(img: Image.Image, remove_bg: bool = True) -> np.ndarray:
    m = _mask_from_alpha(img)
    if m is None and remove_bg:
        m = _mask_with_rembg(img)
        if m is None:
            m = _mask_from_border_color(img)
    if m is None:  # 배경 제거 안 함: 이미지 전체를 판으로
        m = np.ones((img.height, img.width), bool)
    m = _clean_mask(m)
    if m.sum() < 50:
        raise ValueError("물체를 찾지 못했습니다. 배경이 단순한 사진이나 배경을 지운 PNG를 넣어 보세요.")
    return m


# ---------------------------------------------------------------- 3D 생성
def build_mesh(
    img: Image.Image,
    remove_bg: bool = True,
    resolution: int = 160,
    thickness: float = 0.5,
    detail: float = 0.15,
) -> trimesh.Trimesh:
    """이미지 → 색이 입혀진 watertight 메쉬.

    resolution: 긴 변 기준 복셀 수 (높을수록 세밀하지만 느림)
    thickness:  물체 두께 비율 (0.1 납작 ~ 1.0 통통)
    detail:     밝기에 따른 표면 요철 강도 (0이면 매끈)
    """
    img = img.copy()
    img.thumbnail((1024, 1024))
    full_mask = extract_mask(img, remove_bg)

    # 물체 영역만 잘라내기
    ys, xs = np.nonzero(full_mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    crop_rgb = np.asarray(img.convert("RGB"))[y0:y1, x0:x1]
    crop_mask = full_mask[y0:y1, x0:x1]

    # 작업 해상도로 축소
    h, w = crop_mask.shape
    s = resolution / max(h, w)
    gw, gh = max(8, int(round(w * s))), max(8, int(round(h * s)))
    mask = np.asarray(Image.fromarray(crop_mask.astype(np.uint8) * 255).resize((gw, gh), Image.BILINEAR)) >= 128
    rgb = np.asarray(Image.fromarray(crop_rgb).resize((gw, gh), Image.LANCZOS)).astype(np.float32) / 255.0

    # 두께 지도: '구(球) 합치기' 방식.
    # 실루엣의 뼈대(medial axis) 위 각 점에 그 점에서 가장자리까지 거리만큼의 공을 놓고
    # 모든 공을 합친 모양을 물체로 본다. → 굵은 부분은 통통하게, 가는 부분(손잡이·꼭지)은 가늘게.
    skel, dist = medial_axis(mask, return_distance=True)
    qy, qx = np.nonzero(skel)
    qr = dist[qy, qx]
    keep = qr >= 1.0
    qy, qx, qr = qy[keep], qx[keep], qr[keep]
    if len(qr) > 4000:  # 너무 많으면 균등하게 추림
        idx = np.linspace(0, len(qr) - 1, 4000).astype(int)
        qy, qx, qr = qy[idx], qx[idx], qr[idx]
    height = np.zeros((gh, gw), np.float32)
    for y, x, r in zip(qy, qx, qr):
        ri = int(np.ceil(r))
        ya, yb, xa, xb = max(0, y - ri), min(gh, y + ri + 1), max(0, x - ri), min(gw, x + ri + 1)
        yy, xx = np.mgrid[ya:yb, xa:xb]
        hh = r * r - ((yy - y) ** 2 + (xx - x) ** 2)
        np.maximum(height[ya:yb, xa:xb], np.sqrt(np.clip(hh, 0, None)), out=height[ya:yb, xa:xb])
    height *= thickness * 2.0  # 0.5 = 동그란 단면
    dmax = max(float(dist.max()), 1.0)

    # 밝기 기반 미세 요철 (밝은 곳이 살짝 튀어나옴)
    if detail > 0:
        lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
        lum = ndimage.gaussian_filter(lum, 1.0)
        lum = lum - lum[mask].mean()
        height = height + detail * dmax * 0.15 * lum * (height > 2)
    height = ndimage.gaussian_filter(height, 0.7)
    height = np.maximum(height, 0.3) * mask

    # 연속 거리장으로 표면 정의 → 계단 현상 없이 매끈하게.
    # 물체 안: 두께 - |z|,  물체 밖: -(가장자리까지 거리)
    outside = ndimage.distance_transform_edt(~mask)
    hfield = np.where(mask, height, -outside).astype(np.float32)
    zmax = int(np.ceil(height.max())) + 2
    zs = np.arange(-zmax, zmax + 1, dtype=np.float32)
    field = hfield[:, :, None] - np.abs(zs)[None, None, :]
    field = np.pad(field, 2, constant_values=-2.0)
    field = ndimage.gaussian_filter(field, 1.0)  # 가장자리 날카로운 테두리 완화

    verts, faces, _, _ = measure.marching_cubes(field, level=0.0)
    verts -= 2.0  # pad 보정
    scale = float(max(gw, gh))
    # 좌표계: x=오른쪽, y=위, z=앞(카메라 쪽). 긴 변 = 1.0
    v = np.stack([verts[:, 1], (gh - 1) - verts[:, 0], verts[:, 2] - zmax], axis=1)
    mesh = trimesh.Trimesh(vertices=v, faces=faces[:, ::-1], process=True)
    if mesh.volume < 0:
        mesh.invert()
    trimesh.smoothing.filter_taubin(mesh, iterations=4)
    # 너무 촘촘하면 줄이기 (파일 크기 절약)
    if len(mesh.faces) > 80_000:
        try:
            mesh = mesh.simplify_quadric_decimation(face_count=80_000)
        except Exception:
            pass

    # 정점 색: 정점의 (x, y) 위치에 해당하는 이미지 색 (뒷면은 앞면과 같다고 가정)
    col = mesh.vertices[:, 0]
    row = (gh - 1) - mesh.vertices[:, 1]
    r = np.clip(np.round(row).astype(int), 0, gh - 1)
    c = np.clip(np.round(col).astype(int), 0, gw - 1)
    # 가장자리 픽셀은 배경색이 섞여 있으므로 안쪽으로 2픽셀 들어간 영역의 색만 사용
    inner = ndimage.binary_erosion(mask, iterations=2)
    if inner.sum() < 20:
        inner = mask
    _, (ir, ic) = ndimage.distance_transform_edt(~inner, return_indices=True)
    colors = rgb[ir[r, c], ic[r, c]].copy()
    colors[mesh.vertices[:, 2] < 0] *= 0.92  # 뒷면(추정 영역)은 살짝 어둡게
    vcol = np.concatenate([np.clip(colors * 255, 0, 255), np.full((len(colors), 1), 255)], axis=1).astype(np.uint8)

    v = mesh.vertices / scale
    v -= (v.max(0) + v.min(0)) / 2
    return trimesh.Trimesh(vertices=v, faces=mesh.faces, vertex_colors=vcol, process=False)
