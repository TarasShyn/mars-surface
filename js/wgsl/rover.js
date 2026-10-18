// Rover rendering (instanced boxes and cylinders) and the wheel-track stamping pass.
import { FRAME_WGSL, SKY_FUNCS, SH_RES, TRACK_RES } from './common.js';
import { LIGHT_FUNCS, FAR_HORIZON } from './terrain.js';

export const ROVER = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var shTex: texture_2d_array<f32>;
@group(0) @binding(2) var sampC: sampler;
@group(0) @binding(3) var<storage, read> AMB: array<vec4f, 8>;
` + SKY_FUNCS + LIGHT_FUNCS + FAR_HORIZON.replaceAll('${SH_RES}', String(SH_RES)) + /* wgsl */ `
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,
  @location(1) nrm: vec3f,
  @location(2) local: vec3f,
  @location(3) color: vec4f,
  @location(4) extra: vec4f,
};

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) r0: vec4f, @location(3) r1: vec4f,
              @location(4) r2: vec4f, @location(5) color: vec4f, @location(6) extra: vec4f) -> VO {
  let c0 = vec3f(r0.x, r1.x, r2.x);
  let c1 = vec3f(r0.y, r1.y, r2.y);
  let c2 = vec3f(r0.z, r1.z, r2.z);
  var o: VO;
  o.rel = vec3f(dot(r0.xyz, p) + r0.w, dot(r1.xyz, p) + r1.w, dot(r2.xyz, p) + r2.w);
  o.nrm = normalize(n.x * cross(c1, c2) + n.y * cross(c2, c0) + n.z * cross(c0, c1));
  o.pos = F.viewProj * vec4f(o.rel, 1.0);
  o.local = p;
  o.color = color;
  o.extra = extra;
  return o;
}

