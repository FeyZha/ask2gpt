import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".smoke/**",
      "**/*.config.*",
      "**/*.mjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message: "Ask2GPT must never execute commands.",
            },
            {
              name: "child_process",
              message: "Ask2GPT must never execute commands.",
            },
            {
              name: "node:fs",
              message: "Only ConversationStore may write extension-private files.",
            },
            {
              name: "node:fs/promises",
              message: "Only ConversationStore may write extension-private files.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='createTerminal']",
          message: "Ask2GPT must never create a terminal.",
        },
        {
          selector: "CallExpression[callee.property.name='writeFile']",
          message: "Workspace writes are forbidden outside ConversationStore.",
        },
      ],
    },
  },
  {
    files: [
      "apps/vscode-extension/src/services/conversation-store.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message: "Ask2GPT must never execute commands.",
            },
            {
              name: "child_process",
              message: "Ask2GPT must never execute commands.",
            },
          ],
        },
      ],
      "no-restricted-syntax": "off",
    },
  },
  {
    files: ["scripts/webview-preview/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
