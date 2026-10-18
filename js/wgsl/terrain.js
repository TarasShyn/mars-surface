import { FRAME_WGSL, LAYER_FUNCS, SKY_FUNCS, TEX, TEX_MIPS, SH_RES, TRACK_RES, MAX_BOXES } from './common.js';

const BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var hTex: texture_2d_array<f32>;
@group(0) @binding(2) var mTex: texture_2d_array<f32>;
@group(0) @binding(3) var sampR: sampler;
@group(0) @binding(4) var shTex: texture_2d_array<f32>;
@group(0) @binding(5) var sampC: sampler;
@group(0) @binding(6) var hmTex: texture_2d_array<f32>;
@group(0) @binding(7) var<storage, read> AMB: array<vec4f, 8>;
@group(0) @binding(8) var trackTex: texture_2d<u32>;
@group(0) @binding(9) var<uniform> RB: array<vec4f, ${MAX_BOXES * 4}>;
`;

export const LIGHT_FUNCS = /* wgsl */ `
fn ambientLight(n: vec3f) -> vec3f {
  let n2 = n * n;
  return n2.x * select(AMB[1].rgb, AMB[0].rgb, n.x > 0.0)
       + n2.y * select(AMB[3].rgb, AMB[2].rgb, n.y > 0.0)
       + n2.z * select(AMB[5].rgb, AMB[4].rgb, n.z > 0.0);
}
fn applyHaze(col: vec3f, dir: vec3f, dist: f32) -> vec3f {
  let T = exp(-dist * dustTau() * F.mars.y / 11000.0);
  let horizon = skyRad(normalize(vec3f(dir.x, 0.03, dir.z)));
  return col * T + horizon * (1.0 - T);
}
`;

export const ROVER_SHADOW = /* wgsl */ `
// Rover parts are oriented boxes: centre, then three unit axes each carrying its half extent.
fn roverShadow(p: vec3f, sun: vec3f) -> f32 {
  if (F.rover.z < 0.5 || length(p.xz - F.rover.xy) > 45.0) { return 1.0; }
  let oc = p - RB[0].xyz;
  let b = dot(oc, sun);
  if (b > 0.0 && dot(oc, oc) > 7.0) { return 1.0; }
  if (dot(oc, oc) - b * b > 7.0) { return 1.0; }
  for (var i = 0u; i < u32(F.rover.w); i++) {
    let c = RB[i * 4u].xyz;
    let ro = p - c;
    var tmin = 0.0;
    var tmax = 1e6;
    for (var a = 1u; a < 4u; a++) {
      let ax = RB[i * 4u + a];
      let o = dot(ro, ax.xyz);
      let d = dot(sun, ax.xyz);
      if (abs(d) < 1e-5) {
        if (abs(o) > ax.w) { tmax = -1.0; }
      } else {
        let t1 = (-ax.w - o) / d;
        let t2 = (ax.w - o) / d;
        tmin = max(tmin, min(t1, t2));
        tmax = min(tmax, max(t1, t2));
      }
    }
    if (tmax >= tmin) { return 0.0; }
  }
  return 1.0;
}
fn roverOcclusion(p: vec3f) -> f32 {
  if (F.rover.z < 0.5 || length(p.xz - F.rover.xy) > 6.0) { return 1.0; }
  let c = RB[0].xyz;
  let ro = p - c;
  let q = abs(vec2f(dot(ro, RB[1].xyz), dot(ro, RB[3].xyz))) - vec2f(RB[1].w, RB[3].w);
  let d = length(max(q, vec2f(0.0)));
  return mix(0.35, 1.0, smoothstep(0.0, 1.2, d));
}
`;

export const FAR_HORIZON = /* wgsl */ `
// Horizon tangent beyond 6 texels of the finest shadow clipmap level that covers xz, corrected
// for the receiver's own height. Returns (tangent, distance the clipmap takes over from, level).
fn farHorizon(xz: vec2f, y0: f32) -> vec3f {
  for (var l = 0u; l < 5u; l++) {
    let L = F.shadowLvl[l];
    if (L.w < 0.0) { continue; }
    let d = xz - L.xy;
    if (max(abs(d.x), abs(d.y)) < 0.45 * L.z) {
      let s = textureSampleLevel(shTex, sampC, d / L.z + 0.5, u32(L.w), 0.0);
      return vec3f(s.x + (s.z - y0) / max(s.y, 1e-3), 6.0 * L.z / ${SH_RES}.0, f32(l));
    }
  }
  return vec3f(-1e3, 1e9, -1.0);
}

