import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
};

export default defineConfig([
  {
    ignores: [
      ".bob/",
      "coverage/",
      "dist/",
      "node_modules/",
      "stage/",
      "test/fixtures/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      semi: "error",
      "prefer-const": "error",
    },
  },
  {
    files: ["bin/**/*.js", "eslint.config.js"],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ["assets/**/*.js"],
    languageOptions: {
      globals: {
        Deno: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        URLSearchParams: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        atob: "readonly",
        btoa: "readonly",
        globalThis: "readonly",
      },
    },
  },
]);
