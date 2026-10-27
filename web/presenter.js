// The picture: wasi/screen.c's newest frame (RGB565, in shared memory) onto a
// canvas with WebGL2, at the page's pace (requestAnimationFrame), letterboxed
// to the game's aspect. WebGL2 because a frame only has to be uploaded and
// scaled, which every browser's WebGL2 does; RGB565 goes up as it is
// (UNSIGNED_SHORT_5_6_5), no conversion.
//
// How it is scaled (setScale(name, param); the page's menu, settings.js): the
// filters of the Steam release's two wrappers, each computed as its source
// computes it. Both draw the picture as it is (point) at the game's own size,
// and both have the bars beside it black.
// DDrawCompat's DisplayFilter (DDrawCompat/D3dDdi/ShaderBlitter.cpp and
// Shaders/*.hlsl, BSD 0): in linear light (sRGB decoded, filtered, encoded),
// one axis at a time (two passes, the first into an sRGB texture), with as
// many taps as the kernel needs where the picture shrinks:
//   bilinear  blur 0-100 (DDrawCompat's default, 0, is this page's): at 0
//             each game pixel a block with a pixel's blend at its edges
//             (sharp), at 100 the plain bilinear
//   point     nearest-neighbour (EA's own choice: the Steam copy's
//             DDrawCompat.ini says point(0))
//   integer   whole multiples only, nearest-neighbour (cnc-ddraw's boxing too)
//   bicubic   blur 0-100: Mitchell-Netravali, B = blur, C = (1 - B) / 2, so
//             0 is Catmull-Rom
//   lanczos   2-4 lobes
//   spline    2-4 lobes (spline16, 36, 64)
// cnc-ddraw's own shaders (src/render_ogl.c, inc/openglshader.h, MIT), in the
// picture's colours as they are:
//   cnc-bilinear  the texture's bilinear ("Bilinear")
//   catmull       Catmull-Rom in 5 bilinear taps (its default, and "Bicubic")
//   lanczos2      Hyllian's jinc2 lanczos2-sharp, anti-ringing ("Lanczos")
//   xbr           Hyllian's xBR-lv2 ("xBR-lv2")
//
// The frames header (wasi/screen.c, frames_t), 32-bit words: 0 seq, 1 which,
// 2 w, 3 h, 4..6 the buffers, 7 cap, 8 cursor shown, 9 its handle, 10/11 its hot
// spot; bytes 48 and 176 its 32x32 AND and XOR masks; words 76-79 the page's:
// its screen, logical (screen.width, height: in Chrome the system's points,
// whatever the page's zoom) and in pixels (full screen: the window times
// devicePixelRatio, exact at any zoom; else the screen times it, exact at a
// zoom of 100%). The game offers the modes of that screen (wasi/screen.c).
// The cursor: over the game's menus the page shows the one the game set, made
// from those masks; in a game the game draws its own and the page shows none.
// While the mouse is locked (fullscreen.js) the browser shows none at all, and
// softCursor([x, y]) draws that same cursor at a game pixel, over the canvas.
const VS = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;
// DDrawCompat's convolution (its Convolution.hlsli), one axis: the output
// pixel at s source pixels, the taps i from floor(s - 0.5) - (taps - 1) to
// floor(s - 0.5) + taps, each weighed by the kernel at (i + 0.5 - s) * kstep
// (kstep: the scale where it shrinks, else 1), the sum over the weights'.
// Rows top first in every texture (texelFetch's y), the canvas's flipped.
const CONV_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D src;
uniform ivec2 srcSize;
uniform vec2 origin, outSize;
uniform bool flipOut, decodeIn, encodeOut, vertical;
uniform int kind, taps;        // taps: on each side; kind: 0 point, 1 bilinear, 2 cubic (coef: x^3, x^2, x, 1 a lobe), 3 lanczos
uniform float scale, kstep, support, mul, add;
uniform vec4 coef[4];
out vec4 color;
vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 srgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float kernel(float x) {
  if (kind == 0) return x >= -0.5 && x < 0.5 ? 1.0 : 0.0;
  x = abs(x);
  if (kind == 1) return clamp(x * mul + add, 0.0, 1.0);
  x = min(x, support);
  if (kind == 3) { float p = 3.14159265358979 * x; return p == 0.0 ? 1.0 : support * sin(p) * sin(p / support) / (p * p); }
  vec4 k = coef[min(int(x), int(support) - 1)];
  return ((k.x * x + k.y) * x + k.z) * x + k.w;
}
void main() {
  vec2 o = gl_FragCoord.xy - origin;
  if (flipOut) o.y = outSize.y - o.y;
  float s = (vertical ? o.y : o.x) / scale;
  int other = int(vertical ? o.x : o.y), last = (vertical ? srcSize.y : srcSize.x) - 1;
  int first = int(floor(s - 0.5)) - (taps - 1);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 128; j++) {
    if (j >= 2 * taps) break;
    int i = first + j, ic = clamp(i, 0, last);
    float w = kernel((float(i) + 0.5 - s) * kstep);
    vec3 c = texelFetch(src, vertical ? ivec2(other, ic) : ivec2(ic, other), 0).rgb;
    sum += w * (decodeIn ? lin(c) : c);
    wsum += w;
  }
  vec3 r = wsum > 0.0 ? sum / wsum : sum;
  color = vec4(encodeOut ? srgb(r) : r, 1.0);
}`;
// cnc-ddraw's shaders, as in its inc/openglshader.h; uv is TEX0.
const CNC_HEAD = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 TextureSize;
in vec2 uv;
out vec4 color;
`;
const CNC_BILINEAR_FS = CNC_HEAD + `void main() { color = vec4(texture(tex, uv).rgb, 1.0); }`;
// The following code is licensed under the MIT license:
// https://gist.github.com/TheRealMJP/bc503b0b87b643d3505d41eab8b332ae
// Ported from code: https://gist.github.com/TheRealMJP/c83b8c0f46b63f3a88a5986f4fa982b1
// Samples a texture with Catmull-Rom filtering, using 9 texture fetches instead of 16.
// See http://vec3.ca/bicubic-filtering-in-fewer-taps/ for more details
// Modified to use 5 texture fetches
const CNC_CATMULL_FS = CNC_HEAD + `
void main() {
  vec4 SourceSize = vec4(TextureSize, 1.0 / TextureSize);
  vec2 samplePos = uv * SourceSize.xy;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / (w1 + w2);
  vec2 texPos0 = texPos1 - 1.;
  vec2 texPos3 = texPos1 + 2.;
  vec2 texPos12 = texPos1 + offset12;
  texPos0 *= SourceSize.zw;
  texPos3 *= SourceSize.zw;
  texPos12 *= SourceSize.zw;
  float wtm = w12.x * w0.y;
  float wml = w0.x * w12.y;
  float wmm = w12.x * w12.y;
  float wmr = w3.x * w12.y;
  float wbm = w12.x * w3.y;
  vec3 result = vec3(0.0);
  result += texture(tex, vec2(texPos12.x, texPos0.y)).rgb * wtm;
  result += texture(tex, vec2(texPos0.x, texPos12.y)).rgb * wml;
  result += texture(tex, vec2(texPos12.x, texPos12.y)).rgb * wmm;
  result += texture(tex, vec2(texPos3.x, texPos12.y)).rgb * wmr;
  result += texture(tex, vec2(texPos12.x, texPos3.y)).rgb * wbm;
  color = vec4(result * (1. / (wtm + wml + wmm + wmr + wbm)), 1.0);
}`;
// The following code is licensed under the MIT license:
// Hyllian's jinc windowed-jinc 2-lobe sharper with anti-ringing Shader
// Copyright (C) 2011-2016 Hyllian/Jararaca - sergiogdb@gmail.com
// https://github.com/libretro/glsl-shaders/blob/09e2942efbab2f51b60ff0b93b7761b0b0570910/windowed/shaders/lanczos2-sharp.glsl
const CNC_LANCZOS2_FS = CNC_HEAD + `
#define JINC2_WINDOW_SINC 0.5
#define JINC2_SINC 1.0
#define JINC2_AR_STRENGTH 0.8
const float pi = 3.1415926535897932384626433832795;
const float wa = JINC2_WINDOW_SINC*pi;
const float wb = JINC2_SINC*pi;
float d(vec2 pt1, vec2 pt2) { vec2 v = pt2 - pt1; return sqrt(dot(v,v)); }
vec3 min4(vec3 a, vec3 b, vec3 c, vec3 d) { return min(a, min(b, min(c, d))); }
vec3 max4(vec3 a, vec3 b, vec3 c, vec3 d) { return max(a, max(b, max(c, d))); }
vec4 resampler(vec4 x) {
  vec4 res;
  res.x = (x.x==0.0) ? wa*wb : sin(x.x*wa)*sin(x.x*wb)/(x.x*x.x);
  res.y = (x.y==0.0) ? wa*wb : sin(x.y*wa)*sin(x.y*wb)/(x.y*x.y);
  res.z = (x.z==0.0) ? wa*wb : sin(x.z*wa)*sin(x.z*wb)/(x.z*x.z);
  res.w = (x.w==0.0) ? wa*wb : sin(x.w*wa)*sin(x.w*wb)/(x.w*x.w);
  return res;
}
void main() {
  vec3 c;
  vec4 weights[4];
  vec2 dx = vec2(1.0, 0.0);
  vec2 dy = vec2(0.0, 1.0);
  vec2 pc = uv*TextureSize;
  vec2 tc = (floor(pc-vec2(0.5,0.5))+vec2(0.5,0.5));
  weights[0] = resampler(vec4(d(pc, tc    -dx    -dy), d(pc, tc           -dy), d(pc, tc    +dx    -dy), d(pc, tc+2.0*dx    -dy)));
  weights[1] = resampler(vec4(d(pc, tc    -dx       ), d(pc, tc              ), d(pc, tc    +dx       ), d(pc, tc+2.0*dx       )));
  weights[2] = resampler(vec4(d(pc, tc    -dx    +dy), d(pc, tc           +dy), d(pc, tc    +dx    +dy), d(pc, tc+2.0*dx    +dy)));
  weights[3] = resampler(vec4(d(pc, tc    -dx+2.0*dy), d(pc, tc       +2.0*dy), d(pc, tc    +dx+2.0*dy), d(pc, tc+2.0*dx+2.0*dy)));
  dx = dx/TextureSize;
  dy = dy/TextureSize;
  tc = tc/TextureSize;
  vec3 c00 = texture(tex, tc    -dx    -dy).xyz;
  vec3 c10 = texture(tex, tc           -dy).xyz;
  vec3 c20 = texture(tex, tc    +dx    -dy).xyz;
  vec3 c30 = texture(tex, tc+2.0*dx    -dy).xyz;
  vec3 c01 = texture(tex, tc    -dx       ).xyz;
  vec3 c11 = texture(tex, tc              ).xyz;
  vec3 c21 = texture(tex, tc    +dx       ).xyz;
  vec3 c31 = texture(tex, tc+2.0*dx       ).xyz;
  vec3 c02 = texture(tex, tc    -dx    +dy).xyz;
  vec3 c12 = texture(tex, tc           +dy).xyz;
  vec3 c22 = texture(tex, tc    +dx    +dy).xyz;
  vec3 c32 = texture(tex, tc+2.0*dx    +dy).xyz;
  vec3 c03 = texture(tex, tc    -dx+2.0*dy).xyz;
  vec3 c13 = texture(tex, tc       +2.0*dy).xyz;
  vec3 c23 = texture(tex, tc    +dx+2.0*dy).xyz;
  vec3 c33 = texture(tex, tc+2.0*dx+2.0*dy).xyz;
  vec3 min_sample = min4(c11, c21, c12, c22);
  vec3 max_sample = max4(c11, c21, c12, c22);
  c = vec3(dot(weights[0], vec4(c00.x, c10.x, c20.x, c30.x)), dot(weights[0], vec4(c00.y, c10.y, c20.y, c30.y)), dot(weights[0], vec4(c00.z, c10.z, c20.z, c30.z)));
  c+= vec3(dot(weights[1], vec4(c01.x, c11.x, c21.x, c31.x)), dot(weights[1], vec4(c01.y, c11.y, c21.y, c31.y)), dot(weights[1], vec4(c01.z, c11.z, c21.z, c31.z)));
  c+= vec3(dot(weights[2], vec4(c02.x, c12.x, c22.x, c32.x)), dot(weights[2], vec4(c02.y, c12.y, c22.y, c32.y)), dot(weights[2], vec4(c02.z, c12.z, c22.z, c32.z)));
  c+= vec3(dot(weights[3], vec4(c03.x, c13.x, c23.x, c33.x)), dot(weights[3], vec4(c03.y, c13.y, c23.y, c33.y)), dot(weights[3], vec4(c03.z, c13.z, c23.z, c33.z)));
  c = c/(dot(weights[0], vec4(1,1,1,1)) + dot(weights[1], vec4(1,1,1,1)) + dot(weights[2], vec4(1,1,1,1)) + dot(weights[3], vec4(1,1,1,1)));
  vec3 aux = c;
  c = clamp(c, min_sample, max_sample);
  c = mix(aux, c, JINC2_AR_STRENGTH);
  color = vec4(c, 1.0);
}`;
// The following code is licensed under the MIT license:
// Hyllian's xBR-lv2 Shader
// Copyright (C) 2011-2016 Hyllian - sergiogdb@gmail.com
// https://github.com/libretro/glsl-shaders/blob/09e2942efbab2f51b60ff0b93b7761b0b0570910/xbr/shaders/xbr-lv2.glsl
// (its vertex shader's t1..t7 computed here; small_details 0, CORNER_C, as cnc-ddraw has them)
const CNC_XBR_FS = CNC_HEAD + `
#define CORNER_C
#define SMOOTH_TIPS
#define XBR_SCALE 3.0
#define XBR_EQ_THRESHOLD 15.0
#define XBR_LV2_COEFFICIENT 2.0
#define lv2_cf XBR_LV2_COEFFICIENT
const vec3 rgbw = vec3(14.352, 28.176, 5.472);
const vec4 delta   = vec4(1.0/XBR_SCALE, 1.0/XBR_SCALE, 1.0/XBR_SCALE, 1.0/XBR_SCALE);
const vec4 delta_l = vec4(0.5/XBR_SCALE, 1.0/XBR_SCALE, 0.5/XBR_SCALE, 1.0/XBR_SCALE);
const vec4 delta_u = delta_l.yxwz;
const vec4 Ao = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 Bo = vec4( 1.0,  1.0, -1.0,-1.0 );
const vec4 Co = vec4( 1.5,  0.5, -0.5, 0.5 );
const vec4 Ax = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 Bx = vec4( 0.5,  2.0, -0.5,-2.0 );
const vec4 Cx = vec4( 1.0,  1.0, -0.5, 0.0 );
const vec4 Ay = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 By = vec4( 2.0,  0.5, -2.0,-0.5 );
const vec4 Cy = vec4( 2.0,  0.0, -1.0, 0.5 );
const vec4 Ci = vec4(0.25, 0.25, 0.25, 0.25);
vec4 df(vec4 A, vec4 B) { return vec4(abs(A-B)); }
vec4 diff(vec4 A, vec4 B) { return vec4(notEqual(A, B)); }
vec4 eq(vec4 A, vec4 B) { return (step(df(A, B), vec4(XBR_EQ_THRESHOLD))); }
vec4 neq(vec4 A, vec4 B) { return (vec4(1.0, 1.0, 1.0, 1.0) - eq(A, B)); }
vec4 wd(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, vec4 f, vec4 g, vec4 h) { return (df(a,b) + df(a,c) + df(d,e) + df(d,f) + 4.0*df(g,h)); }
float c_df(vec3 c1, vec3 c2) { vec3 df = abs(c1 - c2); return df.r + df.g + df.b; }
void main() {
  float dx = 1.0/TextureSize.x, dy = 1.0/TextureSize.y;
  vec2 texCoord = uv;
  vec4 t1 = uv.xxxy + vec4( -dx, 0, dx,-2.0*dy); // A1 B1 C1
  vec4 t2 = uv.xxxy + vec4( -dx, 0, dx,    -dy); //  A  B  C
  vec4 t3 = uv.xxxy + vec4( -dx, 0, dx,      0); //  D  E  F
  vec4 t4 = uv.xxxy + vec4( -dx, 0, dx,     dy); //  G  H  I
  vec4 t5 = uv.xxxy + vec4( -dx, 0, dx, 2.0*dy); // G5 H5 I5
  vec4 t6 = uv.xyyy + vec4(-2.0*dx,-dy, 0,  dy); // A0 D0 G0
  vec4 t7 = uv.xyyy + vec4( 2.0*dx,-dy, 0,  dy); // C4 F4 I4
  vec4 edri, edr, edr_l, edr_u, px;
  vec4 irlv0, irlv1, irlv2l, irlv2u;
  vec4 fx, fx_l, fx_u;
  vec2 fp = fract(texCoord*TextureSize);
  vec3 A1 = texture(tex, t1.xw ).xyz;
  vec3 B1 = texture(tex, t1.yw ).xyz;
  vec3 C1 = texture(tex, t1.zw ).xyz;
  vec3 A  = texture(tex, t2.xw ).xyz;
  vec3 B  = texture(tex, t2.yw ).xyz;
  vec3 C  = texture(tex, t2.zw ).xyz;
  vec3 D  = texture(tex, t3.xw ).xyz;
  vec3 E  = texture(tex, t3.yw ).xyz;
  vec3 F  = texture(tex, t3.zw ).xyz;
  vec3 G  = texture(tex, t4.xw ).xyz;
  vec3 H  = texture(tex, t4.yw ).xyz;
  vec3 I  = texture(tex, t4.zw ).xyz;
  vec3 G5 = texture(tex, t5.xw ).xyz;
  vec3 H5 = texture(tex, t5.yw ).xyz;
  vec3 I5 = texture(tex, t5.zw ).xyz;
  vec3 A0 = texture(tex, t6.xy ).xyz;
  vec3 D0 = texture(tex, t6.xz ).xyz;
  vec3 G0 = texture(tex, t6.xw ).xyz;
  vec3 C4 = texture(tex, t7.xy ).xyz;
  vec3 F4 = texture(tex, t7.xz ).xyz;
  vec3 I4 = texture(tex, t7.xw ).xyz;
  vec4 b = vec4(dot(B ,rgbw), dot(D ,rgbw), dot(H ,rgbw), dot(F ,rgbw));
  vec4 c = vec4(dot(C ,rgbw), dot(A ,rgbw), dot(G ,rgbw), dot(I ,rgbw));
  vec4 d = b.yzwx;
  vec4 e = vec4(dot(E,rgbw));
  vec4 f = b.wxyz;
  vec4 g = c.zwxy;
  vec4 h = b.zwxy;
  vec4 i = c.wxyz;
  vec4 i4 = vec4(dot(I4,rgbw), dot(C1,rgbw), dot(A0,rgbw), dot(G5,rgbw));
  vec4 i5 = vec4(dot(I5,rgbw), dot(C4,rgbw), dot(A1,rgbw), dot(G0,rgbw));
  vec4 h5 = vec4(dot(H5,rgbw), dot(F4,rgbw), dot(B1,rgbw), dot(D0,rgbw));
  vec4 f4 = vec4(0.0);           // never set in the original (cnc-ddraw's or libretro's): 0, as WebGL makes it
  fx   = (Ao*fp.y+Bo*fp.x);
  fx_l = (Ax*fp.y+Bx*fp.x);
  fx_u = (Ay*fp.y+By*fp.x);
  irlv1 = irlv0 = diff(e,f) * diff(e,h);
  irlv1 = (irlv0 * ( neq(f,b) * neq(f,c) + neq(h,d) * neq(h,g) + eq(e,i) * (neq(f,f4) * neq(f,i4) + neq(h,h5) * neq(h,i5)) + eq(e,g) + eq(e,c)) );
  irlv2l = diff(e,g) * diff(d,g);
  irlv2u = diff(e,c) * diff(b,c);
  vec4 fx45i = clamp((fx   + delta   -Co - Ci)/(2.0*delta  ), 0.0, 1.0);
  vec4 fx45  = clamp((fx   + delta   -Co     )/(2.0*delta  ), 0.0, 1.0);
  vec4 fx30  = clamp((fx_l + delta_l -Cx     )/(2.0*delta_l), 0.0, 1.0);
  vec4 fx60  = clamp((fx_u + delta_u -Cy     )/(2.0*delta_u), 0.0, 1.0);
  vec4 wd1 = wd( e, c,  g, i, h5, f4, h, f);
  vec4 wd2 = wd( h, d, i5, f, i4,  b, e, i);
  edri  = step(wd1, wd2) * irlv0;
  edr   = step(wd1 + vec4(0.1, 0.1, 0.1, 0.1), wd2) * step(vec4(0.5, 0.5, 0.5, 0.5), irlv1);
  edr_l = step( lv2_cf*df(f,g), df(h,c) ) * irlv2l * edr;
  edr_u = step( lv2_cf*df(h,c), df(f,g) ) * irlv2u * edr;
  fx45  = edr   * fx45;
  fx30  = edr_l * fx30;
  fx60  = edr_u * fx60;
  fx45i = edri  * fx45i;
  px = step(df(e,f), df(e,h));
  vec4 maximos = max(max(fx30, fx60), max(fx45, fx45i));
  vec3 res1 = E;
  res1 = mix(res1, mix(H, F, px.x), maximos.x);
  res1 = mix(res1, mix(B, D, px.z), maximos.z);
  vec3 res2 = E;
  res2 = mix(res2, mix(F, B, px.y), maximos.y);
  res2 = mix(res2, mix(D, H, px.w), maximos.w);
  vec3 res = mix(res1, res2, step(c_df(E, res1), c_df(E, res2)));
  color = vec4(res, 1.0);
}`;
// The menu's list: id, whose, and the parameter DDrawCompat's has (its getParamInfo)
export const SCALES = [
  { id: 'bilinear', from: 'DDrawCompat', param: { name: 'blur', min: 0, max: 100, step: 5, def: 0 } },
  { id: 'point', from: 'DDrawCompat' },
  { id: 'integer', from: 'DDrawCompat' },
  { id: 'bicubic', from: 'DDrawCompat', param: { name: 'blur', min: 0, max: 100, step: 5, def: 0 } },
  { id: 'lanczos', from: 'DDrawCompat', param: { name: 'lobes', min: 2, max: 4, step: 1, def: 2 } },
  { id: 'spline', from: 'DDrawCompat', param: { name: 'lobes', min: 2, max: 4, step: 1, def: 2 } },
  { id: 'cnc-bilinear', from: 'cnc-ddraw' },
  { id: 'catmull', from: 'cnc-ddraw' },
  { id: 'lanczos2', from: 'cnc-ddraw' },
  { id: 'xbr', from: 'cnc-ddraw' },
];
const scaleOf = (id) => SCALES.find((m) => m.id === id);
// DDrawCompat's spline weights (ShaderBlitter.cpp splineBlt): a lobe's a, b,
// c, d of t = x - n, as the x^3, x^2, x, 1 its shader takes (getSplineWeights)
const SPLINE = {
  2: [[1, -9 / 5, -1 / 5, 1], [-1 / 3, 4 / 5, -7 / 15, 0]],
  3: [[13 / 11, -453 / 209, -3 / 209, 1], [-6 / 11, 270 / 209, -156 / 209, 0], [1 / 11, -45 / 209, 26 / 209, 0]],
  4: [[49 / 41, -6387 / 2911, -3 / 2911, 1], [-24 / 41, 4032 / 2911, -2328 / 2911, 0],
      [6 / 41, -1008 / 2911, 582 / 2911, 0], [-1 / 41, 168 / 2911, -97 / 2911, 0]],
};
const splineCoef = (lobes) => SPLINE[lobes].flatMap(([a, b, c, d], n) =>
  [a, -3 * n * a + b, 3 * n * n * a - 2 * n * b + c, -n * n * n * a + n * n * b - n * c + d]);
