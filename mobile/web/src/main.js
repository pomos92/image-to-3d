import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fixMaterials, adjustColors, projectPhoto, beginStroke, paintAt, pickColor, undo as undoColor, clearUndo } from "./paint.js";
import { extractMask } from "./engine.js";
import { autoRig, makeJointMarkers, JOINT_LABELS, PARENT } from "./rig.js";
import { showParts, paintPart, snapshotParts, restoreParts, partColor } from "./parts.js";

const $ = (id) => document.getElementById(id);
const status = (t) => { $("status").textContent = t; };

// ---------- 3D 뷰어 ----------
const view = $("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1a18);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
camera.position.set(0, 0.1, 2.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// 조명: 은은한 전체광 + 카메라를 따라다니는 정면광(돌려 봐도 보는 쪽이 어둡지 않게)
scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b8c4, 2.2));
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const headLight = new THREE.DirectionalLight(0xffffff, 1.5);
headLight.position.set(0.4, 0.6, 1);
camera.add(headLight);
scene.add(camera);
let current = null;

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (current) fitView();
}

// 모델 전체가 화면에 들어오도록 카메라 거리 맞추기 (세로로 긴 휴대폰 화면 고려)
function fitView() {
  const box = new THREE.Box3().setFromObject(current);
  if (box.isEmpty()) return;
  const size = new THREE.Vector3(), c = new THREE.Vector3();
  box.getSize(size); box.getCenter(c);
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(size.y / 2 / t, Math.max(size.x, size.z) / 2 / (t * camera.aspect)) * 1.12 + size.z / 2;
  controls.target.copy(c);
  camera.position.set(c.x, c.y + size.y * 0.05, c.z + dist);
  camera.near = dist / 100; camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.update();
}
window.addEventListener("resize", resize);
if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(view);
resize();
let rig = null, markers = null, selectedJoint = null;
(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  if (markers) markers.userData.update(selectedJoint);
  renderer.render(scene, camera);
})();

// ---------- 이미지 불러오기 ----------
let img = null;
$("file").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  img = new Image();
  img.onload = () => {
    $("preview").src = url;
    $("photo").src = url;
    $("photo").hidden = false;
    view.classList.add("has-photo");
    setBusy(false);
    status("'AI로 3D 만들기'를 눌러 주세요.");
  };
  img.src = url;
});
$("pick").addEventListener("click", () => $("file").click());
$("picker").addEventListener("click", () => $("file").click());

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
  view.classList.add("has-model");
  resize();
  fitView();
  $("save").hidden = false;
  clearRig();
  $("rigbox").hidden = false;
  $("colorbox").hidden = false;
  modelPhoto = img;
  clearUndo();
  setPaint(false);
}

// ---------- 관절(뼈대) ----------
function clearRig() {
  if (markers) { scene.remove(markers); markers = null; }
  if (typeof editGroup !== "undefined" && editGroup) { scene.remove(editGroup); editGroup = null; }
  editing = parting = false;
  $("editctl").hidden = $("partctl").hidden = true;
  $("editjoints").classList.remove("primary");
  $("editparts").classList.remove("primary");
  rig = null; selectedJoint = null;
  $("rigctl").hidden = true;
  $("rig").hidden = false;
}

function selectJoint(name) {
  selectedJoint = name;
  $("joint").value = name;
  $("jointswatch").style.background = "#" + partColor(rig.order.indexOf(name)).getHexString();
  const b = rig.bones[name];
  const e = new THREE.Euler().setFromQuaternion(b.quaternion.clone().multiply(rig.root.userData.restPose[name].clone().invert()));
  $("rx").value = THREE.MathUtils.radToDeg(e.x).toFixed(0);
  $("ry").value = THREE.MathUtils.radToDeg(e.y).toFixed(0);
  $("rz").value = THREE.MathUtils.radToDeg(e.z).toFixed(0);
}

function applySliders() {
  if (!rig || !selectedJoint) return;
  const d = THREE.MathUtils.degToRad;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(d(+$("rx").value), d(+$("ry").value), d(+$("rz").value)));
  rig.bones[selectedJoint].quaternion.copy(q.multiply(rig.root.userData.restPose[selectedJoint]));
}

