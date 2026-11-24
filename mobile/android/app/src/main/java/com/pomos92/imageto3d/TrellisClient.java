package com.pomos92.imageto3d;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Random;
import java.util.UUID;

/**
 * Hugging Face 공개 Space "trellis-community/TRELLIS" 를 Gradio 큐 API 로 호출해
 * 색(텍스처)까지 입힌 GLB 를 받아온다. (gradio_client 와 같은 방식)
 * 안드로이드 전용 클래스를 쓰지 않아 PC 의 java 로도 테스트 가능:
 *   java -cp json.jar TrellisClient.java 사진.png 결과.glb
 */
public class TrellisClient {
    public interface Progress { void update(String msg); }

    static final String BASE = "https://trellis-community-trellis.hf.space";
    private final String token;
    private String api;
    private final String session = UUID.randomUUID().toString();
    private JSONArray deps;

    public TrellisClient(String token) {
        this.token = (token == null || token.trim().isEmpty()) ? null : token.trim();
    }

    private HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(30000);
        c.setReadTimeout(900000);
        c.setRequestProperty("User-Agent", "ImageTo3D-App/1.0");
        c.setRequestProperty("x-gradio-user", "api");
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    private static byte[] readBytes(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    private static String text(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String s = in == null ? "" : new String(readBytes(in), StandardCharsets.UTF_8);
        if (code >= 400) throw new Exception("HTTP " + code + " " + s.substring(0, Math.min(300, s.length())));
        return s;
    }

    private String post(String url, String json) throws Exception {
        HttpURLConnection c = open(url, "POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream os = c.getOutputStream()) { os.write(json.getBytes(StandardCharsets.UTF_8)); }
        return text(c);
    }

    private void connect() throws Exception {
        JSONObject cfg = new JSONObject(text(open(BASE + "/config", "GET")));
        String prefix = cfg.optString("api_prefix", "");
        if (prefix.isEmpty() || "null".equals(prefix)) prefix = "/gradio_api";
        if (prefix.endsWith("/")) prefix = prefix.substring(0, prefix.length() - 1);
        api = BASE + prefix;
        deps = cfg.getJSONArray("dependencies");
    }

    private int fnIndex(String apiName) throws Exception {
        for (int i = 0; i < deps.length(); i++) {
            JSONObject d = deps.getJSONObject(i);
            if (apiName.equals(d.optString("api_name"))) return d.optInt("id", i);
        }
        throw new Exception("AI 서버 구성이 바뀌었어요 (" + apiName + " 없음). 앱 업데이트가 필요해요.");
    }

    /** 큐에 작업을 넣고 끝날 때까지 기다린 뒤 output.data 를 돌려준다 */
    private JSONArray run(String apiName, JSONArray data, Progress p, String waitMsg) throws Exception {
        JSONObject body = new JSONObject();
        body.put("data", data);
        body.put("fn_index", fnIndex(apiName));
        body.put("session_hash", session);
        JSONObject join = new JSONObject(post(api + "/queue/join", body.toString()));
        String eventId = join.optString("event_id");

        HttpURLConnection sse = open(api + "/queue/data?session_hash=" + session, "GET");
        sse.setRequestProperty("Accept", "text/event-stream");
        if (sse.getResponseCode() >= 400) text(sse);
        try (BufferedReader br = new BufferedReader(new InputStreamReader(sse.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                if (!line.startsWith("data:")) continue;
                JSONObject m = new JSONObject(line.substring(5).trim());
                String msg = m.optString("msg");
                if (!eventId.isEmpty() && m.has("event_id") && !eventId.equals(m.optString("event_id"))) continue;
                if ("estimation".equals(msg)) {
                    int rank = m.optInt("rank", -1);
                    if (rank > 0) p.update("AI 대기열 " + rank + "번째... 잠시만요");
                    else if (waitMsg != null) p.update(waitMsg);
                } else if ("process_starts".equals(msg)) {
                    if (waitMsg != null) p.update(waitMsg);
                } else if ("process_completed".equals(msg)) {
                    JSONObject out = m.optJSONObject("output");
                    if (!m.optBoolean("success", true) || out == null || !out.has("data")) {
                        String err = out != null ? out.optString("error", "") : "";
                        if (err.isEmpty() || "null".equals(err)) err = "알 수 없는 오류 (" + m.toString().substring(0, Math.min(400, m.toString().length())) + ")";
                        if (err.contains("quota") || err.contains("GPU")) {
                            err += "\n→ 무료 사용량을 다 쓴 것 같아요. 설정에 Hugging Face 토큰을 넣거나 나중에 다시 해 보세요.";
                        }
                        throw new Exception("AI 서버 오류: " + err);
                    }
                    return out.getJSONArray("data");
                } else if ("unexpected_error".equals(msg)) {
                    throw new Exception("AI 서버 오류: " + m.optString("message"));
                }
            }
        }
        throw new Exception("AI 서버 연결이 끊겼어요. 다시 시도해 주세요.");
    }

    private String upload(byte[] image, String filename) throws Exception {
        String boundary = "----img23d" + System.currentTimeMillis();
        HttpURLConnection up = open(api + "/upload", "POST");
        up.setDoOutput(true);
        up.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (OutputStream os = up.getOutputStream()) {
            os.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"" + filename
                    + "\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            os.write(image);
            os.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        }
        return new JSONArray(text(up)).getString(0);
    }

    private static JSONObject fileData(String path, String name) throws Exception {
        JSONObject f = new JSONObject();
        f.put("path", path);
        f.put("orig_name", name);
        JSONObject meta = new JSONObject();
        meta.put("_type", "gradio.FileData");
        f.put("meta", meta);
        return f;
    }

    private static String findGlb(Object o) {
        if (o instanceof JSONObject) {
            JSONObject j = (JSONObject) o;
            String path = j.optString("path", "");
            if (path.endsWith(".glb")) return j.has("url") && !j.isNull("url") ? j.optString("url") : path;
            for (java.util.Iterator<String> it = j.keys(); it.hasNext(); ) {
                String r = findGlb(j.opt(it.next()));
                if (r != null) return r;
            }
        } else if (o instanceof JSONArray) {
            JSONArray a = (JSONArray) o;
            for (int i = 0; i < a.length(); i++) {
                String r = findGlb(a.opt(i));
                if (r != null) return r;
            }
        } else if (o instanceof String && ((String) o).endsWith(".glb")) {
            return (String) o;
        }
        return null;
    }

    /** 이미지(PNG/JPG 바이트) → 색이 입혀진 GLB 바이트 */
    public byte[] generate(byte[] image, String filename, Progress p) throws Exception {
        p.update("AI 서버에 연결 중...");
        connect();
        try { run("start_session", new JSONArray(), p, null); } catch (Exception ignored) { }

        p.update("사진 올리는 중...");
        String path = upload(image, filename);

        p.update("배경 지우는 중...");
        JSONArray pre = run("preprocess_image", new JSONArray().put(fileData(path, filename)), p, "배경 지우는 중...");
        Object preImg = pre.get(0);
        JSONObject preFile = preImg instanceof JSONObject ? (JSONObject) preImg : fileData(String.valueOf(preImg), "image.png");

        JSONArray args = new JSONArray()
                .put(preFile).put(new JSONArray()).put(new Random().nextInt(100000))
                .put(7.5).put(12).put(3).put(12).put("stochastic")
                .put(0.95).put(1024);
        JSONArray out = run("generate_and_extract_glb", args, p, "AI가 3D를 만드는 중... (보통 20초~1분)");

        String glb = findGlb(out);
        if (glb == null) throw new Exception("AI 결과에 3D 파일이 없어요.");
        if (!glb.startsWith("http")) glb = api + "/file=" + glb;
        p.update("3D 파일 받는 중...");
        HttpURLConnection dl = open(glb, "GET");
        if (dl.getResponseCode() >= 400) throw new Exception("3D 파일 다운로드 실패: HTTP " + dl.getResponseCode());
        return readBytes(dl.getInputStream());
    }

    /** PC 테스트용 */
    public static void main(String[] args) throws Exception {
        byte[] img = Files.readAllBytes(Paths.get(args[0]));
        long t = System.currentTimeMillis();
        byte[] glb = new TrellisClient(System.getenv("HF_TOKEN")).generate(img, Paths.get(args[0]).getFileName().toString(), System.out::println);
        Files.write(Paths.get(args[1]), glb);
        System.out.println("OK " + glb.length + " bytes in " + (System.currentTimeMillis() - t) / 1000 + "s");
    }
}
