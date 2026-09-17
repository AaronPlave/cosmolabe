import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { installMemoryProbe } from './lib/memory-probe';

// A no-op unless the page was loaded with `?mem=1`. Installed before the app
// mounts so its baseline sample is taken against an empty scene.
installMemoryProbe();

const app = mount(App, { target: document.getElementById('app')! });

export default app;
