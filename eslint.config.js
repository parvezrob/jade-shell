// ESLint for the GNOME Shell extension (GJS, ES modules).
import js from '@eslint/js';

export default [
    js.configs.recommended,
    {
        files: ['extension/**/*.js', 'tests/shell/**/*.js', 'packaging/jade-shell-settings'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                global: 'readonly', imports: 'readonly', log: 'readonly', logError: 'readonly', print: 'readonly', printerr: 'readonly',
                console: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
            'no-empty': ['error', {allowEmptyCatch: true}],
            'prefer-const': 'error',
            'eqeqeq': ['error', 'always'],
            'curly': ['error', 'multi-or-nest', 'consistent'],
        },
    },
];
