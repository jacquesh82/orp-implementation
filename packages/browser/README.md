# @optirelay/browser

Browser adapters of [OptiRelay](https://orp.mindlog.today/) — device-to-device transfer through a screen and a camera, no network: `getUserMedia` camera with white balance / exposure locks, `TmDisplay` (animated frames on a canvas), `TmReader` (decoding in a Worker), video reading, calibration, file helpers.

```sh
npm install @optirelay/browser @optirelay/core
```

```ts
import { CODEC, CryptoWebCrypto, SenderSession } from "@optirelay/core";
import { TmDisplay, pairingFrame } from "@optirelay/browser";

const session = new SenderSession(new CryptoWebCrypto(), { pairing: "passphrase", codecs: [CODEC.COLOR_4] });
await session.prepare(new TextEncoder().encode("Hello world"));
await session.receivePassphrase(code); // a code shown to the user, typed on the receiver
session.confirmSas();
const display = new TmDisplay(canvas, { moduleSize: 10 });
const init = pairingFrame(session.initCode());
await session.start(async (frame) => {
  await display.show(init, CODEC.COLOR_4, 1);
  await display.show(frame, CODEC.COLOR_4, 2);
});
```

The receiving side: `openCamera({ rearFacing: true })`, a `TmReader` on the `<video>`, and a `ReceiverSession` fed with the frames it decodes.

## Examples

Three apps ship in `examples/`:

- **`studio/` — OptiRelay Studio**, the reference example of an application on the npm packages: real transfer between two devices (`src/live.ts` — start there), the whole protocol through a simulated optical channel (`src/lab.ts`), the anatomy of a grid, a frame and the fountain code (`src/anatomy.ts`). Live at [orp.mindlog.today/studio/](https://orp.mindlog.today/studio/); its README maps each file to the APIs it shows;
- **`hello-world/`** — the smallest transfer, paired by a public demo passphrase;
- **`secure-hello-world/`** — the capture needs a code typed on the receiver to start the transfer (PBKDF2-stretched, SAS compared).

```sh
cp -r node_modules/@optirelay/browser/examples optirelay-examples
cd optirelay-examples/studio && npm install && npm run dev:lan   # or hello-world, secure-hello-world: npm run dev
```

Open the page on two devices (HTTPS, same network). The camera and WebCrypto require a secure context.

Requires a bundler that follows `new Worker(new URL(…, import.meta.url))` (Vite, webpack 5, Rollup with a worker plugin).

License: Apache-2.0.
