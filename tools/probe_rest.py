"""TRELLIS 큐 프로토콜(/queue/join) 확인 (안드로이드 앱이 쓸 방식, CI 디버그용)."""
import sys, time, json, random, string, requests
B = "https://trellis-community-trellis.hf.space"
img = sys.argv[1]
cfg = requests.get(B + "/config").json()
deps = cfg["dependencies"]
idx = {d.get("api_name"): (d.get("id", i), i) for i, d in enumerate(deps)}
print("fn:", {k: v for k, v in idx.items() if k in ("start_session", "preprocess_image", "generate_and_extract_glb")})
up = requests.post(B + "/upload", files={"files": open(img, "rb")}).json()
fd = lambda p: {"path": p, "orig_name": "image.png", "meta": {"_type": "gradio.FileData"}}
sh = "".join(random.choices(string.ascii_lowercase + string.digits, k=11))

def call(api, data):
    fid, pos = idx[api]
    r = requests.post(B + "/queue/join", json={"data": data, "event_data": None, "fn_index": fid, "trigger_id": None, "session_hash": sh})
    print("join", api, r.status_code, r.text[:200])
    with requests.get(B + "/queue/data", params={"session_hash": sh}, stream=True) as s:
        for line in s.iter_lines(decode_unicode=True):
            if not line.startswith("data:"): continue
            m = json.loads(line[5:])
            if m.get("msg") not in ("heartbeat",): print("   ", str(m)[:300])
            if m.get("msg") == "process_completed":
                return m
t = time.time()
call("start_session", [])
m = call("preprocess_image", [fd(up[0])])
pre = m["output"]["data"][0]
m = call("generate_and_extract_glb", [pre, [], 0, 7.5, 12, 3, 12, "stochastic", 0.95, 1024])
print("elapsed", time.time() - t)
for x in m["output"]["data"]:
    if isinstance(x, dict) and str(x.get("path", "")).endswith(".glb"):
        for url in (x.get("url"), f"{B}/file={x['path']}"):
            r = requests.get(url); print("download", str(url)[:140], r.status_code, len(r.content))