// 포즈: [x, y, z] 각도(처음 자세 기준) 또는 어깨는 { lift: 수평에서 위로 몇 도, swing: 앞뒤 } 로 지정
function setPose(p) {
  for (const n of rig.order) rig.bones[n].quaternion.copy(rig.root.userData.restPose[n]);
  const d = THREE.MathUtils.degToRad;
  for (const [n, v] of Object.entries(p)) {
    let q;
    if (Array.isArray(v)) {
      const [x, y, z] = v;
      // 오른쪽(R) 관절은 거울 대칭이 되도록 y·z 부호를 뒤집는다
      const m = n.endsWith("R") ? -1 : 1;
      q = new THREE.Quaternion().setFromEuler(new THREE.Euler(d(x), d(y) * m, d(z) * m));
    } else {
      const side = n.slice(-1), s = side === "L" ? 1 : -1;
      const z = s * (d(v.lift) - rig.armLift[side]);
      q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), d(v.swing || 0))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), z));
    }
    rig.bones[n].quaternion.copy(q.multiply(rig.root.userData.restPose[n]));
  }
  if (selectedJoint) selectJoint(selectedJoint);
}

const POSES = {
  reset: {},
  // 팔꿈치 z: +면 팔이 위쪽으로 굽음 (좌우 대칭 처리됨)
  armsdown: { shoulderL: { lift: -72 }, shoulderR: { lift: -72 } },
  wave: { shoulderR: { lift: 55 }, elbowR: [0, 0, 55], shoulderL: { lift: -72 } },
  walk: {
    hipL: [-28, 0, 0], kneeL: [30, 0, 0], hipR: [22, 0, 0], kneeR: [10, 0, 0],
    shoulderL: { lift: -72, swing: 25 }, shoulderR: { lift: -72, swing: -25 },
  },
};

function applyRig(joints) {
  if (current) showParts(current, false);
  const r = autoRig(current, joints ? { joints } : {});
  scene.remove(current);
  current = r.root;
  scene.add(current);
  rig = r;
  clearUndo();
  partUndo.length = 0;
  if (markers) scene.remove(markers);
  const box = new THREE.Box3().setFromObject(current), size = new THREE.Vector3();
  box.getSize(size);
  modelH = Math.max(size.x, size.y, size.z);
  markers = makeJointMarkers(r.bones, modelH);
  scene.add(markers);
  $("joint").innerHTML = r.order.map((n) => `<option value="${n}">${JOINT_LABELS[n]}</option>`).join("");
  selectJoint(selectedJoint && r.bones[selectedJoint] ? selectedJoint : "shoulderR");
  $("rig").hidden = true;
  $("rigctl").hidden = false;
}

$("rig").addEventListener("click", () => {
  if (!current) return;
  try {
    applyRig(null);
    status("뼈대를 넣었어요. 관절이 안 맞으면 '관절 위치 고치기'로 점을 끌어 옮기세요.");
  } catch (e) {
    status("뼈대 넣기 실패: " + e.message);
  }
});
$("joint").addEventListener("change", () => selectJoint($("joint").value));
["rx", "ry", "rz"].forEach((id) => $(id).addEventListener("input", applySliders));
document.querySelectorAll("[data-pose]").forEach((b) => b.addEventListener("click", () => rig && setPose(POSES[b.dataset.pose])));

// 화면에서 관절 점 누르기 (드래그가 아닌 짧은 탭만)
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (painting || editing || parting) return;
  if (!markers || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(v, camera);
  // 점이 작아서 화면상 가장 가까운 관절을 고른다
  let best = null, bd = Infinity;
  for (const m of markers.children) {
    const p = m.position.clone().project(camera);
    const dd = Math.hypot(p.x - v.x, p.y - v.y);
    if (dd < bd) { bd = dd; best = m.userData.joint; }
  }
  if (best && bd < 0.12) { selectJoint(best); status(JOINT_LABELS[best] + " 선택됨"); }
});

function setBusy(b) {
  $("ai").disabled = b || !img;
  $("pick").disabled = b;
}

