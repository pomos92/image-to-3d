package com.pomos92.imageto3d;

import java.io.ByteArrayOutputStream;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Random;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hugging Face 공개 Space "tencent/Hunyuan3D-2" 를 Gradio REST API 로 호출해 GLB 를 받아온다.
 * 안드로이드 전용 클래스를 쓰지 않아서 PC 의 java 로도 그대로 테스트할 수 있다:
 *   java HunyuanClient.java 사진.png 결과.glb
 */
public class HunyuanClient {
    public interface Progress { void update(String msg); }

    static final String BASE = "https://tencent-hunyuan3d-2.hf.space";
    private final String token; // 선택: HF 토큰 (사용 한도 늘리기)

    public HunyuanClient(String token) { this.token = (token == null || token.trim().isEmpty()) ? null : token.trim(); }

    private HttpURLConnection open(String url, String method) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(30000);
        c.setReadTimeout(600000);
        c.setRequestProperty("User-Agent", "ImageTo3D-App");
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        return c;
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }

    private static byte[] readBytes(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    private static String body(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String s = in == null ? "" : readAll(in);
        if (code >= 400) throw new Exception("HTTP " + code + ": " + s.substring(0, Math.min(300, s.length())));
        return s;
    }

    private static String jsonEscape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /** 이미지(PNG/JPG 바이트) → GLB 바이트 */
    public byte[] generate(byte[] image, String filename, Progress p) throws Exception {
        p.update("AI 서버 확인 중...");
        String cfg = body(open(BASE + "/config", "GET"));
        Matcher pm = Pattern.compile("\"api_prefix\"\\s*:\\s*\"([^\"]*)\"").matcher(cfg);
        String prefix = pm.find() ? pm.group(1) : "";
        if (prefix.endsWith("/")) prefix = prefix.substring(0, prefix.length() - 1);
        String api = BASE + prefix;

        p.update("사진 올리는 중...");
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
        String upRes = body(up);
        Matcher um = Pattern.compile("\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(upRes);
        if (!um.find()) throw new Exception("업로드 응답 이상: " + upRes);
        String path = um.group(1).replace("\\\\", "\\");

        p.update("AI가 3D를 만드는 중... (보통 30초~2분, 대기열이 있으면 더 걸려요)");
        String file = "{\"path\":\"" + jsonEscape(path) + "\",\"orig_name\":\"" + jsonEscape(filename) + "\",\"meta\":{\"_type\":\"gradio.FileData\"}}";
        int seed = new Random().nextInt(1000000);
        // caption, image, mv_front, mv_back, mv_left, mv_right, steps, guidance, seed, octree_res, rembg, num_chunks, randomize_seed
        String data = "{\"data\":[null," + file + ",null,null,null,null,30,5," + seed + ",256,true,8000,true]}";
        HttpURLConnection call = open(api + "/call/generation_all", "POST");
        call.setDoOutput(true);
        call.setRequestProperty("Content-Type", "application/json");
        try (OutputStream os = call.getOutputStream()) { os.write(data.getBytes(StandardCharsets.UTF_8)); }
        String callRes = body(call);
        Matcher em = Pattern.compile("\"event_id\"\\s*:\\s*\"([^\"]+)\"").matcher(callRes);
        if (!em.find()) throw new Exception("작업 시작 실패: " + callRes);

        HttpURLConnection sse = open(api + "/call/generation_all/" + em.group(1), "GET");
        String event = null, result = null;
        try (BufferedReader br = new BufferedReader(new InputStreamReader(sse.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                if (line.startsWith("event:")) event = line.substring(6).trim();
                else if (line.startsWith("data:")) {
                    String d = line.substring(5).trim();
                    if ("complete".equals(event)) { result = d; break; }
                    if ("error".equals(event)) throw new Exception("AI 서버 오류: " + d
                            + " (무료 사용량을 다 썼을 수 있어요. 잠시 뒤 다시 하거나 HF 토큰을 넣어 보세요)");
                    if ("generating".equals(event) || "heartbeat".equals(event)) p.update("AI가 3D를 만드는 중...");
                }
            }
        }
        if (result == null) throw new Exception("AI 서버 응답이 끊겼어요.");
        // 결과 중 .glb 파일 URL 찾기 (텍스처 있는 것 우선 = 두 번째 파일)
        Matcher fm = Pattern.compile("\"url\"\\s*:\\s*\"([^\"]+\\.glb)\"").matcher(result);
        String glbUrl = null;
        while (fm.find()) glbUrl = fm.group(1);
        if (glbUrl == null) {
            Matcher pm2 = Pattern.compile("\"path\"\\s*:\\s*\"([^\"]+\\.glb)\"").matcher(result);
            while (pm2.find()) glbUrl = api + "/file=" + pm2.group(1);
        }
        if (glbUrl == null) throw new Exception("결과에 3D 파일이 없어요: " + result.substring(0, Math.min(300, result.length())));

        p.update("3D 파일 받는 중...");
        HttpURLConnection dl = open(glbUrl, "GET");
        if (dl.getResponseCode() >= 400) throw new Exception("3D 파일 다운로드 실패: HTTP " + dl.getResponseCode());
        return readBytes(dl.getInputStream());
    }

    /** PC 테스트용 */
    public static void main(String[] args) throws Exception {
        byte[] img = Files.readAllBytes(Paths.get(args[0]));
        long t = System.currentTimeMillis();
        byte[] glb = new HunyuanClient(System.getenv("HF_TOKEN")).generate(img, Paths.get(args[0]).getFileName().toString(), System.out::println);
        Files.write(Paths.get(args[1]), glb);
        System.out.println("OK " + glb.length + " bytes in " + (System.currentTimeMillis() - t) / 1000 + "s");
    }
}
