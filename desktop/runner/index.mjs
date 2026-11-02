// OCTA runner — runs the bots on this computer with the AI tools you are signed in to, and talks to OCTA's local API
// over loopback HTTP. Each bot gets its own browser (own profile, logins, tabs), so several bots can work at once.
// Files (attachments, screenshots, what bots make) stay in the OCTA file folder, one folder per bot or group.
//
// The desktop app imports startRunner() from here; this file only re-exports the public names of the runner modules.

export { VERSION, OLLAMA_NUM_CTX, GOOGLE_HOME } from './state.mjs';
export { limitSignal } from './api-client.mjs';
export { storeDir, findChrome } from './files.mjs';
export {
  autonomyRules, SAFE_WORK_RULES, memoryLines, manualLines, memoryHowTo, routineLines, mustMarkLines, sideNote,
  GROUP_HISTORY, buildPrompt, fitLocal, buildLocalPrompt, taskPrompt, evidenceText, scrubNotes, takeBrowserTask,
  stripBrowserTask, keepBrowserTask, needsPage, forcedBrowseTask, planBrowserRound, buildBrowserPrompt,
  loginHints, hideSecrets, findUploads
} from './prompts.mjs';
export { ENGINES, has, spawnCli, leanFlags } from './engines.mjs';
export { ollamaContextTag, ollamaContextModelfile, parseOllamaCaps, ollamaChoices, NO_TOOLS_TEXT, browserUseReady } from './ollama.mjs';
export { PARTIAL_TAG, partialNote } from './warm.mjs';
export { triedText } from './chat.mjs';
export { pickLivePage, ensureBrowser, closeAllBrowsers } from './browser.mjs';
export { googleSignInUrl, googleSignedIn, googleLoginMark, googleLoginDone, returnToEmbed } from './google.mjs';
export { browserWindowAsk, takeWindowMarks } from './live.mjs';
export { pollAge, sideReport, startRunner } from './loop.mjs';
