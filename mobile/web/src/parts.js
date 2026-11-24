// 부위 나누기: 각 정점이 어느 관절(뼈)에 붙어 있는지 색으로 보여 주고, 붓으로 칠해서 바꾼다.
import * as THREE from "three";

const PALETTE = [
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4, 0x46f0f0, 0xf032e6,
  0xbcf60c, 0xfabebe, 0x008080, 0xe6beff, 0x9a6324, 0xfffac8, 0x800000, 0xaaffc3, 0x808000,
];
export const partColor = (i) => new THREE.Color(PALETTE[i % PALETTE.length]);

function skinnedMeshes(root) {
  const out = [];
  root.traverse((o) => { if (o.isSkinnedMesh) out.push(o); });
  return out;
}

function dominant(si, sw, i) {
  let b = si.getX(i), w = sw.getX(i);
  for (const k of [1, 2, 3]) {
    const wk = k === 1 ? sw.getY(i) : k === 2 ? sw.getZ(i) : sw.getW(i);
    if (wk > w) { w = wk; b = k === 1 ? si.getY(i) : k === 2 ? si.getZ(i) : si.getW(i); }
  }
  return b;
}

// on: 부위 색 보기 켜기/끄기 (끄면 원래 색·재질로 돌아감)
export function showParts(root, on) {
  for (const m of skinnedMeshes(root)) {
    const g = m.geometry;
    if (on && !m.userData.partBackup) {
      m.userData.partBackup = { material: m.material, color: g.getAttribute("color") || null };
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      const attr = new THREE.BufferAttribute(arr, 3);
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, c = new THREE.Color();
      for (let i = 0; i < n; i++) { c.set(PALETTE[dominant(si, sw, i) % PALETTE.length]); attr.setXYZ(i, c.r, c.g, c.b); }
      g.setAttribute("color", attr);
      m.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    } else if (!on && m.userData.partBackup) {
      const b = m.userData.partBackup;
      if (b.color) g.setAttribute("color", b.color); else g.deleteAttribute("color");
      m.material.dispose();
      m.material = b.material;
      delete m.userData.partBackup;
    }
  }
}

const _tri = new THREE.Triangle(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _bary = new THREE.Vector3(), _local = new THREE.Vector3();

// hit 근처 정점을 bone 번호의 뼈에 100% 붙인다. size: 모델 크기 대비 붓 반지름
export function paintPart(hit, bone, size) {
  const mesh = hit.object;
  if (!mesh.isSkinnedMesh || !hit.face) return;
  const g = mesh.geometry, P = g.attributes.position;
  const { a, b, c } = hit.face;
  mesh.getVertexPosition(a, _a); mesh.getVertexPosition(b, _b); mesh.getVertexPosition(c, _c);
  _local.copy(hit.point); mesh.worldToLocal(_local);
  _tri.set(_a, _b, _c); _tri.getBarycoord(_local, _bary);
  _a.fromBufferAttribute(P, a); _b.fromBufferAttribute(P, b); _c.fromBufferAttribute(P, c);
  const hx = _a.x * _bary.x + _b.x * _bary.y + _c.x * _bary.z;
  const hy = _a.y * _bary.x + _b.y * _bary.y + _c.y * _bary.z;
  const hz = _a.z * _bary.x + _b.z * _bary.y + _c.z * _bary.z;
  if (!g.boundingSphere) g.computeBoundingSphere();
  const r = g.boundingSphere.radius * 2 * size, r2 = r * r;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, col = g.getAttribute("color");
  const pc = partColor(bone);
  for (let i = 0; i < P.count; i++) {
    const dx = P.getX(i) - hx, dy = P.getY(i) - hy, dz = P.getZ(i) - hz;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    si.setXYZW(i, bone, 0, 0, 0);
    sw.setXYZW(i, 1, 0, 0, 0);
    if (mesh.userData.partBackup && col) col.setXYZ(i, pc.r, pc.g, pc.b);
  }
  si.needsUpdate = true; sw.needsUpdate = true;
  if (col) col.needsUpdate = true;
}

// 되돌리기용 스냅샷
export function snapshotParts(root) {
  return skinnedMeshes(root).map((m) => ({
    m, si: m.geometry.attributes.skinIndex.array.slice(), sw: m.geometry.attributes.skinWeight.array.slice(),
    col: m.userData.partBackup && m.geometry.getAttribute("color") ? m.geometry.getAttribute("color").array.slice() : null,
  }));
}
export function restoreParts(snap) {
  for (const { m, si, sw, col } of snap) {
    const g = m.geometry;
    g.attributes.skinIndex.array.set(si); g.attributes.skinIndex.needsUpdate = true;
    g.attributes.skinWeight.array.set(sw); g.attributes.skinWeight.needsUpdate = true;
    if (col && m.userData.partBackup && g.getAttribute("color")) { g.getAttribute("color").array.set(col); g.getAttribute("color").needsUpdate = true; }
  }
}
