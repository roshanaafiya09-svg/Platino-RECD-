import { registerRootComponent } from "expo";
import App from "./App";

// Registers the app with Expo / React Native. This is the entry point named by "main" in package.json;
// it replaces "node_modules/expo/AppEntry.js", which only resolves when expo is installed inside this folder
// (in this monorepo it is installed one level up, so the Android release build could not find it).
registerRootComponent(App);
