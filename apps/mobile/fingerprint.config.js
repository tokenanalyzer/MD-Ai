// @expo/fingerprint config (read by `eas build` when computing the project
// fingerprint). Its own default for `concurrentIoLimit` is `os.cpus().length`
// (see node_modules/@expo/fingerprint/build/Options.js), with no floor. Many
// Android/Termux setups restrict /proc/cpuinfo, so `os.cpus()` returns an
// empty array there and the default becomes 0 — which p-limit (used
// internally to bound concurrent file hashing) rejects with "Expected
// `concurrency` to be a number from 1 and up", aborting fingerprint
// computation before the build can start. Clamp to a floor of 1 so
// fingerprinting works on every host, including ones where CPU count can't
// be read, without hardcoding a fixed worker count that would under-use
// normal machines.
const os = require("os");

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  concurrentIoLimit: Math.max(1, os.cpus().length || 1),
};
