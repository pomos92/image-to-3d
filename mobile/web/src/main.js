import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { buildMesh } from "./engine.js";

const $ = (id) => document.getElementById(id);
const status = (t) => { $("status").textContent = t; };

// ---------- 3D 뷰어 ----------
const view = $("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2f3f5);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
camera.position.set(0, 0.1, 2.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 2, 3);
scene.add(sun);
let current = null;

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();
(function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();

// ---------- 이미지 불러오기 ----------
let img = null;
$("file").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  img = new Image();
  img.onload = () => {
    $("preview").src = url;
    $("preview").hidden = false;
    $("pick").textContent = "다른 사진 고르기";
    setBusy(false);
    status("'AI로 만들기'(고품질, 인터넷 필요) 또는 '빠른 3D'(휴대폰 안에서)를 눌러 주세요.");
  };
  img.src = url;
});
$("pick").addEventListener("click", () => $("file").click());
$("thick").addEventListener("input", () => { $("thickv").textContent = Number($("thick").value).toFixed(2); });

function imageData(maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

function showModel(obj) {
  if (current) {
    scene.remove(current);
    current.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
  current = obj;
  scene.add(current);
  controls.reset();
  $("save").hidden = false;
}

function setBusy(b) {
  $("make").disabled = b || !img;
  $("ai").disabled = b || !img;
  $("pick").disabled = b;
}

// ---------- AI로 만들기 (클라우드, 앱 전용) ----------
const hasBridge = !!(window.AndroidBridge && window.AndroidBridge.aiGenerate);
if (!hasBridge) $("ai").title = "안드로이드 앱에서만 쓸 수 있어요";
try { $("hftoken").value = localStorage.getItem("hfToken") || ""; } catch (e) {}
$("hftoken").addEventListener("change", () => { try { localStorage.setItem("hfToken", $("hftoken").value.trim()); } catch (e) {} });

function aiImage() {
  // 긴 변 1024px. 투명 배경이 있으면 PNG, 아니면 JPEG
  const s = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let alpha = false;
  for (let i = 3; i < d.length; i += 4 * 97) if (d[i] < 250) { alpha = true; break; }
  const url = alpha ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.92);
  return { b64: url.split(",")[1], name: alpha ? "photo.png" : "photo.jpg" };
}

let aiStart = 0;
window.onAiProgress = (m) => status(m + ` (${Math.round((performance.now() - aiStart) / 1000)}초)`);
window.onAiError = (m) => { status("AI 실패: " + m); setBusy(false); };
window.onAiDone = (b64) => {
  try {
    const bin = atob(b64), buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    new GLTFLoader().parse(buf.buffer, "", (gltf) => {
      const root = gltf.scene;
      // 크기를 긴 변 1 로, 중심을 원점으로
      const box = new THREE.Box3().setFromObject(root), size = new THREE.Vector3(), center = new THREE.Vector3();
      box.getSize(size); box.getCenter(center);
      const k = 1 / Math.max(size.x, size.y, size.z, 1e-6);
      const wrap = new THREE.Group();
      root.position.sub(center);
      wrap.add(root);
      wrap.scale.setScalar(k);
      wrap.name = "model";
      showModel(wrap);
      let tris = 0;
      wrap.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
      status(`AI 완료! ${Math.round(tris).toLocaleString()}개 삼각형 · ${Math.round((performance.now() - aiStart) / 1000)}초. 손가락으로 돌려 보세요.`);
      setBusy(false);
    }, (e) => { status("3D 파일을 열지 못했어요: " + e); setBusy(false); });
  } catch (e) { status("3D 파일을 열지 못했어요: " + e.message); setBusy(false); }
};

$("ai").addEventListener("click", () => {
  if (!img) return;
  if (!hasBridge) { status("AI 기능은 안드로이드 앱에서만 쓸 수 있어요."); return; }
  setBusy(true);
  aiStart = performance.now();
  status("AI 준비 중...");
  const { b64, name } = aiImage();
  window.AndroidBridge.aiGenerate(b64, name, $("hftoken").value.trim());
});

// ---------- 3D 만들기 ----------
$("make").addEventListener("click", () => {
  if (!img) return;
  setBusy(true);
  status("3D 만드는 중... (몇 초 걸려요)");
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const { data, w, h } = imageData(640);
      const res = Number($("quality").value);
      const m = buildMesh(data, w, h, {
        removeBg: $("removebg").checked,
        resolution: res,
        thickness: Number($("thick").value),
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      // 이미지 색(sRGB)을 3D 렌더링용 선형 색으로 변환
      const lin = new Float32Array(m.colors.length);
      for (let i = 0; i < lin.length; i++) lin[i] = Math.pow(m.colors[i], 2.2);
      geo.setAttribute("color", new THREE.BufferAttribute(lin, 3));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = "model";
      showModel(mesh);
      status(`완료! ${(m.indices.length / 3).toLocaleString()}개 삼각형 · ${((performance.now() - t0) / 1000).toFixed(1)}초. 손가락으로 돌려 보세요.`);
    } catch (err) {
      status("실패: " + (err && err.message ? err.message : err));
    } finally {
      setBusy(false);
    }
  }, 50);
});

// ---------- 저장 ----------
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `model_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function saveFile(name, data, mime) {
  const buf = typeof data === "string" ? new TextEncoder().encode(data).buffer : data;
  if (window.AndroidBridge && window.AndroidBridge.saveFile) {
    const ok = window.AndroidBridge.saveFile(name, mime, toBase64(buf));
    status(ok ? `저장했어요: 다운로드/ImageTo3D/${name}` : "저장에 실패했어요.");
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], { type: mime }));
  a.download = name;
  a.click();
  status(`저장했어요: ${name}`);
}

function mergedPositions(root) {
  // 모든 메쉬를 월드 좌표로 합친 위치 전용 지오메트리
  root.updateMatrixWorld(true);
  const parts = [];
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    const pos = g.attributes.position.clone();
    pos.applyMatrix4(o.matrixWorld);
    parts.push(pos); n += pos.count;
  });
  const arr = new Float32Array(n * 3);
  let off = 0;
  for (const p of parts) { for (let i = 0; i < p.count; i++) { arr[off++] = p.getX(i); arr[off++] = p.getY(i); arr[off++] = p.getZ(i); } }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  return g;
}

function printableClone(sizeMm) {
  // 3D 프린팅용: Z 위쪽, 가장 긴 변 = sizeMm, 바닥 z=0
  const g = mergedPositions(current);
  g.rotateX(Math.PI / 2);
  g.computeBoundingBox();
  const bb = g.boundingBox, size = new THREE.Vector3();
  bb.getSize(size);
  const k = sizeMm / Math.max(size.x, size.y, size.z);
  g.scale(k, k, k);
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  return new THREE.Mesh(g);
}

document.querySelectorAll("[data-fmt]").forEach((btn) => btn.addEventListener("click", () => {
  if (!current) return;
  const name = stamp();
  const fmt = btn.dataset.fmt;
  if (fmt === "glb") {
    new GLTFExporter().parse(current, (glb) => saveFile(name + ".glb", glb, "model/gltf-binary"),
      (e) => status("GLB 저장 실패: " + e), { binary: true });
  } else if (fmt === "stl") {
    const mm = Number($("sizemm").value) || 100;
    const dv = new STLExporter().parse(printableClone(mm), { binary: true });
    saveFile(name + ".stl", dv.buffer, "model/stl");
  } else if (fmt === "obj") {
    saveFile(name + ".obj", new OBJExporter().parse(current), "text/plain");
  }
}));