const bicubicCoef = (blur) => {           // ShaderBlitter.cpp bicubicBlt
  const B = blur / 100, C = (1 - B) / 2;
  return [(12 - 9 * B - 6 * C) / 6, (-18 + 12 * B + 6 * C) / 6, 0, (6 - 2 * B) / 6,
          (-B - 6 * C) / 6, (6 * B + 30 * C) / 6, (-12 * B - 48 * C) / 6, (8 * B + 24 * C) / 6];
};

export function startPresenter(canvas, memory, ptr, { onFrame = () => {}, scale = 'bilinear', param } = {}) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('no WebGL2');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const program = (fs) => {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const uniforms = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { p, u: uniforms };
  };
  const conv = program(CONV_FS);
  const cnc = { 'cnc-bilinear': program(CNC_BILINEAR_FS), catmull: program(CNC_CATMULL_FS),
                lanczos2: program(CNC_LANCZOS2_FS), xbr: program(CNC_XBR_FS) };
  const linearTaps = { 'cnc-bilinear': true, catmull: true };   // cnc-ddraw's filter_bilinear: these sample bilinear
  const texture = (filter) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const tex = texture(gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  // DDrawCompat's first pass goes into an sRGB texture: linear values in, the
  // hardware encodes them, and the second pass reads them back linear
  const mid = texture(gl.NEAREST), fbo = gl.createFramebuffer();
  let midW = 0, midH = 0;
  let mode = scaleOf(scale) ? scale : 'bilinear', par = param ?? scaleOf(mode).param?.def;

  let hdr = null, bytes = null;
  const view = () => {             // a growing shared memory hands out a longer buffer: views again
    if (!hdr || hdr.buffer !== memory.buffer) { hdr = new Int32Array(memory.buffer, ptr, 80); bytes = new Uint8Array(memory.buffer); }
  };
  let lastSeq = -1, texW = 0, texH = 0, staging = new Uint16Array(0), cursorKey = '', soft = null, softKey = '';
  const urls = new Map();                         // cursor handle -> its image
  const softEl = document.createElement('div');
  softEl.style.cssText = 'position:absolute;width:32px;height:32px;pointer-events:none;display:none;z-index:3;image-rendering:pixelated';
  canvas.parentElement?.appendChild(softEl);
  const rect = { x: 0, y: 0, w: 0, h: 0 };        // where the picture is, in CSS pixels of the canvas
  let shown = 0, t0 = performance.now(), fps = 0;

  function cursorUrl() {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x2 = c.getContext('2d'), img = x2.createImageData(32, 32);
    for (let i = 0; i < 1024; i++) {
      const bit = 0x80 >> (i & 7), a = bytes[ptr + 48 + (i >> 3)] & bit, x = bytes[ptr + 176 + (i >> 3)] & bit;
      const o = i * 4;                // AND 1 XOR 0: clear; AND 0: black or white; AND 1 XOR 1 (invert): black
      if (a && !x) continue;
      const v = !a && x ? 255 : 0;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
    }
    x2.putImageData(img, 0, 0);
    return c.toDataURL();
  }
  const urlOf = (handle) => { let u = urls.get(handle); if (!u) urls.set(handle, u = cursorUrl()); return u; };
  function updateCursor() {
    const show = Atomics.load(hdr, 8), handle = Atomics.load(hdr, 9);
    const key = show ? `${handle}` : 'none';
    if (key !== cursorKey) {
      cursorKey = key;
      canvas.style.cursor = !show ? 'none' : handle ? `url(${urlOf(handle)}) ${hdr[10]} ${hdr[11]}, default` : 'default';
    }
    if (!soft || !show || !texW) { softEl.style.display = 'none'; return; }
    if (key !== softKey) { softKey = key; softEl.style.backgroundImage = handle ? `url(${urlOf(handle)})` : 'none'; }
    const r = canvas.getBoundingClientRect(), [cx, cy] = [rect.x + (soft[0] + 0.5) * rect.w / texW, rect.y + (soft[1] + 0.5) * rect.h / texH];
    softEl.style.left = `${r.left + cx - (handle ? hdr[10] : 0)}px`;
    softEl.style.top = `${r.top + cy - (handle ? hdr[11] : 0)}px`;
    softEl.style.display = handle ? 'block' : 'none';
  }

  // DDrawCompat: one axis, src (w x h) to the viewport set, at outW x outH
  function pass(src, w, h, vertical, outScale, origin, outW, outH, flip, decode, encode) {
    const { p, u } = conv, kstep = Math.min(outScale, 1);
    let kind = 0, support = 0.5, mul = 0, add = 0, coef = new Float32Array(16);
    if (mode === 'bilinear') {                 // ShaderBlitter.cpp bilinearBlt
      const blur = par / 100, higher = Math.max(outScale, 1 / outScale), adj = 1 / (blur + (1 - blur) / higher);
      kind = 1; mul = -adj; add = 0.5 * adj + 0.5; support = 0.5 + 0.5 / adj;
    } else if (mode === 'bicubic') { kind = 2; support = 2; coef.set(bicubicCoef(par)); }
    else if (mode === 'spline') { kind = 2; support = par; coef.set(splineCoef(par)); }
    else if (mode === 'lanczos') { kind = 3; support = par; }
    gl.useProgram(p);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform2i(u.srcSize, w, h);
    gl.uniform2f(u.origin, origin[0], origin[1]);
    gl.uniform2f(u.outSize, outW, outH);
    gl.uniform1i(u.flipOut, flip); gl.uniform1i(u.decodeIn, decode); gl.uniform1i(u.encodeOut, encode); gl.uniform1i(u.vertical, vertical);
    gl.uniform1i(u.kind, kind);
    gl.uniform1i(u.taps, Math.min(Math.ceil(support / kstep - 1e-6), 64));
    gl.uniform1f(u.scale, outScale); gl.uniform1f(u.kstep, kstep); gl.uniform1f(u.support, support);
    gl.uniform1f(u.mul, mul); gl.uniform1f(u.add, add);
    gl.uniform4fv(u.coef, coef);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // DDrawCompat's convolutionBlt: an axis that keeps its size is not filtered;
  // both scaled, the one that shrinks more (or grows less) first
  function convolve(vx, vy, vw, vh) {
    const sx = vw / texW, sy = vh / texH;
    if (vh === texH || vw === texW) {
      gl.viewport(vx, vy, vw, vh);
      return pass(tex, texW, texH, vh !== texH, vh === texH ? sx : sy, [vx, vy], vw, vh, true, true, true);
    }
    const hFirst = vw * texH <= texW * vh, iw = hFirst ? vw : texW, ih = hFirst ? texH : vh;
    if (iw !== midW || ih !== midH) {
      gl.bindTexture(gl.TEXTURE_2D, mid);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, iw, ih, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mid, 0);
      midW = iw; midH = ih;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, iw, ih);
    pass(tex, texW, texH, !hFirst, hFirst ? sx : sy, [0, 0], iw, ih, false, true, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(vx, vy, vw, vh);
    pass(mid, iw, ih, hFirst, hFirst ? sy : sx, [vx, vy], vw, vh, true, false, true);
  }
  function picture(vx, vy, vw, vh) {
    const same = vw === texW && vh === texH;        // both wrappers: the picture as it is
    if (!cnc[mode] || same) {
      if (same || mode === 'integer') { const m = mode; mode = 'point'; convolve(vx, vy, vw, vh); mode = m; return; }
      return convolve(vx, vy, vw, vh);
    }
    const { p, u } = cnc[mode], f = linearTaps[mode] ? gl.LINEAR : gl.NEAREST;
    gl.viewport(vx, vy, vw, vh);
    gl.useProgram(p);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.uniform2f(u.TextureSize, texW, texH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  function frame() {
    view();
    const seq = Atomics.load(hdr, 0);
    if (seq !== lastSeq && seq !== 0) {
      const which = Atomics.load(hdr, 1), w = hdr[2], h = hdr[3], addr = hdr[4 + which] >>> 0;
      if (w > 0 && h > 0 && addr) {
        if (staging.length < w * h) staging = new Uint16Array(w * h);
        const px = staging.subarray(0, w * h);
        px.set(new Uint16Array(memory.buffer, addr, w * h));
        if (Atomics.load(hdr, 0) - seq < 2) {      // not written over while it was copied
          gl.bindTexture(gl.TEXTURE_2D, tex);
          if (w !== texW || h !== texH) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB565, w, h, 0, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, px); texW = w; texH = h; }
          else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, px);
          lastSeq = seq; shown++;
          onFrame(w, h);
        }
      }
    }
    updateCursor();
    const dpr = window.devicePixelRatio || 1, cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    const full = !!document.fullscreenElement;
    Atomics.store(hdr, 76, screen.width); Atomics.store(hdr, 77, screen.height);
    Atomics.store(hdr, 78, Math.round((full ? innerWidth : screen.width) * dpr));
    Atomics.store(hdr, 79, Math.round((full ? innerHeight : screen.height) * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);      // the bars: black
    if (texW) {
      let vw, vh;
      const k = Math.floor(Math.min(cw / texW, ch / texH));
      if (mode === 'integer' && k >= 1) { vw = texW * k; vh = texH * k; }      // not even 1x fits: scaled to fit, as cnc-ddraw's boxing then
      else { const s = Math.min(cw / texW, ch / texH); vw = Math.round(texW * s); vh = Math.round(texH * s); }
      const vx = Math.round((cw - vw) / 2), vy = Math.round((ch - vh) / 2);
      picture(vx, vy, vw, vh);
      rect.x = vx / dpr; rect.y = vy / dpr; rect.w = vw / dpr; rect.h = vh / dpr;
    }
    const now = performance.now();
    if (now - t0 >= 1000) { fps = Math.round(shown * 1000 / (now - t0)); shown = 0; t0 = now; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    // a point of the canvas (CSS pixels, from its top left) at the game's pixels, clamped to the picture
    gameAt(cx, cy) {
      if (!texW || !rect.w) return null;
      const x = Math.floor((cx - rect.x) * texW / rect.w), y = Math.floor((cy - rect.y) * texH / rect.h);
      return [Math.max(0, Math.min(texW - 1, x)), Math.max(0, Math.min(texH - 1, y))];
    },
    // a battle: the game has the mouse captured and draws its own cursor (its
    // menus, loads and movies use the Windows cursor: wasi/main.c, word 8)
    battle: () => !!hdr && texW > 0 && Atomics.load(hdr, 8) === 0,
    // whether a point of the canvas (CSS pixels) is on the picture, not beside it
    inPicture: (cx, cy) => rect.w > 0 && cx >= rect.x && cy >= rect.y && cx < rect.x + rect.w && cy < rect.y + rect.h,
    // the other way: where a game pixel is on the canvas (the tests click there)
    canvasAt(gx, gy) { return texW ? [rect.x + (gx + 0.5) * rect.w / texW, rect.y + (gy + 0.5) * rect.h / texH] : null; },
    size: () => [texW, texH],
    // game pixels to a CSS pixel of the picture (the locked mouse's moves are in CSS pixels)
    scale: () => (rect.w ? [texW / rect.w, texH / rect.h] : [1, 1]),
    // the page's own cursor at a game pixel while the mouse is locked ([x, y]), or none (null)
    softCursor(p) { soft = p; },
    fps: () => fps,
    // a filter (SCALES' id) and its parameter (blur or lobes; its default if none or out of range)
    setScale(id, param) {
      const m = scaleOf(id);
      if (!m) return;
      mode = id;
      par = m.param && param >= m.param.min && param <= m.param.max ? +param : m.param?.def;
    },
    scaleName: () => mode,
    scaleParam: () => par,
    // the newest frame at the game's own size, as a PNG (a Blob), or null before the first
    async screenshot() {
      if (!texW) return null;
      const c = document.createElement('canvas'); c.width = texW; c.height = texH;
      const x2 = c.getContext('2d'), img = x2.createImageData(texW, texH), d = img.data;
      for (let i = 0; i < texW * texH; i++) {
        const v = staging[i], o = i * 4;
        d[o] = ((v >> 11) & 31) * 255 / 31; d[o + 1] = ((v >> 5) & 63) * 255 / 63; d[o + 2] = (v & 31) * 255 / 31; d[o + 3] = 255;
      }
      x2.putImageData(img, 0, 0);
      return new Promise((res) => c.toBlob(res, 'image/png'));
    },
  };
}
