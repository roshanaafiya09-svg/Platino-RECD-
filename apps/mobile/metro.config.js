// Metro (the JavaScript bundler) configuration.
//
// This project is an npm workspace: most packages are installed in the repository's top-level node_modules, but the
// installed copy of "expo" there carries its own NESTED, newer react-native (0.86). Without this file, anything that
// imports "react-native" from inside expo would get that second copy instead of this app's react-native (0.74.5),
// and the release bundle fails to build. Every "react-native" import is therefore resolved from this app's folder.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const appEntry = path.join(__dirname, "index.js");

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react-native" || moduleName.startsWith("react-native/")) {
    return context.resolveRequest({ ...context, originModulePath: appEntry }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
