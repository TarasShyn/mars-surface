// Dusty Mars sky with the Sun and its aureole, thin water-ice clouds, stars, Phobos, Deimos and the
// Earth as an evening star.
import { FRAME_WGSL, NOISE_WGSL, SKY_FUNCS } from './common.js';

export const SKY = FRAME_WGSL + NOISE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
` + SKY_FUNCS + /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VO;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

fn starDir(face: u32, sp: vec2f) -> vec3f {
  switch face {
    case 0u: { return normalize(vec3f(1.0, sp.x, sp.y)); }
    case 1u: { return normalize(vec3f(-1.0, sp.x, sp.y)); }
    case 2u: { return normalize(vec3f(sp.x, 1.0, sp.y)); }
    case 3u: { return normalize(vec3f(sp.x, -1.0, sp.y)); }
    case 4u: { return normalize(vec3f(sp.x, sp.y, 1.0)); }
    default: { return normalize(vec3f(sp.x, sp.y, -1.0)); }
  }
}

// One star per cube-map cell, kept 0.25 cells from the edges so no neighbour lookups are needed.
fn starLayer(dir: vec3f, N: f32, seed: u32, prob: f32, fmin: f32, fmax: f32, sigma: f32) -> vec3f {
  let a = abs(dir);
  var face = 0u;
  var uv = vec2f(0.0);
  if (a.x >= a.y && a.x >= a.z) { face = select(1u, 0u, dir.x > 0.0); uv = dir.yz / a.x; }
  else if (a.y >= a.z) { face = select(3u, 2u, dir.y > 0.0); uv = dir.xz / a.y; }
  else { face = select(5u, 4u, dir.z > 0.0); uv = dir.xy / a.z; }
  let cell = vec2i(floor((uv * 0.5 + 0.5) * N));
  let h = hash4(cell + vec2i(i32(face) * 4099, i32(face) * 131), seed);
  if (h.x > prob) { return vec3f(0.0); }
  let sp = (vec2f(cell) + 0.25 + 0.5 * h.yz) / N * 2.0 - 1.0;
  let d = length(dir - starDir(face, sp));
  let flux = mix(fmin, fmax, pow(h.w, 5.0));
  let temp = hash4(cell, seed ^ 0xabcdefu).x;
  let col = select(mix(vec3f(1.0, 0.97, 0.92), vec3f(0.72, 0.82, 1.0), (temp - 0.6) / 0.4),
                   mix(vec3f(1.0, 0.62, 0.38), vec3f(1.0, 0.97, 0.92), temp / 0.6), temp < 0.6);
  return col * flux * exp(-d * d / (2.0 * sigma * sigma)) / (6.2832 * sigma * sigma);
}

fn stars(dir: vec3f, pixAng: f32) -> vec3f {
  let sigma = max(pixAng * 0.6, 2e-5);
  var s = starLayer(dir, 40.0, 11u, 0.4, 4e-9, 9e-8, sigma);
  s += starLayer(dir, 110.0, 23u, 0.45, 8e-10, 6e-9, sigma);
  s += starLayer(dir, 300.0, 37u, 0.35, 3e-10, 1.2e-9, sigma);
  return s;
}

fn milkyWay(dir: vec3f) -> vec3f {
  let gN = normalize(vec3f(-0.42, 0.62, 0.66));
  let gC = normalize(cross(gN, vec3f(1.0, 0.0, 0.0)));
  let b = dot(dir, gN);
  let band = exp(-b * b / 0.022);
  let bulge = exp(-(1.0 - dot(dir, gC)) * 5.0) * exp(-b * b / 0.05);
  let s = fbm3(dir * 7.0 + 3.0, 5);
  let dust = smoothstep(0.48, 0.66, fbm3(dir * 11.0 + 17.0, 5)) * exp(-b * b / 0.004);
  return vec3f(1.0, 0.93, 0.82) * (band * (0.35 + 0.9 * s * s) + bulge * 1.4) * (1.0 - 0.85 * dust) * 4e-4;
}

fn sunDisk(dir: vec3f, pixAng: f32) -> vec3f {
  let sun = F.sunDir.xyz;
  let th = length(dir - sun);
  let w = max(pixAng, 1e-5);
  let cov = 1.0 - smoothstep(SUN_ANG_R - w, SUN_ANG_R + w, th);
  let x = clamp(th / SUN_ANG_R, 0.0, 1.0);
  let limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - x * x));
  return vec3f(1.0, 0.985, 0.96) * F.sunDir.w * sunTrans(sun.y) * cov * limb / (PI * SUN_ANG_R * SUN_ANG_R);
}

fn fbm2(p: vec2f) -> f32 {
  var s = 0.0; var a = 0.5; var q = p;
  for (var o = 0; o < 5; o++) {
    s += a * gnoise(q);
    q = q * 2.07 + vec2f(3.1, 1.7);
    a *= 0.5;
  }
  return s;
}

fn cloudCover(dir: vec3f) -> f32 {
  if (dir.y <= 0.0) { return 0.0; }
  let uv = dir.xz / (dir.y + 0.12) * 1.6 + vec2f(0.012, 0.004) * F.mars.w;
  let streak = fbm2(uv * vec2f(1.0, 2.6)) + 0.4 * fbm2(uv * 4.0 + 7.0);
  return smoothstep(0.08, 0.5, streak + F.mars.z - 0.5) * smoothstep(0.0, 0.12, dir.y);
}

// A small body lit by the Sun: lumpy outline, Lambert shading, seen through the dust.
fn moonlet(dir: vec3f, body: vec4f, pixAng: f32, albedo: f32, lumpy: f32) -> vec4f {
  let bd = normalize(body.xyz);
  let r = body.w;
  if (bd.y < -0.02 || dot(dir, bd) < cos(r * 1.5 + pixAng * 2.0)) { return vec4f(0.0); }
  let eu = normalize(cross(bd, vec3f(0.0, 1.0, 0.0)));
  let ev = cross(eu, bd);
  let xy = vec2f(dot(dir, eu), dot(dir, ev)) / r;
  let ang = atan2(xy.y, xy.x);
  let rho = length(xy) * (1.0 + lumpy * (0.5 * sin(ang * 2.0 + 0.7) + 0.3 * sin(ang * 3.0 + 2.1)));
  let aa = max(pixAng / r, 0.02);
  let cover = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, rho);
  if (cover <= 0.0) { return vec4f(0.0); }
  let xc = xy / max(length(xy), 1.0);
  let nrm = normalize(eu * xc.x + ev * xc.y - bd * sqrt(max(1.0 - dot(xc, xc), 0.0)));
  let grain = 0.85 + 0.3 * gnoise(xy * 4.0 + 9.0);
  let lit = albedo / PI * max(dot(nrm, F.sunDir.xyz), 0.0) * F.sunDir.w * grain;
  let T = exp(-(dustTau() + RAY_TAU) * airmass(max(dir.y, 0.0)));
  return vec4f(vec3f(lit) * T * cover, cover);
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let dir = normalize(F.camFwd.xyz + in.ndc.x * F.camRight.xyz + in.ndc.y * F.camUp.xyz);
  let pixAng = 2.0 * length(F.camUp.xyz) * F.screen.w;
  let up = max(dir.y, 0.0);
  let T = exp(-(dustTau() + RAY_TAU) * airmass(up));
  var L = (milkyWay(F.skyRot * dir) * F.sky.y + stars(F.skyRot * dir, pixAng) * F.sky.x) * T;
  let ph = moonlet(dir, F.phobos, pixAng, 0.07, 0.12);
  L = L * (1.0 - ph.a) + ph.rgb;
  let de = moonlet(dir, F.deimos, pixAng, 0.07, 0.08);
  L = L * (1.0 - de.a) + de.rgb;
  let ed = F.earthDir.xyz;
  let de2 = length(dir - ed);
  let sig = max(pixAng * 0.7, 2e-5);
  L += vec3f(0.55, 0.75, 1.0) * F.earthDir.w * T * exp(-de2 * de2 / (2.0 * sig * sig)) / (6.2832 * sig * sig);
  L += sunDisk(dir, pixAng);
  L += skyRad(dir);
  let cc = cloudCover(dir);
  if (cc > 0.0) {
    let c = dot(dir, F.sunDir.xyz);
    let cl = F.sunDir.w * sunTrans(F.sunDir.y) * vec3f(0.92, 0.95, 1.0) * (0.03 + 0.35 * hgv(c, vec3f(0.75)).x)
      + skyRad(vec3f(0.0, 1.0, 0.0)) * 0.6;
    L = mix(L, cl, cc * 0.55);
  }
  return vec4f(L, 1.0);
}
`;

