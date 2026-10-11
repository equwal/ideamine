// The UserPromptSubmit hook: ideahook's hook plus the verbs and background jobs that belong to the
// board: /ideas-watch, /ideas-web, the watcher, and the dashboard upload.

import { fileURLToPath } from 'node:url';
import * as ideahook from 'ideahook/hook';
import * as sync from 'ideahook/sync';
import * as publish from './publish.js';
import * as watch from './watch.js';

// Background syncs run through the ideamine CLI, which also sends the token use.
export const configureSync = () =>
  sync.configure({ usage: () => import('./usage.js'), bin: fileURLToPath(new URL('../bin/ideamine.js', import.meta.url)) });
configureSync();

const extraVerbs = {
  'ideas-watch': async (arg) => {
    if (!arg) watch.turnOn();
    else if (/^off$/i.test(arg)) watch.turnOff();
    else return null;
    return watch.status(); // runHook starts the first pass after this
  },
  'ideas-web': async (arg) => {
    // Loaded here, not at the top: the hook runs for each prompt.
    const serve = await import('./serve.js');
    if (!arg) return serve.ensureRunning();
    if (/^off$/i.test(arg)) return serve.stopRunning();
    return null;
  },
};

export const handlePrompt = (prompt, opts = {}) => ideahook.handlePrompt(prompt, { ...opts, extraVerbs });

export const runHook = () => ideahook.runHook({ extraVerbs, kicks: [watch.kick, publish.kick] });
