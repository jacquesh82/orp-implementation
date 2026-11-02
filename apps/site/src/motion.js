(() => {
  'use strict';

  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const toggle = document.querySelector('.motion-toggle');
  const fields = [...document.querySelectorAll('[data-wave-field]')];
  const ornaments = [...document.querySelectorAll('.optical-link')];
  if (!toggle || !fields.length) return;
  const renderers = new Map();
  const visible = new Set();
  let wantsMotion = !preference.matches;
  let frameId = 0;
  let previousTime = 0;
  let lastPaint = 0;
  let elapsed = 0;

  const vertexSource = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;
  const fragmentSource = `
    precision highp float;
    uniform vec2 resolution;
    uniform float density;
    uniform float time;
    uniform float reverse;
    uniform float gap;
    void main() {
      vec2 p = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y) / density;
      vec2 uv = vec2(gl_FragCoord.x / resolution.x, 1.0 - gl_FragCoord.y / resolution.y);
      float displacement = 19.0 * sin(p.y / 143.0 + p.x / 157.0 + time * 0.22)
        + 12.0 * sin(p.y / 247.0 - p.x / 211.0 - time * 0.15)
        + 10.0 * sin(p.y / 81.0 + p.x / 340.0 + time * 0.1);
      float distanceToLine = abs(fract((p.x + displacement) / gap) - 0.5) * gap;
      float line = 1.0 - smoothstep(0.45, 0.95 + 0.4 / density, distanceToLine);
      vec3 color = mix(vec3(0.004), vec3(0.682, 0.651, 0.714), line);
      float gradient = mix(uv.y, 1.0 - uv.y, reverse);
      float blueAmount = pow(smoothstep(0.0, 1.0, gradient), 1.25);
      color = mix(color, vec3(0.0353, 0.2627, 0.6275), blueAmount);
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  function createField(element) {
    const canvas = document.createElement('canvas');
    canvas.className = 'wave-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    let gl;
    let program;
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      if (!gl) return createFallback(element);
      function shader(type, source) {
        const compiled = gl.createShader(type);
        gl.shaderSource(compiled, source);
        gl.compileShader(compiled);
        if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) {
          gl.deleteShader(compiled);
          throw new Error('Shader unavailable');
        }
        return compiled;
      }
      const vertex = shader(gl.VERTEX_SHADER, vertexSource);
      const fragment = shader(gl.FRAGMENT_SHADER, fragmentSource);
      program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program unavailable');
    } catch {
      if (program) gl.deleteProgram(program);
      return createFallback(element);
    }

    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = Object.fromEntries(['resolution', 'density', 'time', 'reverse', 'gap'].map(name => [name, gl.getUniformLocation(program, name)]));
    let width = 0;
    let height = 0;
    let density = 1;
    let lost = false;
    const renderer = {
      canvas,
      resize(nextWidth, nextHeight) {
        width = nextWidth;
        height = nextHeight;
        density = Math.min(window.devicePixelRatio || 1, 1.5);
        canvas.width = Math.max(1, Math.round(width * density));
        canvas.height = Math.max(1, Math.round(height * density));
        gl.viewport(0, 0, canvas.width, canvas.height);
        renderer.draw(elapsed);
      },
      draw(seconds) {
        if (lost || !width || !height) return;
        gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
        gl.uniform1f(uniforms.density, density);
        gl.uniform1f(uniforms.time, seconds);
        gl.uniform1f(uniforms.reverse, element.hasAttribute('data-wave-reverse') ? 1 : 0);
        gl.uniform1f(uniforms.gap, width < 500 ? 13 : 9);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      animate() {},
      dispose() {
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
      },
    };
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      lost = true;
      element.classList.remove('wave-ready');
      renderers.set(element, createFallback(element));
      canvas.remove();
      updateMotion();
    }, { once: true });
    element.append(canvas);
    element.classList.add('wave-ready');
    return renderer;
  }

  function createFallback(element) {
    const layer = document.createElement('div');
    layer.className = 'wave-fallback';
    element.append(layer);
    element.classList.add('wave-ready');
    const animation = layer.animate([
      { transform: 'translateX(-8px) scaleX(1.025)' },
      { transform: 'translateX(8px) scaleX(1.055)' },
    ], { duration: 14000, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
    animation.pause();
    return { resize() {}, animate(active) { active ? animation.play() : animation.pause(); }, dispose() { animation.cancel(); } };
  }

  function paint(timestamp) {
    frameId = 0;
    if (!wantsMotion || document.hidden) return;
    const active = fields.filter(field => visible.has(field) && renderers.get(field)?.draw);
    if (!active.length) return;
    if (!previousTime) previousTime = timestamp;
    elapsed += Math.min(timestamp - previousTime, 80) / 1000;
    previousTime = timestamp;
    if (timestamp - lastPaint >= 1000 / 30) {
      active.forEach(field => renderers.get(field).draw(elapsed));
      lastPaint = timestamp;
    }
    frameId = requestAnimationFrame(paint);
  }

  function updateMotion() {
    const running = wantsMotion && !document.hidden;
    fields.forEach(field => renderers.get(field)?.animate(running && visible.has(field)));
    ornaments.forEach(ornament => ornament.classList.toggle('motion-active', running && visible.has(ornament)));
    fields.forEach(field => field.dataset.motionState = running && visible.has(field) ? 'running' : 'paused');
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
    previousTime = 0;
    if (running && fields.some(field => visible.has(field) && renderers.get(field)?.draw)) frameId = requestAnimationFrame(paint);
    toggle.hidden = false;
    toggle.setAttribute('aria-pressed', String(!wantsMotion));
    toggle.setAttribute('aria-label', wantsMotion ? 'Pause animations' : 'Play animations');
    toggle.querySelector('.motion-label').textContent = wantsMotion ? 'Pause' : 'Play';
    toggle.querySelector('.motion-icon').textContent = wantsMotion ? 'Ⅱ' : '▷';
  }

  fields.forEach(field => renderers.set(field, createField(field)));
  const resize = new ResizeObserver(entries => {
    for (const entry of entries) renderers.get(entry.target)?.resize(entry.contentRect.width, entry.contentRect.height);
  });
  fields.forEach(field => resize.observe(field));
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target));
    updateMotion();
  }, { threshold: 0.01 });
  [...fields, ...ornaments].forEach(element => observer.observe(element));
  toggle.addEventListener('click', () => { wantsMotion = !wantsMotion; updateMotion(); });
  preference.addEventListener('change', () => { wantsMotion = !preference.matches; updateMotion(); });
  document.addEventListener('visibilitychange', updateMotion);
  window.addEventListener('pagehide', () => {
    cancelAnimationFrame(frameId);
    previousTime = 0;
    ornaments.forEach(ornament => ornament.classList.remove('motion-active'));
    fields.forEach(field => renderers.get(field)?.animate(false));
  });
  window.addEventListener('pageshow', updateMotion);
  updateMotion();
})();