`;

const CONSTS = /* wgsl */ `
const TEXN: f32 = ${TEX}.0;
const MAXLOD: f32 = ${TEX_MIPS - 1}.0;
const HMAX: f32 = 4500.0;
`;

// Terrain height along a sun ray relative to its start x0. Bilinear weights are quantised to a
// few bits, so a layer whose texels are much larger than t is extrapolated from its gradient at
// x0 instead of sampled; otherwise its sampled difference would be mostly quantisation noise.
const MARCH_FUNCS = (uv) => /* wgsl */ `
struct Local { h0: array<f32, 5>, g: array<vec2f, 5>, y0: f32 };

fn layerLod(foot: f32, k: u32) -> f32 { return log2(max(foot * TEXN / layerPeriod(k), 1e-6)); }
fn layerMean(k: u32) -> f32 { return F.layerMean[k >> 2u][k & 3u]; }
fn layerHeight(p: vec2f, k: u32, lod: f32) -> f32 {
  if (lod > MAXLOD - 0.5) { return layerMean(k); }
  return textureSampleLevel(hmTex, sampR, ${uv}(p, k), k, max(lod, 0.0)).r;
}
fn relHeight(x0: vec2f, sh: vec2f, t: f32, foot: f32, L: Local) -> f32 {
  let p = x0 + sh * t;
  var dh = 0.0;
  for (var k = 0u; k < 5u; k++) {
    if (layerPeriod(k) > 2.0 * t * TEXN) {
      dh += dot(L.g[k], sh) * t;
    } else {
      dh += layerHeight(p, k, layerLod(foot, k)) - L.h0[k];
    }
  }
  return dh;
}
`;

export const TERRAIN = FRAME_WGSL + BINDINGS + LAYER_FUNCS + SKY_FUNCS + CONSTS + MARCH_FUNCS('layerUV') + LIGHT_FUNCS + ROVER_SHADOW + FAR_HORIZON + /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,
  @location(1) xz: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) inst: vec4f) -> VSOut {
  let n = u32(F.lodP.y);
  let gi = vec2f(f32(vi % (n + 1u)), f32(vi / (n + 1u)));
  let spacing = inst.z / f32(n);
  var xz = inst.xy + gi * spacing;
  let R = F.lodP.x * exp2(inst.w);
  let dy = max(max(F.lodP.z - F.camPos.y, 0.0), F.camPos.y - F.lodP.w);
  let d = length(vec3f(xz.x, dy, xz.y));
  let mk = clamp((d - 0.8 * R) / (0.2 * R), 0.0, 1.0);
  xz -= fract(gi * 0.5) * 2.0 * spacing * mk;
  let eff = spacing * (1.0 + mk);
  var h = 0.0;
  for (var k = 0u; k < 5u; k++) {
    let lod = clamp(log2(max(eff * TEXN / layerPeriod(k), 1.0)) + 0.5, 0.0, MAXLOD);
    h += textureSampleLevel(hmTex, sampR, layerUV(xz, k), k, lod).r;
  }
  var o: VSOut;
  o.rel = vec3f(xz.x, h - dot(xz, xz) / (2.0 * PLANET_R) - F.camPos.y, xz.y);
  o.pos = F.viewProj * vec4f(o.rel, 1.0);
  o.xz = xz;
  return o;
}

// Visible fraction of the solar disc. The short range is marched per pixel; tangents are in the
// receiver's local frame, where the surface drops by t^2/2R and the sun stands higher by the
// distance travelled toward it over R.
fn sunShadow(xz: vec2f, s0: f32, L: Local) -> f32 {
  let sun = F.sunDir.xyz;
  let hl = length(sun.xz);
  if (hl < 1e-4) { return 1.0; }
  let sh = sun.xz / hl;
  let tanE = sun.y / hl + dot(xz, sh) / PLANET_R;
  let bias = 0.004 + s0 * 0.15;
  let far = farHorizon(xz, L.y0 + bias);
  var maxA = far.x;
  if (maxA > tanE + SUN_ANG_R) { return 0.0; }
  let steps = i32(F.shade.w);
  var t = s0;
  for (var i = 0; i < steps && t < far.y; i++) {
    let dh = relHeight(xz, sh, t, max(t * 0.6, s0), L) - bias - t * t / (2.0 * PLANET_R);
    maxA = max(maxA, dh / t);
    if (maxA > tanE + SUN_ANG_R) { return 0.0; }
    t *= 1.6;
  }
  return smoothstep(-SUN_ANG_R, SUN_ANG_R, tanE - maxA);
}

const TRACK_N: i32 = ${TRACK_RES};

// Rover tracks live in a toroidal world-space map; each texel carries the low bits of its tile
// index, so a texel left over from a different tile reads as undisturbed ground.
fn trackTexel(c: vec2i) -> f32 {
  let w = ((c % TRACK_N) + TRACK_N) % TRACK_N;
  let v = textureLoad(trackTex, w, 0).r;
  let tile = vec2i(F.trackTile.xy) + vec2i(floor(vec2f(c) / f32(TRACK_N)));
  let tag = (u32(tile.x) & 255u) | ((u32(tile.y) & 255u) << 8u);
  return select(0.0, f32(v & 255u) / 255.0, ((v >> 8u) & 65535u) == tag);
}
// Bilinear depth and its gradient in texels, from the same four texels.
fn trackSample(g: vec2f) -> vec3f {
  let b = g - 0.5;
  let i = vec2i(floor(b));
  let f = b - floor(b);
  let t00 = trackTexel(i);
  let t10 = trackTexel(i + vec2i(1, 0));
  let t01 = trackTexel(i + vec2i(0, 1));
  let t11 = trackTexel(i + vec2i(1, 1));
  let d = mix(mix(t00, t10, f.x), mix(t01, t11, f.x), f.y);
  return vec3f(d, mix(t10 - t00, t11 - t01, f.y), mix(t01 - t00, t11 - t10, f.x));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let xz = in.xz;
  var loc: Local;
  var g = vec2f(0.0);
  var alb = 1.0;
  var rock = 0.0;
  var sand = 0.0;
  var bedrock = 0.0;
  for (var k = 0u; k < 6u; k++) {
    let uv = layerUV(xz, k);
    let t = textureSample(hTex, sampR, uv, k);
    let gk = gradToWorld(t.yz, k);
    g += gk;
    if (k < 5u) { loc.g[k] = gk; }
    let m = textureSample(mTex, sampR, uv, k);
    alb *= m.r * 2.0;
    rock = max(rock, m.g);
    sand = max(sand, m.b);
    bedrock = max(bedrock, m.a);
  }
  let dist = length(in.rel);
  var track = 0.0;
  if (F.track.w > 0.5 && dist < 60.0) {
    let ts = trackSample((F.track.xy + xz / F.track.z) * f32(TRACK_N));
    track = ts.x;
    g -= ts.yz * 0.035 / (F.track.z / f32(TRACK_N));
  }
  let nrm = normalize(vec3f(-g.x + xz.x / PLANET_R, 1.0, -g.y + xz.y / PLANET_R));
  let up = normalize(vec3f(xz.x / PLANET_R, 1.0, xz.y / PLANET_R));
  let V = -in.rel / dist;
  let sun = F.sunDir.xyz;
  let pixAng = 2.0 * length(F.camUp.xyz) * F.screen.w;

  let s0 = max(0.012, dist * pixAng * 1.5);
  let mu0 = dot(nrm, sun);
  var shadow = 0.0;
  if (mu0 > 0.0) {
    loc.y0 = 0.0;
    for (var k = 0u; k < 5u; k++) {
      loc.h0[k] = layerHeight(xz, k, layerLod(s0, k));
      loc.y0 += loc.h0[k];
    }
    shadow = sunShadow(xz, s0, loc) * roverShadow(in.rel, sun);
  }

  let worldH = in.rel.y + F.camPos.y + dot(xz, xz) / (2.0 * PLANET_R);
  let slope = 1.0 - dot(nrm, up);
  sand *= 1.0 - smoothstep(0.04, 0.12, slope);
  let strata = 1.0 + 0.16 * sin(worldH * 0.157 + 2.0 * sin(worldH * 0.037)) * smoothstep(0.12, 0.45, slope);
  var base = vec3f(0.58, 0.33, 0.18);
  base = mix(base, vec3f(0.62, 0.47, 0.36), bedrock * 0.8);
  base = mix(base, vec3f(0.25, 0.19, 0.15), sand);
  base = mix(base, vec3f(0.24, 0.2, 0.18), rock);
  base *= F.shade.x * alb * strata * (1.0 - 0.22 * track);

  let alpha = acos(clamp(dot(sun, V), -1.0, 1.0));
  let direct = F.sunDir.w * AMB[6].rgb * shadow * max(mu0, 0.0) * (1.0 + 0.3 * exp(-alpha * 5.0));
  let ambient = ambientLight(nrm) * roverOcclusion(in.rel);
  var col = base / PI * (direct + ambient);

  if (F.post.w > 0.5) {
    if (F.post.w < 1.5) { return vec4f(nrm * 0.5 + 0.5, 1.0) * 0.02; }
    if (F.post.w < 2.5) { return vec4f(vec3f(shadow), 1.0) * 0.02; }
    return vec4f(base, 1.0) * 0.1;
  }
  return vec4f(applyHaze(col, -V, dist), 1.0);
}
`;

