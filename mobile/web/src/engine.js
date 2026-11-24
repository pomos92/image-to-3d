// 오프라인 3D 엔진 (PC 버전 img23d/basic.py 를 자바스크립트로 옮긴 것)
// 1) 배경 제거 → 2) 실루엣 '구 합치기' 부풀리기 → 3) 거리장 → 4) 서피스 네츠로 메쉬 → 5) 색 입히기

// ---------- 거리 변환 (Felzenszwalb, 정확한 유클리드 거리) ----------
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    while (true) {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// mask 가 true 인 픽셀에서 가장 가까운 false 픽셀까지 거리
export function distanceTransform(mask, w, h) {
  const INF = 1e20;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? INF : 0;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

// ---------- 배경 제거 ----------
function labelKeepBig(mask, w, h) {
  const lab = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    n++; let sp = 0, size = 0;
    stack[sp++] = i; lab[i] = n;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = n; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = n; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = n; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = n; stack[sp++] = p + w; }
    }
    sizes.push(size);
  }
  const biggest = Math.max(0, ...sizes);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = lab[i] && sizes[lab[i]] >= biggest * 0.15 ? 1 : 0;
  return out;
}

function fillHoles(mask, w, h) {
  // 테두리에서 닿을 수 있는 배경만 진짜 배경, 나머지 구멍은 채움
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (p) => { if (!mask[p] && !outside[p]) { outside[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop(); const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

function erode(mask, w, h, it) {
  let m = mask;
  for (let k = 0; k < it; k++) {
    const o = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      o[p] = m[p] && m[p - 1] && m[p + 1] && m[p - w] && m[p + w] ? 1 : 0;
    }
    m = o;
  }
  return m;
}

export function extractMask(rgba, w, h, removeBg) {
  const N = w * h;
  let mask = new Uint8Array(N);
  let transparent = 0;
  for (let i = 0; i < N; i++) if (rgba[i * 4 + 3] < 128) transparent++;
  if (transparent / N > 0.02) {
    for (let i = 0; i < N; i++) mask[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
  } else if (removeBg) {
    // 테두리 색을 배경으로 간주
    const b = Math.max(2, (Math.min(w, h) / 50) | 0);
    const rs = [], gs = [], bs = [], idx = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < b || y < b || x >= w - b || y >= h - b) idx.push(y * w + x);
    }
    for (const p of idx) { rs.push(rgba[p * 4]); gs.push(rgba[p * 4 + 1]); bs.push(rgba[p * 4 + 2]); }
    const med = (a) => { a.sort((u, v) => u - v); return a[a.length >> 1]; };
    const bg = [med(rs), med(gs), med(bs)];
    const dists = idx.map((p) => Math.hypot(rgba[p * 4] - bg[0], rgba[p * 4 + 1] - bg[1], rgba[p * 4 + 2] - bg[2]));
    dists.sort((u, v) => u - v);
    const thr = Math.max(30, dists[Math.floor(dists.length * 0.9)] * 1.8);
    for (let i = 0; i < N; i++) {
      mask[i] = Math.hypot(rgba[i * 4] - bg[0], rgba[i * 4 + 1] - bg[1], rgba[i * 4 + 2] - bg[2]) > thr ? 1 : 0;
    }
  } else {
    mask.fill(1);
  }
  mask = labelKeepBig(erodeDilate(mask, w, h), w, h);
  mask = fillHoles(mask, w, h);
  let count = 0; for (let i = 0; i < N; i++) count += mask[i];
  if (count < 50) throw new Error("물체를 찾지 못했어요. 배경이 단순한 사진이나 배경을 지운 PNG로 해 보세요.");
  return mask;
}

function erodeDilate(mask, w, h) { // 1px 열림 연산(잡티 제거)
  const e = erode(mask, w, h, 1);
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    o[p] = e[p] || (x > 0 && e[p - 1]) || (x < w - 1 && e[p + 1]) || (y > 0 && e[p - w]) || (y < h - 1 && e[p + w]) ? 1 : 0;
  }
  return o;
}

// ---------- 블러 ----------
function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1); let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}
// 3차원 배열(크기 nx, ny, nz; 인덱스 x + nx*(y + ny*z)) 의 한 축 방향 블러
function blurAxis(a, dims, axis, sigma) {
  const { k, r } = gaussKernel(sigma);
  const [nx, ny, nz] = dims;
  const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
  const len = dims[axis];
  const out = new Float32Array(a.length);
  const line = new Float32Array(len);
  const others = a.length / len;
  for (let o = 0; o < others; o++) {
    let base;
    if (axis === 0) base = o * nx;
    else if (axis === 1) { const x = o % nx, z = (o / nx) | 0; base = x + nx * ny * z; }
    else base = o;
    for (let i = 0; i < len; i++) line[i] = a[base + i * stride];
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) { const t = Math.min(len - 1, Math.max(0, i + j)); s += line[t] * k[j + r]; }
      out[base + i * stride] = s;
    }
  }
  return out;
}
function blur(a, dims, sigma) {
  let b = a;
  for (let ax = 0; ax < 3; ax++) if (dims[ax] > 1) b = blurAxis(b, dims, ax, sigma);
  return b;
}

