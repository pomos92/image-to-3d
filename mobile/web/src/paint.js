// 색 입히기: 원본 사진 색을 모델에 투영하거나, 손가락으로 직접 칠하기.
// 텍스처가 있는 모델(AI)은 텍스처 픽셀에, 정점 색 모델(빠른 3D)은 정점 색에 칠한다.
import * as THREE from "three";

const MAX_TEX = 2048;
const surfaces = new WeakMap();

function meshesOf(root) {
  const out = [];
  root.traverse((o) => { if (o.isMesh && !o.userData.isMarker && o.geometry && o.geometry.attributes.position) out.push(o); });
  return out;
}

function firstMat(mesh) {
  if (Array.isArray(mesh.material)) {
    mesh.material = mesh.material[0];
  }
  return mesh.material;
}

// AI 모델(TRELLIS 등)은 metallic 값이 비어 있어 금속(=1)으로 읽혀 어둡고 칙칙하게 보인다 → 비금속으로
export function fixMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m && "metalness" in m) {
        m.metalness = 0;
        m.metalnessMap = null;
        if (m.roughness < 0.5) m.roughness = 0.6;
        m.needsUpdate = true;
      }
    }
  });
}

// ---- 칠할 수 있는 '표면' 준비: 텍셀 또는 정점마다 (위치, 법선, 저장 위치) ----
function surfaceOf(mesh) {
  let s = surfaces.get(mesh);
  if (s && s.geometry === mesh.geometry) return s;
  const g = mesh.geometry;
  if (!g.attributes.normal) g.computeVertexNormals();
  const mat = firstMat(mesh);
  const uv = g.attributes.uv;
  if (uv && mat.map && mat.map.image) s = textureSurface(mesh, g, mat, uv);
  else s = vertexSurface(mesh, g, mat);
  s.geometry = g;
  surfaces.set(mesh, s);
  return s;
}

function vertexSurface(mesh, g, mat) {
  const n = g.attributes.position.count;
  let col = g.attributes.color;
  if (!col || col.itemSize < 3) {
    const base = (mat.color || new THREE.Color(1, 1, 1)).clone();
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[3 * i] = base.r; arr[3 * i + 1] = base.g; arr[3 * i + 2] = base.b; }
    col = new THREE.BufferAttribute(arr, 3);
    g.setAttribute("color", col);
    if (mat.color) mat.color.set(1, 1, 1);
  }
  mat.vertexColors = true;
  mat.needsUpdate = true;
  // 작업용 sRGB 0~255 버퍼
  const rgb = new Uint8ClampedArray(n * 4);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.fromBufferAttribute(col, i).convertLinearToSRGB();
    rgb[4 * i] = c.r * 255; rgb[4 * i + 1] = c.g * 255; rgb[4 * i + 2] = c.b * 255; rgb[4 * i + 3] = 255;
  }
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const P = g.attributes.position, N = g.attributes.normal;
  for (let i = 0; i < n; i++) {
    pos[3 * i] = P.getX(i); pos[3 * i + 1] = P.getY(i); pos[3 * i + 2] = P.getZ(i);
    nrm[3 * i] = N.getX(i); nrm[3 * i + 1] = N.getY(i); nrm[3 * i + 2] = N.getZ(i);
  }
  return {
    kind: "vertex", mesh, rgb, idx, pos, nrm,
    commit() {
      for (let i = 0; i < n; i++) {
        c.setRGB(rgb[4 * i] / 255, rgb[4 * i + 1] / 255, rgb[4 * i + 2] / 255).convertSRGBToLinear();
        col.setXYZ(i, c.r, c.g, c.b);
      }
      col.needsUpdate = true;
    },
  };
}

