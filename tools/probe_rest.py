"""텍스처 포함 3D 를 주는 공개 Space 찾기 (CI 디버그용)."""
import sys, time, traceback
from gradio_client import Client, handle_file
img = sys.argv[1]

def run(name, fn):
    t = time.time()
    try:
        r = fn()
        print(f"RESULT {name} OK {time.time()-t:.0f}s :: {str(r)[:700]}", flush=True)
    except Exception as e:
        print(f"RESULT {name} FAIL {time.time()-t:.0f}s :: {repr(e)[:500]}", flush=True)

def trellis():
    c = Client("trellis-community/TRELLIS", verbose=False)
    try: c.predict(api_name="/start_session")
    except Exception as e: print("start_session:", e)
    pre = c.predict(image=handle_file(img), api_name="/preprocess_image")
    print("pre:", str(pre)[:200])
    return c.predict(image=handle_file(pre if isinstance(pre, str) else pre["path"]), multiimages=[], seed=0, ss_guidance_strength=7.5, ss_sampling_steps=12,
                     slat_guidance_strength=3, slat_sampling_steps=12, multiimage_algo="stochastic", mesh_simplify=0.95, texture_size=1024,
                     api_name="/generate_and_extract_glb")

def hy21():
    c = Client("tencent/Hunyuan3D-2.1", verbose=False)
    return c.predict(image=handle_file(img), steps=30, guidance_scale=5, seed=1234, octree_resolution=256, check_box_rembg=True,
                     num_chunks=8000, randomize_seed=True, api_name="/generation_all")

def trellis2():
    c = Client("microsoft/TRELLIS.2", verbose=False)
    try: c.predict(api_name="/start_session")
    except Exception as e: print("start_session:", e)
    pre = c.predict(input=handle_file(img), api_name="/preprocess_image")
    info = c.view_api(return_format="dict", print_info=False)["named_endpoints"]["/image_to_3d"]["parameters"]
    print("t2 params:", [p["parameter_name"] for p in info])
    c.predict(image=handle_file(pre if isinstance(pre, str) else pre["path"]), api_name="/image_to_3d")
    return c.predict(decimation_target=200000, texture_size=1024, api_name="/extract_glb")

run("TRELLIS", trellis)
run("Hunyuan3D-2.1", hy21)
run("TRELLIS.2", trellis2)
