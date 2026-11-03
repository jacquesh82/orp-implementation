/**
 * OptiRelay — Secure Hello world.
 *
 * The capture needs a CODE to start the transfer. The sender draws a random
 * code (12 characters, ≈ 59 bits) and shows it as TEXT, next to the animated
 * image — never inside it. The pairing passphrase path of ORP v0.2 turns this
 * code into the session keys:
 *
 *   key = PBKDF2-HMAC-SHA-256(code, session_id, 600 000 iterations) → HKDF
 *
 * so someone who films the whole transfer gets encrypted frames (AES-256-GCM)
 * and would have to try ~2⁵⁹ codes, each costing 600 000 HMACs.
 *
 * Without the code the receiver decodes the images but decrypts nothing: its
 * session only accepts data frames once `pairWithPassphrase` has run. A wrong
 * code gives another verification code (SAS) than the sender's, and frames
 * rejected as "falsifiee" — the user can then type it again.
 */
import "../../shared/style.css";
import { CODEC, CryptoWebCrypto, INIT_CODE_SIZE, ReceiverSession, SenderSession, pairingCodeKind } from "@optirelay/core";
import { TmDisplay, TmReader, closeCamera, isPairingFrame, openCamera, pairingFrame, pairingPayload } from "@optirelay/browser";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Unambiguous alphabet: no 0/O, 1/I/L. 31 symbols → 12 characters ≈ 59 bits. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

/** Random code, uniform (rejection sampling on bytes). */
function randomCode(): string {
  let code = "";
  const limit = 256 - (256 % ALPHABET.length);
  while (code.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && code.length < CODE_LENGTH) code += ALPHABET[b % ALPHABET.length];
    }
  }
  return code;
}

/** "K7QF-M2XP-9CHR" for the eyes; the passphrase itself has no dashes, case-insensitive. */
const shown = (code: string) => code.match(/.{1,4}/g)!.join("-");
const normalized = (typed: string) => typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
const sasText = (sas: string) => `${sas.slice(0, 3)} ${sas.slice(3)}`;

// ── Sending ───────────────────────────────────────────────────────────────

async function send(): Promise<void> {
  showRole("sender");
  const code = randomCode();
  // Encryption "required" is the default; "passphrase": the init code tells
  // the receiver to ask for the code instead of answering with its own.
  const session = new SenderSession(new CryptoWebCrypto(), { pairing: "passphrase", codecs: [CODEC.COLOR_4] });
  await session.prepare(new TextEncoder().encode($<HTMLInputElement>("text").value || "Hello world"));
  await session.receivePassphrase(code);
  $("secret").textContent = shown(code);
  $("sender-sas").textContent = sasText(session.sas());
  session.confirmSas();

  const display = new TmDisplay($<HTMLCanvasElement>("code"), { moduleSize: 10 });
  const init = pairingFrame(session.initCode());
  $("stop").onclick = () => {
    session.finish();
    display.stop();
    session.dispose(); // best-effort wipe of the keys
    showRole("choice");
  };
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

  const cryptoProvider = new CryptoWebCrypto();
  let session = new ReceiverSession(cryptoProvider);
  let initCode: Uint8Array | null = null;
  let forged = 0;
  let queue = Promise.resolve();
  const reader = new TmReader(video, {
    stream,
    onFrame: (bytes) => {
      queue = queue.then(() => frameRead(bytes)).catch((e) => console.warn("[secure-hello-world]", e));
    },
  });

  /** A fresh session on the same init code: one session pairs only once. */
  function newSession(): void {
    session.dispose();
    session = new ReceiverSession(cryptoProvider);
    session.scanInitCode(initCode!);
    forged = 0;
    session.events.on("rejection", ({ reason }) => {
      if (reason === "falsifiee" && ++forged === 3) askCode("Frames cannot be decrypted: wrong code? Type it again.");
    });
  }

  function askCode(message: string): void {
    $("reading").textContent = message;
    $("compare").hidden = true;
    $("code-form").hidden = false;
    $<HTMLInputElement>("code-input").value = "";
    $("code-input").focus();
  }

  $<HTMLFormElement>("code-form").onsubmit = (e) => {
    e.preventDefault();
    const typed = normalized($<HTMLInputElement>("code-input").value);
    if (typed.length !== CODE_LENGTH) return askCode(`The code has ${CODE_LENGTH} characters.`);
    $("code-form").hidden = true;
    $("reading").textContent = "Deriving the key…"; // PBKDF2: a fraction of a second, on purpose
    queue = queue.then(async () => {
      if (session.state !== "appairage") newSession();
      await session.pairWithPassphrase(typed);
      $("receiver-sas").textContent = sasText(session.sas());
      $("reading").textContent = "Compare the verification codes.";
      $("compare").hidden = false;
      $("match").focus();
    });
  };
  $("match").onclick = () => {
    session.confirmSas(); // only now are data frames accepted
    $("compare").hidden = true;
    $("reading").textContent = "Receiving…";
  };
  $("mismatch").onclick = () => askCode("Different codes: type the code shown on the sender again.");

  async function frameRead(bytes: Uint8Array): Promise<void> {
    if (isPairingFrame(bytes)) {
      const code = pairingPayload(bytes, INIT_CODE_SIZE);
      if (initCode || !code || pairingCodeKind(code) !== "init") return;
      try {
        const info = session.scanInitCode(code); // refuses a sender that does not encrypt
        if (!info.byPassphrase) throw new Error("this sender pairs by codes, not by a typed code");
      } catch (e) {
        $("reading").textContent = `Sender refused: ${(e as Error).message}`;
        $("reading").classList.add("bad");
        reader.close();
        closeCamera(stream);
        return;
      }
      initCode = code;
      newSession();
      askCode("Sender found. Type the code shown on its screen to start the transfer.");
      return;
    }
    // Before the code is typed and the SAS confirmed, data frames are only
    // pixels: nothing is decrypted. The sender loops, they will come back.
    if (session.state !== "calibre" && session.state !== "transmission") return;
    await session.receiveFrame(bytes);
    if (!session.done) return;
    const { data } = await session.result(); // SHA-256 checked against the init code
    reader.close();
    closeCamera(stream);
    session.dispose();
    $("reading").textContent = "Received and verified:";
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
