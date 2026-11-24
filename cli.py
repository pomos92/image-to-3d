"""명령줄 사용:
    python cli.py 사진.jpg                    # 자동 (AI → 실패 시 오프라인)
    python cli.py 사진.jpg --engine basic     # 오프라인만
    python cli.py 사진.jpg --engine cloud --model TRELLIS
"""
import argparse

from img23d import generate

p = argparse.ArgumentParser(description="이미지 한 장 → 3D 파일 (GLB/OBJ/STL)")
p.add_argument("image")
p.add_argument("--engine", choices=["auto", "cloud", "basic"], default="auto")
p.add_argument("--model", default="자동", help="자동 | TRELLIS | Hunyuan3D-2 | TripoSR")
p.add_argument("--token", default=None, help="Hugging Face 토큰 (또는 환경변수 HF_TOKEN)")
p.add_argument("--out", default="outputs")
p.add_argument("--thickness", type=float, default=0.5)
p.add_argument("--resolution", type=int, default=160)
p.add_argument("--size-mm", type=float, default=100.0)
p.add_argument("--no-bg-removal", action="store_true")
a = p.parse_args()

r = generate(a.image, engine=a.engine, cloud_model=a.model, hf_token=a.token, out_dir=a.out,
             remove_bg=not a.no_bg_removal, thickness=a.thickness, resolution=a.resolution, size_mm=a.size_mm)
print(f"\n엔진: {r.engine}\nGLB: {r.glb}\nOBJ: {r.obj_zip}\nSTL: {r.stl}")
