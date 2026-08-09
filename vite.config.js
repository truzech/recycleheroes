import { defineConfig } from 'vite';

// No JSX in the source (App.js/index.js use React.createElement directly),
// so no bundler plugin/transform is needed. No router, no extra config.
export default defineConfig({});
