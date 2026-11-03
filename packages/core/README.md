# @optirelay/core

ORP (Optical Relay Protocol) — the protocol layer of [OptiRelay](https://orp.mindlog.today/): device-to-device transfer through a screen and a camera, no network.

Messages and frames, session state machine, authenticated pairing, AES-256-GCM encryption, block segmentation, fountain code and Reed-Solomon. No DOM, no platform dependency: the crypto is injected (`CryptoWebCrypto` works in every modern browser and in Node ≥ 20).

Wire format: **ORP v0.2** ([specification](https://github.com/jacquesh82/orp-specs)) — commit/reveal pairing with a 6-digit SAS, keys bound to the pairing transcript, PBKDF2-stretched passphrase.

```sh
npm install @optirelay/core
```

```ts
import { CryptoWebCrypto, SenderSession, ReceiverSession } from "@optirelay/core";

const crypto = new CryptoWebCrypto();
const sender = new SenderSession(crypto, { pairing: "passphrase" });
await sender.prepare(new TextEncoder().encode("Hello world"));
await sender.receivePassphrase("correct horse battery");

const receiver = new ReceiverSession(crypto);
receiver.scanInitCode(sender.initCode()); // read optically in a real transfer
await receiver.pairWithPassphrase("correct horse battery");
console.log(sender.sas() === receiver.sas()); // the users compare these 6 digits
sender.confirmSas();
receiver.confirmSas();

await sender.start(async (frame) => {
  await receiver.receiveFrame(frame); // displayed, then captured by a camera
  if (receiver.done) sender.finish();
});
console.log(new TextDecoder().decode((await receiver.result()).data)); // "Hello world", SHA-256 checked
```

Strong pairing (both devices have a camera): `initCode()` → `responseCode()` → `receiveResponseCode()` → `revealCode()` → `receiveRevealCode()`.

The optical encoding lives in [`@optirelay/optical`](https://www.npmjs.com/package/@optirelay/optical), the browser camera and screen in [`@optirelay/browser`](https://www.npmjs.com/package/@optirelay/browser).

**Example application: [OptiRelay Studio](https://orp.mindlog.today/studio/)** — a complete app on the three npm packages (real two-device transfer, simulated optical channel, anatomy of a frame). Its source ships in `@optirelay/browser` (`examples/studio`), with a README mapping each file to the APIs it uses.

License: Apache-2.0.