function textureSurface(mesh, g, mat, uv) {
  const old = mat.map;
  const im = old.image;
  const sc = Math.min(1, MAX_TEX / Math.max(im.width, im.height));
  const W = Math.max(1, Math.round(im.width * sc)), H = Math.max(1, Math.round(im.height * sc));
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(im, 0, 0, W, H);
  const imgData = ctx.getImageData(0, 0, W, H);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = old.flipY;
  tex.colorSpace = old.colorSpace || THREE.SRGBColorSpace;
  tex.wrapS = old.wrapS; tex.wrapT = old.wrapT;
  tex.magFilter = old.magFilter; tex.minFilter = old.minFilter;
  tex.channel = old.channel;
  mat.map = tex;
  mat.needsUpdate = true;
  const flipY = old.flipY;

  // 삼각형을 UV 공간에 그려서, 각 텍셀의 3D 위치·법선을 구한다
  const P = g.attributes.position, N = g.attributes.normal;
  const index = g.index;
  const triCount = index ? index.count / 3 : P.count / 3;
  const owner = new Uint8Array(W * H);
  let cap = 1 << 18, cnt = 0;
  let idx = new Int32Array(cap), pos = new Float32Array(cap * 3), nrm = new Float32Array(cap * 3);
  const grow = () => {
    cap *= 2;
    const i2 = new Int32Array(cap); i2.set(idx); idx = i2;
    const p2 = new Float32Array(cap * 3); p2.set(pos); pos = p2;
    const n2 = new Float32Array(cap * 3); n2.set(nrm); nrm = n2;
  };
  const vi = [0, 0, 0], px = [0, 0, 0], py = [0, 0, 0];
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(3 * t + k) : 3 * t + k;
      vi[k] = v;
      let u = uv.getX(v), w = uv.getY(v);
      px[k] = u * W;
      py[k] = (flipY ? 1 - w : w) * H;
    }
    const x0 = px[0], y0 = py[0], x1 = px[1], y1 = py[1], x2 = px[2], y2 = py[2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    // 가장자리 경계선이 비지 않도록 0.75px 바깥까지 포함
    const e0 = Math.hypot(x2 - x1, y2 - y1), e1 = Math.hypot(x0 - x2, y0 - y2), e2 = Math.hypot(x1 - x0, y1 - y0);
    const A = Math.abs(area);
    const t0 = -0.75 * e0 / A, t1 = -0.75 * e1 / A, t2 = -0.75 * e2 / A;
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2) - 1)), bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2) + 1));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2) - 1)), by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2) + 1));
    for (let y = by0; y <= by1; y++) {
      const cy = y + 0.5;
      for (let x = bx0; x <= bx1; x++) {
        const o = y * W + x;
        if (owner[o]) continue;
        const cx = x + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < t0 || w1 < t1 || w2 < t2) continue;
        owner[o] = 1;
        if (cnt === cap) grow();
        idx[cnt] = o;
        const a = Math.min(1, Math.max(0, w0)), b = Math.min(1, Math.max(0, w1)), c = Math.min(1, Math.max(0, w2));
        const sum = a + b + c || 1;
        for (let d = 0; d < 3; d++) {
          const get = d === 0 ? "getX" : d === 1 ? "getY" : "getZ";
          pos[3 * cnt + d] = (P[get](vi[0]) * a + P[get](vi[1]) * b + P[get](vi[2]) * c) / sum;
          nrm[3 * cnt + d] = (N[get](vi[0]) * a + N[get](vi[1]) * b + N[get](vi[2]) * c) / sum;
        }
        cnt++;
      }
    }
  }
  return {
    kind: "texture", mesh, rgb: imgData.data, idx: idx.subarray(0, cnt),
    pos: pos.subarray(0, cnt * 3), nrm: nrm.subarray(0, cnt * 3),
    commit() { ctx.putImageData(imgData, 0, 0); tex.needsUpdate = true; },
  };
}

// ---- 되돌리기 ----
const undoStack = [];
function snapshot(list) {
  undoStack.push(list.map((s) => ({ s, data: s.rgb.slice() })));
  if (undoStack.length > 6) undoStack.shift();
}
export function undo() {
  const snap = undoStack.pop();
  if (!snap) return false;
  for (const { s, data } of snap) { s.rgb.set(data); s.commit(); }
  return true;
}
export function clearUndo() { undoStack.length = 0; }