// ---------- AI로 만들기 (클라우드, 앱 전용) ----------
const hasBridge = !!(window.AndroidBridge && window.AndroidBridge.aiGenerate);
if (!hasBridge) $("ai").title = "안드로이드 앱에서만 쓸 수 있어요";
// 토큰은 이 폰(앱 저장소)에만 저장되고, 앱을 다시 켜도 유지된다
function savedToken() { try { return localStorage.getItem("hfToken") || ""; } catch (e) { return ""; } }
function showTokenState() {
  const t = savedToken();
  $("tokenstate").textContent = t ? "✓ 이 폰에 저장됨 (" + t.slice(0, 5) + "…)" : (window.DEFAULT_HF_TOKEN ? "앱에 들어 있는 기본 토큰을 써요" : "저장된 토큰 없음 · 넣으면 AI를 더 많이 쓸 수 있어요");
}
$("hftoken").value = savedToken();
if (window.DEFAULT_HF_TOKEN) $("hftoken").placeholder = "비워 두면 앱에 들어 있는 토큰을 써요";
function storeToken() {
  const t = $("hftoken").value.trim();
  if (t && !/^hf_[A-Za-z0-9]{20,}$/.test(t)) { $("tokenstate").textContent = "토큰 모양이 이상해요. hf_로 시작하는지 확인해 주세요."; return; }
  try { if (t) localStorage.setItem("hfToken", t); else localStorage.removeItem("hfToken"); } catch (e) {}
  showTokenState();
}
$("hftoken").addEventListener("change", storeToken);
$("tokensave").addEventListener("click", storeToken);
$("tokenclear").addEventListener("click", () => { $("hftoken").value = ""; storeToken(); });
showTokenState();

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
      fixMaterials(root);
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
  window.AndroidBridge.aiGenerate(b64, name, savedToken() || window.DEFAULT_HF_TOKEN || "");
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

// 현재 자세를 그대로 굳힌 일반 메쉬들 (STL/OBJ 용)
function bakedMeshes(root) {
  root.updateMatrixWorld(true);
  const out = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    const pos = g.attributes.position;
    if (o.isSkinnedMesh) {
      o.skeleton.update();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        o.applyBoneTransform(i, v);
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      g.deleteAttribute("skinIndex"); g.deleteAttribute("skinWeight");
      g.deleteAttribute("normal");
      g.applyMatrix4(o.matrixWorld);
      g.computeVertexNormals();
    } else {
      g.applyMatrix4(o.matrixWorld);
    }
    out.push({ geometry: g, material: Array.isArray(o.material) ? o.material[0] : o.material });
  });
  return out;
}

// 정점 색 구하기: 정점 색 → 텍스처(uv) → 재질 색 순서. sRGB 0~1 로 돌려줌
function vertexColorsOf(geometry, material) {
  const n = geometry.attributes.position.count;
  const out = new Float32Array(n * 3);
  const c = new THREE.Color();
  const col = geometry.getAttribute("color");
  const uv = geometry.getAttribute("uv");
  const map = material && material.map && material.map.image;
  if (col) {
    for (let i = 0; i < n; i++) { c.fromBufferAttribute(col, i); c.convertLinearToSRGB(); out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b; }
  } else if (uv && map) {
    const cv = document.createElement("canvas");
    cv.width = map.width; cv.height = map.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(map, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const flipY = material.map.flipY;
    for (let i = 0; i < n; i++) {
      let u = uv.getX(i) % 1, t = uv.getY(i) % 1;
      if (u < 0) u += 1; if (t < 0) t += 1;
      const x = Math.min(cv.width - 1, Math.floor(u * cv.width));
      const y = Math.min(cv.height - 1, Math.floor((flipY ? 1 - t : t) * cv.height));
      const k = (y * cv.width + x) * 4;
      out[3 * i] = px[k] / 255; out[3 * i + 1] = px[k + 1] / 255; out[3 * i + 2] = px[k + 2] / 255;
    }
  } else {
    c.copy(material && material.color ? material.color : new THREE.Color(1, 1, 1)).convertLinearToSRGB();
    for (let i = 0; i < n; i++) { out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b; }
  }
  return out;
}

// 색 포함 OBJ ("v x y z r g b" — 블렌더·MeshLab 등에서 색이 보임)
function exportColoredObj(root) {
  const parts = [];
  let base = 1;
  for (const { geometry: g, material } of bakedMeshes(root)) {
    const pos = g.attributes.position, cols = vertexColorsOf(g, material);
    const lines = [];
    for (let i = 0; i < pos.count; i++) {
      lines.push(`v ${pos.getX(i).toFixed(5)} ${pos.getY(i).toFixed(5)} ${pos.getZ(i).toFixed(5)} ${cols[3 * i].toFixed(4)} ${cols[3 * i + 1].toFixed(4)} ${cols[3 * i + 2].toFixed(4)}`);
    }
    const idx = g.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx.getX(3 * t) : 3 * t, b = idx ? idx.getX(3 * t + 1) : 3 * t + 1, c = idx ? idx.getX(3 * t + 2) : 3 * t + 2;
      lines.push(`f ${a + base} ${b + base} ${c + base}`);
    }
    base += pos.count;
    parts.push(lines.join("\n"));
  }
  return "# ImageTo3D\n" + parts.join("\n") + "\n";
}

