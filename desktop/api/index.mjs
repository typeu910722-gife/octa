// OCTA local API — runs inside the desktop app (desktop/server.mjs); the only user is 'local'.
// The desktop window and the built-in runner call it over loopback (env.isLocal: true).
// A phone reaches it through the tunnel (env.pairCheck): it pairs with the one-time code shown on the
// computer and then uses the session token it got. External events come in on /api/hook/<key>.
// Changes bump users.rev; open pages and the runner long-poll it.
//
// onRequest({ request, env, params: { path } }) → Response
//   env: { DB (D1-like), TZ_OFFSET_MIN, isLocal?, pairCheck?(code), runnerOnline?() , OCTA_CODE_ALLOW_FIXTURE? }
//
// Modules:
//   router.mjs           public routes (config, pair, hook), who is asking, and the route handlers in order
//   hooks.mjs            4.5 交接網址: hook/<key> work, status, inbox, feedback, teach (other AIs; 401 without the key)
//   files.mjs            file pieces and the file/ + files routes
//   runner-routes.mjs    runner/* (the built-in runner); runner-done.mjs: runner/done
//   chat-routes.mjs      long-poll, state, messages, compact, live view, opening a bot's browser
//   manage-routes.mjs    bots, groups, folders (分區), routines, templates
//   code-routes.mjs      coding tasks
//   settings-routes.mjs  settings, connectors, notifications, logs, board, AI engines and usage
//   util / db / schedule / chat / engines / notify / routines / jobs / memory / templates: shared logic

export { onRequest } from './router.mjs';
export { wake } from './db.mjs';
export { schedulesFromTurn, clockWords, scheduleAsk, correctionAsk, splitTaskSchedules } from './schedule.mjs';
export { sideKind, missingResult, calmReply, mentionAsks } from './chat.mjs';
export { routineTarget, nextRun, sameRoutine } from './routines.mjs';
export {
  capList,
  manualScore,
  pickManuals,
  memoryFor,
  parseManuals,
  saveManuals,
  applyRuleUpdates,
  apprOpen
} from './memory.mjs';
