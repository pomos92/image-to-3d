import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
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
    $("make").disabled = false;
    status("'3D 만들기'를 눌러 주세요.");
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

// ---------- 3D 만들기 ----------
$("make").addEventListener("click", () => {
  if (!img) return;
  $("make").disabled = true;
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
      if (current) { scene.remove(current); current.geometry.dispose(); }
      current = new THREE.Mesh(geo, mat);
      current.name = "model";
      scene.add(current);
      controls.reset();
      $("save").hidden = false;
      status(`완료! ${(m.indices.length / 3).toLocaleString()}개 삼각형 · ${((performance.now() - t0) / 1000).toFixed(1)}초. 손가락으로 돌려 보세요.`);
    } catch (err) {
      status("실패: " + (err && err.message ? err.message : err));
    } finally {
      $("make").disabled = false;
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

function printableClone(sizeMm) {
  // 3D 프린팅용: Z 위쪽, 가장 긴 변 = sizeMm, 바닥 z=0
  const g = current.geometry.clone();
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