function mergedPositions(root) {
  // 모든 메쉬를 (현재 자세 그대로) 월드 좌표로 합친 위치 전용 지오메트리
  const parts = bakedMeshes(root).map(({ geometry }) => (geometry.index ? geometry.toNonIndexed() : geometry).attributes.position);
  let n = 0; for (const p of parts) n += p.count;
  const arr = new Float32Array(n * 3);
  let off = 0;
  for (const p of parts) { arr.set(p.array.subarray(0, p.count * 3), off); off += p.count * 3; }
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
  // 부위 보기 중이면 원래 색으로 돌려서 저장
  const wasParting = parting;
  if (wasParting) showParts(current, false);
  Promise.resolve().then(() => exportAs(btn.dataset.fmt))
    .catch((e) => status("저장 실패: " + (e && e.message ? e.message : e)))
    .finally(() => { if (wasParting && parting) showParts(current, true); });
}));

function exportAs(fmt) {
  const name = stamp();
  if (fmt === "glb") {
    return new GLTFExporter().parseAsync(current, { binary: true }).then((glb) => saveFile(name + ".glb", glb, "model/gltf-binary"));
  } else if (fmt === "stl") {
    const mm = Number($("sizemm").value) || 100;
    const dv = new STLExporter().parse(printableClone(mm), { binary: true });
    saveFile(name + ".stl", dv.buffer, "model/stl");
  } else if (fmt === "obj") {
    saveFile(name + ".obj", exportColoredObj(current), "text/plain");
  }
}

// ---------- 색 입히기 ----------
let modelPhoto = null, painting = false, picking = false, stroking = false;
const raycaster = new THREE.Raycaster();

function setPaint(on) {
  if (on && editing) setEditing(false);
  if (on && parting) setParting(false);
  painting = on;
  picking = false;
  $("paintctl").hidden = !on;
  $("painttoggle").innerHTML = on ? "칠하기 끝" : "직접 칠하기<br><small>손가락으로 칠해요</small>";
  $("painttoggle").classList.toggle("primary", on);
}

function hitAt(e) {
  if (!current) return null;
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(current, true).filter((h) => h.object.isMesh && h.face);
  return hits[0] || null;
}

$("pstrength").addEventListener("input", () => { $("pstrengthv").textContent = $("pstrength").value + "%"; });
$("painttoggle").addEventListener("click", () => {
  if (!current) return;
  setPaint(!painting);
  if (painting) { status("모델 위를 손가락으로 문질러 칠하세요."); $("colorbox").scrollIntoView({ behavior: "smooth", block: "start" }); }
});
$("ppick").addEventListener("click", () => { picking = true; status("모델에서 색을 가져올 곳을 누르세요."); });
$("pundo").addEventListener("click", () => status(undoColor() ? "되돌렸어요." : "되돌릴 게 없어요."));

$("photocolor").addEventListener("click", () => {
  if (!current) return;
  const photo = modelPhoto || img;
  if (!photo) { status("먼저 사진을 골라 주세요."); return; }
  status("사진 색 입히는 중...");
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const s = Math.min(1, 1024 / Math.max(photo.naturalWidth, photo.naturalHeight));
      const w = Math.max(1, Math.round(photo.naturalWidth * s)), h = Math.max(1, Math.round(photo.naturalHeight * s));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(photo, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const mask = extractMask(data, w, h, true);
      projectPhoto(current, { data, w, h, mask }, { strength: Number($("pstrength").value) / 100, back: $("pback").checked });
      status(`사진 색을 입혔어요 (${((performance.now() - t0) / 1000).toFixed(1)}초). 마음에 안 들면 '색 되돌리기'.`);
    } catch (err) {
      status("색 입히기 실패: " + (err && err.message ? err.message : err));
    }
  }, 30);
});

renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!painting) return;
  const hit = hitAt(e);
  if (!hit) return;
  e.stopImmediatePropagation(); // 모델 위는 칠하기, 빈 곳은 화면 돌리기
  if (picking) {
    const c = pickColor(hit);
    if (c) { $("pcolor").value = "#" + c.getHexString(THREE.NoColorSpace); status("이 색으로 칠할게요."); }
    picking = false;
    return;
  }
  stroking = true;
  renderer.domElement.setPointerCapture(e.pointerId);
  beginStroke(current);
  paintAt(hit, new THREE.Color().setStyle($("pcolor").value, THREE.NoColorSpace), Number($("psize").value) / 200);
}, { capture: true });
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!painting || !stroking) return;
  const hit = hitAt(e);
  if (hit) paintAt(hit, new THREE.Color().setStyle($("pcolor").value, THREE.NoColorSpace), Number($("psize").value) / 200);
}, { capture: true });
const endStroke = () => { stroking = false; };
renderer.domElement.addEventListener("pointerup", endStroke);
renderer.domElement.addEventListener("pointercancel", endStroke);

// ---------- 관절 위치 고치기 · 부위 나누기 ----------
let editing = false, parting = false, editJoints = null, editGroup = null, dragJoint = null, modelH = 1;
let partStroke = false;
const partUndo = [];
const dragPlane = new THREE.Plane();

function ndcOf(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}
// 화면에서 손가락 가까이(28px 이내)에 있는 관절
function jointNear(e, posOf) {
  const r = renderer.domElement.getBoundingClientRect();
  let best = null, bd = 28;
  for (const n of rig.order) {
    const p = posOf(n).clone().project(camera);
    const x = (p.x + 1) / 2 * r.width + r.left, y = (1 - p.y) / 2 * r.height + r.top;
    const d = Math.hypot(x - e.clientX, y - e.clientY);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

function buildEditGroup() {
  if (editGroup) scene.remove(editGroup);
  editGroup = new THREE.Group();
  const geo = new THREE.SphereGeometry(0.018 * modelH, 14, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff6a00, depthTest: false });
  const sel = new THREE.MeshBasicMaterial({ color: 0x1e88ff, depthTest: false });
  const balls = {};
  for (const n of rig.order) {
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1000;
    m.userData.isMarker = true;
    balls[n] = m;
    editGroup.add(m);
  }
  const lineGeo = new THREE.BufferGeometry();
  const pairs = rig.order.filter((n) => PARENT[n]);
  lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xff6a00, depthTest: false }));
  lines.renderOrder = 999;
  editGroup.add(lines);
  editGroup.userData.refresh = () => {
    for (const n of rig.order) {
      balls[n].position.fromArray(editJoints[n]);
      balls[n].material = n === selectedJoint ? sel : mat;
    }
    const a = lineGeo.attributes.position;
    pairs.forEach((n, i) => { a.setXYZ(2 * i, ...editJoints[n]); a.setXYZ(2 * i + 1, ...editJoints[PARENT[n]]); });
    a.needsUpdate = true;
  };
  editGroup.userData.refresh();
  scene.add(editGroup);
}

function setEditing(on) {
  if (on && parting) setParting(false);
  if (on) setPaint(false);
  editing = on;
  $("editctl").hidden = !on;
  $("editjoints").classList.toggle("primary", on);
  if (on) {
    setPose(POSES.reset);
    editJoints = {};
    for (const n of rig.order) editJoints[n] = rig.joints[n].slice();
    markers.visible = false;
    buildEditGroup();
    $("rigbox").scrollIntoView({ behavior: "smooth", block: "start" });
    status("점을 끌어서 관절 위치를 맞추세요. 다 되면 '이 위치로 뼈대 다시 넣기'.");
  } else {
    if (editGroup) { scene.remove(editGroup); editGroup = null; }
    if (markers) markers.visible = true;
    dragJoint = null;
  }
}

