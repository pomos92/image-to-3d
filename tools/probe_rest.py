"""Hunyuan3D-2 REST 호출 방식 비교 (CI 디버그용)."""
import json, sys, time, requests
from gradio_client import Client, handle_file
B = "https://tencent-hunyuan3d-2.hf.space"
img = sys.argv[1]
# A) REST /call
up = requests.post(B + "/upload", files={"files": open(img, "rb")}).json()
print("upload:", up)
fd = {"path": up[0], "orig_name": "sample.png", "meta": {"_type": "gradio.FileData"}}
r = requests.post(B + "/call/generation_all", json={"data": [None, fd, None, None, None, None, 30, 5, 1234, 256, True, 8000, True]})
print("call:", r.status_code, r.text[:300])
eid = r.json()["event_id"]
with requests.get(f"{B}/call/generation_all/{eid}", stream=True) as s:
    for line in s.iter_lines(decode_unicode=True):
        if line: print("SSE:", line[:600])
# B) same via shape_generation
r = requests.post(B + "/call/shape_generation", json={"data": [None, fd, None, None, None, None, 30, 5, 1234, 256, True, 8000, True]})
eid = r.json()["event_id"]
with requests.get(f"{B}/call/shape_generation/{eid}", stream=True) as s:
    for line in s.iter_lines(decode_unicode=True):
        if line: print("SSE2:", line[:600])
# C) gradio_client for comparison
t = time.time()
c = Client("tencent/Hunyuan3D-2", verbose=False)
res = c.predict(caption=None, image=handle_file(img), steps=30, guidance_scale=5, seed=1234, octree_resolution=256,
                check_box_rembg=True, num_chunks=8000, randomize_seed=True, api_name="/generation_all")
print("client OK", time.time() - t, str(res)[:600])
