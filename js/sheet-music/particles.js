/* ------------------------------------------------------------------
   LEGATO – WebGL particle staff
   Replaces the original Canvas 2D overlay with a Three.js renderer
   that runs fully on the GPU:

     • OrthographicCamera matching canvas CSS pixel dimensions
     • 3D Simplex-Noise vertex shader for organic breathing drift
     • Multi-frequency sin layering driven by uBass / uEnergy
     • Scatter ↔ assemble state machine (idle / playback / paused / settling)
     • Additive-blending "bloom" second pass for soft glow
     • Tone.Analyser tap for bass / energy uniforms (graceful fallback)
------------------------------------------------------------------ */

// Dense enough to preserve noteheads, stems, beams, and accidentals after the
// semantic SVG is replaced by particles. Compact devices retain a lower cap
// so the two-pass point render does not overwhelm integrated/mobile GPUs.
const DESKTOP_PARTICLES = 48000;
const COMPACT_PARTICLES = 20000;
const MAX_DPR           = 3;
// Fallback-dot color before a real SVG sample lands — matches render.js's
// userColor so the transient scaffold blends into the same cosmic palette
// the assembled notation renders in.
const HARMONY_TINT       = [143, 147, 232];
const SAMPLE_CACHE_LIMIT = 3;
// Dislodge — the pointer leaves a short trail of timestamped "touch" impulses
// (position + the direction the pointer was travelling at that instant).
// Each impulse's effect is purely a function of its own age: a quick rise as
// the hand passes through, a brief hold, then a slow decay back to nothing —
// independent of where the pointer currently is. That's what makes a touch
// keep drifting under its own momentum instead of being a field that
// snaps back the instant the cursor moves elsewhere.
// The trail is a fixed-size ring buffer — a new touch always recycles
// whichever slot was written longest ago (plain least-recently-used, the
// same thing round-robin index cycling gives you). For that recycled slot to
// never visibly interrupt anything, it needs to have already finished
// decaying by the time its turn comes back around, which means:
// TRAIL_SIZE * (time between stamps) should safely exceed one impulse's
// full lifespan (RISE + HOLD + ~4 * DECAY). The constants below are tuned
// to satisfy that under fast, continuous pointer movement.
const DISLODGE_TRAIL_SIZE   = 48;
const DISLODGE_RISE_S       = 0.2;   // time to reach peak displacement
const DISLODGE_HOLD_S       = 0.22;  // stays near peak before decay begins
const DISLODGE_DECAY_S      = 0.8;   // time-constant of the fade-out
const DISLODGE_STAMP_PX     = 12;    // min pointer movement between new impulses
const DISLODGE_STAMP_MS     = 55;    // min time between new impulses, regardless of speed
const FAST_RETURN_SPEED     = 5.5;

// Central diagnostic switch. Keep this available so particle rendering can be
// isolated again during profiling without changing the rest of the score.
export const PARTICLE_EFFECTS_ENABLED = true;

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const ease  = (t) => 1 - (1 - clamp(t)) ** 3;

// ── Font embedding for SVG rasterization ───────────────────────────
// The SVG is rasterized through an <img>, whose isolated document cannot see
// the page's @font-face fonts — chord-symbol text would silently fall back
// to a generic serif in the particle layer while the live SVG shows the real
// project font. Embedding the face as a data: URI inside the serialized
// markup keeps both layers identical. Fetched once per family, then cached.
const FONT_SOURCES = new Map([
  ['MuseJazz Text', { url: '/fonts/MuseJazzText.otf', weight: '400 700', format: 'opentype' }],
  ['Edwin', { url: '/fonts/Edwin-Bold.otf', weight: '700', format: 'opentype' }],
  ['Orbitron', { url: '/fonts/Orbitron-Bold.woff2', weight: '700 800', format: 'woff2' }],
]);
const FONT_MIME = { opentype: 'font/otf', woff2: 'font/woff2' };
const fontDataUris = new Map();

async function fontFaceStyleFor(svg) {
  const families = new Set();
  svg.querySelectorAll('text').forEach((text) => {
    const family = text.getAttribute('font-family');
    if (family && FONT_SOURCES.has(family)) families.add(family);
  });
  const rules = [];
  for (const family of families) {
    if (!fontDataUris.has(family)) {
      try {
        const source = FONT_SOURCES.get(family);
        const buffer = await (await fetch(source.url)).arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const mime = FONT_MIME[source.format] ?? 'font/otf';
        fontDataUris.set(family, `data:${ mime };base64,${ btoa(binary) }`);
      } catch {
        fontDataUris.set(family, null); // fetch failed: fall back silently
      }
    }
    const uri = fontDataUris.get(family);
    if (uri) {
      const { weight, format } = FONT_SOURCES.get(family);
      rules.push(`@font-face{font-family:'${ family }';src:url('${ uri }') format('${ format }');font-weight:${ weight };}`);
    }
  }
  return rules.length ? `<style>${ rules.join('') }</style>` : '';
}

/** Playback position expressed as measure index + progress within it. */
export function particlePlayhead(measureIndex, measureProgress, layoutLength, globalProgress = 0) {
  if (Number.isInteger(measureIndex) && measureIndex >= 0) {
    return measureIndex + clamp(Number(measureProgress) || 0);
  }
  return clamp(Number(globalProgress) || 0) * Math.max(0, Number(layoutLength) || 0);
}

/**
 * Convert an engraved X position into musical progress using actual note
 * onsets. The system preamble (clef/key/time signature) clamps to the first
 * note's onset, so it never pushes that sounding note later in the timeline.
 */
