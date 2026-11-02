# OptiRelay website

The English marketing website and the ORP protocol guide share a Vite build, self-hosted fonts and the same visual system.

## Pages

- `/`: animated optical-transfer illustration, TM4/TM8 overview and access to the test bench, browser app and Android APK.
- `/protocol/`: English Web guide to temporal modulation, pairing, frame structure, error recovery and integrity. `/protocol` redirects to the trailing-slash URL.

The `/lab/` bundle is built separately and assembled alongside the website by the root Dockerfile. The APK and its metadata come from `public/download/` (written by `apps/android-lab/rebuild.sh`; the former `/telecharger/` route redirects there).

## Development and checks

From the repository root:

```bash
pnpm --filter @optirelay/site dev
pnpm --filter @optirelay/site typecheck
pnpm --filter @optirelay/site build
```

The development server previews the website and protocol guide. The root Dockerfile produces the complete site, including the lab and app routes.

## Rendering and motion

The optical test patterns are rendered by `@optirelay/optical` at runtime. Local SVGs provide initial images when JavaScript is unavailable. The illustration demonstrates the reference/payload sequence; it does not run a file transfer.

WebGL animates the waves, with a CSS transformation fallback when WebGL is unavailable. The Pause/Play control affects the waves, scan line, frame alternation, packets and reflections. Animation stops off screen or in a hidden tab and honours reduced-motion preferences.

Font licences are shipped under `/licenses/`. All assets and scripts are served from the same origin, including on the protocol page.
