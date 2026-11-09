/**
 * electron-builder's afterSign hook (electron-builder.yml): notarizes and staples the signed Mac app
 * before the dmg and zip are made from it (scripts/notarize-dmg.mjs). electron-builder calls it only
 * after it signed the app.
 */
import { join } from "node:path";
import { notarizeApp } from "./notarize-dmg.mjs";

/** @param {{ electronPlatformName: string, appOutDir: string, packager: { appInfo: { productFilename: string } } }} context */
export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  await notarizeApp(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}
