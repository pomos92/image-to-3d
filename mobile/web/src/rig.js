// 자동 뼈대(관절) 넣기: 서 있는 사람/캐릭터 모양을 가정하고
// 몸 비율과 실제 메쉬 모양으로 관절 위치를 잡은 뒤, 각 정점을 가까운 뼈에 묶는다(스키닝).
import * as THREE from "three";

// 관절 이름(한국어 표시용)
export const JOINT_LABELS = {
  hips: "골반", spine: "허리", chest: "가슴", neck: "목", head: "머리",
  shoulderL: "왼쪽 어깨", elbowL: "왼쪽 팔꿈치", handL: "왼쪽 손목",
  shoulderR: "오른쪽 어깨", elbowR: "오른쪽 팔꿈치", handR: "오른쪽 손목",
  hipL: "왼쪽 고관절", kneeL: "왼쪽 무릎", ankleL: "왼쪽 발목",
  hipR: "오른쪽 고관절", kneeR: "오른쪽 무릎", ankleR: "오른쪽 발목",
};

// 부모 관계
export const PARENT = {
  hips: null, spine: "hips", chest: "spine", neck: "chest", head: "neck",
  shoulderL: "chest", elbowL: "shoulderL", handL: "elbowL",
  shoulderR: "chest", elbowR: "shoulderR", handR: "elbowR",
  hipL: "hips", kneeL: "hipL", ankleL: "kneeL",
  hipR: "hips", kneeR: "hipR", ankleR: "kneeR",
};
const ORDER = Object.keys(PARENT);

// ---- 하나의 메쉬로 합치기 (월드 좌표, uv/색/재질 유지) ----
function collectMesh(root) {
  root.updateMatrixWorld(true);
  const meshes = [];
  // 이미 뼈대가 있는 모델(SkinnedMesh)도 처음 자세 그대로 다시 쓸 수 있다
  root.traverse((o) => { if (o.isMesh && !o.userData.isMarker) meshes.push(o); });
  if (!meshes.length) throw new Error("3D 모델이 없어요.");
  // 가장 큰 메쉬 하나를 기준(재질)으로, 나머지는 위치만 합쳐도 대부분 충분하지만
  // 재질이 여러 개면 그룹으로 유지한다.
  const geos = [], mats = [];
  for (const m of meshes) {
    const g = m.geometry.clone();
    g.deleteAttribute("skinIndex");
    g.deleteAttribute("skinWeight");
    if (m.userData.partBackup) {
      // 부위 보기 중이면 원래 색으로
      if (m.userData.partBackup.color) g.setAttribute("color", m.userData.partBackup.color.clone());
      else g.deleteAttribute("color");
    }
    g.applyMatrix4(m.matrixWorld);
    geos.push(g);
    const mat = m.userData.partBackup ? m.userData.partBackup.material : m.material;
    mats.push(Array.isArray(mat) ? mat[0] : mat);
  }
  return { geos, mats };
}

