const BUILD_VERSION = typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "dev";
const BUILD_GIT_HASH = typeof __BUILD_GIT_HASH__ !== "undefined" ? __BUILD_GIT_HASH__ : "nogit";
const BUILD_TIME = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "1970-01-01T00:00:00.000Z";
const BUILD_TAG = typeof __BUILD_TAG__ !== "undefined" ? __BUILD_TAG__ : `${BUILD_VERSION}+${BUILD_GIT_HASH}@${BUILD_TIME}`;

export const BUILD_INFO = {
  version: BUILD_VERSION,
  gitHash: BUILD_GIT_HASH,
  buildTime: BUILD_TIME,
  tag: BUILD_TAG,
} as const;
