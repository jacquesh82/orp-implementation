# OptiRelay Studio — example application on the npm packages

A complete application built **only** on the published packages
[`@optirelay/core`](https://www.npmjs.com/package/@optirelay/core),
[`@optirelay/optical`](https://www.npmjs.com/package/@optirelay/optical) and
[`@optirelay/browser`](https://www.npmjs.com/package/@optirelay/browser) (ORP v0.2): moving bytes from one device to
another **through a screen and a camera**, no network. Read it as the reference for implementing the library in your
own app — every call it makes is a public API, nothing comes from the monorepo.

Live: [orp.mindlog.today/studio/](https://orp.mindlog.today/studio/) · source: this directory, also shipped in the
npm package (`node_modules/@optirelay/browser/examples/studio`).

```sh
npm install
npm run dev        # http://localhost:5173 — one device is enough for the Lab and the Anatomy
npm run dev:lan    # HTTPS on the local network: for a real transfer to a phone
npm run build      # tsc + vite build → dist/
npm run test:sim   # Node scripts: full pipeline through the simulated channel, ECDH pairing, spy
```

## Where to look

| File | Shows how to… | Main APIs |
|---|---|---|
| [`src/live.ts`](src/live.ts) | **Do a real transfer between two devices** — start here. The sender draws a random 12-character code, shows it as text and loops the frames on a canvas; the receiver films, asks for the code, compares the verification code (SAS), rebuilds and previews the file. | `SenderSession`, `ReceiverSession`, `TmDisplay`, `TmReader`, `openCamera`, `pairingFrame`, `pairingPayload`, `pack` / `unpack`, `TransferTracker`, `moduleDiagnostic`, `saveFile`, `createPreview` |
| [`src/lab.ts`](src/lab.ts) | Run the whole protocol on one device: sender → **simulated optical channel** (loss, rolling shutter, blur, noise, rotation, perspective, white balance, crosstalk…) → receiver, pairing by typed code (PBKDF2) or by crossed codes (ECDH P-256, commit / reveal). A **spy** films the same screen and decrypts nothing. | `renderTmPair`, `degradeImage`, `TmReceiver`, `SenderSession`, `ReceiverSession`, `pairingCodeKind` |
| [`src/anatomy.ts`](src/anatomy.ts) | Explain the format: the 41×41 grid and its roles, MONO_2 / COLOR_4 / COLOR_8, the TM reference / payload subframes, an encrypted frame byte by byte, the LT fountain code (peeling vs the ORP decoder). | `structuralGrid`, `writeBytesToGrid`, `roleOf`, `frameSize`, `ltNeighbors`, `FountainDecoder` |
| [`src/ui.ts`](src/ui.ts) | The pairing code helpers: `randomCode` (uniform, unambiguous alphabet, ≈ 59 bits), `shownCode` ("K7QF-M2XP-9CHR"), `normalizedCode` (what the user typed → passphrase). | — |
| [`scripts/`](scripts/) | The same flows in Node, without a browser. | — |

## The pattern, in short

```ts
// Sender — the code is shown as TEXT, never inside the animated image.
const code = randomCode();
const session = new SenderSession(new CryptoWebCrypto(), { pairing: "passphrase", codecs: [CODEC.COLOR_4] });
await session.prepare(pack(file));
await session.receivePassphrase(code);          // PBKDF2 (600 000 iterations) → AES-256-GCM keys
showText(shownCode(code), session.sas());       // the SAS is compared on both screens
session.confirmSas();
const display = new TmDisplay(canvas, { moduleSize: "auto" });
const init = pairingFrame(session.initCode());
await session.start(async (frame) => {          // no return channel: loop until stopped
  await display.show(init, CODEC.COLOR_4, 1);
  await display.show(frame, CODEC.COLOR_4, 2);
});

// Receiver
const stream = await openCamera({ rearFacing: true });
const receiver = new ReceiverSession(new CryptoWebCrypto());
const reader = new TmReader(video, { stream, onFrame: async (bytes) => {
  if (isPairingFrame(bytes)) {
    const init = pairingPayload(bytes, INIT_CODE_SIZE);
    if (init && pairingCodeKind(init) === "init" && receiver.state === "initial") receiver.scanInitCode(init);
    return;                                      // then: ask for the code → pairWithPassphrase → compare SAS → confirmSas
  }
  if (receiver.state !== "calibre" && receiver.state !== "transmission") return; // nothing decrypted before the code
  await receiver.receiveFrame(bytes);
  if (receiver.done) save(unpack((await receiver.result()).data)); // SHA-256 checked
}});
reader.start();
```

The full version, with errors, progress, a wrong code typed again and the clean-up of the camera and the loops, is in
[`src/live.ts`](src/live.ts).

## Interoperability

The OptiRelay Android apps receive what the Studio sends: the user types the code shown by the Studio (dashes, spaces
and lower case are accepted). The Android app also embeds the Studio itself.

## Notes

- `@optirelay/browser` is excluded from Vite's pre-bundling (`optimizeDeps.exclude`) so that its Worker URL
  `new URL("./reader-worker.js", import.meta.url)` resolves.
- The camera and WebCrypto require a secure context: `localhost` is fine, a phone needs `dev:lan` (accept the local
  certificate once).
- Languages: English by default, French available (EN/FR switch, `?lang=fr`). `src/i18n/en.ts` is the reference
  dictionary; `fr.ts` is typed `Messages`, so a missing or extra key fails `tsc`. The framing advice and the module
  size diagnostic come from `@optirelay/*`, which only speaks English.
- Served by the OptiRelay showcase (`/studio/`), the page shows the showcase menu on top (`src/site-nav.css`); elsewhere
  it stands alone.
- `scripts/presets-check.mjs` measures the decoding rate per preset: under "Hell", TM4 still decodes almost every pair
  and TM8 almost none — the reason for the TM4 fallback.
