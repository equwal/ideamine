// The UserPromptSubmit hook: ideahook's hook plus the verbs and background jobs that belong to the
// board: /ideas-watch, /ideas-web, the watcher, and the dashboard upload.

import { fileURLToPath } from 'node:url';
import * as watch from 'ideaboard/watch';
import * as ideahook from 'ideahook/hook';
import * as sync from 'ideahook/sync';
import * as publish from 'ideamine-web/publish';

const BIN = fileURLToPath(new URL('../bin/ideamine.js', import.meta.url));
watch.configure({ bin: BIN });
publish.configure({ bin: BIN });

// Background syncs run through the ideamine CLI, which also sends the token use.
export const configureSync = () => sync.configure({ usage: () => import('ideaprofile/usage'), bin: BIN });
configureSync();

const extraVerbs = {
  ...watch.verbs,
  'ideas-web': async (arg) => {
    // Loaded here, not at the top: the hook runs for each prompt.
    const serve = await import('ideamine-web/serve');
    serve.configure({ bin: BIN });
    if (!arg) return serve.ensureRunning();
    if (/^off$/i.test(arg)) return serve.stopRunning();
    return null;
  },
};

export const handlePrompt = (prompt, opts = {}) => ideahook.handlePrompt(prompt, { ...opts, extraVerbs });

export const runHook = () => ideahook.runHook({ extraVerbs, kicks: [watch.kick, publish.kick] });
