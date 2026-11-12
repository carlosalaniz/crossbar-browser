// SPDX-License-Identifier: AGPL-3.0-only
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", ".cache/", "**/test/pages/**", "**/fixtures/**", "**/dist/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Rule 10: nothing outside browser/ calls CDP.
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/browser/src/cdp*"], message: "Only browser/ talks CDP. Use the pool/controller interface." }] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  { files: ["browser/**"], rules: { "no-restricted-imports": "off" } },
);
