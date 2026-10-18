// Procedural Mars terrain, generated once at start-up as six tileable layers whose features scale
// with their period: a Gale-like crater with a layered central mound, mesas, dune fields, sand
// ripples, cracked mudstone plates and rocks down to pebbles.
import { NOISE_WGSL, TEX, LAYER_P, HERO_R, wgslF } from './common.js';

const LAYER_UNIFORM = /* wgsl */ `
struct GenU { layer: u32, p0: u32, p1: u32, p2: u32 };
@group(0) @binding(0) var<uniform> U: GenU;
const TEXF: f32 = ${TEX}.0;
var<private> PER: array<f32, 6> = array<f32, 6>(${LAYER_P.map(wgslF).join(', ')});
`;

export const GEN = NOISE_WGSL + LAYER_UNIFORM + /* wgsl */ `
@group(0) @binding(1) var hOut: texture_storage_2d_array<r32float, write>;
@group(0) @binding(2) var mOut: texture_storage_2d_array<rgba8unorm, write>;

const HERO_R: f32 = ${wgslF(HERO_R)};
var<private> RELIEF: array<f32, 6> = array<f32, 6>(0.0035, 0.0028, 0.0022, 0.0016, 0.0014, 0.0030);
var<private> ROUGH_GAIN: array<f32, 6> = array<f32, 6>(0.5, 0.5, 0.52, 0.55, 0.58, 0.62);
var<private> BOULDER_D: array<f32, 6> = array<f32, 6>(0.0, 0.0, 0.0, 0.3, 0.55, 0.85);
var<private> CRATER_D: array<f32, 6> = array<f32, 6>(0.55, 0.5, 0.45, 0.3, 0.2, 0.1);

struct CF { h: f32, rim: f32 };

fn wrapDelta(d: vec2f) -> vec2f { return d - round(d); }

// Eroded, partly infilled crater. d: offset from the centre in crater radii.
fn craterProfile(d: vec2f, Rm: f32, age: f32, sf: f32) -> vec2f {
  let l = length(d);
  let dirv = d / max(l, 1e-5);
  let complex = smoothstep(2500.0, 9000.0, Rm);
  let irr = gnoise(dirv * 2.2 + sf) * 0.6 + gnoise(dirv * 5.3 + sf * 1.3) * 0.3 + gnoise(d * 3.0 + sf * 0.7) * 0.3;
  let r = l * (1.0 + (0.07 + 0.05 * complex) * irr);
  let depth = mix(0.36, 0.14, complex) * (1.0 - 0.7 * age) * Rm;
  let rimRel = mix(0.2, 0.26, complex) * (1.0 - 0.8 * age);
  let inner = pow(clamp(r, 0.0, 1.8), mix(2.0, 3.4, complex)) - 1.0 + rimRel;
  let outer = rimRel * pow(max(r, 0.6), -3.0) * (1.0 - smoothstep(1.5, 2.4, r));
  var s = smin(inner, outer, 0.06 + 0.3 * age);
  s = smax(s, -1.0 + rimRel + 0.3 * complex + 0.45 * age, 0.1 + 0.25 * age);
  let rim = exp(-(r - 1.0) * (r - 1.0) / 0.06) * (1.0 - age);
  return vec2f(s * depth, rim);
}

fn craterOctave(p: vec2f, n: i32, seed: u32, P: f32, dens: f32, cf: ptr<function, CF>) {
  let nf = f32(n);
  let q = p * nf;
  let c = vec2i(floor(q));
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = c + vec2i(i, j);
      let cw = ((cc % n) + n) % n;
      let r4 = hash4(cw, seed);
      if (r4.x > dens) { continue; }
      let ctr = vec2f(cc) + 0.15 + 0.7 * r4.yz;
      let Rc = mix(0.12, 0.40, pow(r4.w, 2.2));
      let d = (q - ctr) / Rc;
      if (dot(d, d) > 6.76) { continue; }
      let r4b = hash4(cw, seed ^ 0x9e3779b9u);
      let res = craterProfile(d, Rc / nf * P, mix(0.35, 1.0, sqrt(r4b.x)), r4b.y * 100.0);
      (*cf).h += res.x;
      (*cf).rim = max((*cf).rim, res.y);
    }
  }
}

// Angular, wind-faceted rocks. Radii span rMin..rMax cells so each stays 3-30 texels wide.
fn boulderOctave(p: vec2f, n: i32, seed: u32, P: f32, dens: f32, rMin: f32, rMax: f32) -> vec2f {
  let nf = f32(n);
  let q = p * nf;
  let c = vec2i(floor(q));
  var hb = 0.0;
  var rk = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = c + vec2i(i, j);
      let cw = ((cc % n) + n) % n;
      let r = hash4(cw, seed);
      if (r.x > dens + 0.06) { continue; }
      let present = smoothstep(r.x, r.x + 0.06, dens);
      if (present <= 0.0) { continue; }
      let r2 = hash4(cw, seed ^ 0x68bc21ebu);
      let ctr = vec2f(cc) + 0.3 + 0.4 * r.yz;
      let Rc = mix(rMin, rMax, pow(r.w, 2.5));
      let Rm = Rc / nf * P;
      var lv = (q - ctr) / Rc;
      let a = r2.x * 6.2831853;
      let cs = cos(a);
      let sn = sin(a);
      lv = vec2f(cs * lv.x - sn * lv.y, sn * lv.x + cs * lv.y) * vec2f(1.0, mix(1.0, 1.7, r2.y));
      let l2 = dot(lv, lv);
      if (l2 > 2.0) { continue; }
      let sf = r2.z * 50.0;
      let bump = gnoise(lv * 1.4 + sf) * 0.25 + gnoise(lv * 3.3 + sf) * 0.1;
      let facet = max(max(abs(lv.x), abs(lv.y)), abs(lv.x * 0.7 + lv.y * 0.7) * 1.05);
      let qd = mix(sqrt(l2), facet, 0.6) * (1.0 + bump);
      let top = 1.0 - smoothstep(0.5, 1.0, qd);
      let ridge = mix(0.4, 0.75, r2.w) * top + 0.12 * max(1.0 - qd, 0.0) - 0.08 * r.y;
      let b = Rm * (ridge - 0.08) * present;
      hb = max(hb, b);
      rk = max(rk, smoothstep(0.0, 0.05 * Rm, b));
    }
  }
  return vec2f(hb, rk);
}

// Distance to the nearest cell border (F2 - F1), for desiccation cracks between mudstone plates.
fn crackOctave(p: vec2f, n: i32, seed: u32) -> vec2f {
  let nf = f32(n);
  let q = p * nf;
  let c = vec2i(floor(q));
  var d1 = 9.0;
  var d2 = 9.0;
  var id = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = c + vec2i(i, j);
      let cw = ((cc % n) + n) % n;
      let r = hash4(cw, seed);
      let d = length(q - (vec2f(cc) + 0.1 + 0.8 * r.xy));
      if (d < d1) { d2 = d1; d1 = d; id = r.z; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2f(d2 - d1, id);
}

// Wind-blown bedforms: integer wave numbers keep them tileable; the stoss side climbs over 80% of
// the wavelength and the lee face drops over the last 20%.
fn bedforms(p: vec2f, wave: vec2f, warp: f32, seed: f32) -> f32 {
  let w = pfbm(p * 4.0 + vec2f(seed, seed * 1.7), 4, 3);
  let ph = fract(dot(p, wave) + warp * w);
  let stoss = smoothstep(0.0, 0.8, ph);
  let lee = 1.0 - smoothstep(0.8, 1.0, ph);
  return min(stoss, lee);
}

fn terrace(h: f32, step: f32, sharp: f32) -> f32 {
  let t = h / step;
  let f = fract(t);
  return (floor(t) + smoothstep(0.5 - sharp, 0.5 + sharp, f)) * step;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = U.layer;
  let P = PER[k];
  let fk = f32(k);
  let p = (vec2f(gid.xy) + 0.5) / TEXF;
  let seed = k * 7919u + 101u;

  var h = pfbmGain(p * 4.0 + vec2f(fk * 17.3, fk * 5.1), 4, 8, ROUGH_GAIN[k]) * RELIEF[k] * P;
  var sand = 0.0;
  var bedrock = 0.0;
  var rock = 0.0;
  var albV = 0.0;

  var cf: CF;
  cf.h = 0.0;
  cf.rim = 0.0;
  let cd = CRATER_D[k];
  craterOctave(p, 4, seed + 1u, P, 0.55 * cd, &cf);
  craterOctave(p, 8, seed + 2u, P, 0.70 * cd, &cf);
  craterOctave(p, 16, seed + 3u, P, 0.85 * cd, &cf);

  if (k == 0u) {
    let heroD = wrapDelta(p - vec2f(0.5)) * P / HERO_R;
    let heroR = length(heroD);
    let ridge = pridged(p * 6.0 + vec2f(3.3, 1.7), 6, 6);
    h += ridge * 900.0 * smoothstep(1.0, 1.4, heroR);
    let hero = craterProfile(heroD, HERO_R, 0.35, 7.0);
    h += hero.x * 1.6 + cf.h * smoothstep(0.85, 1.2, heroR);
    let md = heroD - vec2f(0.0, -0.2);
    let ang = atan2(md.y, md.x);
    let outline = 1.0 + 0.18 * pnoise(vec2f(cos(ang), sin(ang)) * 1.5 + 4.0, 64) + 0.1 * sin(ang * 3.0 + 1.0);
    let mr = length(md) / (0.42 * outline);
    var mound = 4500.0 * pow(max(1.0 - mr * mr, 0.0), 1.3);
    let gullies = pridged(vec2f(ang * 3.0, length(md) * 9.0) + 11.0, 8, 3);
    mound *= 1.0 - 0.18 * gullies * smoothstep(0.2, 0.8, mr);
    mound = mix(mound, terrace(mound, 90.0, 0.18), 0.7);
    h += mound;
    bedrock = smoothstep(0.0, 0.2, mound / 4500.0) * 0.8;
  } else {
    h += cf.h;
  }

  if (k == 1u) {
    let m = pfbm(p * 3.0 + vec2f(2.2, 7.9), 3, 5);
    let plateau = smoothstep(0.12, 0.17, m);
    let mesa = terrace(220.0 * plateau * (0.8 + 0.4 * pfbm(p * 6.0, 6, 2)), 18.0, 0.2);
    h += mesa;
    bedrock = max(bedrock, smoothstep(0.02, 0.4, plateau) * (1.0 - plateau * 0.6));
  }
  if (k == 2u) {
    let field = smoothstep(0.02, 0.2, pfbm(p * 2.0 + vec2f(5.5, 1.2), 2, 3));
    let crest = 0.55 + 0.45 * smoothstep(-0.25, 0.25, pfbm(p * 24.0 + 3.0, 24, 2));
    h += 9.0 * bedforms(p, vec2f(14.0, 5.0), 1.2, 3.0) * field * crest;
    sand = field;
  }
  if (k == 3u) {
    let field = smoothstep(0.05, 0.22, pfbm(p * 2.0 + vec2f(8.1, 4.4), 2, 3));
    h += 0.35 * bedforms(p, vec2f(60.0, 19.0), 2.0, 5.0) * field;
    sand = field;
    let outcrop = smoothstep(0.05, 0.2, pfbm(p * 3.0 + vec2f(1.9, 6.6), 3, 3)) * (1.0 - field);
    h += terrace(outcrop * 1.6, 0.35, 0.12);
    bedrock = outcrop;
  }
  if (k == 4u) {
    let field = smoothstep(0.0, 0.2, pfbm(p * 2.0 + vec2f(3.7, 9.4), 2, 3));
    h += 0.035 * bedforms(p, vec2f(36.0, 11.0), 1.5, 7.0) * field;
    sand = field;
    let plates = smoothstep(0.0, 0.15, pfbm(p * 3.0 + vec2f(6.2, 2.8), 3, 3)) * (1.0 - field);
    let cr = crackOctave(p, 24, seed + 21u);
    let crack = smoothstep(0.02, 0.07, cr.x);
    h += plates * (0.05 * crack + 0.02 * cr.y - 0.035);
    bedrock = plates * (0.6 + 0.4 * crack);
    albV = plates * (cr.y - 0.5) * 0.25;
  }
  if (k == 5u) {
    let field = smoothstep(0.0, 0.25, pfbm(p * 2.0 + vec2f(1.1, 5.3), 2, 3));
    h += 0.006 * bedforms(p, vec2f(20.0, 7.0), 1.0, 9.0) * field;
    sand = field * 0.5;
  }

  if (BOULDER_D[k] > 0.0) {
    let dens = clamp(BOULDER_D[k] * (0.5 + 2.5 * cf.rim + bedrock) * (1.0 - 0.85 * sand), 0.0, 1.0);
    let b0 = boulderOctave(p, 10, seed + 9u, P, dens * select(0.3, 0.08, k == 3u), 0.12, 0.3);
    let b1 = boulderOctave(p, 20, seed + 10u, P, dens * 0.45, 0.12, 0.3);
    let b2 = boulderOctave(p, 40, seed + 11u, P, dens * 0.65, 0.12, 0.3);
    h += max(max(b0.x, b1.x), b2.x);
    rock = max(max(b0.y, b1.y), b2.y);
  }

  let albN = pfbm(p * 8.0 + vec2f(fk * 3.7, 1.3), 8, 4);
  let alb = (1.0 + 0.3 * albN + albV);
  textureStore(hOut, gid.xy, k, vec4f(h, 0.0, 0.0, 0.0));
  textureStore(mOut, gid.xy, k, vec4f(clamp(alb * 0.5, 0.0, 1.0), rock, sand, bedrock));
}
`;