// ---------- 서피스 네츠 (거리장 → 메쉬) ----------
function surfaceNets(field, nx, ny, nz, iso) {
  const verts = [];
  const vidx = new Int32Array(nx * ny * nz).fill(-1);
  const F = (x, y, z) => field[x + nx * (y + ny * z)] - iso;
  const corners = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const edges = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
  const val = new Float32Array(8);
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    let pos = 0, neg = 0;
    for (let c = 0; c < 8; c++) { val[c] = F(x + corners[c][0], y + corners[c][1], z + corners[c][2]); if (val[c] > 0) pos++; else neg++; }
    if (!pos || !neg) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of edges) {
      const va = val[a], vb = val[b];
      if ((va > 0) === (vb > 0)) continue;
      const t = va / (va - vb);
      sx += corners[a][0] + t * (corners[b][0] - corners[a][0]);
      sy += corners[a][1] + t * (corners[b][1] - corners[a][1]);
      sz += corners[a][2] + t * (corners[b][2] - corners[a][2]);
      cnt++;
    }
    vidx[x + nx * (y + ny * z)] = verts.length / 3;
    verts.push(x + sx / cnt, y + sy / cnt, z + sz / cnt);
  }
  const faces = [];
  const V = (x, y, z) => vidx[x + nx * (y + ny * z)];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) faces.push(a, c, b, a, d, c); else faces.push(a, b, c, a, c, d);
  };
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const inside = F(x, y, z) > 0;
    // x 방향 모서리
    if (inside !== (F(x + 1, y, z) > 0)) quad(V(x, y - 1, z - 1), V(x, y, z - 1), V(x, y, z), V(x, y - 1, z), !inside);
    if (inside !== (F(x, y + 1, z) > 0)) quad(V(x - 1, y, z - 1), V(x - 1, y, z), V(x, y, z), V(x, y, z - 1), !inside);
    if (inside !== (F(x, y, z + 1) > 0)) quad(V(x - 1, y - 1, z), V(x, y - 1, z), V(x, y, z), V(x - 1, y, z), !inside);
  }
  return { verts: new Float32Array(verts), faces: new Uint32Array(faces) };
}

function smooth(verts, faces, iterations) {
  // Taubin 스무딩 (부피 줄어듦 방지)
  const n = verts.length / 3;
  const nb = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
  }
  const lists = nb.map((s) => Int32Array.from(s));
  let v = verts;
  for (let it = 0; it < iterations * 2; it++) {
    const f = it % 2 === 0 ? 0.5 : -0.53;
    const o = new Float32Array(v.length);
    for (let i = 0; i < n; i++) {
      const L = lists[i];
      if (!L.length) { o[3 * i] = v[3 * i]; o[3 * i + 1] = v[3 * i + 1]; o[3 * i + 2] = v[3 * i + 2]; continue; }
      let ax = 0, ay = 0, az = 0;
      for (const j of L) { ax += v[3 * j]; ay += v[3 * j + 1]; az += v[3 * j + 2]; }
      ax /= L.length; ay /= L.length; az /= L.length;
      o[3 * i] = v[3 * i] + f * (ax - v[3 * i]);
      o[3 * i + 1] = v[3 * i + 1] + f * (ay - v[3 * i + 1]);
      o[3 * i + 2] = v[3 * i + 2] + f * (az - v[3 * i + 2]);
    }
    v = o;
  }
  return v;
}