// ---- 관절 위치 추정 ----
function estimateJoints(allPos) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < allPos.length; i += 3) {
    const x = allPos[i], y = allPos[i + 1], z = allPos[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const H = y1 - y0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const Y = (f) => y0 + f * H;

  // 높이별 단면: x 방향으로 정점이 있는 칸을 표시해 두고, 몸 중심(mx)에서 이어진 구간만 '몸통'으로 본다.
  // (팔이 몸과 떨어져 있으면 빈 칸으로 끊기고, 다리 사이는 가운데가 비어 있다)
  const NY = 60, NX = 120;
  const W = Math.max(x1 - x0, 1e-6);
  const occ = Array.from({ length: NY }, () => new Uint8Array(NX));
  const binX = (x) => Math.min(NX - 1, Math.max(0, Math.floor(((x - x0) / W) * NX)));
  for (let i = 0; i < allPos.length; i += 3) {
    const k = Math.min(NY - 1, Math.max(0, Math.floor(((allPos[i + 1] - y0) / H) * NY)));
    occ[k][binX(allPos[i])] = 1;
  }
  // 빈 칸 1~2개짜리 틈은 메워서 듬성듬성한 정점 때문에 끊기지 않게
  for (const row of occ) for (let j = 1; j < NX - 2; j++) if (!row[j] && row[j - 1] && (row[j + 1] || row[j + 2])) row[j] = 2;
  const fy = (k) => (k + 0.5) / NY;

  // 몸 중심선: 위쪽 절반 단면들의 (좌+우)/2 중앙값
  const mids = [];
  for (let k = Math.floor(NY * 0.45); k < NY; k++) {
    const row = occ[k]; let a = -1, b = -1;
    for (let j = 0; j < NX; j++) if (row[j]) { if (a < 0) a = j; b = j; }
    if (a >= 0) mids.push((a + b + 1) / 2);
  }
  mids.sort((p, q) => p - q);
  const mxBin = mids.length ? Math.floor(mids[mids.length >> 1]) : NX >> 1;
  const mx = x0 + ((mxBin + 0.5) / NX) * W;
  const run = (k, c = mxBin) => {
    const row = occ[k];
    if (!row[c]) return null;
    let a = c, b = c;
    while (a > 0 && row[a - 1]) a--;
    while (b < NX - 1 && row[b + 1]) b++;
    return [x0 + (a / NX) * W, x0 + ((b + 1) / NX) * W];
  };

  // 가랑이: 아래에서 위로 올라가며 가운데가 처음 채워지는 높이 (못 찾으면 0.48)
  let crotchF = 0.48;
  {
    let seenGap = false;
    for (let k = 1; k < NY * 0.7; k++) {
      if (!occ[k][mxBin]) seenGap = true;
      else if (seenGap) { crotchF = fy(k); break; }
    }
  }
  crotchF = Math.min(0.62, Math.max(0.3, crotchF));

  // 목: 가랑이 위쪽에서 몸통 폭이 가장 좁은 곳 (머리가 커도 잡힘)
  let neckF = 0.84, best = Infinity;
  for (let k = Math.ceil(NY * (crotchF + 0.2)); k < NY * 0.95; k++) {
    const r = run(k);
    if (!r) continue;
    const w = r[1] - r[0];
    if (w < best * 0.97) { best = w; neckF = fy(k); }
  }

  // 몸통 반폭: 가랑이~목 사이 단면 폭들의 하위 30% (팔이 붙은 단면은 넓으니 제외되도록)
  const widths = [];
  for (let k = Math.ceil(NY * (crotchF + 0.02)); k < NY * (neckF - 0.04); k++) {
    const r = run(k);
    if (r) widths.push((r[1] - r[0]) / 2);
  }
  widths.sort((p, q) => p - q);
  const torsoHalf = Math.max(0.05 * H, widths.length ? widths[Math.floor(widths.length * 0.3)] : 0.15 * H);

  const torsoLen = neckF - crotchF;
  const shoulderF = neckF - torsoLen * 0.12;
  const joints = {};
  joints.hips = [mx, Y(crotchF + torsoLen * 0.08), cz];
  joints.spine = [mx, Y(crotchF + torsoLen * 0.38), cz];
  joints.chest = [mx, Y(crotchF + torsoLen * 0.68), cz];
  joints.neck = [mx, Y(neckF), cz];
  joints.head = [mx, Y(neckF + (1 - neckF) * 0.35), cz];

  // 손: 가랑이~목 높이에서 몸통 바깥쪽으로 가장 멀리 나간 정점
  const reach = (side) => {
    let best = null, bestD = -Infinity;
    for (let i = 0; i < allPos.length; i += 3) {
      const f = (allPos[i + 1] - y0) / H;
      if (f < crotchF - torsoLen * 0.3 || f > neckF) continue;
      const d = side * (allPos[i] - mx);
      if (d > bestD) { bestD = d; best = [allPos[i], allPos[i + 1], allPos[i + 2]]; }
    }
    return { p: best, d: bestD };
  };

  for (const [side, s] of [["L", 1], ["R", -1]]) {
    // 캐릭터 기준 왼쪽 = 화면 오른쪽(+x) (정면을 바라본다고 가정)
    const sh = [mx + s * torsoHalf * 0.85, Y(shoulderF), cz];
    const r = reach(s);
    let hand;
    if (r.p && r.d > torsoHalf * 1.3) {
      hand = r.p.slice();
      // 손끝보다 조금 안쪽을 손목으로
      hand[0] = sh[0] + (hand[0] - sh[0]) * 0.88;
      hand[1] = sh[1] + (hand[1] - sh[1]) * 0.88;
      hand[2] = cz;
    } else {
      // 팔이 몸에 붙어 있으면 몸 옆으로 내려뜨린 자세로 가정
      hand = [mx + s * torsoHalf * 1.1, Y(crotchF), cz];
    }
    joints["shoulder" + side] = sh;
    joints["elbow" + side] = [(sh[0] + hand[0]) / 2, (sh[1] + hand[1]) / 2, cz];
    joints["hand" + side] = hand;

    // 다리: 발 부분(아래 8%) 정점들 중 이쪽 편 평균 x
    let sx = 0, n = 0;
    for (let i = 0; i < allPos.length; i += 3) {
      const f = (allPos[i + 1] - y0) / H;
      if (f < 0.08 && s * (allPos[i] - mx) > 0) { sx += allPos[i]; n++; }
    }
    const footX = n ? sx / n : mx + s * torsoHalf * 0.5;
    const hipX = mx + s * Math.min(torsoHalf * 0.6, Math.abs(footX - mx) + 0.02 * H);
    joints["hip" + side] = [hipX, Y(crotchF), cz];
    joints["knee" + side] = [(hipX + footX) / 2, Y(crotchF * 0.5 + 0.02), cz];
    joints["ankle" + side] = [footX, Y(Math.min(0.06, crotchF * 0.15)), cz];
  }
  return { joints, H };
}

function segDist(p, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const L = abx * abx + aby * aby + abz * abz;
  let t = L > 0 ? (apx * abx + apy * aby + apz * abz) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = apx - t * abx, dy = apy - t * aby, dz = apz - t * abz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// 각 뼈가 담당하는 선분 (뼈 위치 → 자식 위치). 끝 뼈는 짧게 연장.
function boneSegments(joints, H) {
  const child = {
    hips: "spine", spine: "chest", chest: "neck", neck: "head", head: null,
    shoulderL: "elbowL", elbowL: "handL", handL: null,
    shoulderR: "elbowR", elbowR: "handR", handR: null,
    hipL: "kneeL", kneeL: "ankleL", ankleL: null,
    hipR: "kneeR", kneeR: "ankleR", ankleR: null,
  };
  const segs = {};
  for (const name of ORDER) {
    const a = joints[name];
    let b;
    if (child[name]) b = joints[child[name]];
    else if (name === "head") b = [a[0], a[1] + 0.08 * H, a[2]];
    else if (name.startsWith("hand")) {
      const e = joints["elbow" + name.slice(-1)];
      b = [a[0] + (a[0] - e[0]) * 0.35, a[1] + (a[1] - e[1]) * 0.35, a[2] + (a[2] - e[2]) * 0.35];
    } else if (name.startsWith("ankle")) b = [a[0], a[1] - 0.05 * H, a[2] + 0.06 * H];
    segs[name] = [a, b];
  }
  // 골반 뼈는 양쪽 고관절 사이를 담당
  segs.hips = [joints.hipL, joints.hipR];
  return segs;
}

// ---- 메인: object(Group/Mesh) → { root(Group), skinned(SkinnedMesh), bones(map) } ----
// opts.joints: 사용자가 옮긴 관절 위치(월드 좌표)가 있으면 그것을 쓴다
export function autoRig(object, opts = {}) {
  const { geos, mats } = collectMesh(object);
  // 모든 정점을 모아 관절 추정
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const allPos = new Float32Array(total * 3);
  let off = 0;
  for (const g of geos) {
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) { allPos[off++] = P.getX(i); allPos[off++] = P.getY(i); allPos[off++] = P.getZ(i); }
  }
  const est = estimateJoints(allPos);
  const H = est.H;
  const joints = {};
  for (const n of ORDER) joints[n] = (opts.joints && opts.joints[n] ? opts.joints[n] : est.joints[n]).slice();
  const segs = boneSegments(joints, H);

  // 뼈 만들기 (위치는 부모 기준 상대 좌표)
  const bones = {};
  for (const name of ORDER) {
    const b = new THREE.Bone();
    b.name = name;
    bones[name] = b;
  }
  for (const name of ORDER) {
    const p = PARENT[name], j = joints[name];
    if (p) {
      const pj = joints[p];
      bones[name].position.set(j[0] - pj[0], j[1] - pj[1], j[2] - pj[2]);
      bones[p].add(bones[name]);
    } else {
      bones[name].position.set(j[0], j[1], j[2]);
    }
  }
  const boneList = ORDER.map((n) => bones[n]);
  const skeleton = new THREE.Skeleton(boneList);

  const root = new THREE.Group();
  root.name = "rigged_model";
  root.add(bones.hips);
  // bind 전에 뼈의 월드 행렬을 계산해 둬야 역바인드 행렬이 맞는다
  root.updateMatrixWorld(true);

  const skinnedMeshes = [];
  geos.forEach((g, gi) => {
    const pos = g.attributes.position;
    const n = pos.count;
    const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4);
    const p = [0, 0, 0];
    const cand = new Array(ORDER.length);
    for (let i = 0; i < n; i++) {
      p[0] = pos.getX(i); p[1] = pos.getY(i); p[2] = pos.getZ(i);
      for (let b = 0; b < ORDER.length; b++) {
        const name = ORDER[b];
        let d = segDist(p, segs[name][0], segs[name][1]);
        // 팔 뼈가 몸통 정점을 잡지 않도록: 어깨 안쪽(몸통 중심 쪽) 정점은 팔 뼈 거리에 벌점
        if (/elbow|hand/.test(name)) {
          const s = name.endsWith("L") ? 1 : -1;
          const inside = s * (p[0] - joints["shoulder" + name.slice(-1)][0]);
          if (inside < 0) d += -inside * 2;
        }
        // 팔 뼈는 목보다 위(머리) 정점을 잡지 않도록
        if (/shoulder|elbow|hand/.test(name) && p[1] > joints.neck[1]) d += (p[1] - joints.neck[1]) * 4;
        // 다리 뼈는 골반보다 위 정점을 잡지 않도록
        if (/knee|ankle/.test(name) && p[1] > joints.hips[1]) d += (p[1] - joints.hips[1]) * 3;
        cand[b] = [b, d];
      }
      cand.sort((a, c) => a[1] - c[1]);
      const eps = 0.004 * H;
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const d = cand[k][1];
        // 가장 가까운 뼈 대비 너무 멀면 영향 없음
        const w = d > cand[0][1] * 1.6 + 0.03 * H ? 0 : 1 / Math.pow(d + eps, 4);
        skinIndex[i * 4 + k] = cand[k][0];
        skinWeight[i * 4 + k] = w;
        sum += w;
      }
      for (let k = 0; k < 4; k++) skinWeight[i * 4 + k] = sum > 0 ? skinWeight[i * 4 + k] / sum : (k === 0 ? 1 : 0);
    }
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
    const mat = mats[gi].clone();
    const sm = new THREE.SkinnedMesh(g, mat);
    sm.name = "body" + (gi || "");
    root.add(sm);
    sm.bind(skeleton);
    skinnedMeshes.push(sm);
  });
  root.userData.restPose = Object.fromEntries(ORDER.map((n) => [n, bones[n].quaternion.clone()]));
  // 팔의 처음 각도(수평 바깥 방향 기준, 위가 +): 포즈를 실제 팔 방향에 맞춰 주기 위해
  const armLift = {};
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    const a = joints["shoulder" + side], b = joints["elbow" + side];
    armLift[side] = Math.atan2(b[1] - a[1], s * (b[0] - a[0]));
  }
  return { root, bones, skeleton, skinnedMeshes, joints, armLift, order: ORDER };
}

// 관절 표시용 점·선
export function makeJointMarkers(bones, H = 1) {
  const g = new THREE.Group();
  g.name = "__markers";
  const mat = new THREE.MeshBasicMaterial({ color: 0xff6a00, depthTest: false });
  const sel = new THREE.MeshBasicMaterial({ color: 0x1e88ff, depthTest: false });
  const geo = new THREE.SphereGeometry(0.012 * H, 12, 8);
  const markers = {};
  for (const [name, b] of Object.entries(bones)) {
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 999;
    m.userData.joint = name;
    m.userData.isMarker = true;
    markers[name] = m;
    g.add(m);
  }
  g.userData.update = (selected) => {
    for (const [name, m] of Object.entries(markers)) {
      bones[name].getWorldPosition(m.position);
      m.material = name === selected ? sel : mat;
      m.scale.setScalar(name === selected ? 1.6 : 1);
    }
  };
  return g;
}