export function musicalProgressAtX(measure, x, snapPx = 14) {
  const start = Number(measure?.x) || 0;
  const width = Math.max(1, Number(measure?.width) || 1);
  const target = Number(x) || 0;
  const fallback = () => clamp((target - start) / width);
  const anchors = measure?.timelineAnchors;
  if (!Array.isArray(anchors) || !anchors.length) return fallback();

  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (!Number.isFinite(first?.x) || !Number.isFinite(first?.progress)
    || !Number.isFinite(last?.x) || !Number.isFinite(last?.progress)) return fallback();

  const snap = Math.max(0, Number(snapPx) || 0);
  if (target <= first.x + snap) return clamp(first.progress);

  for (let index = 0; index < anchors.length - 1; index += 1) {
    const left = anchors[index];
    const right = anchors[index + 1];
    if (![left.x, left.progress, right.x, right.progress].every(Number.isFinite)) continue;
    if (Math.abs(target - right.x) <= snap) return clamp(right.progress);
    if (target < right.x - snap) {
      const fromX = left.x + snap;
      const toX = right.x - snap;
      if (target <= fromX || toX <= fromX) return clamp(left.progress);
      const ratio = clamp((target - fromX) / (toX - fromX));
      return clamp(left.progress + (right.progress - left.progress) * ratio);
    }
  }

  if (target <= last.x + snap) return clamp(last.progress);
  const fromX = last.x + snap;
  const toX = start + width;
  if (toX <= fromX) return clamp(last.progress);
  const ratio = clamp((target - fromX) / (toX - fromX));
  return clamp(last.progress + (1 - last.progress) * ratio);
}

/* ── GLSL ────────────────────────────────────────────────────────── */

// Compact 3D Simplex noise (Stefan Gustavson / Ashima Arts)
const SIMPLEX = /* glsl */`
vec4 _p289(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod(i, 289.0);
  vec4 p = _p289(_p289(_p289(
      i.z + vec4(0.0,i1.z,i2.z,1.0))
    + i.y + vec4(0.0,i1.y,i2.y,1.0))
    + i.x + vec4(0.0,i1.x,i2.x,1.0));
  float n_ = 0.142857142857;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4  j  = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_  = floor(j * ns.z);
  vec4 y_  = floor(j - 7.0 * x_);
  vec4 xx  = x_ * ns.x + ns.yyyy;
  vec4 yy  = y_ * ns.x + ns.yyyy;
  vec4 h   = 1.0 - abs(xx) - abs(yy);
  vec4 b0  = vec4(xx.xy, yy.xy);
  vec4 b1  = vec4(xx.zw, yy.zw);
  vec4 s0  = floor(b0)*2.0 + 1.0;
  vec4 s1  = floor(b1)*2.0 + 1.0;
  vec4 sh  = -step(h, vec4(0.0));
  vec4 a0  = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1  = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0  = vec3(a0.xy, h.x);
  vec3 p1  = vec3(a0.zw, h.y);
  vec3 p2  = vec3(a1.xy, h.z);
  vec3 p3  = vec3(a1.zw, h.w);
  vec4 norm = inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERT = /* glsl */`
precision highp float;
${SIMPLEX}

#define DISLODGE_N ${DISLODGE_TRAIL_SIZE}

uniform float uTime;
uniform float uBass;
uniform float uEnergy;
uniform float uPlayhead;  // measure index + within-measure progress
uniform float uScatterT;   // 0 = assembled, 1 = fully scattered
uniform float uCanvasW;
uniform float uCanvasH;    // canvas CSS height for y-flip
uniform float uPixelRatio; // for gl_PointSize
uniform float uBloomMult;  // 1.0 for main pass, >1 for bloom
uniform float uMotionStrength;
uniform float uPointerActive;
uniform float uPointerRadius;
uniform vec2  uPointer;
// Dislodge trail: each impulse is where the pointer touched and which way it
// was heading. Unused slots carry a time far in the past so their response
// curve (below) naturally evaluates to zero without any dynamic branching.
uniform vec2  uDislodgePos[DISLODGE_N];
uniform vec2  uDislodgeDir[DISLODGE_N];
uniform float uDislodgeTime[DISLODGE_N];
uniform float uReturnSpeed; // 1.0 normal drift-back rate; >1 fast-forwards it

attribute float aSeed;
attribute float aTimeline;
attribute float aMeasure;
attribute float aCoverage;
attribute vec3  aCol;

varying float vAlpha;
varying float vBright;
varying float vCoverage;
varying vec3  vCol;

