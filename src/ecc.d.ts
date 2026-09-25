// tiny-secp256k1 ships without TypeScript declarations. This ambient module
// declaration keeps strict-mode compilation working without adding an extra
// @types package. The value is passed straight to bitcoin.initEccLib().
declare module "tiny-secp256k1";
