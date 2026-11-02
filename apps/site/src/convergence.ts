/**
 * Animated "convergence" figure: threads of light leave from the whole screen
 * (on the left), narrow into the central opening — the filmed screen — then
 * leave braided towards the camera (on the right). Pulses run along the
 * threads from left to right: the frames going through.
 *
 * Same drawing as convergence.svg (static fallback, kept until the canvas is
 * ready), in the same 1200 × 540 frame. Honors the Pause/Play button of the
 * site (.motion-toggle, aria-pressed) and prefers-reduced-motion: when
 * stopped, a still image.
 */

const WIDTH = 1200;
const HEIGHT = 540;
const THREADS = 72;
const CENTER: [number, number] = [600, 270];
const COLORS: [string, number][] = [
  ["201, 196, 210", 0.85],
  ["23, 67, 129", 0.65],
  ["109, 134, 173", 0.65],
];
/** Threads carrying a pulse, and its speed (full run in s). */
const PULSES = 14;
const TRAVEL_DURATION = 5.5;

type Point = [number, number];

/** The two cubics of a thread at time t (1200 × 540 frame). */
function thread(i: number, t: number): [Point, Point, Point, Point, Point, Point, Point] {
  const u = i / (THREADS - 1);
  // Left: the fan barely breathes.
  const y0 = 20 + 7 * i + 3 * Math.sin(t * 0.5 + u * 5);
  const c1x = 200 + 18 * Math.sin(t * 0.3 + u * 3);
  // Right: braided beam, which waves and crosses itself.
  const braid = 70 * Math.sin(Math.PI * u + t * 0.45) * Math.cos(t * 0.21 + u * 2.4);
  const y1 = CENTER[1] + braid + 18 * Math.sin(t * 0.8 + u * 9);
  const y2 = 210 + 120 * u + 26 * Math.sin(t * 0.37 + u * 6.5) + 14 * Math.sin(t * 0.9 - u * 11);
  return [[-25, y0], [c1x, y0], [310, CENTER[1]], CENTER, [820, CENTER[1]], [920, y1], [1225, y2]];
}

/** Point of a thread at parameter s ∈ [0, 2] (first then second cubic). */
function pointOn(p: ReturnType<typeof thread>, s: number): Point {
  const [a, b, c, d] = s < 1 ? [p[0], p[1], p[2], p[3]] : [p[3], p[4], p[5], p[6]];
  const k = s < 1 ? s : s - 1;
  const m = 1 - k;
  return [
    m * m * m * a[0] + 3 * m * m * k * b[0] + 3 * m * k * k * c[0] + k * k * k * d[0],
    m * m * m * a[1] + 3 * m * m * k * b[1] + 3 * m * k * k * c[1] + k * k * k * d[1],
  ];
}

export function animateConvergence(element: HTMLElement): void {
  const canvas = document.createElement("canvas");
  canvas.className = "convergence-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("2d");
  if (!context) return; // the static SVG stays
  const c = context;
  element.append(canvas);
  element.classList.add("convergence-ready");

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const button = document.querySelector<HTMLElement>(".motion-toggle");
  const mobile = window.matchMedia("(max-width: 767px)");
  let width = 0;
  let height = 0;
  let visible = false;
  let clock = 0;
  let previous = 0;
  let image = 0;
  // Pulses: one thread and one phase offset each, spread over the beam.
  const pulses = Array.from({ length: PULSES }, (_, n) => ({
    thread: Math.round(((n * 37) % THREADS + (n * 0.5)) % THREADS),
    phase: n / PULSES,
  }));

  const moving = () =>
    visible && !document.hidden && !reduced.matches && button?.getAttribute("aria-pressed") !== "true";

  function draw(t: number): void {
    if (!width || !height) return;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    // SVG frame: full width, centered (desktop); stretched (mobile, rotated).
    const sx = width / WIDTH;
    const sy = mobile.matches ? height / HEIGHT : sx;
    const oy = (height - HEIGHT * sy) / 2;
    c.setTransform(density * sx, 0, 0, density * sy, 0, density * oy);
    c.clearRect(-50, -HEIGHT, WIDTH + 100, HEIGHT * 3);
    c.lineWidth = 0.9 / Math.min(sx, sy) * Math.min(1, sx * 1.4);
    c.globalCompositeOperation = "source-over";
    const threads = Array.from({ length: THREADS }, (_, i) => thread(i, t));
    threads.forEach((p, i) => {
      const [rgb, a] = COLORS[(i * 7 + (i >> 2)) % 3]!;
      c.strokeStyle = `rgba(${rgb}, ${a})`;
      c.beginPath();
      c.moveTo(...p[0]);
      c.bezierCurveTo(...p[1], ...p[2], ...p[3]);
      c.bezierCurveTo(...p[4], ...p[5], ...p[6]);
      c.stroke();
    });
    // Pulses: a trail that brightens as it moves, livelier when crossing the center.
    c.globalCompositeOperation = "lighter";
    c.lineCap = "round";
    for (const pulse of pulses) {
      const s = (((t / TRAVEL_DURATION + pulse.phase) % 1) + 1) % 1 * 2;
      const p = threads[pulse.thread]!;
      const glow = 0.35 + 0.65 * Math.exp(-((s - 1) ** 2) * 6);
      const step = 0.012;
      for (let k = 0; k < 10; k++) {
        const s0 = s - (k + 1) * step;
        if (s0 < 0) break;
        const [x0, y0] = pointOn(p, s0);
        const [x1, y1] = pointOn(p, s - k * step);
        c.strokeStyle = `rgba(159, 214, 255, ${(glow * (1 - k / 10)).toFixed(3)})`;
        c.lineWidth = (2.4 - k * 0.18) / Math.min(sx, sy) * Math.min(1, sx * 1.4);
        c.beginPath();
        c.moveTo(x0, y0);
        c.lineTo(x1, y1);
        c.stroke();
      }
    }
  }

  function tick(stamp: number): void {
    image = 0;
    if (!moving()) return;
    if (previous) clock += Math.min(stamp - previous, 80) / 1000;
    previous = stamp;
    draw(clock);
    image = requestAnimationFrame(tick);
  }

  function restart(): void {
    if (image) cancelAnimationFrame(image);
    image = 0;
    previous = 0;
    if (moving()) image = requestAnimationFrame(tick);
    else draw(clock); // still image, where the animation stopped
  }

  new ResizeObserver(([entry]) => {
    if (!entry) return;
    width = entry.contentRect.width;
    height = entry.contentRect.height;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * density));
    canvas.height = Math.max(1, Math.round(height * density));
    draw(clock);
  }).observe(element);
  new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    restart();
  }).observe(element);
  if (button) new MutationObserver(restart).observe(button, { attributes: true, attributeFilter: ["aria-pressed"] });
  reduced.addEventListener("change", restart);
  mobile.addEventListener("change", () => draw(clock));
  document.addEventListener("visibilitychange", restart);
}