// x + w is the height (split into an f16 part and its residual so the rgba16float fallback keeps
// precision when sampled unfiltered); y and z are the slope along the layer's local axes.
export const DERIV = (fmt, hfmt) => LAYER_UNIFORM + /* wgsl */ `
@group(0) @binding(1) var hIn: texture_2d_array<f32>;
@group(0) @binding(2) var hOut: texture_storage_2d_array<${fmt}, write>;
@group(0) @binding(3) var hOnly: texture_storage_2d_array<${hfmt}, write>;
fn ld(c: vec2i, k: u32) -> f32 {
  let n = i32(TEXF);
  return textureLoad(hIn, (c + n) % n, k, 0).r;
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let k = U.layer;
  let c = vec2i(gid.xy);
  let texel = PER[k] / TEXF;
  let h = ld(c, k);
  let hx = (ld(c + vec2i(1, 0), k) - ld(c - vec2i(1, 0), k)) / (2.0 * texel);
  let hz = (ld(c + vec2i(0, 1), k) - ld(c - vec2i(0, 1), k)) / (2.0 * texel);
  let hi = quantizeToF16(h);
  textureStore(hOut, gid.xy, k, vec4f(hi, hx, hz, h - hi));
  textureStore(hOnly, gid.xy, k, vec4f(h, 0.0, 0.0, 0.0));
}
`;