void main() {
  // Raw pixel coordinates stored in buffer; flip y to match Three.js (y-up)
  vec3 pos = vec3(position.x, uCanvasH - position.y, position.z);

  // Stable per-particle randoms from seed
  float s1 = fract(sin(aSeed * 12.9898 + 1.0) * 43758.5453);
  float s2 = fract(sin(aSeed * 78.233  + 2.0) * 43758.5453);
  float s3 = fract(sin(aSeed * 39.346  + 3.0) * 43758.5453);

  // ── Readable orbital breathing ────────────────────────────────────
  // Every point stays close to its notation origin. Phase offsets across x
  // turn the small ellipses into broad travelling waves without deforming
  // the glyph silhouettes enough to hurt legibility.
  float nT       = uTime * 0.19;
  float phase    = uTime * 0.72 + pos.x * 0.014 + aMeasure * 0.82 + s1 * 0.12;
  float wave     = sin(uTime * 0.34 + pos.x * 0.0105 + pos.y * 0.022 + aMeasure * 0.56);
  float shimmer  = 0.5 + 0.5 * sin(phase * 0.74 + wave * 0.65);
  float orbitAmp = 0.55 + s2 * 0.12 + uBass * 0.15;
  vec2 center    = vec2(uCanvasW * 0.5, uCanvasH * 0.5);
  float camScale = 1.0 + sin(uTime * 0.43) * 0.0017 * uMotionStrength;
  vec2 camDrift  = center + (pos.xy - center) * camScale - pos.xy;
  float nX       = (cos(phase) * orbitAmp
                   + snoise(vec3(pos.x * 0.0036, pos.y * 0.0072, nT)) * 0.38
                   + camDrift.x) * uMotionStrength;
  float nY       = (sin(phase) * orbitAmp * 1.18
                   + wave * (0.34 + uEnergy * 0.16)
                   + snoise(vec3(pos.x * 0.0036 + 100.0, pos.y * 0.0072, nT * 0.71)) * 0.30
                   + camDrift.y) * uMotionStrength;

  // ── Star-field scatter displacement ──────────────────────────────
  float scatterAngle = s1 * 6.2832;
  float scatterReach = 0.38 + s2 * 0.62;
  float scX = cos(scatterAngle) * min(270.0, uCanvasW * 0.34) * scatterReach
            + sin(uTime * 0.052 + s3 * 6.2832) * 16.0;
  float scY = sin(scatterAngle) * min(170.0, uCanvasH * 0.46) * scatterReach
            + cos(uTime * 0.044 + s2 * 6.2832) * 12.0;

  // ── Assembly progress for this individual particle ────────────────
  // A tiny stable delay prevents dense clefs, accidentals, and vertical chord
  // clusters from changing opacity in one frame while preserving one gesture.
  float particleDelay = (s1 - 0.5) * 0.012;
  float dist      = uPlayhead - aTimeline - particleDelay;
  float assembled = smoothstep(-0.018, 0.018, dist);

  // scatter only applies to unbuilt portion
  float effScatter = uScatterT * (1.0 - assembled);

  pos.x += mix(nX, scX, effScatter);
  pos.y += mix(nY, scY, effScatter);
  float hover = uPointerActive * (1.0 - smoothstep(
    uPointerRadius * 0.18,
    uPointerRadius,
    distance(pos.xy, uPointer)
  ));

  // ── Dislodge ─────────────────────────────────────────────────────
  // Not a field that tracks the live cursor (that read as "avoiding the
  // mouse" and snapped back the instant the cursor moved elsewhere). Instead
  // the pointer leaves a trail of touch impulses; each one's effect is a
  // function of *its own age only* — a quick rise, a brief hold, then a slow
  // independent decay — so a particle keeps drifting on its own timeline
  // whether or not the pointer is still anywhere nearby. Direction blends
  // "pushed away from the touch point" with "pushed the way the hand was
  // moving," which is what makes it read as a shove rather than a repulsion
  // field radiating from a point.
  //
  // Multiple overlapping impulses are combined as a weighted average (not a
  // sum, which exploded when several impulses overlapped, and not a hard
  // max, which caused visible discontinuities whenever the strongest
  // candidate flipped between two competing impulses frame to frame). A
  // weighted average changes smoothly as weights shift, and clamping the
  // total keeps it bounded regardless of how many impulses overlap.
  float reach = uPointerRadius * 0.95;
  vec2  dirSum = vec2(0.0);
  float weightSum = 0.0;
  for (int i = 0; i < DISLODGE_N; i++) {
    float age = (uTime - uDislodgeTime[i]) * uReturnSpeed;
    float attack = 1.0 - exp(-age / ${DISLODGE_RISE_S.toFixed(2)});
    float decay = exp(-max(0.0, age - ${DISLODGE_HOLD_S.toFixed(2)}) / ${DISLODGE_DECAY_S.toFixed(2)});
    float response = attack * decay;
    vec2  toParticle = pos.xy - uDislodgePos[i];
    float d = length(toParticle) + 0.001;
    float falloff = 1.0 - smoothstep(0.0, reach, d);
    float weight = response * falloff;
    vec2  pushDir = normalize(mix(toParticle / d, uDislodgeDir[i], 0.55));
    dirSum += pushDir * weight;
    weightSum += weight;
  }
  vec2  avgDir = weightSum > 0.0005 ? dirSum / weightSum : vec2(0.0);
  float influence = clamp(weightSum, 0.0, 1.0);

  // Per-particle magnitude variance keeps neighbours from moving in perfect
  // lockstep — reads as individual particles drifting apart, not one surface.
  float indivStrength = 0.55 + s2 * 0.9;
  vec2 drift = avgDir * influence * indivStrength * 34.0;

  // Small persistent wobble while drifting, like two like charges that repel
  // but never quite settle — amplitude scales with influence so it vanishes
  // once fully assembled again instead of adding noise everywhere.
  vec2 wobble = vec2(
    snoise(vec3(aSeed * 0.08, uTime * 1.7, 0.0)),
    snoise(vec3(aSeed * 0.08 + 40.0, uTime * 1.7, 7.0))
  ) * influence * 5.0;

  pos.xy += (drift + wobble) * uMotionStrength;

  // Subtle z pulsation (visible in perspective-free ortho as size modulation)
  pos.z  = snoise(vec3(pos.x * 0.0026, pos.y * 0.0026, uTime * 0.09)) * 1.4
         + uBass * 0.7;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

  // ── Point size ───────────────────────────────────────────────────
  float isFrontier = step(abs(dist), 0.026);
  float isActive   = step(abs(dist), 0.062);
  float coverage   = smoothstep(0.12, 0.92, aCoverage);
  float sz         = (0.72 + s3 * 0.42 + uBass * 0.16) * uPixelRatio;
  sz *= (1.0 + isFrontier * 0.38 + isActive * 0.14 + hover * 0.22
        + shimmer * 0.04 * uMotionStrength) * uBloomMult;
  gl_PointSize = sz;

  // ── Alpha ────────────────────────────────────────────────────────
  float idleA     = 0.73 + s1 * 0.18 + shimmer * 0.08 * uMotionStrength;
  // Reveal against the continuous musical playhead instead of opening an
  // entire measure with an integer step. Future notation remains invisible,
  // but the frontier fades in over a narrow, tempo-relative window.
  float reveal = smoothstep(-0.032, 0.014, dist);
  float playbackA = reveal * (0.08 + assembled * 0.76 + isActive * 0.18);
  vAlpha = min(1.0, (mix(idleA, playbackA, step(0.01, uScatterT)) + hover * reveal * 0.20)
           * (0.78 + coverage * 0.22));

  // ── Brightness ──────────────────────────────────────────────────
  vBright = 0.88 + isFrontier * 0.30 + isActive * 0.18
          + uBass * 0.16 + uEnergy * 0.08 + hover * 0.82
          + shimmer * 0.14 * uMotionStrength;

  vCoverage = coverage;
  vCol = aCol;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uDotTex;
uniform float     uColorBoost;
varying float vAlpha;
varying float vBright;
varying float vCoverage;
varying vec3  vCol;
void main() {
  vec4 t = texture2D(uDotTex, gl_PointCoord);
  if (t.a < 0.018) discard;
  vec3 col = max(vCol * vBright, vec3(0.0));
  col = pow(col, vec3(1.0 / max(1.0, uColorBoost)));
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float floorLum = mix(0.31, 0.36, vCoverage);
  col *= max(1.0, floorLum / max(0.001, lum));
  col = clamp(col, vec3(0.0), vec3(1.45));
  float core = smoothstep(0.06, 0.28, t.a);
  gl_FragColor = vec4(col, core * vAlpha);
}
`;

const BLOOM_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uDotTex;
uniform float     uBloomAlpha;
uniform float     uColorBoost;
varying float vAlpha;
varying float vBright;
varying float vCoverage;
varying vec3  vCol;
void main() {
  vec4 t = texture2D(uDotTex, gl_PointCoord);
  if (t.a < 0.01) discard;
  float soft = t.a * t.a;
  vec3 col = max(vCol * (0.72 + vBright * 0.48), vec3(0.0));
  col = pow(col, vec3(1.0 / max(1.0, uColorBoost)));
  // A small neutral-cool boost instead of the old warm-amber one: most
  // particles now sample the cool lavender harmony color, and a warm additive
  // tint here would muddy that toward brown. Gold (technique/melody) material
  // still reads warm because its sampled vCol already carries that hue.
  col = clamp(col + vec3(0.05, 0.055, 0.09), vec3(0.0), vec3(1.65));
  gl_FragColor = vec4(col, soft * vAlpha * uBloomAlpha * (0.76 + vCoverage * 0.24));
}
`;

/* ── Soft radial dot texture ────────────────────────────────────── */
function makeDotTexture(T) {
  const S = 64;
  const c = Object.assign(document.createElement('canvas'), { width: S, height: S });
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,1.00)');
  g.addColorStop(0.28, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.58, 'rgba(255,255,255,0.48)');
  g.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new T.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/* ── Main export ────────────────────────────────────────────────── */
export function createSheetMusicParticles(canvas) {
  if (!PARTICLE_EFFECTS_ENABLED) {
    const stage = canvas.closest('[data-particle-stage], .notation-stage');
    canvas.hidden = true;
    stage?.classList.remove(
      'has-full-particles',
      'is-particle-playing',
      'is-particle-paused',
      'is-particle-settling',
    );

    return {
      setSheetMusic() {
        // Without `has-full-particles`, the original vector SVG remains
        // visible and crisp. No rasterization or particle geometry is built.
        stage?.classList.remove('has-full-particles');
        return Promise.resolve(false);
      },
      ready() { return Promise.resolve(false); },
      beginPlayback() {
        stage?.style.setProperty('--sheet-music-progress', '0%');
      },
      setProgress(next) {
        const progress = clamp(Number(next) || 0);
        stage?.style.setProperty('--sheet-music-progress', `${ (progress * 100).toFixed(2) }%`);
      },
      settle() {
        stage?.style.setProperty('--sheet-music-progress', '0%');
      },
      setFastReturn() {},
      destroy() {},
    };
  }

  const T = window.THREE;
  if (!T) {
    console.warn('[particles] Three.js not available — visual disabled.');
    return {
      setSheetMusic() { return Promise.resolve(false); },
      ready() { return Promise.resolve(false); },
      beginPlayback() {}, setProgress() {}, settle() {}, setFastReturn() {}, destroy() {},
    };
  }

  const stage   = canvas.closest('[data-particle-stage], .notation-stage');
  const stateEl = stage?.querySelector('#sheet-music-fx-state');
  const mq      = window.matchMedia('(prefers-reduced-motion: reduce)');
  let   rm      = mq.matches;
  const compact = window.matchMedia('(max-width: 700px), (pointer: coarse)').matches
    || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)
    || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  const particleCap = compact ? COMPACT_PARTICLES : DESKTOP_PARTICLES;
  const sampleStep  = compact ? 2 : 1;

  /* ── Three.js renderer ─────────────────────────────────────────── */
  const renderer = new T.WebGLRenderer({
    canvas,
    alpha: true,
    premultipliedAlpha: false,
    antialias: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
  renderer.setClearColor(0x000000, 0);
  renderer.sortObjects = false;
  // The sampled SVG pixels are sRGB. Match the reference visual system and
  // keep the renderer in sRGB output instead of writing them as linear values.
  if (T.SRGBColorSpace !== undefined) {
    renderer.outputColorSpace = T.SRGBColorSpace;
  }

  const scene = new T.Scene();
  let camera  = null;
  let cW = 0, cH = 0;

  /* ── Shared uniform objects (mutated every frame) ─────────────── */
  const uTime       = { value: 0 };
  const uBass       = { value: 0 };
  const uEnergy     = { value: 0 };
  const uPlayhead   = { value: 0 };
  const uScatterT   = { value: 0 };
  const uCanvasW    = { value: 1 };
  const uCanvasH    = { value: 1 };
  const uPixelRatio = { value: renderer.getPixelRatio() };
  const uDotTex     = { value: makeDotTexture(T) };
  const uMotionStrength = { value: rm ? 0 : 1 };
  const uPointerActive  = { value: 0 };
  const uPointerRadius  = { value: compact ? 82 : 112 };
  const uPointer        = { value: new T.Vector2(-10000, -10000) };
  const uColorBoost     = { value: 1.28 };
  // Dislodge trail. Slots start far in the past so they contribute nothing
  // (see the response curve in VERT) until the pointer actually touches the
  // sheet. dislodgePositions/dislodgeDirs are mutated in place on pointer
  // move; Three.js re-reads the current component values each frame.
  const dislodgePositions = Array.from({ length: DISLODGE_TRAIL_SIZE }, () => new T.Vector2(-10000, -10000));
  const dislodgeDirs = Array.from({ length: DISLODGE_TRAIL_SIZE }, () => new T.Vector2(0, 0));
  const dislodgeTimes = new Array(DISLODGE_TRAIL_SIZE).fill(-1000);
  const uDislodgePos  = { value: dislodgePositions };
  const uDislodgeDir  = { value: dislodgeDirs };
  const uDislodgeTime = { value: dislodgeTimes };
  const uReturnSpeed  = { value: 1 };

  // Main pass (normal blending, tight point size)
  const mainUniforms = {
    uTime, uBass, uEnergy, uPlayhead, uScatterT,
    uCanvasW, uCanvasH, uPixelRatio, uDotTex,
    uMotionStrength, uPointerActive, uPointerRadius, uPointer, uColorBoost,
    uDislodgePos, uDislodgeDir, uDislodgeTime, uReturnSpeed,
    uBloomMult:  { value: 1.0 },
  };

  // Bloom pass (additive blending, enlarged points for soft halo). Kept
  // tighter/dimmer than the original warm-palette tuning: the cosmic colors
  // sit closer to white already, and additive overlap between neighbouring
  // halos saturates to a flat merged glow much faster than it did against
  // the old warmer, lower-luminance palette.
  const bloomUniforms = {
    uTime, uBass, uEnergy, uPlayhead, uScatterT,
    uCanvasW, uCanvasH, uPixelRatio, uDotTex,
    uMotionStrength, uPointerActive, uPointerRadius, uPointer, uColorBoost,
    uDislodgePos, uDislodgeDir, uDislodgeTime, uReturnSpeed,
    uBloomMult:  { value: 1.45 },
    uBloomAlpha: { value: 0.1 },
  };

  const matBase = {
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  };

  const mat      = new T.ShaderMaterial({ ...matBase, uniforms: mainUniforms, blending: T.NormalBlending });
  const bloomMat = new T.ShaderMaterial({ ...matBase, fragmentShader: BLOOM_FRAG, uniforms: bloomUniforms, blending: T.AdditiveBlending });

  let geo = null, pts = null, bPts = null;

  /* ── Camera / resize ───────────────────────────────────────────── */
  function syncCamera() {
    const par = canvas.parentElement;
    if (!par) return;
    const w = Math.max(1, par.clientWidth);
    const h = Math.max(1, par.clientHeight);
    const nextDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const dprChanged = Math.abs(renderer.getPixelRatio() - nextDpr) > 0.001;
    if (dprChanged) renderer.setPixelRatio(nextDpr);
    if (w === cW && h === cH && camera && !dprChanged) return;
    cW = w; cH = h;
    renderer.setSize(w, h, false); // false = don't override CSS width/height
    uCanvasW.value    = w;
    uCanvasH.value    = h;
    uPixelRatio.value = renderer.getPixelRatio();
    if (camera) {
      camera.left = 0; camera.right = w;
      camera.top  = h; camera.bottom = 0;
      camera.updateProjectionMatrix();
    } else {
      // top=h, bottom=0 → world y=0 at bottom, y=h at top
      // particle y is raw pixel (0=top); flip in shader: world_y = h - pixel_y
      camera = new T.OrthographicCamera(0, w, h, 0, -200, 200);
    }
  }

  /* ── State ─────────────────────────────────────────────────────── */
  let mode          = 'idle';
  let progress      = 0;
  let activeMeasure = null;
  let activeMeasureProgress = 0;
  let modeStartedAt = performance.now();
  let layout        = [];
  let sampleGen     = 0;
  let readyPromise  = Promise.resolve(false);
  let pendingSample = null;
  const sampleCache = new Map();
  let frameId       = 0;
  let lastT         = performance.now();
  let destroyed     = false;

  /* ── Audio analysis via Tone.Analyser ──────────────────────────── */
  let toneAnalyser = null;

  function getAnalyser() {
    if (toneAnalyser) return toneAnalyser;
    try {
      if (!window.Tone) return null;
      const raw = Tone.getContext().rawContext;
      if (raw.state === 'suspended') return null;
      toneAnalyser = new Tone.Analyser({ type: 'fft', size: 128, smoothing: 0.82 });
      Tone.getDestination().connect(toneAnalyser);
    } catch (e) { toneAnalyser = null; }
    return toneAnalyser;
  }

  function readAudio() {
    if (rm) return { bass: 0, energy: 0 };
    const an = getAnalyser();
    if (!an) return { bass: 0, energy: 0 };
    const v = an.getValue(); // Float32Array dBFS (~-100..0)
    const n = v.length;
    const bassEnd = Math.max(2, Math.floor(n * 0.04));
    let bSum = 0;
    for (let i = 0; i < bassEnd; i++) bSum += Math.max(0, (v[i] + 100) / 100);
    const bass = Math.min(1, bSum / bassEnd);
    let eSum = 0;
    for (let i = 0; i < n; i++) eSum += Math.max(0, (v[i] + 100) / 100);
    const energy = Math.min(1, eSum / n);
    return { bass, energy };
  }

  /* ── Geometry builders ─────────────────────────────────────────── */
  const seededR = (v) => { const r = Math.sin(v * 12.9898 + 78.233) * 43758.5453; return r - Math.floor(r); };

  function nearestM(x, y, sourceLayout = layout) {
    return sourceLayout.reduce((best, m) => {
      const hd = x < m.x ? m.x - x : Math.max(0, x - m.x - m.width);
      const d  = hd * 2 + Math.abs(y - (m.staffTop + 20));
      return !best || d < best.d ? { m, d } : best;
    }, null)?.m;
  }

  function buildGeo(list) {
    const n  = list.length;
    const pa = new Float32Array(n * 3);
    const sa = new Float32Array(n);
    const ta = new Float32Array(n);
    const ma = new Float32Array(n);
    const qa = new Float32Array(n);
    const ca = new Float32Array(n * 3);

    list.forEach((p, i) => {
      pa[i * 3]     = p.x;
      pa[i * 3 + 1] = p.y; // raw pixel y (0 = top); flipped in shader via uCanvasH
      pa[i * 3 + 2] = 0;
      sa[i]     = p.seed;
      ta[i]     = p.timeline;
      ma[i]     = p.measure;
      qa[i]     = p.coverage ?? 1;
      ca[i * 3]     = p.color[0] / 255;
      ca[i * 3 + 1] = p.color[1] / 255;
      ca[i * 3 + 2] = p.color[2] / 255;
    });

    if (pts) scene.remove(pts);
    if (bPts) scene.remove(bPts);
    geo?.dispose();
    geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pa, 3));
    geo.setAttribute('aSeed',    new T.BufferAttribute(sa, 1));
    geo.setAttribute('aTimeline', new T.BufferAttribute(ta, 1));
    geo.setAttribute('aMeasure', new T.BufferAttribute(ma, 1));
    geo.setAttribute('aCoverage', new T.BufferAttribute(qa, 1));
    geo.setAttribute('aCol',     new T.BufferAttribute(ca, 3));

    // Bloom renders first (behind), main pass on top
    bPts = new T.Points(geo, bloomMat);
    pts  = new T.Points(geo, mat);
    bPts.frustumCulled = false;
    pts.frustumCulled = false;
    bPts.renderOrder = 0;
    pts.renderOrder = 1;
    scene.add(bPts);
    scene.add(pts);
  }

  function buildFallback(nextLayout = layout) {
    layout = nextLayout;
    const sp   = Math.max(4, layout.reduce((s, m) => s + m.width * 5, 0) / 1800);
    const list = [];
    layout.forEach((m) => {
      const cnt = Math.max(2, Math.floor(m.width / sp));
      for (let line = 0; line < 5; line++) {
        for (let k = 0; k <= cnt; k++) {
          const visualProgress = k / cnt;
          const x = m.x + visualProgress * m.width;
          const musicalProgress = musicalProgressAtX(m, x);
          const seed = m.index * 997 + line * 173 + k * 11;
          list.push({
            x,
            y: m.staffTop + line * m.lineGap,
            color: HARMONY_TINT, seed,
            timeline: m.index + musicalProgress,
            measure: m.index,
            coverage: 1,
          });
        }
      }
    });
    buildGeo(list);
  }

  function samplePx(imgData, w, h, sp, scale = 1, sourceLayout = layout) {
    const px = imgData.data;
    const list = [];
    for (let cy = 0; cy < h; cy += sp) {
      for (let cx = 0; cx < w; cx += sp) {
        let bestA = 28, bestOff = -1;
        for (let y = cy; y < Math.min(h, cy + sp); y++) {
          for (let x = cx; x < Math.min(w, cx + sp); x++) {
            const off = (y * w + x) * 4;
            if (px[off + 3] > bestA) { bestA = px[off + 3]; bestOff = off; }
          }
        }
        if (bestOff < 0) continue;
        const pi = bestOff / 4;
        const rasterX = pi % w;
        const rasterY = Math.floor(pi / w);
        const x = rasterX / scale;
        const y = rasterY / scale;
        const m  = nearestM(x, y, sourceLayout);
        if (!m) continue;
        const lp   = musicalProgressAtX(m, x);
        const seed = m.index * 997 + Math.round(x) * 17 + Math.round(y) * 31 + list.length;
        list.push({
          x, y,
          color: [px[bestOff], px[bestOff + 1], px[bestOff + 2]]
            .map((c) => Math.min(255, Math.round(c * 1.18 + 12))),
          seed,
          timeline: m.index + lp,
          measure: m.index,
          coverage: bestA / 255,
        });
      }
    }
    return list;
  }

  async function sampleSvg(svg, gen, nextLayout) {
    const par = canvas.parentElement;
    if (!svg || !par) return null;
    const w = Math.max(1, Math.round(par.clientWidth));
    const h = Math.max(1, Math.round(par.clientHeight));
    const fontStyle = await fontFaceStyleFor(svg);
    if (gen !== sampleGen) return null;
    const markup = new XMLSerializer().serializeToString(svg)
      .replace(/(<svg[^>]*>)/, `$1${ fontStyle }`);
    const timelineKey = nextLayout.map((measure) => (measure.timelineAnchors ?? [])
      .map((anchor) => `${Number(anchor.x).toFixed(2)},${Number(anchor.progress).toFixed(4)}`)
      .join(';')).join('|');
    const cacheKey = `${w}x${h}:${compact ? 'compact' : 'desktop'}:${timelineKey}:${markup}`;
    if (sampleCache.has(cacheKey)) {
      const cached = sampleCache.get(cacheKey);
      sampleCache.delete(cacheKey);
      sampleCache.set(cacheKey, cached);
      return { list: cached, layout: nextLayout };
    }
    const url = URL.createObjectURL(
      new Blob([markup], { type: 'image/svg+xml' }),
    );
    const img = new Image();
    try {
      await new Promise((ok, ko) => { img.onload = ok; img.onerror = ko; img.src = url; });
      if (gen !== sampleGen) return null;
      // Rasterize above CSS resolution before selecting points. This gives
      // thin glyph details several candidate pixels instead of letting a
      // single low-resolution sample erase a stem, beam, or accidental.
      const sampleScale = compact ? 2 : 3;
      const rasterW = Math.max(1, Math.round(w * sampleScale));
      const rasterH = Math.max(1, Math.round(h * sampleScale));
      const rc  = Object.assign(document.createElement('canvas'), { width: rasterW, height: rasterH });
      const rctx = rc.getContext('2d', { willReadFrequently: true });
      rctx.imageSmoothingEnabled = true;
      rctx.imageSmoothingQuality = 'high';
      rctx.drawImage(img, 0, 0, rasterW, rasterH);
      const data = rctx.getImageData(0, 0, rasterW, rasterH);
      let sp = sampleStep;
      let list = samplePx(data, rasterW, rasterH, sp, sampleScale, nextLayout);
      while (list.length > particleCap && sp < 10) {
        sp++;
        list = samplePx(data, rasterW, rasterH, sp, sampleScale, nextLayout);
      }
      if (gen !== sampleGen || !list.length) return null;
      const sampled = list.slice(0, particleCap);
      sampleCache.set(cacheKey, sampled);
      while (sampleCache.size > SAMPLE_CACHE_LIMIT) {
        sampleCache.delete(sampleCache.keys().next().value);
      }
      return { list: sampled, layout: nextLayout };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function commitSample(sample) {
    if (!sample) return false;
    layout = sample.layout;
    buildGeo(sample.list);
    stage?.classList.add('has-full-particles');
    return true;
  }

  function applyPendingSample() {
    if (!pendingSample || pendingSample.gen !== sampleGen) return false;
    const sample = pendingSample.sample;
    pendingSample = null;
    return commitSample(sample);
  }

  /* ── Render loop ───────────────────────────────────────────────── */
  function loop(now) {
    if (destroyed) return;
    frameId = requestAnimationFrame(loop);

    const dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;

    syncCamera();
    if (!camera) return;

    const { bass, energy } = readAudio();
    uTime.value     += dt;
    uBass.value      = bass;
    uEnergy.value    = energy;
    uPlayhead.value  = particlePlayhead(
      activeMeasure,
      activeMeasureProgress,
      layout.length,
      progress,
    );

    const elapsed = now - modeStartedAt;
    if (mode === 'idle') {
      uScatterT.value = 0;
    } else if (mode === 'playback') {
      uScatterT.value = ease(elapsed / 280);
    } else if (mode === 'paused') {
      uScatterT.value = 1;
    } else if (mode === 'settling') {
      uScatterT.value = 1 - ease(elapsed / 700);
      if (elapsed >= 700) {
        mode = 'idle';
        modeStartedAt = now;
        uScatterT.value = 0;
        stage?.classList.remove('is-particle-playing', 'is-particle-paused', 'is-particle-settling');
        stage?.style.setProperty('--sheet-music-progress', '0%');
        setLabel('Sheet music breathing');
        applyPendingSample();
      }
    }

    renderer.render(scene, camera);
  }

  function ensureLoop() { if (!destroyed && !frameId) frameId = requestAnimationFrame(loop); }
  function setLabel(v)  { if (stateEl) stateEl.textContent = v; }

  /* ── Public API (identical surface to old Canvas 2D version) ───── */
  function setSheetMusic(svg, nextLayout) {
    sampleGen++;
    const gen = sampleGen;
    syncCamera();
    if (!svg || !nextLayout.length) {
      pendingSample = null;
      stage?.classList.remove('has-full-particles');
      buildFallback(nextLayout);
      ensureLoop();
      readyPromise = Promise.resolve(false);
      return readyPromise;
    }
    if (!stage?.classList.contains('has-full-particles')) buildFallback(nextLayout);
    ensureLoop();
    readyPromise = sampleSvg(svg, gen, nextLayout)
      .then((sample) => {
        if (gen !== sampleGen) return false;
        if (!sample) {
          if (!stage?.classList.contains('has-full-particles')) buildFallback(nextLayout);
          return false;
        }
        // Replacing a large GPU buffer in the middle of playback causes a
        // visible one-frame stall. Commit it only after playback is finished.
        if (mode === 'playback' || mode === 'paused' || mode === 'settling') {
          pendingSample = { gen, sample };
          return true;
        }
        return commitSample(sample);
      })
      .catch(() => {
        if (gen === sampleGen && !stage?.classList.contains('has-full-particles')) {
          buildFallback(nextLayout);
        }
        return false;
      });
    return readyPromise;
  }

  function ready() {
    return readyPromise;
  }

  function beginPlayback({ resume = false } = {}) {
    mode = 'playback';
    if (!resume) {
      progress = 0;
      activeMeasure = null;
      activeMeasureProgress = 0;
    }
    // A resumed score is already fully scattered. Preserve both its musical
    // coordinate and scatter amount instead of replaying the entrance ramp.
    modeStartedAt = performance.now() - (resume ? 280 : 0);
    stage?.classList.remove('is-particle-paused', 'is-particle-settling');
    stage?.classList.add('is-particle-playing');
    stage?.style.setProperty('--sheet-music-progress', '0%');
    setLabel('Notation dispersing');
    getAnalyser(); // eagerly start audio tap on first user gesture
    ensureLoop();
  }

  function setProgress(next, measureIndex = activeMeasure, measureProgress = next) {
    progress = clamp(next);
    activeMeasure = measureIndex;
    activeMeasureProgress = clamp(Number(measureProgress) || 0);
    stage?.style.setProperty('--sheet-music-progress', `${ (progress * 100).toFixed(2) }%`);
    if (measureIndex != null) setLabel(`Assembling measure ${ measureIndex + 1 }`);
  }

  function settle({ preserveProgress = false, immediate = false } = {}) {
    stage?.classList.remove('is-particle-playing', 'is-particle-paused', 'is-particle-settling');
    if (preserveProgress && (mode === 'playback' || mode === 'paused') && progress < 1) {
      mode = 'paused';
      modeStartedAt = performance.now();
      uScatterT.value = 1;
      stage?.classList.add('is-particle-paused');
      setLabel(`Paused at ${ Math.round(progress * 100) }%`);
      ensureLoop();
      return;
    }
    if (preserveProgress) immediate = true;
    progress = 1;
    activeMeasureProgress = 1;
    mode = immediate || rm ? 'idle' : 'settling';
    modeStartedAt = performance.now();
    uScatterT.value = mode === 'idle' ? 0 : uScatterT.value;
    stage?.classList.toggle('is-particle-settling', mode === 'settling');
    stage?.style.setProperty('--sheet-music-progress', '0%');
    setLabel(mode === 'idle' ? 'Sheet music breathing' : 'Recalling the sheet music');
    if (mode === 'idle') applyPendingSample();
    ensureLoop();
  }

  function handleMotionPreferenceChange(e) {
    rm = e.matches;
    uMotionStrength.value = rm ? 0 : 1;
    uPointerActive.value = rm ? 0 : uPointerActive.value;
    if (rm && mode === 'settling') {
      mode = 'idle';
      uScatterT.value = 0;
      stage?.classList.remove('is-particle-settling');
      setLabel('Sheet music breathing');
      applyPendingSample();
    }
  }

  let lastDislodgeX = null;
  let lastDislodgeY = null;
  let lastDislodgeStampAt = -Infinity;
  // Points at the slot that will be overwritten next. Always advancing this
  // by exactly one on every stamp — never "whichever slot looks weakest
  // right now" — guarantees a slot can't be picked again until every other
  // slot has had a turn first. A response-based "pick the weakest" approach
  // was tried and broke: a slot's response curve is 0 both before it rises
  // AND after it decays, so a slot written a moment ago (still rising) reads
  // as just as "weak" as one that's fully faded — new touches kept picking
  // (and immediately overwriting) the slot they'd *just* written instead of
  // an actually-finished one, which meant touching a new area never
  // accumulated enough impulses to become visible.
  let dislodgeWriteIndex = 0;

  function handlePointerMove(event) {
    if (rm) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) * cW / rect.width;
    const y = cH - (event.clientY - rect.top) * cH / rect.height;
    uPointer.value.set(x, y);
    uPointerActive.value = 1;

    let dx = 0, dy = 0, moved = 0;
    if (lastDislodgeX != null) {
      dx = x - lastDislodgeX;
      dy = y - lastDislodgeY;
      moved = Math.hypot(dx, dy);
      // Throttled by both distance AND time: distance alone doesn't cap a
      // fast sweep's stamp *rate*, which is what determines how much of the
      // trail's lifespan (TRAIL_SIZE slots) a burst of movement consumes.
      if (moved < DISLODGE_STAMP_PX || performance.now() - lastDislodgeStampAt < DISLODGE_STAMP_MS) return;
    }
    lastDislodgeX = x;
    lastDislodgeY = y;
    lastDislodgeStampAt = performance.now();

    const slot = dislodgeWriteIndex;
    dislodgeWriteIndex = (dislodgeWriteIndex + 1) % DISLODGE_TRAIL_SIZE;
    dislodgeDirs[slot].set(moved > 0 ? dx / moved : 0, moved > 0 ? dy / moved : 0);
    dislodgePositions[slot].set(x, y);
    dislodgeTimes[slot] = uTime.value;
  }

  function handlePointerLeave() {
    uPointerActive.value = 0;
    lastDislodgeX = null;
    lastDislodgeY = null;
  }

  /** Held down, this fast-forwards any particles currently drifting back. */
  function setFastReturn(active) {
    uReturnSpeed.value = active ? FAST_RETURN_SPEED : 1;
  }

  mq.addEventListener?.('change', handleMotionPreferenceChange);
  stage?.addEventListener('pointermove', handlePointerMove, { passive: true });
  stage?.addEventListener('pointerleave', handlePointerLeave, { passive: true });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    sampleGen++;
    pendingSample = null;
    sampleCache.clear();
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
    mq.removeEventListener?.('change', handleMotionPreferenceChange);
    stage?.removeEventListener('pointermove', handlePointerMove);
    stage?.removeEventListener('pointerleave', handlePointerLeave);
    stage?.classList.remove('has-full-particles', 'is-particle-playing', 'is-particle-paused', 'is-particle-settling');
    toneAnalyser?.dispose?.();
    toneAnalyser = null;
    if (pts) scene.remove(pts);
    if (bPts) scene.remove(bPts);
    geo?.dispose();
    mat.dispose();
    bloomMat.dispose();
    uDotTex.value?.dispose?.();
    renderer.dispose();
  }

  syncCamera();
  ensureLoop();

  return { setSheetMusic, ready, beginPlayback, setProgress, settle, setFastReturn, destroy };
}
