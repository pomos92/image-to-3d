"""gradio_client 가 실제로 어떤 URL/본문으로 TRELLIS 를 호출하는지 기록 (CI 디버그용)."""
import sys, json, logging, httpx
from gradio_client import Client, handle_file
logging.basicConfig(level=logging.INFO, format="LOG %(message)s")
orig_post = httpx.post
def post(url, *a, **k):
    print("POST", url, "json=", json.dumps(k.get("json"))[:400] if k.get("json") is not None else None, "headers=", {h: v for h, v in (k.get("headers") or {}).items() if h.lower() != "authorization"}, flush=True)
    return orig_post(url, *a, **k)
httpx.post = post
orig_req = httpx.Client.send
def send(self, request, *a, **k):
    print("SEND", request.method, request.url, request.content[:300] if request.method == "POST" and not request.headers.get("content-type", "").startswith("multipart") else "", flush=True)
    return orig_req(self, request, *a, **k)
httpx.Client.send = send
img = sys.argv[1]
c = Client("trellis-community/TRELLIS", verbose=False)
print("src", c.src, "prefixed", c.src_prefixed, "sse_data_url", c.sse_data_url, "protocol", c.protocol)
c.predict(api_name="/start_session")
pre = c.predict(image=handle_file(img), api_name="/preprocess_image")
print("pre", pre)