export const HEIGHT_MIPS = (fmt) => /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<${fmt}, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(dst);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let c = vec2i(gid.xy) * 2;
  let k = gid.z;
  let a = textureLoad(src, c, k, 0);
  let b = textureLoad(src, c + vec2i(1, 0), k, 0);
  let d = textureLoad(src, c + vec2i(0, 1), k, 0);
  let e = textureLoad(src, c + vec2i(1, 1), k, 0);
  let s = (a + b + d + e) * 0.25;
  let h = s.x + s.w;
  let hi = quantizeToF16(h);
  textureStore(dst, gid.xy, k, vec4f(hi, s.y, s.z, h - hi));
}
`;

export const SCALAR_MIPS = (fmt) => /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<${fmt}, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(dst);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let c = vec2i(gid.xy) * 2;
  let k = gid.z;
  let s = textureLoad(src, c, k, 0).r + textureLoad(src, c + vec2i(1, 0), k, 0).r
        + textureLoad(src, c + vec2i(0, 1), k, 0).r + textureLoad(src, c + vec2i(1, 1), k, 0).r;
  textureStore(dst, gid.xy, k, vec4f(s * 0.25, 0.0, 0.0, 0.0));
}
`;

export const MAT_MIPS = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba8unorm, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = textureDimensions(dst);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let c = vec2i(gid.xy) * 2;
  let k = gid.z;
  let s = textureLoad(src, c, k, 0) + textureLoad(src, c + vec2i(1, 0), k, 0)
        + textureLoad(src, c + vec2i(0, 1), k, 0) + textureLoad(src, c + vec2i(1, 1), k, 0);
  textureStore(dst, gid.xy, k, s * 0.25);
}
`;