export const PROBE_POINTS = 8;
export const PROBE = FRAME_WGSL + /* wgsl */ `
struct ProbeU { ahead: vec2f, radius: f32, count: f32, pts: array<vec4f, 4> };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var hmTex: texture_2d_array<f32>;
@group(0) @binding(2) var sampR: sampler;
@group(0) @binding(3) var<storage, read_write> outH: array<f32, 12>;
@group(0) @binding(4) var<uniform> U: ProbeU;
` + LAYER_FUNCS + /* wgsl */ `
fn heightAt(rel: vec2f) -> f32 {
  var h = 0.0;
  for (var k = 0u; k < 5u; k++) {
    h += textureSampleLevel(hmTex, sampR, layerUV(rel, k), k, 0.0).r;
  }
  return h - dot(rel, rel) / (2.0 * PLANET_R);
}
@compute @workgroup_size(1)
fn main() {
  let centre = heightAt(vec2f(0.0));
  var top = centre;
  for (var i = 0; i < 12; i++) {
    let a = f32(i) * 0.5235988;
    let d = vec2f(cos(a), sin(a));
    top = max(top, heightAt(d * U.radius * 0.5));
    top = max(top, heightAt(d * U.radius));
  }
  for (var j = 1; j <= 6; j++) {
    top = max(top, heightAt(U.ahead * (f32(j) / 6.0)));
  }
  outH[0] = centre;
  outH[1] = top;
  for (var i = 0u; i < u32(U.count); i++) {
    let v = U.pts[i >> 1u];
    outH[2u + i] = heightAt(select(v.xy, v.zw, (i & 1u) == 1u));
  }
}
`;

