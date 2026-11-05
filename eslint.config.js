import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.scratch/**', 'docs/**', '参考项目/**', '.agents/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['脚本/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    files: ['界面/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: { ...hooks.configs.recommended.rules },
  },
);