// ---- 원본 사진 색 투영 ----
// photo: {data(RGBA), w, h, mask(Uint8Array)}; strength 0~1; back: 뒷면에도 입힐지
export function projectPhoto(root, photo, { strength = 1, back = true } = {}) {
  root.updateMatrixWorld(true);
  const list = meshesOf(root).map(surfaceOf);
  if (!list.length) throw new Error("3D 모델이 없어요.");
  snapshot(list);

  // 사진 속 물체 범위
  const { w: pw, h: ph, mask } = photo;
  let mx0 = pw, mx1 = -1, my0 = ph, my1 = -1;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (mask[y * pw + x]) {
    if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y;
  }
  if (mx1 < 0) throw new Error("사진에서 물체를 찾지 못했어요.");
  const fill = filledPhoto(photo);

  // 모델(처음 자세)의 월드 좌표 범위와 깊이 버퍼(앞·뒤)
  const geoWorld = meshesOf(root).map((m) => {
    const p = m.geometry.attributes.position, mw = m.matrixWorld, v = new THREE.Vector3();
    const out = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(mw); out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z; }
    return { m, w: out, index: m.geometry.index };
  });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const { w } of geoWorld) for (let i = 0; i < w.length; i += 3) {
    if (w[i] < x0) x0 = w[i]; if (w[i] > x1) x1 = w[i];
    if (w[i + 1] < y0) y0 = w[i + 1]; if (w[i + 1] > y1) y1 = w[i + 1];
    if (w[i + 2] < z0) z0 = w[i + 2]; if (w[i + 2] > z1) z1 = w[i + 2];
  }
  const SX = x1 - x0 || 1e-6, SY = y1 - y0 || 1e-6;
  const G = 512;
  const gw = SX >= SY ? G : Math.max(16, Math.round((G * SX) / SY)), gh = SY >= SX ? G : Math.max(16, Math.round((G * SY) / SX));
  const zf = new Float32Array(gw * gh).fill(-Infinity), zb = new Float32Array(gw * gh).fill(Infinity);
  const gx = (x) => ((x - x0) / SX) * gw, gy = (y) => ((y1 - y) / SY) * gh;
  for (const { w, index } of geoWorld) {
    const tc = index ? index.count / 3 : w.length / 9;
    for (let t = 0; t < tc; t++) {
      const a = index ? index.getX(3 * t) : 3 * t, b = index ? index.getX(3 * t + 1) : 3 * t + 1, c = index ? index.getX(3 * t + 2) : 3 * t + 2;
      rasterZ(gx(w[3 * a]), gy(w[3 * a + 1]), w[3 * a + 2], gx(w[3 * b]), gy(w[3 * b + 1]), w[3 * b + 2], gx(w[3 * c]), gy(w[3 * c + 1]), w[3 * c + 2], gw, gh, zf, zb);
    }
  }
  const tol = 0.02 * Math.max(SX, SY, z1 - z0);
  const v = new THREE.Vector3(), nv = new THREE.Vector3(), nm = new THREE.Matrix3();
  for (const s of list) {
    const mw = s.mesh.matrixWorld;
    nm.getNormalMatrix(mw);
    const { pos, nrm, idx, rgb } = s;
    const n = idx.length;
    for (let i = 0; i < n; i++) {
      v.set(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]).applyMatrix4(mw);
      nv.set(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]).applyMatrix3(nm);
      const X = Math.min(gw - 1, Math.max(0, Math.floor(gx(v.x)))), Y = Math.min(gh - 1, Math.max(0, Math.floor(gy(v.y))));
      const k = Y * gw + X;
      let wgt = 0;
      if (v.z >= zf[k] - tol && nv.z > -0.35) wgt = strength;
      else if (back && v.z <= zb[k] + tol && nv.z < 0.35) wgt = strength;
      if (wgt <= 0) continue;
      const fx = mx0 + ((v.x - x0) / SX) * (mx1 - mx0 + 1), fy = my0 + ((y1 - v.y) / SY) * (my1 - my0 + 1);
      const px = Math.min(pw - 1, Math.max(0, Math.floor(fx))), py = Math.min(ph - 1, Math.max(0, Math.floor(fy)));
      const q = (py * pw + px) * 3, o = idx[i] * 4;
      rgb[o] += (fill[q] - rgb[o]) * wgt;
      rgb[o + 1] += (fill[q + 1] - rgb[o + 1]) * wgt;
      rgb[o + 2] += (fill[q + 2] - rgb[o + 2]) * wgt;
    }
    s.commit();
  }
}

function rasterZ(ax, ay, az, bx, by, bz, cx, cy, cz, W, H, zf, zb) {
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(area) < 1e-12) return;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
      const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
      const z = w0 * az + w1 * bz + w2 * cz, k = y * W + x;
      if (z > zf[k]) zf[k] = z;
      if (z < zb[k]) zb[k] = z;
    }
  }
}

// 물체 밖(배경) 픽셀은 가까운 물체 색으로 채워서, 테두리에서 배경색이 묻지 않게
function filledPhoto({ data, w, h, mask }) {
  const out = new Float32Array(w * h * 3);
  let known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i]) {
    known[i] = 1; out[3 * i] = data[4 * i]; out[3 * i + 1] = data[4 * i + 1]; out[3 * i + 2] = data[4 * i + 2];
  }
  // 테두리 1~2px 은 배경이 섞여 있으니 안쪽 색으로 덮는다
  const inner = new Uint8Array(known);
  for (let it = 0; it < 2; it++) {
    const nx = inner.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (inner[i] && (!inner[i - 1] || !inner[i + 1] || !inner[i - w] || !inner[i + w])) nx[i] = 0;
    }
    inner.set(nx);
  }
  let any = false;
  for (let i = 0; i < w * h; i++) if (inner[i]) { any = true; break; }
  if (any) known = inner;
  for (let it = 0; it < 24; it++) {
    const nk = known.slice();
    let changed = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || !known[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        r += out[3 * j]; g += out[3 * j + 1]; b += out[3 * j + 2]; c++;
      }
      if (c) { out[3 * i] = r / c; out[3 * i + 1] = g / c; out[3 * i + 2] = b / c; nk[i] = 1; changed = true; }
    }
    known = nk;
    if (!changed) break;
  }
  return out;
}