// color.w picks the finish: 0 painted, 1 bare aluminium, 2 dark, 3 wheel, 4 gold foil.
@fragment fn fs(in: VO, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.nrm);
  if (!front) { n = -n; }
  let kind = u32(in.color.w + 0.5);
  let dist = length(in.rel);
  let V = -in.rel / dist;
  let sun = F.sunDir.xyz;
  var albedo = in.color.rgb;
  var metal = in.extra.y;
  var rough = in.extra.z;

  if (kind == 3u) {
    let radial = length(in.local.xz);
    let ang = atan2(in.local.z, in.local.x) + in.extra.x;
    let chevron = fract(ang * 3.8197 + abs(in.local.y) * 1.2);
    let grouser = smoothstep(0.0, 0.08, chevron) * (1.0 - smoothstep(0.12, 0.2, chevron));
    let onTread = smoothstep(0.46, 0.49, radial);
    albedo *= 1.0 - 0.45 * grouser * onTread;
    let hub = 1.0 - smoothstep(0.16, 0.18, radial);
    albedo = mix(albedo, vec3f(0.12, 0.12, 0.13), hub * (1.0 - onTread));
  }

  let dust = vec3f(0.56, 0.34, 0.2);
  albedo = mix(albedo, dust, clamp(0.12 + 0.35 * max(n.y, 0.0) + select(0.0, 0.25, kind == 3u), 0.0, 0.6));

  let worldY = in.rel.y + F.camPos.y + dot(in.rel.xz, in.rel.xz) / (2.0 * PLANET_R);
  let hl = length(sun.xz);
  var vis = 1.0;
  if (hl > 1e-4) {
    let tanE = sun.y / hl + dot(in.rel.xz, sun.xz / hl) / PLANET_R;
    let far = farHorizon(in.rel.xz, worldY);
    vis = smoothstep(-SUN_ANG_R, SUN_ANG_R, tanE - far.x);
  }
  if (sun.y < -0.02) { vis = 0.0; }
  let E = F.sunDir.w * AMB[6].rgb * vis;
  let ndl = max(dot(n, sun), 0.0);
  let H = normalize(sun + V);
  let shin = mix(400.0, 12.0, rough);
  let spec = pow(max(dot(n, H), 0.0), shin) * (shin + 8.0) / (8.0 * PI);
  let fres = mix(vec3f(0.04), albedo, metal);
  let ao = mix(0.55, 1.0, n.y * 0.5 + 0.5);
  var col = albedo * (1.0 - metal * 0.85) / PI * (E * ndl + ambientLight(n) * ao);
  col += E * ndl * spec * fres;
  col += ambientLight(reflect(-V, n)) * fres * 0.15 * (1.0 - rough);
  return vec4f(applyHaze(col, -V, dist), 1.0);
}
`;

// Each wheel stamps the capsule between its previous and current contact point into the r32uint
// track map: low byte = depth with a chevron grouser pattern, next two bytes = tile tag.
export const TRACK_STAMP = FRAME_WGSL + /* wgsl */ `
struct Stamp { w: array<vec4f, 12> };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> S: Stamp;
@group(0) @binding(2) var trackW: texture_storage_2d<r32uint, read_write>;
const N: i32 = ${TRACK_RES};
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let a = S.w[gid.z * 2u];
  let b = S.w[gid.z * 2u + 1u];
  if (b.z <= 0.0) { return; }
  let cur = a.xy;
  let prev = a.zw;
  let mid = floor((cur + prev) * 0.5);
  let c = vec2i(mid) + vec2i(gid.xy) - vec2i(16);
  let p = vec2f(c) + 0.5;
  let dir = b.xy;
  let seg = cur - prev;
  let len2 = max(dot(seg, seg), 1e-6);
  let t = clamp(dot(p - prev, seg) / len2, 0.0, 1.0);
  let q = prev + seg * t;
  let across = dot(p - q, vec2f(-dir.y, dir.x));
  let alongEnd = dot(p - cur, dir);
  let alongStart = dot(p - prev, dir);
  if (abs(across) > b.z || alongEnd > 0.5 || alongStart < -0.5) { return; }
  let texelM = F.track.z / f32(N);
  let along = b.w + dot(p - prev, dir) * texelM;
  let g = fract(along / 0.1 + abs(across) * texelM * 2.5);
  let tread = smoothstep(0.0, 0.1, g) * (1.0 - smoothstep(0.35, 0.45, g));
  let edge = 1.0 - smoothstep(b.z * 0.75, b.z, abs(across));
  let depth = edge * (0.55 + 0.45 * tread);
  let w = ((c % N) + N) % N;
  let tile = vec2i(F.trackTile.xy) + vec2i(floor(vec2f(c) / f32(N)));
  let tag = (u32(tile.x) & 255u) | ((u32(tile.y) & 255u) << 8u);
  let old = textureLoad(trackW, w).r;
  var d = depth;
  if (((old >> 8u) & 65535u) == tag) { d = max(d, f32(old & 255u) / 255.0); }
  textureStore(trackW, w, vec4u(u32(clamp(d, 0.0, 1.0) * 255.0 + 0.5) | (tag << 8u), 0u, 0u, 0u));
}
`;

function cubeMesh() {
  const v = [], idx = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, w] of faces) {
    const base = v.length / 6;
    for (const [su, sw] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      v.push(0.5 * (n[0] + su * u[0] + sw * w[0]), 0.5 * (n[1] + su * u[1] + sw * w[1]), 0.5 * (n[2] + su * u[2] + sw * w[2]), ...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { verts: new Float32Array(v), idx: new Uint16Array(idx) };
}

function cylinderMesh(seg = 36) {
  const v = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    v.push(0.5 * c, -0.5, 0.5 * s, c, 0, s, 0.5 * c, 0.5, 0.5 * s, c, 0, s);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 2;
    idx.push(a, a + 1, b + 1, a, b + 1, b);
  }
  for (const y of [-0.5, 0.5]) {
    const centre = v.length / 6;
    v.push(0, y, 0, 0, Math.sign(y), 0);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      v.push(0.5 * Math.cos(a), y, 0.5 * Math.sin(a), 0, Math.sign(y), 0);
    }
    for (let i = 0; i < seg; i++) idx.push(centre, centre + 1 + i, centre + 2 + i);
  }
  return { verts: new Float32Array(v), idx: new Uint16Array(idx) };
}

export const MESHES = { cube: cubeMesh(), cylinder: cylinderMesh() };

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const rot = (v, axis, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang), d = dot(axis, v) * (1 - c), x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * d, v[1] * c + x[1] * s + axis[1] * d, v[2] * c + x[2] * s + axis[2] * d];
};

const WHITE = [0.82, 0.8, 0.76];
const ALU = [0.72, 0.72, 0.74];
const DARK = [0.08, 0.08, 0.09];
const GOLD = [0.75, 0.55, 0.22];
const PAINT = 0, METAL = 1, BLACK = 2, WHEEL = 3, FOIL = 4;

export const WHEEL_R = 0.26;
const WHEEL_W = 0.4;
const HALF_TRACK = 1.05;
const WHEEL_Z = [1.05, -0.05, -1.05];
const ROCKER_Z = 0.15;
const BOGIE_Z = -0.55;
const TURN_RADIUS = 3.5;
const DRIVE_SPEED = 2.5;
const BOOST_SPEED = 7.0;

// Six wheels on a rocker-bogie: each bogie averages its two wheels, each rocker links the bogie to
// the front wheel, and the differential sets body pitch to the mean rocker angle and roll from the
// two sides. Wheel heights come from the GPU probe a few frames late, so they are predicted ahead.
export class Rover {
  constructor() {
    this.active = false;
    this.x = 0; this.z = 0; this.heading = 0;
    this.speed = 0; this.steer = 0; this.spin = 0;
    this.ground = new Float64Array(7);
    this.wheelY = new Float64Array(6);
    this.haveGround = false;
    this.prevContact = null;
    this.rolled = new Float64Array(6);
    this.cubes = []; this.cyls = []; this.boxes = [];
  }

  place(x, z, heading, groundY) {
    this.active = true;
    this.x = x; this.z = z; this.heading = heading;
    this.speed = 0; this.steer = 0;
    this.ground.fill(groundY);
    this.wheelY.fill(groundY + WHEEL_R);
    this.haveGround = false;
    this.prevContact = null;
  }

  frame() {
    const h = this.heading;
    return { f: [Math.sin(h), 0, -Math.cos(h)], r: [Math.cos(h), 0, Math.sin(h)] };
  }

  wheelXZ(i, lead = 0) {
    const { f, r } = this.frame();
    const side = i < 3 ? -1 : 1;
    const z = WHEEL_Z[i % 3];
    const ahead = this.speed * lead;
    return [this.x + r[0] * side * HALF_TRACK + f[0] * (z + ahead), this.z + r[2] * side * HALF_TRACK + f[2] * (z + ahead)];
  }

  probePoints(lead) {
    const pts = [];
    for (let i = 0; i < 6; i++) pts.push(this.wheelXZ(i, lead));
    pts.push([this.x, this.z]);
    return pts;
  }

  setGround(heights) {
    for (let i = 0; i < 7; i++) this.ground[i] = heights[i];
    if (!this.haveGround) {
      for (let i = 0; i < 6; i++) this.wheelY[i] = heights[i] + WHEEL_R;
      this.haveGround = true;
    }
  }

  update(dt, keys) {
    const throttle = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const steerIn = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const boost = keys.ShiftLeft || keys.ShiftRight;
    const target = throttle * (boost ? BOOST_SPEED : DRIVE_SPEED);
    this.speed += (target - this.speed) * Math.min(1, dt * (throttle ? 1.2 : 3));
    this.steer += (steerIn - this.steer) * Math.min(1, dt * 4);
    if (Math.abs(this.speed) > 0.05) this.heading += this.steer * this.speed / TURN_RADIUS * dt;
    else this.heading += this.steer * 0.45 * dt;
    const { f } = this.frame();
    this.x += f[0] * this.speed * dt;
    this.z += f[2] * this.speed * dt;
    this.spin += this.speed * dt / WHEEL_R;
    const k = Math.min(1, dt * 14);
    for (let i = 0; i < 6; i++) this.wheelY[i] += (this.ground[i] + WHEEL_R - this.wheelY[i]) * k;
  }

  pose() {
    const { f, r } = this.frame();
    const U = [0, 1, 0];
    const sideHeights = (o) => {
      const hF = this.wheelY[o], hM = this.wheelY[o + 1], hR = this.wheelY[o + 2];
      const hB = (hM + hR) / 2 + 0.12;
      const tPiv = (WHEEL_Z[0] - ROCKER_Z) / (WHEEL_Z[0] - BOGIE_Z);
      const hP = hF + (hB - hF) * tPiv + 0.28;
      return { hF, hM, hR, hB, hP, ang: Math.atan2(hF - hB, WHEEL_Z[0] - BOGIE_Z) };
    };
    const L = sideHeights(0), R = sideHeights(3);
    const pitch = (L.ang + R.ang) / 2;
    const roll = Math.atan2(L.hP - R.hP, 2 * HALF_TRACK);
    const f1 = norm(add(mul(f, Math.cos(pitch)), mul(U, Math.sin(pitch))));
    const u1 = norm(cross(r, f1));
    const r2 = norm(add(mul(r, Math.cos(roll)), mul(u1, -Math.sin(roll))));
    const u2 = norm(cross(r2, f1));
    const centre = [this.x, (L.hP + R.hP) / 2 + 0.18, this.z];
    return { centre, f: f1, r: r2, u: u2, L, R, flat: { f, r } };
  }

  // Parts in world space, camera-relative; returns oriented boxes for terrain shadows too.
  build(camX, camY, camZ) {
    const cubes = [], cyls = [], boxes = [];
    const P = this.pose();
    const { f, r, u } = P;
    const cam = [camX, camY, camZ];
    const toRel = (p) => sub(p, cam);
    const at = (x, y, z) => add(add(add(P.centre, mul(r, x)), mul(u, y)), mul(f, z));
    const part = (list, centre, ax, ay, az, sx, sy, sz, color, kind, extra = [0, 0, 0.6], shadow = true) => {
      const c = toRel(centre);
      const X = mul(ax, sx), Y = mul(ay, sy), Z = mul(az, sz);
      list.push(X[0], Y[0], Z[0], c[0], X[1], Y[1], Z[1], c[1], X[2], Y[2], Z[2], c[2], ...color, kind, ...extra, 0);
      if (shadow) boxes.push([c, ax, ay, az, sx / 2, sy / 2, sz / 2]);
    };
    const box = (centre, sx, sy, sz, color, kind, extra, shadow) => part(cubes, centre, r, u, f, sx, sy, sz, color, kind, extra, shadow);
    const bar = (a, b, t, color, kind = METAL) => {
      const d = sub(b, a), l = len(d), z = norm(d);
      const y = norm(cross(z, r));
      part(cubes, mul(add(a, b), 0.5), cross(y, z), y, z, t, t, l, color, kind, [0, 0.8, 0.4]);
    };

    box(at(0, 0, 0), 1.6, 0.55, 2.05, WHITE, PAINT, [0, 0, 0.7]);
    box(at(0, 0.3, -0.05), 1.75, 0.05, 2.25, [0.62, 0.6, 0.57], PAINT, [0, 0, 0.6], false);
    box(at(0, -0.31, 0), 1.4, 0.08, 1.9, GOLD, FOIL, [0, 0.9, 0.35], false);
    box(at(-0.62, 0.38, 0.85), 0.2, 0.12, 0.2, DARK, BLACK, [0, 0, 0.3], false);
    box(at(0.62, 0.38, 0.85), 0.2, 0.12, 0.2, DARK, BLACK, [0, 0, 0.3], false);
    box(at(0, 0.36, 0.0), 1.9, 0.06, 0.08, ALU, METAL, [0, 0.9, 0.35], false);

    const rtgAxis = norm(add(mul(f, -0.8), mul(u, 0.6)));
    const rtgPos = at(0, 0.45, -1.3);
    const rtgSide = norm(cross(rtgAxis, r));
    part(cyls, rtgPos, rtgSide, rtgAxis, r, 0.42, 0.7, 0.42, DARK, BLACK, [0, 0.3, 0.6]);
    for (let i = 0; i < 8; i++) {
      const fa = rot(r, rtgAxis, (i / 8) * Math.PI * 2);
      const fz = norm(cross(fa, rtgAxis));
      part(cubes, add(rtgPos, mul(fa, 0.33)), fa, rtgAxis, fz, 0.26, 0.66, 0.025, [0.14, 0.14, 0.15], BLACK, [0, 0.3, 0.5], false);
    }

    const mastBase = at(0.55, 0.3, 0.8);
    part(cyls, add(mastBase, mul(u, 0.6)), r, u, f, 0.13, 1.2, 0.13, WHITE, PAINT);
    const head = add(mastBase, mul(u, 1.3));
    box(head, 0.42, 0.3, 0.28, WHITE, PAINT, [0, 0, 0.5]);
    for (const dx of [-0.1, 0.1]) part(cyls, add(add(head, mul(r, dx)), mul(f, 0.15)), r, f, u, 0.07, 0.06, 0.07, DARK, BLACK, [0, 0.2, 0.1], false);
    part(cyls, add(add(head, mul(u, 0.2)), mul(f, 0.05)), r, f, u, 0.15, 0.3, 0.15, ALU, METAL, [0, 0.8, 0.3], false);

    const hga = at(-0.5, 0.62, -0.45);
    part(cyls, at(-0.5, 0.45, -0.45), r, u, f, 0.06, 0.3, 0.06, ALU, METAL, [0, 0.8, 0.4], false);
    const hgaN = norm(add(add(u, mul(f, 0.5)), mul(r, -0.4)));
    part(cyls, hga, norm(cross(hgaN, f)), hgaN, norm(cross(r, hgaN)), 0.62, 0.05, 0.62, [0.7, 0.68, 0.64], PAINT);
    part(cyls, at(-0.65, 0.55, -0.85), r, u, f, 0.05, 0.5, 0.05, WHITE, PAINT, [0, 0, 0.6], false);
    part(cyls, at(0.6, 0.48, -0.75), r, u, f, 0.12, 0.3, 0.12, WHITE, PAINT, [0, 0, 0.6], false);

    const shoulder = at(0.55, -0.05, 1.05);
    const elbow = at(0.0, -0.1, 1.22);
    const turret = at(-0.45, -0.12, 1.25);
    bar(shoulder, elbow, 0.1, ALU);
    bar(elbow, turret, 0.1, ALU);
    part(cyls, turret, f, r, u, 0.38, 0.3, 0.38, ALU, METAL, [0, 0.7, 0.4]);
    box(add(turret, mul(u, -0.2)), 0.16, 0.16, 0.16, DARK, BLACK, [0, 0.3, 0.4], false);

    const steerAng = this.steer * 0.35;
    for (let side = 0; side < 2; side++) {
      const S = side === 0 ? P.L : P.R;
      const sgn = side === 0 ? -1 : 1;
      const hubs = [];
      for (let j = 0; j < 3; j++) {
        const i = side * 3 + j;
        const [wx, wz] = this.wheelXZ(i);
        const hub = [wx, this.wheelY[i], wz];
        hubs.push(hub);
        const yaw = j === 0 ? steerAng : j === 2 ? -steerAng : 0;
        const axle = rot(P.flat.r, [0, 1, 0], -yaw);
        const fwd = norm(cross([0, 1, 0], axle));
        part(cyls, hub, fwd, axle, [0, 1, 0], WHEEL_R * 2, WHEEL_W, WHEEL_R * 2, ALU, WHEEL, [this.spin * sgn, 0.6, 0.45]);
        part(cyls, add(hub, mul(axle, sgn * 0.12)), fwd, axle, [0, 1, 0], 0.18, 0.2, 0.18, DARK, BLACK, [0, 0.4, 0.5], false);
      }
      const bogie = [P.centre[0] + P.flat.r[0] * sgn * HALF_TRACK + P.flat.f[0] * BOGIE_Z, S.hB,
        P.centre[2] + P.flat.r[2] * sgn * HALF_TRACK + P.flat.f[2] * BOGIE_Z];
      const pivot = at(sgn * 0.9, -0.15, ROCKER_Z);
      bar(pivot, hubs[0], 0.09, WHITE, PAINT);
      bar(pivot, bogie, 0.09, WHITE, PAINT);
      bar(bogie, hubs[1], 0.08, WHITE, PAINT);
      bar(bogie, hubs[2], 0.08, WHITE, PAINT);
    }
    this.cubes = cubes; this.cyls = cyls; this.boxes = boxes;
    return P;
  }

  // Contact points for the track map: current and previous position of each wheel's footprint.
  contacts(dt) {
    const out = [];
    const { f } = this.frame();
    for (let i = 0; i < 6; i++) {
      const [x, z] = this.wheelXZ(i);
      const prev = this.prevContact ? this.prevContact[i] : [x, z];
      this.rolled[i] += Math.hypot(x - prev[0], z - prev[1]);
      out.push({ x, z, px: prev[0], pz: prev[1], dx: f[0], dz: f[2], rolled: this.rolled[i] });
    }
    this.prevContact = out.map((c) => [c.x, c.z]);
    return out;
  }
}