// Shadow clipmap update: horizon tangent toward the sun azimuth from each texel centre, marched
// from 6 texels out to 60 km. Stores (tangent, distance of the steepest occluder, texel height).
export const SHADOW_MAP = (fmt) => FRAME_WGSL + /* wgsl */ `
struct Job { off: array<vec4f, 3>, geo: vec4f, sun: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> J: Job;
@group(0) @binding(2) var hmTex: texture_2d_array<f32>;
@group(0) @binding(3) var sampR: sampler;
@group(0) @binding(4) var outTex: texture_storage_2d<${fmt}, write>;
@group(0) @binding(5) var hTex: texture_2d_array<f32>;
const STEPS: i32 = 40;
` + LAYER_FUNCS + CONSTS + /* wgsl */ `
fn jobUV(pos: vec2f, k: u32) -> vec2f {
  let cs = layerCS(k);
  let v = J.off[k >> 1u];
  let o = select(v.xy, v.zw, (k & 1u) == 1u);
  return o + vec2f(cs.x * pos.x - cs.y * pos.y, cs.y * pos.x + cs.x * pos.y) / layerPeriod(k);
}
` + MARCH_FUNCS('jobUV') + /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let ij = vec2u(gid.x, gid.y + u32(J.geo.w));
  if (ij.y >= ${SH_RES}u) { return; }
  let texel = J.geo.z;
  let pos = J.geo.xy + (vec2f(ij) + 0.5) * texel;
  let sh = J.sun.xy;
  var loc: Local;
  loc.y0 = 0.0;
  for (var k = 0u; k < 5u; k++) {
    let lod = layerLod(texel, k);
    loc.h0[k] = layerHeight(pos, k, lod);
    loc.y0 += loc.h0[k];
    let d = textureSampleLevel(hTex, sampR, jobUV(pos, k), k, clamp(lod, 0.0, MAXLOD));
    loc.g[k] = gradToWorld(d.yz, k);
  }
  let bias = 0.01 + 0.1 * texel;
  let y0 = loc.y0 + bias;
  let t0 = 6.0 * texel;
  let q = exp(log(60000.0 / t0) / f32(STEPS));
  var t = t0;
  var maxA = -1e3;
  var tMax = t0;
  for (var i = 0; i < STEPS; i++) {
    let drop = t * t / (2.0 * PLANET_R);
    if (HMAX - drop - y0 < maxA * t) { break; }
    let a = (relHeight(pos, sh, t, t * (q - 1.0), loc) - bias - drop) / t;
    if (a > maxA) { maxA = a; tMax = t; }
    t *= q;
  }
  textureStore(outTex, ij, vec4f(maxA, tMax, y0, 1.0));
}
`;