// ---- 직접 칠하기 ----
const _tri = new THREE.Triangle(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _bary = new THREE.Vector3(), _local = new THREE.Vector3();

export function beginStroke(root) {
  snapshot(meshesOf(root).map(surfaceOf));
}

// hit: Raycaster 결과 하나. color: THREE.Color(sRGB 값). size: 모델 크기 대비 붓 반지름(0~1)
export function paintAt(hit, color, size) {
  const mesh = hit.object;
  if (!mesh.isMesh || !hit.face) return;
  const s = surfaceOf(mesh);
  // 맞은 점을 '처음 자세' 메쉬 좌표로 (뼈대로 움직인 상태여도 맞게)
  const { a, b, c } = hit.face;
  mesh.getVertexPosition(a, _a); mesh.getVertexPosition(b, _b); mesh.getVertexPosition(c, _c);
  _local.copy(hit.point);
  mesh.worldToLocal(_local);
  _tri.set(_a, _b, _c);
  _tri.getBarycoord(_local, _bary);
  const P = mesh.geometry.attributes.position;
  _a.fromBufferAttribute(P, a); _b.fromBufferAttribute(P, b); _c.fromBufferAttribute(P, c);
  const hx = _a.x * _bary.x + _b.x * _bary.y + _c.x * _bary.z;
  const hy = _a.y * _bary.x + _b.y * _bary.y + _c.y * _bary.z;
  const hz = _a.z * _bary.x + _b.z * _bary.y + _c.z * _bary.z;
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
  const r = Math.max(1e-6, mesh.geometry.boundingSphere.radius * 2 * size), r2 = r * r;
  const { pos, idx, rgb } = s;
  const R = color.r * 255, Gc = color.g * 255, B = color.b * 255;
  for (let i = 0, n = idx.length; i < n; i++) {
    const dx = pos[3 * i] - hx, dy = pos[3 * i + 1] - hy, dz = pos[3 * i + 2] - hz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    const t = d2 / r2, w = t < 0.6 ? 1 : (1 - t) / 0.4;
    const o = idx[i] * 4;
    rgb[o] += (R - rgb[o]) * w;
    rgb[o + 1] += (Gc - rgb[o + 1]) * w;
    rgb[o + 2] += (B - rgb[o + 2]) * w;
  }
  s.commit();
}

// 스포이드: 맞은 곳의 현재 색
export function pickColor(hit) {
  const s = surfaceOf(hit.object);
  if (s.kind === "vertex") {
    const o = hit.face.a * 4;
    return new THREE.Color(s.rgb[o] / 255, s.rgb[o + 1] / 255, s.rgb[o + 2] / 255);
  }
  if (!hit.uv) return null;
  const tex = firstMat(hit.object).map, cv = tex.image;
  const u = ((hit.uv.x % 1) + 1) % 1, v = ((hit.uv.y % 1) + 1) % 1;
  const x = Math.min(cv.width - 1, Math.floor(u * cv.width)), y = Math.min(cv.height - 1, Math.floor((tex.flipY ? 1 - v : v) * cv.height));
  const o = (y * cv.width + x) * 4;
  return new THREE.Color(s.rgb[o] / 255, s.rgb[o + 1] / 255, s.rgb[o + 2] / 255);
}

// ---- 밝기·채도 조절 (텍스처/정점 색 전체). gain>1 이면 밝게(어두운 곳을 더 많이 올림) ----
export function adjustColors(root, gain, sat = 1) {
  const list = meshesOf(root).map(surfaceOf);
  snapshot(list);
  const g = 1 / gain;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, g));
  for (const s of list) {
    const d = s.rgb;
    for (let o = 0; o < d.length; o += 4) {
      let r = lut[d[o]], gg = lut[d[o + 1]], b = lut[d[o + 2]];
      if (sat !== 1) {
        const y = 0.299 * r + 0.587 * gg + 0.114 * b;
        r = y + (r - y) * sat; gg = y + (gg - y) * sat; b = y + (b - y) * sat;
      }
      d[o] = r; d[o + 1] = gg; d[o + 2] = b;
    }
    s.commit();
  }
}