// ---------- 전체 ----------
// rgba: Uint8ClampedArray (w*h*4). 반환: { positions, colors(0~1), indices }  (긴 변 = 1, 중심 원점, y 위, z 앞)
export function buildMesh(rgba, w, h, { removeBg = true, resolution = 128, thickness = 0.5, detail = 0.15 } = {}) {
  const fullMask = extractMask(rgba, w, h, removeBg);
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fullMask[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const s = resolution / Math.max(cw, ch);
  const gw = Math.max(8, Math.round(cw * s)), gh = Math.max(8, Math.round(ch * s));

  // 작업 해상도로 다시 샘플 (영역 평균)
  const mask = new Uint8Array(gw * gh);
  const rgb = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const sx0 = x0 + Math.floor(gx / s), sx1 = Math.max(sx0 + 1, x0 + Math.floor((gx + 1) / s));
    const sy0 = y0 + Math.floor(gy / s), sy1 = Math.max(sy0 + 1, y0 + Math.floor((gy + 1) / s));
    let m = 0, cnt = 0, r = 0, g = 0, b = 0, cm = 0;
    for (let yy = sy0; yy < Math.min(sy1, h); yy++) for (let xx = sx0; xx < Math.min(sx1, w); xx++) {
      const p = yy * w + xx; cnt++;
      if (fullMask[p]) { m++; r += rgba[p * 4]; g += rgba[p * 4 + 1]; b += rgba[p * 4 + 2]; cm++; }
    }
    const q = gy * gw + gx;
    mask[q] = cnt && m / cnt >= 0.5 ? 1 : 0;
    if (cm) { rgb[q * 3] = r / cm / 255; rgb[q * 3 + 1] = g / cm / 255; rgb[q * 3 + 2] = b / cm / 255; }
  }

  // 구 합치기: 뼈대(거리 지도의 능선) 위 각 점에 반지름 d 인 공을 놓고 합친다
  const dist = distanceTransform(mask, gw, gh);
  let height = new Float32Array(gw * gh);
  let dmax = 1;
  for (let i = 0; i < gw * gh; i++) if (dist[i] > dmax) dmax = dist[i];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const p = y * gw + x, r = dist[p];
    if (r < 1) continue;
    let ridge = true;
    for (let dy = -1; dy <= 1 && ridge; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
      if (dist[yy * gw + xx] > r + 0.7) { ridge = false; break; }
    }
    if (!ridge) continue;
    const ri = Math.ceil(r);
    for (let yy = Math.max(0, y - ri); yy <= Math.min(gh - 1, y + ri); yy++) for (let xx = Math.max(0, x - ri); xx <= Math.min(gw - 1, x + ri); xx++) {
      const hh = r * r - ((yy - y) ** 2 + (xx - x) ** 2);
      if (hh > 0) { const v = Math.sqrt(hh); if (v > height[yy * gw + xx]) height[yy * gw + xx] = v; }
    }
  }
  for (let i = 0; i < gw * gh; i++) height[i] *= thickness * 2;

  // 밝기 기반 미세 요철
  if (detail > 0) {
    let mean = 0, c = 0;
    const lum = new Float32Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) { lum[i] = 0.299 * rgb[3 * i] + 0.587 * rgb[3 * i + 1] + 0.114 * rgb[3 * i + 2]; if (mask[i]) { mean += lum[i]; c++; } }
    mean /= Math.max(c, 1);
    const lb = blur(lum, [gw, gh, 1], 1.0);
    for (let i = 0; i < gw * gh; i++) if (height[i] > 2) height[i] += detail * dmax * 0.15 * (lb[i] - mean);
  }
  height = blur(height, [gw, gh, 1], 0.7);
  for (let i = 0; i < gw * gh; i++) height[i] = mask[i] ? Math.max(height[i], 0.3) : 0;

  // 3D 거리장: 안 = 두께 - |z|, 밖 = -(가장자리까지 거리)
  const inv = new Uint8Array(gw * gh); for (let i = 0; i < gw * gh; i++) inv[i] = mask[i] ? 0 : 1;
  const outside = distanceTransform(inv, gw, gh);
  let hmax = 0; for (let i = 0; i < gw * gh; i++) if (height[i] > hmax) hmax = height[i];
  const zmax = Math.ceil(hmax) + 2, P = 2;
  const nx = gw + 2 * P, ny = gh + 2 * P, nz = 2 * zmax + 1 + 2 * P;
  let field = new Float32Array(nx * ny * nz).fill(-2);
  for (let z = 0; z < 2 * zmax + 1; z++) {
    const zz = Math.abs(z - zmax);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const p = y * gw + x;
      const hv = mask[p] ? height[p] : -outside[p];
      field[(x + P) + nx * ((y + P) + ny * (z + P))] = hv - zz;
    }
  }
  field = blur(field, [nx, ny, nz], 1.0);
  const { verts, faces } = surfaceNets(field, nx, ny, nz, 0);
  const sm = smooth(verts, faces, 3);

  // 색: 가장자리 2픽셀 안쪽 픽셀 중 가장 가까운 색 (배경색 섞임 방지)
  let inner = erode(mask, gw, gh, 2);
  let ic = 0; for (let i = 0; i < gw * gh; i++) ic += inner[i];
  if (ic < 20) inner = mask;
  const nearest = nearestIndex(inner, gw, gh);

  const n = sm.length / 3;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const scale = Math.max(gw, gh);
  for (let i = 0; i < n; i++) {
    const gx = sm[3 * i] - P, gy = sm[3 * i + 1] - P, gz = sm[3 * i + 2] - P - zmax;
    positions[3 * i] = (gx - gw / 2) / scale;
    positions[3 * i + 1] = (gh / 2 - gy) / scale;
    positions[3 * i + 2] = gz / scale;
    const cx = Math.min(gw - 1, Math.max(0, Math.round(gx))), cy = Math.min(gh - 1, Math.max(0, Math.round(gy)));
    const q = nearest[cy * gw + cx];
    const k = gz < 0 ? 0.92 : 1;
    colors[3 * i] = rgb[3 * q] * k; colors[3 * i + 1] = rgb[3 * q + 1] * k; colors[3 * i + 2] = rgb[3 * q + 2] * k;
  }
  // y 를 뒤집었으므로 삼각형 방향도 뒤집기
  const indices = new Uint32Array(faces.length);
  for (let i = 0; i < faces.length; i += 3) { indices[i] = faces[i]; indices[i + 1] = faces[i + 2]; indices[i + 2] = faces[i + 1]; }
  // 바깥을 향하도록 방향 맞추기 (부피가 음수면 뒤집기)
  let vol = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    vol += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  if (vol < 0) for (let i = 0; i < indices.length; i += 3) { const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t; }
  return { positions, colors, indices };
}

function nearestIndex(mask, w, h) {
  // 다중 시작점 BFS 로 각 픽셀에서 가장 가까운 마스크 픽셀 인덱스
  const res = new Int32Array(w * h).fill(-1);
  const q = new Int32Array(w * h); let qh = 0, qt = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) { res[i] = i; q[qt++] = i; }
  while (qh < qt) {
    const p = q[qh++]; const x = p % w, y = (p / w) | 0;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const t of nb) if (t >= 0 && res[t] < 0) { res[t] = res[p]; q[qt++] = t; }
  }
  for (let i = 0; i < w * h; i++) if (res[i] < 0) res[i] = 0;
  return res;
}
