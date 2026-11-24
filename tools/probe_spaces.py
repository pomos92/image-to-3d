"""Hugging Face 공개 3D Space 들의 API 를 확인하고 실제로 한 번 생성해 본다 (CI 용)."""
import os, sys, time, traceback
from gradio_client import Client, handle_file

SPACES = ["trellis-community/TRELLIS", "tencent/Hunyuan3D-2", "stabilityai/TripoSR", "tencent/Hunyuan3D-2.1", "microsoft/TRELLIS.2"]
img = sys.argv[1]
token = os.environ.get("HF_TOKEN") or None
for sp in SPACES:
    print("=" * 30, sp, flush=True)
    try:
        c = Client(sp, token=token, verbose=False) if token else Client(sp, verbose=False)
        info = c.view_api(return_format="dict", print_info=False)
        for name, ep in (info.get("named_endpoints") or {}).items():
            params = [(p.get("parameter_name"), p.get("python_type", {}).get("type"), p.get("parameter_default")) for p in ep.get("parameters", [])]
            rets = [r.get("python_type", {}).get("type") for r in ep.get("returns", [])]
            if name in ("/generation_all", "/generate_and_extract_glb", "/image_to_3d"):
                for pp in ep.get("parameters", []):
                    print("     -", pp.get("parameter_name"), "default=", pp.get("parameter_default"), "type=", str(pp.get("python_type", {}).get("type"))[:60])
            else:
                print(f"  {name}: params={[x[0] for x in params]}")
    except Exception as e:
        print("  view_api failed:", repr(e)[:300])
print("=" * 30, "generation test via img23d.cloud", flush=True)
sys.path.insert(0, ".")
from img23d import cloud
for m in []:
    t = time.time()
    try:
        p, used = cloud.generate(img, m, token, print)
        print(f"OK {m}: {p} {os.path.getsize(p)} bytes in {time.time()-t:.0f}s")
    except Exception as e:
        print(f"FAIL {m}: {str(e)[:500]}")
