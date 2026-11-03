/**
 * OptiRelay — Hello world.
 *
 * The smallest complete transfer: a SenderSession turns the message into ORP
 * frames, a TmDisplay shows them on the screen; on the other device a
 * TmReader decodes the camera images and a ReceiverSession rebuilds the
 * message, checked by its SHA-256.
 *
 * Pairing uses the passphrase path with a PUBLIC demo passphrase, so nothing
 * has to be typed: the frames are encrypted, but anyone who films the screen
 * and knows this example can read them. For a real secret, see
 * examples/secure-hello-world (a code shown on the sender must be typed on
 * the receiver).
 */
import "../../shared/style.css";
import { CODEC, CryptoWebCrypto, INIT_CODE_SIZE, ReceiverSession, SenderSession, pairingCodeKind } from "@optirelay/core";
import { TmDisplay, TmReader, closeCamera, isPairingFrame, openCamera, pairingFrame, pairingPayload } from "@optirelay/browser";

const MESSAGE = "Hello world";
/** Public on purpose (see above): at least 8 characters, the same on both sides. */
const DEMO_PASSPHRASE = "optirelay-hello-world";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Sending ───────────────────────────────────────────────────────────────

async function send(): Promise<void> {
  showRole("sender");
  // TM4 (COLOR_4): the most robust mode, no calibration needed.
  const session = new SenderSession(new CryptoWebCrypto(), { pairing: "passphrase", codecs: [CODEC.COLOR_4] });
  await session.prepare(new TextEncoder().encode(MESSAGE));
  await session.receivePassphrase(DEMO_PASSPHRASE);
  session.confirmSas(); // nothing to compare with a public passphrase

  const display = new TmDisplay($<HTMLCanvasElement>("code"), { moduleSize: 10 });
  const init = pairingFrame(session.initCode());
  $("stop").onclick = () => {
    session.finish();
    display.stop();
    showRole("choice");
  };
  // No return channel: the sender loops (fountain code — every frame is a new
  // combination) until "Stop". The init code comes before each data frame, so
  // a receiver can start at any moment.
  await session.start(async (frame) => {
    await display.show(init, CODEC.COLOR_4, 1);
    await display.show(frame, CODEC.COLOR_4, 2);
  });
}

// ── Receiving ─────────────────────────────────────────────────────────────

async function receive(): Promise<void> {
  showRole("receiver");
  const stream = await openCamera({ rearFacing: true });
  const video = $<HTMLVideoElement>("camera");
  video.srcObject = stream;
  await video.play();

  const session = new ReceiverSession(new CryptoWebCrypto());
  let queue = Promise.resolve();
  const reader = new TmReader(video, {
    stream, // locks white balance and exposure once the code is stable
    onFrame: (bytes) => {
      queue = queue.then(() => frameRead(bytes)).catch((e) => console.warn("[hello-world]", e));
    },
  });

  async function frameRead(bytes: Uint8Array): Promise<void> {
    if (isPairingFrame(bytes)) {
      // The init code: session, size, SHA-256 of the message, pairing mode.
      const code = pairingPayload(bytes, INIT_CODE_SIZE);
      if (session.state !== "initial" || !code || pairingCodeKind(code) !== "init") return;
      session.scanInitCode(code);
      await session.pairWithPassphrase(DEMO_PASSPHRASE);
      session.confirmSas();
      $("reading").textContent = "Code read — receiving…";
      return;
    }
    if (session.state === "initial" || session.state === "appairage") return; // before the init code: more will come
    await session.receiveFrame(bytes);
    if (!session.done || session.state === "termine") return;
    const { data } = await session.result(); // throws if the SHA-256 does not match
    reader.close();
    closeCamera(stream);
    $("reading").textContent = "Received:";
    $("message").textContent = new TextDecoder().decode(data);
    $("message").hidden = false;
  }

  reader.start();
}

// ── Page ──────────────────────────────────────────────────────────────────

function showRole(role: "choice" | "sender" | "receiver"): void {
  for (const id of ["choice", "sender", "receiver"]) $(id).hidden = id !== role;
}

function fail(e: unknown): void {
  $("reading").textContent = `Error: ${(e as Error).message}`;
  $("reading").classList.add("bad");
  showRole("receiver");
}

$("send").onclick = () => void send().catch(fail);
$("receive").onclick = () => void receive().catch(fail);