// Irradiance from the sky and the ground on the six axis directions, plus the Sun's transmittance,
// for the terrain and the rover. One thread integrates the sky over a 12 x 6 grid.
export const AMBIENT = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read_write> AMB: array<vec4f, 8>;
` + SKY_FUNCS + /* wgsl */ `
@compute @workgroup_size(1)
fn main() {
  var e: array<vec3f, 6>;
  var axes = array<vec3f, 6>(vec3f(1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0),
                             vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.0, -1.0));
  let dAz = 2.0 * PI / 12.0;
  let dEl = 0.5 * PI / 6.0;
  for (var j = 0; j < 6; j++) {
    let el = (f32(j) + 0.5) * dEl;
    for (var i = 0; i < 12; i++) {
      let az = (f32(i) + 0.5) * dAz;
      let d = vec3f(cos(el) * cos(az), sin(el), cos(el) * sin(az));
      let w = skyRad(d) * cos(el) * dAz * dEl;
      for (var a = 0; a < 6; a++) { e[a] += w * max(dot(d, axes[a]), 0.0); }
    }
  }
  let T = sunTrans(F.sunDir.y);
  let groundAlb = vec3f(0.58, 0.33, 0.18) * F.shade.x;
  let Lg = groundAlb / PI * (e[2] + F.sunDir.w * T * max(F.sunDir.y, 0.0));
  for (var a = 0; a < 6; a++) {
    var g = 0.5;
    if (a == 2) { g = 0.0; }
    if (a == 3) { g = 1.0; }
    AMB[a] = vec4f(e[a] + Lg * PI * g, 0.0);
  }
  AMB[6] = vec4f(T, 0.0);
  AMB[7] = vec4f(Lg, 0.0);
}
`;
