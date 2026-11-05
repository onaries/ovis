/** The device's side of pairing with a typed code; it lives in shared/ so a PC that adds another through the relay runs it too. */
export { offerFromCode, TypedCodeError, type TypedCodeFailure, type TypedCodeOptions } from "../../../shared/relay-code-offer.ts";
