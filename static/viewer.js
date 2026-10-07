/* A small WebGL2 renderer for the avatars' Gaussians, with orbit controls.

   Each avatar file holds, per Gaussian, its world position, its 3D covariance (the six upper
   entries, as the rasterizer's cov3D_precomp) and an RGBA colour, 40 bytes in all. Gaussians are
   sorted front to back on every view change and drawn as screen-space ellipses (3 sigma quads)
   with front-to-back alpha blending, as the 3D Gaussian splatting rasterizer composites them. */
(() => {
  "use strict";
  const STRIDE = 40;
  const WIDTH = 1024; // data texture width in texels

  const VERTEX = `#version 300 es
  precision highp float; precision highp int;
  uniform highp sampler2D uCenter; uniform highp sampler2D uCovA; uniform highp sampler2D uCovB;
  uniform highp sampler2D uColor;
  uniform mat4 uView; uniform mat4 uProj; uniform vec2 uFocal; uniform vec2 uViewport;
  in vec2 aCorner; in uint aIndex;
  out vec4 vColor; out vec2 vPos;
  ivec2 texel(uint i) { return ivec2(int(i) % ${WIDTH}, int(i) / ${WIDTH}); }
  void main() {
    ivec2 t = texel(aIndex);
    vec4 c = texelFetch(uCenter, t, 0);
    vec4 cam = uView * vec4(c.xyz, 1.0);
    if (cam.z > -0.05) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    vec4 clip = uProj * cam;
    vec4 a = texelFetch(uCovA, t, 0), b = texelFetch(uCovB, t, 0);
    mat3 sigma = mat3(a.x, a.y, a.z,  a.y, a.w, b.x,  a.z, b.x, b.y);
    float z = -cam.z;
    mat3 J = mat3(uFocal.x / z, 0.0, 0.0,
                  0.0, uFocal.y / z, 0.0,
                  uFocal.x * cam.x / (z * z), uFocal.y * cam.y / (z * z), 0.0);
    mat3 W = mat3(uView);
    mat3 T = J * W;
    mat3 cov = T * sigma * transpose(T);
    float p = cov[0][0] + 0.3, q = cov[0][1], r = cov[1][1] + 0.3;
    float mid = 0.5 * (p + r), rad = length(vec2(0.5 * (p - r), q));
    float l1 = mid + rad, l2 = mid - rad;
    if (l2 <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    vec2 axis = abs(q) > 1e-12 ? normalize(vec2(q, l1 - p)) : (p >= r ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
    vec2 major = 3.0 * min(sqrt(l1), 512.0) * axis;
    vec2 minor = 3.0 * min(sqrt(l2), 512.0) * vec2(axis.y, -axis.x);
    vec2 ndc = clip.xy / clip.w;
    vPos = 3.0 * aCorner;
    vColor = texelFetch(uColor, t, 0);
    gl_Position = vec4(ndc + (aCorner.x * major + aCorner.y * minor) * 2.0 / uViewport, 0.0, 1.0);
  }`;

  const FRAGMENT = `#version 300 es
  precision highp float;
  in vec4 vColor; in vec2 vPos; out vec4 outColor;
  void main() {
    float d = dot(vPos, vPos);
    if (d > 9.0) discard;
    float alpha = min(0.99, vColor.a * exp(-0.5 * d));
    if (alpha < 1.0 / 255.0) discard;
    outColor = vec4(vColor.rgb * alpha, alpha);
  }`;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function texture(gl, unit, internal, format, type, data, rows) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, WIDTH, rows, 0, format, type, data);
    return tex;
  }

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a) => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };

  class GaussianViewer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
      if (!gl) throw new Error("WebGL2 is not available");
      this.gl = gl;
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      this.program = program;
      const uniforms = new Map();
      this.uniform = (name) => {
        if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
        return uniforms.get(name);
      };
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const corners = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
      const aCorner = gl.getAttribLocation(program, "aCorner");
      gl.enableVertexAttribArray(aCorner);
      gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
      this.indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
      const aIndex = gl.getAttribLocation(program, "aIndex");
      gl.enableVertexAttribArray(aIndex);
      gl.vertexAttribIPointer(aIndex, 1, gl.UNSIGNED_INT, 0, 0);
      gl.vertexAttribDivisor(aIndex, 1);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
      gl.uniform1i(this.uniform("uCenter"), 0);
      gl.uniform1i(this.uniform("uCovA"), 1);
      gl.uniform1i(this.uniform("uCovB"), 2);
      gl.uniform1i(this.uniform("uColor"), 3);
      this.count = 0;
      this.active = false;
      this.pendingFrame = null;
      this.quality = 1;
      this.slow = 0;
      this.dirty = true;
      this.controls();
      this.resizeObserver = new ResizeObserver(() => this.invalidate());
      this.resizeObserver.observe(canvas);
    }

    // Input bursts share one frame. A stationary or hidden stage schedules no callbacks.
    invalidate() {
      this.dirty = true;
      if (!this.active || this.pendingFrame !== null) return;
      this.pendingFrame = requestAnimationFrame((time) => {
        this.pendingFrame = null;
        this.tick(time);
      });
    }

    setActive(active) {
      if (this.active === active) return;
      this.active = active;
      if (active) this.invalidate();
      else if (this.pendingFrame !== null) {
        cancelAnimationFrame(this.pendingFrame);
        this.pendingFrame = null;
      }
    }

    /* Load an avatar: `buffer` holds count x 40 bytes; `camera` gives eye, target, up and fovy.
       `keepView` keeps the current turn and zoom, for stepping through one clip's moments. */
    load(buffer, camera, keepView = false) {
      if (!buffer.byteLength || buffer.byteLength % STRIDE) throw new Error("Invalid Gaussian file length");
      if (![camera.eye, camera.target, camera.up].every((v) => v?.length === 3 && v.every(Number.isFinite)) ||
          !Number.isFinite(camera.fovy) || camera.fovy <= 0 || camera.fovy >= Math.PI) throw new Error("Invalid avatar camera");
      const kept = keepView && this.count ? { azimuth: this.azimuth, elevation: this.elevation, distance: this.distance } : null;
      const gl = this.gl;
      const n = buffer.byteLength / STRIDE;
      const rows = Math.ceil(n / WIDTH);
      const view = new DataView(buffer);
      const center = new Float32Array(WIDTH * rows * 4), covA = new Float32Array(WIDTH * rows * 4);
      const covB = new Float32Array(WIDTH * rows * 4), color = new Uint8Array(WIDTH * rows * 4);
      this.positions = new Float32Array(n * 3);
      this.base = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        for (let k = 0; k < 3; k++) center[4 * i + k] = this.positions[3 * i + k] = view.getFloat32(o + 4 * k, true);
        for (let k = 0; k < 4; k++) covA[4 * i + k] = view.getFloat32(o + 12 + 4 * k, true);
        for (let k = 0; k < 2; k++) covB[4 * i + k] = view.getFloat32(o + 28 + 4 * k, true);
        for (let k = 0; k < 4; k++) color[4 * i + k] = this.base[4 * i + k] = view.getUint8(o + 36 + k);
      }
      for (const tex of this.textures || []) gl.deleteTexture(tex);
      this.textures = [
        texture(gl, 0, gl.RGBA32F, gl.RGBA, gl.FLOAT, center, rows),
        texture(gl, 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, covA, rows),
        texture(gl, 2, gl.RGBA32F, gl.RGBA, gl.FLOAT, covB, rows),
        texture(gl, 3, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, color, rows),
      ];
      this.rows = rows;
      this.colorUpload = color;
      this.count = n;
      this.order = new Uint32Array(n);
      this.depths = new Float32Array(n);
      this.keys = new Uint32Array(n);           // sort buffers, allocated once per avatar
      this.counts = new Uint32Array(65536);
      this.sortedDir = null;
      this.camera = camera;
      this.reset();
      if (kept) Object.assign(this, kept);
    }

    goHome() {
      Object.assign(this, this.home);
      this.invalidate();
    }

    /* Replace the displayed colours (count x 4 bytes, RGBA). */
    setColors(rgba) {
      if (rgba.length !== this.count * 4) throw new Error("Selection does not match the loaded avatar");
      const gl = this.gl;
      this.colorUpload.set(rgba);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[3]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WIDTH, this.rows, gl.RGBA, gl.UNSIGNED_BYTE, this.colorUpload);
      this.invalidate();
    }

    reset() {
      const { eye, target, up } = this.camera;
      const offset = sub(eye, target);
      this.up = unit(up);
      // Azimuth and elevation of the eye around the up axis, measured in a frame fixed at load.
      this.east = unit(cross(this.up, offset));
      if (!isFinite(this.east[0])) this.east = unit(cross(this.up, [1, 0, 0]));
      this.north = cross(this.east, this.up);
      const flat = [dot(offset, this.north), dot(offset, this.east)];
      this.azimuth = Math.atan2(flat[1], flat[0]);
      this.elevation = Math.atan2(dot(offset, this.up), Math.hypot(...flat));
      this.distance = Math.hypot(...offset);
      this.home = { azimuth: this.azimuth, elevation: this.elevation, distance: this.distance };
      this.quality = 1;
      this.slow = 0;
      this.lastTick = null;
      this.invalidate();
    }

    eye() {
      const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
      const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
      const t = this.camera.target, d = this.distance;
      return [0, 1, 2].map((k) => t[k] + d * (ce * (ca * this.north[k] + sa * this.east[k]) + se * this.up[k]));
    }

    matrices() {
      const eye = this.eye(), target = this.camera.target;
      const f = unit(sub(target, eye)), s = unit(cross(f, this.up)), u = cross(s, f);
      const view = new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0,
        -dot(s, eye), -dot(u, eye), dot(f, eye), 1]);
      const w = this.canvas.width, h = this.canvas.height;
      const fy = h / (2 * Math.tan(this.camera.fovy / 2)), fx = fy;
      const near = 0.05, far = 100;
      const proj = new Float32Array([2 * fx / w, 0, 0, 0, 0, 2 * fy / h, 0, 0, 0, 0, -(far + near) / (far - near), -1,
        0, 0, -2 * far * near / (far - near), 0]);
      return { view, proj, fx, fy };
    }

    sort(view) {
      // Front to back: ascending distance along the viewing direction (-z in view space). The order
      // barely changes over a small turn, so it is kept until the direction moves by about 1.5 degrees.
      const dir = [view[2], view[6], view[10]], last = this.sortedDir;
      if (last && dir[0] * last[0] + dir[1] * last[1] + dir[2] * last[2] > 0.99966) return;
      this.sortedDir = dir;
      const p = this.positions, n = this.count, depth = this.depths;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const z = -(view[2] * p[3 * i] + view[6] * p[3 * i + 1] + view[10] * p[3 * i + 2] + view[14]);
        depth[i] = z;
        if (z < lo) lo = z;
        if (z > hi) hi = z;
      }
      const buckets = 65536, counts = this.counts.fill(0), keys = this.keys;
      const scale = (buckets - 1) / Math.max(hi - lo, 1e-6);
      for (let i = 0; i < n; i++) { keys[i] = ((depth[i] - lo) * scale) | 0; counts[keys[i]]++; }
      for (let i = 1; i < buckets; i++) counts[i] += counts[i - 1];
      for (let i = n - 1; i >= 0; i--) this.order[--counts[keys[i]]] = i;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.order, gl.DYNAMIC_DRAW);
    }

    tick(time) {
      if (!this.count || !this.active) return;
      // Adapt only during a continuous drag; idle time must never count as a slow frame.
      const elapsed = time - this.lastTick;
      if (this.dragging && this.lastTick !== null && elapsed > 40 && elapsed < 1000 && ++this.slow >= 3) {
        this.quality = Math.max(0.45, this.quality * 0.8);
        this.slow = 0;
      }
      this.lastTick = time;
      const canvas = this.canvas;
      const pixels = canvas.clientWidth * canvas.clientHeight;
      if (!pixels) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.25, Math.sqrt(700000 / pixels)) * this.quality;
      const w = Math.round(canvas.clientWidth * ratio), h = Math.round(canvas.clientHeight * ratio);
      if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; this.dirty = true; }
      if (!this.dirty) return;
      this.dirty = false;
      const gl = this.gl, { view, proj, fx, fy } = this.matrices();
      this.sort(view);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniformMatrix4fv(this.uniform("uView"), false, view);
      gl.uniformMatrix4fv(this.uniform("uProj"), false, proj);
      gl.uniform2f(this.uniform("uFocal"), fx, fy);
      gl.uniform2f(this.uniform("uViewport"), canvas.width, canvas.height);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.count);
    }

    controls() {
      const canvas = this.canvas, pointers = new Map();
      let pinch = 0;
      const touch = () => {
        canvas.dispatchEvent(new Event("viewerinteraction"));
        this.invalidate();
      };
      canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        this.dragging = true;
        this.quality = 0.7;
        this.lastTick = null;
        this.slow = 0;
        touch();
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!pointers.has(e.pointerId)) return;
        const [x0, y0] = pointers.get(e.pointerId);
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        if (pointers.size === 1) {
          this.azimuth -= (e.clientX - x0) * 0.008;
          this.elevation = Math.max(-1.3, Math.min(1.3, this.elevation + (e.clientY - y0) * 0.006));
        } else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const span = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (pinch) this.zoom(pinch / span);
          pinch = span;
        }
        touch();
      });
      const release = (e) => {
        pointers.delete(e.pointerId);
        pinch = 0;
        this.dragging = pointers.size > 0;
        if (!this.dragging) this.quality = 1;
        touch();
      };
      canvas.addEventListener("pointerup", release);
      canvas.addEventListener("pointercancel", release);
      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.quality = 0.7;
        this.zoom(Math.exp(e.deltaY * 0.001));
        touch();
        clearTimeout(this.zoomTimer);
        this.zoomTimer = setTimeout(() => { this.quality = 1; this.invalidate(); }, 140);
      }, { passive: false });
      canvas.addEventListener("dblclick", () => this.goHome());
      // Keyboard: arrows turn, + and - zoom, Home resets.
      canvas.addEventListener("keydown", (e) => {
        const turn = { ArrowLeft: [-0.12, 0], ArrowRight: [0.12, 0], ArrowUp: [0, 0.08], ArrowDown: [0, -0.08] }[e.key];
        if (turn) {
          this.azimuth += turn[0];
          this.elevation = Math.max(-1.3, Math.min(1.3, this.elevation + turn[1]));
        } else if (e.key === "+" || e.key === "=") this.zoom(0.9);
        else if (e.key === "-") this.zoom(1.1);
        else if (e.key === "Home") { this.goHome(); e.preventDefault(); return; }
        else return;
        e.preventDefault();
        touch();
      });
    }

    zoom(factor) {
      this.distance = Math.max(this.home.distance * 0.35, Math.min(this.home.distance * 2.5, this.distance * factor));
      this.invalidate();
    }
  }

  window.GaussianViewer = GaussianViewer;
})();