function setParting(on) {
  if (on && editing) setEditing(false);
  if (on) setPaint(false);
  parting = on;
  $("partctl").hidden = !on;
  $("editparts").classList.toggle("primary", on);
  showParts(current, on);
  if (on) $("rigbox").scrollIntoView({ behavior: "smooth", block: "start" });
  if (on) status("색깔별 덩어리가 관절마다 나뉜 모습이에요. 관절을 고르고 문질러서 고치세요.");
}

$("editjoints").addEventListener("click", () => rig && setEditing(!editing));
$("editcancel").addEventListener("click", () => { setEditing(false); status("관절 위치 고치기를 취소했어요."); });
$("editapply").addEventListener("click", () => {
  const j = editJoints;
  setEditing(false);
  try {
    applyRig(j);
    status("새 관절 위치로 뼈대를 다시 넣었어요. 덩어리가 이상하면 '부위 나누기'로 고치세요.");
  } catch (e) { status("뼈대 다시 넣기 실패: " + e.message); }
});
$("editparts").addEventListener("click", () => rig && setParting(!parting));
$("partdone").addEventListener("click", () => { setParting(false); status("부위 나누기를 마쳤어요. 포즈 버튼이나 슬라이더로 확인해 보세요."); });
$("partundo").addEventListener("click", () => {
  const s = partUndo.pop();
  if (s) { restoreParts(s); status("되돌렸어요."); } else status("되돌릴 게 없어요.");
});

// 관절 끌기/부위 칠하기는 화면 돌리기보다 먼저 받아서, 모델·점 위를 누르면 화면이 안 돌게 한다
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!rig || !(editing || parting)) return;
  if (editing) {
    const n = jointNear(e, (k) => new THREE.Vector3().fromArray(editJoints[k]));
    if (!n) return;
    e.stopImmediatePropagation();
    dragJoint = n;
    selectJoint(n);
    editGroup.userData.refresh();
    const p = new THREE.Vector3().fromArray(editJoints[n]);
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), p);
    renderer.domElement.setPointerCapture(e.pointerId);
    return;
  }
  // parting
  const n = jointNear(e, (k) => rig.bones[k].getWorldPosition(new THREE.Vector3()));
  if (n) { e.stopImmediatePropagation(); selectJoint(n); status(JOINT_LABELS[n] + " 선택됨 · 이제 모델을 문질러 칠하세요"); return; }
  const hit = hitAt(e);
  if (!hit || !hit.object.isSkinnedMesh) return;
  e.stopImmediatePropagation();
  partUndo.push(snapshotParts(current));
  if (partUndo.length > 6) partUndo.shift();
  partStroke = true;
  renderer.domElement.setPointerCapture(e.pointerId);
  paintPart(hit, rig.order.indexOf(selectedJoint), Number($("partsize").value) / 200);
}, { capture: true });

renderer.domElement.addEventListener("pointermove", (e) => {
  if (editing && dragJoint) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndcOf(e), camera);
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(dragPlane, p)) return;
    editJoints[dragJoint] = [p.x, p.y, p.z];
    if ($("mirror").checked && /[LR]$/.test(dragJoint)) {
      const other = dragJoint.slice(0, -1) + (dragJoint.endsWith("L") ? "R" : "L");
      const cx = editJoints.hips[0];
      editJoints[other] = [2 * cx - p.x, p.y, p.z];
    }
    editGroup.userData.refresh();
  } else if (parting && partStroke) {
    const hit = hitAt(e);
    if (hit && hit.object.isSkinnedMesh) paintPart(hit, rig.order.indexOf(selectedJoint), Number($("partsize").value) / 200);
  }
}, { capture: true });
const endEdit = () => { dragJoint = null; partStroke = false; };
renderer.domElement.addEventListener("pointerup", endEdit);
renderer.domElement.addEventListener("pointercancel", endEdit);

$("brighter").addEventListener("click", () => { if (current) { adjustColors(current, 1.18, 1.05); status("색을 밝게 했어요. 저장하면 파일에도 그대로 들어가요."); } });
$("darker").addEventListener("click", () => { if (current) { adjustColors(current, 1 / 1.18, 1); status("색을 조금 어둡게 했어요."); } });
