// OCTA runner — runs the bots on this computer with the AI tools you are signed in to, and talks to OCTA's local API
// over loopback HTTP. Each bot gets its own browser (own profile, logins, tabs), so several bots can work at once.
// Files (attachments, screenshots, what bots make) stay in the OCTA file folder, one folder per bot or group.
//
// The desktop app imports startRunner() from here; this file only re-exports the public names of the runner modules.

export { VERSION, OLLAMA_NUM_CTX, GOOGLE_HOME, CONT_GUARD, CONT_MAX, WARM_MAX } from './state.mjs';
export { limitSignal } from './api-client.mjs';
export { storeDir, findChrome } from './files.mjs';
export {
  autonomyRules, SAFE_WORK_RULES, memoryLines, manualLines, memoryHowTo, routineLines, mustMarkLines, sideNote,
  GROUP_HISTORY, GROUP_HISTORY_FULL, historyCaps, FULL_RULE, BROWSE_MAX_FULL, buildPrompt, fitLocal, buildLocalPrompt, taskPrompt, evidenceText, scrubNotes, takeBrowserTask,
  stripBrowserTask, keepBrowserTask, needsPage, forcedBrowseTask, planBrowserRound, buildBrowserPrompt,
  loginHints, hideSecrets, findUploads, browseMode, browseRules
} from './prompts.mjs';
export { ENGINES, has, spawnCli, leanFlags, DIRECT_BROWSE, browseKind, claudeEvent } from './engines.mjs';
export { parsePlan, parseStep, stripStepMarks, stepTracker } from './steps.mjs';
export { ollamaContextTag, ollamaContextModelfile, parseOllamaCaps, ollamaChoices, NO_TOOLS_TEXT, browserUseReady } from './ollama.mjs';
export { PARTIAL_TAG, partialNote, warmCap, staleSession, sessions } from './warm.mjs';
export { triedText, RESUME_PROMPT, CONNECTOR_MAX_FULL, CONNECTOR_RESULT_FULL } from './chat.mjs';
export { needsMore, isTerminal, contPrompt, runUntilDone, mergeReplies, carryMarks, madeProgress, toolSig, stuckText } from './continue.mjs';
export { pickLivePage, ensureBrowser, closeAllBrowsers, livePortOf } from './browser.mjs';
export { googleSignInUrl, googleSignedIn, googleLoginMark, googleLoginDone, returnToEmbed } from './google.mjs';
export { browserWindowAsk, takeWindowMarks } from './live.mjs';
export { pollAge, sideReport, startRunner } from './loop.mjs';
