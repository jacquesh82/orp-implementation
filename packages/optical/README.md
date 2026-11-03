# @optirelay/optical

Optical codecs of [OptiRelay](https://orp.mindlog.today/) (ORP v0.2): `MONO_2`, `COLOR_4`, `COLOR_8` grids, finder location and homography, CIELAB colour calibration, and the TM4 / TM8 differential temporal modulation used to read frames reliably through a phone camera. No DOM: images are plain RGBA buffers.

```sh
npm install @optirelay/optical
```

Most applications do not use it directly: [`@optirelay/browser`](https://www.npmjs.com/package/@optirelay/browser) displays (`TmDisplay`) and reads (`TmReader`) the frames produced by [`@optirelay/core`](https://www.npmjs.com/package/@optirelay/core). Use this package for custom pipelines (native capture, video files, simulation — see `simulateCapture`). [OptiRelay Studio](https://orp.mindlog.today/studio/) (source in `@optirelay/browser`, `examples/studio/src/lab.ts`) drives a simulated optical channel with `renderTmPair`, `degradeImage` and `TmReceiver`.

License: Apache-2.0.
