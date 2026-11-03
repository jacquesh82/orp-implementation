# OptiRelay examples

Pages built only on the public packages (`@optirelay/core`, `@optirelay/optical`, `@optirelay/browser`). The two *Hello world* use the workspace sources; the *Studio* uses the versions published on npm, like any application would. Each one is a single
page: open it on **two devices**, choose *Send* on one and *Receive* on the other, and point the receiving camera
at the sending screen.

| Example | What it shows |
|---|---|
| [`hello-world/`](hello-world/) | The smallest complete transfer: `SenderSession` → `TmDisplay` on one side, `TmReader` → `ReceiverSession` on the other. Pairing by a **public** demo passphrase, so nothing has to be typed — encrypted, but not secret. |
| [`secure-hello-world/`](secure-hello-world/) | The capture **needs a code** to start the transfer: the sender shows a random 12-character code as text (never in the animated image); the receiver decodes nothing until it is typed. The code is stretched by PBKDF2 (ORP v0.2, §7.2) into the AES-256-GCM keys; a verification code (SAS) is compared before receiving. |
| [`studio/`](studio/) | **OptiRelay Studio**, the interactive demo served at `/studio/` on the showcase. Built on the **published npm packages** (`@optirelay/*@^0.2.0` from the registry, not the workspace): an optical lab with a simulated channel and a spy that decrypts nothing, a real transfer between two devices, and the anatomy of a grid, a frame and the fountain code. See its [README](studio/README.md). |

## Run

```sh
pnpm install
pnpm --filter @optirelay/example-hello-world dev          # or @optirelay/example-secure-hello-world
pnpm --filter @optirelay/example-studio dev:lan            # Studio: HTTPS on the local network
```

Vite serves the page over HTTPS with a local certificate (`--host`: reachable from the other device on the same
network — accept the certificate warning once). The camera and WebCrypto require that secure context.

## Flow (secure version)

```
sender                                   receiver
──────                                   ────────
code = random 12 chars (shown as text)
SenderSession({ pairing: "passphrase" })
prepare(message) → receivePassphrase(code)
loop: init code, data frame, …  ──light──▶  init code read: scanInitCode()
                                           user types the code → pairWithPassphrase(code)
SAS shown                                  SAS shown — compared by the user → confirmSas()
                                           data frames: receiveFrame() … result() (SHA-256 checked)
```

Without the code, the receiver's session rejects every data frame before decoding it; with a wrong code, the SAS
differ and the frames fail authentication (`falsifiee`) — the page asks for the code again.
