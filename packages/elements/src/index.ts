/**
 * @optirelay/elements — ORP Web Components. Importing this package registers
 * the elements: usable without a framework, styles isolated by Shadow DOM,
 * customization through CSS Custom Properties, slots and parts.
 *
 * The DOM API of the elements — event names (`orp:received`,
 * `orp:progress`…), event detail keys, slot and part names — is a public
 * contract: see the header of each element.
 */

export { OptirelaySend } from "./optirelay-send.ts";
export { OptirelayReceive } from "./optirelay-receive.ts";
export { OptirelayTransferDialog } from "./optirelay-transfer-dialog.ts";
