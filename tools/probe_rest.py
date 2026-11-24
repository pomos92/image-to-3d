"""TRELLIS REST 프로토콜 확인 (안드로이드 앱이 쓸 방식, CI 디버그용)."""
import sys, time, json, random, string, requests
B = "https://trellis-community-trellis.hf.space"
img = sys.argv[1]
cfg = requests.get(B + "/config").json()
print("version", cfg.get("version"), "api_prefix", cfg.get("api_prefix"))
P = (cfg.get("api_prefix") or "").rstrip("/")
A = B + P
up = requests.post(A + "/upload", files={"files": open(img, "rb")}).json()
print("upload:", up)
fd = lambda p: {"path": p, "orig_name": "image.png", "meta": {"_type": "gradio.FileData"}}
sh = "".join(random.choices(string.ascii_lowercase + string.digits, k=11))

def call(api, data):
    r = requests.post(f"{A}/call/{api}", json={"data": data, "session_hash": sh})
    print("call", api, r.status_code, r.text[:200])
    eid = r.json()["event_id"]
    ev = None
    with requests.get(f"{A}/call/{api}/{eid}", stream=True) as s:
        for line in s.iter_lines(decode_unicode=True):
            if not line: continue
            if line.startswith("event:"): ev = line[6:].strip()
            elif line.startswith("data:"):
                d = line[5:].strip()
                if ev in ("complete", "error"):
                    print("  ", ev, d[:600]); return ev, d
t = time.time()
call("start_session", [])
ev, d = call("preprocess_image", [fd(up[0])])
pre = json.loads(d)[0]
ev, d = call("generate_and_extract_glb", [fd(pre["path"]), [], 0, 7.5, 12, 3, 12, "stochastic", 0.95, 1024])
print("elapsed", time.time() - t)
if ev == "complete":
    res = json.loads(d)
    print("result types:", [type(x).__name__ for x in res])
    for x in res:
        if isinstance(x, dict) and str(x.get("path", "")).endswith(".glb"):
            for url in (x.get("url"), f"{A}/file={x['path']}"):
                r = requests.get(url); print("download", url[:120], r.status_code, len(r.content))
