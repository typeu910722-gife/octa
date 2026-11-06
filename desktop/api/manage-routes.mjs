// Routes that manage bots, groups, folders (分區), routines and templates.
import { NAME_SPACE, NAME_SPACE_ERR, STANDBY, autoStandby, autonomyOk, noSpaces } from './chat.mjs';
import { addMsg, getSettings, loadAll } from './db.mjs';
import { gcForget } from './grokcloud.mjs';
import { GROKBOT_WIN, PALETTE, avatarOk, colorOk, engineOk, fbOk, grokBotOff, modelOk } from './engines.mjs';
import { ROUTINE_NEEDS_PROMPT, tidyScan, triggerFrom } from './routines.mjs';
import { cleanTimes, isEvery, localNow } from './schedule.mjs';
import { TEMPLATES_I18N, TEMPLATE_AVATARS } from './templates.mjs';
import { J, clean, err, folderOk, now, uid } from './util.mjs';

export async function manageRoutes(c) {
  const { env, db, path, m, url, body, U, ok } = c;
  if (path === 'template' && m === 'POST') {
    const lang = TEMPLATES_I18N[body.lang] ? body.lang : (await getSettings(db, U)).lang || 'zh-TW';
    const raw = (TEMPLATES_I18N[lang] || TEMPLATES_I18N['zh-TW'])[body.name];
    if (!raw) return err('沒有這個範本');
    const t = {
      folder: raw.folder,
      notes: raw.notes || '',
      bots: raw.bots.map(([k, name, task]) => ({ k, name: noSpaces(name), task })),
      groups: raw.groups.map(([name, task, members]) => ({ name, task, members }))
    };
    let folder = null;
    if (t.folder) {
      folder = (await db.prepare('SELECT id FROM folders WHERE user_id=? AND name=?').bind(U, t.folder).first())?.id;
      if (!folder) {
        folder = 'f-' + uid();
        await db
          .prepare('INSERT INTO folders (id,user_id,name,notes,created) VALUES (?,?,?,?,?)')
          .bind(folder, U, t.folder, t.notes || null, now())
          .run();
      }
    }
    const map = {};
    // each template bot gets its own colour, so a team is easy to tell apart
    const used = (await loadAll(db, U)).bots.length;
    for (const [i, b] of t.bots.entries()) {
      map[b.k] = uid();
      await db
        .prepare('INSERT INTO bots (id,user_id,name,task,folder,avatar,color,created) VALUES (?,?,?,?,?,?,?,?)')
        .bind(map[b.k], U, b.name, b.task, folder, TEMPLATE_AVATARS[b.k] || null, PALETTE[(used + i) % PALETTE.length], now())
        .run();
    }
    for (const g of t.groups)
      await db
        .prepare('INSERT INTO groups_ (id,user_id,name,task,members,folder,created) VALUES (?,?,?,?,?,?,?)')
        .bind('g-' + uid(), U, g.name, g.task, JSON.stringify(g.members.map(k => map[k])), folder, now() + 1)
        .run();
    // routines the template needs start paused: the person fills in the folder notes and times first
    for (const [k, name, times, prompt] of raw.routines || []) {
      if (!map[k]) continue;
      await db
        .prepare("INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,0,'{}',?)")
        .bind('r-' + uid(), U, map[k], clean(name, 40), clean(prompt, 2000), JSON.stringify(cleanTimes(times)), now())
        .run();
      await addMsg(
        db,
        U,
        map[k],
        'sys',
        `這個範本附了例行任務「${clean(name, 40)}」（${cleanTimes(times).join('、')}），目前暫停。先在分區資料寫好內容，再到任務設定 → 例行任務打開。`
      );
    }
    return ok();
  }
  // folders (分區)
  if (path === 'folders' && m === 'POST') {
    const name = clean(body.name, 20);
    if (!name) return err('分區名稱要填');
    const id = 'f-' + uid();
    await db
      .prepare('INSERT INTO folders (id,user_id,name,notes,created) VALUES (?,?,?,?,?)')
      .bind(id, U, name, clean(body.notes, 20000), now())
      .run();
    return ok({ id });
  }
  if (path.startsWith('folders/')) {
    const id = path.slice(8);
    if (m === 'PUT') {
      const name = clean(body.name, 20);
      if (!name) return err('分區名稱要填');
      await db
        .prepare('UPDATE folders SET name=?, notes=? WHERE id=? AND user_id=?')
        .bind(name, clean(body.notes, 20000), id, U)
        .run();
      return ok();
    }
    if (m === 'DELETE') {
      // items fall back to 未分區
      await db.batch([
        db.prepare('UPDATE bots SET folder=NULL WHERE folder=? AND user_id=?').bind(id, U),
        db.prepare('UPDATE groups_ SET folder=NULL WHERE folder=? AND user_id=?').bind(id, U),
        db.prepare('DELETE FROM folders WHERE id=? AND user_id=?').bind(id, U)
      ]);
      return ok();
    }
  }
  if (path === 'move' && m === 'POST') {
    const { folders } = await loadAll(db, U);
    const folder = folderOk(folders, body.folder);
    const id = clean(body.id, 64);
    await db
      .prepare(`UPDATE ${id.startsWith('g-') ? 'groups_' : 'bots'} SET folder=? WHERE id=? AND user_id=?`)
      .bind(folder, id, U)
      .run();
    return ok();
  }

  // bots
  if (path === 'bots' && m === 'POST') {
    const name = clean(body.name, 20),
      task = clean(body.task, 4000);
    if (!name) return err('名稱要填'); // the task may be empty: the bot learns it from the chat
    if (NAME_SPACE.test(name)) return err(NAME_SPACE_ERR);
    const { folders, bots } = await loadAll(db, U);
    if (bots.some(b => b.name === name)) return err('已經有同名的機器人，名字要不同才能用 @ 叫它');
    const color = colorOk(body.color);
    if (color === undefined) return err('顏色不正確');
    const id = uid(),
      engine = engineOk(body.engine);
    if (engine === 'grokbot' && grokBotOff(env)) return err(GROKBOT_WIN);
    await db
      .prepare(
        'INSERT INTO bots (id,user_id,name,task,folder,engine,model,avatar,color,browser,created,fb,autonomy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .bind(
        id,
        U,
        name,
        task,
        folderOk(folders, body.folder),
        engine,
        modelOk(engine, body.model),
        avatarOk(body.avatar),
        color,
        body.browser === 'mine' ? 'mine' : null,
        now(),
        engine === 'grokcloud' ? '[]' : fbOk(body.fb),
        autonomyOk(body.autonomy)
      )
      .run();
    await addMsg(db, U, id, 'sys', task ? '機器人已建立' : '機器人已建立：直接傳訊息告訴它要做什麼，它會自己整理成指定任務');
    // 4.14: a Grok Bot（雲端）bot doesn't patrol by itself (each look would be a Grok Bot run)
    if (task && engine !== 'grokcloud') await autoStandby(db, U, id);
    return ok({ id });
  }
  if (path.startsWith('bots/')) {
    const id = path.slice(5);
    if (m === 'PUT') {
      const name = clean(body.name, 20),
        task = clean(body.task, 4000);
      if (!name) return err('名稱要填'); // the task may be empty: the bot learns it from the chat
      const { folders, bots } = await loadAll(db, U);
      if (bots.some(b => b.name === name && b.id !== id)) return err('已經有同名的機器人');
      const old = bots.find(b => b.id === id);
      if (NAME_SPACE.test(name) && name !== old?.name) return err(NAME_SPACE_ERR); // an old name with spaces may stay until it is renamed
      const engine = engineOk(body.engine);
      if (engine === 'grokbot' && grokBotOff(env) && old?.engine !== 'grokbot') return err(GROKBOT_WIN); // a bot that already had it keeps its setting (its jobs explain why they can't run)
      // Grok Bot（雲端）: the point is to use no Claude/GPT quota — switching to it drops the backup AIs; they come back only
      // when the person adds one again afterwards (a later save that sends fb while already on Grok Bot（雲端）)
      let fb = body.fb === undefined ? JSON.stringify(old?.fb || []) : fbOk(body.fb);
      if (engine === 'grokcloud' && old?.engine !== 'grokcloud') fb = '[]';
      const autonomy = body.autonomy === undefined ? old?.autonomy || null : autonomyOk(body.autonomy);
      const color = body.color === undefined ? old?.color || null : colorOk(body.color); // left out: keep the colour it has
      if (color === undefined) return err('顏色不正確');
      await db
        .prepare(
          'UPDATE bots SET name=?,task=?,folder=?,engine=?,model=?,avatar=?,color=?,browser=?,fb=?,autonomy=? WHERE id=? AND user_id=?'
        )
        .bind(
          name,
          task,
          folderOk(folders, body.folder),
          engine,
          modelOk(engine, body.model),
          body.avatar === undefined ? old?.avatar || null : avatarOk(body.avatar),
          color,
          body.browser === 'mine' ? 'mine' : null,
          fb,
          autonomy,
          id,
          U
        )
        .run();
      if (old && task && !String(old.task || '').trim() && engine !== 'grokcloud') await autoStandby(db, U, id); // just got its standing task
      return ok();
    }
    if (m === 'DELETE') {
      // files stay on the host computer; only the records go
      // take the bot out of its groups; a group left with nobody is removed too
      const { groups } = await loadAll(db, U);
      for (const g of groups.filter(x => x.members.includes(id))) {
        const left = g.members.filter(x => x !== id);
        if (left.length)
          await db.prepare('UPDATE groups_ SET members=? WHERE id=? AND user_id=?').bind(JSON.stringify(left), g.id, U).run();
        else
          await db.batch([
            db.prepare('DELETE FROM groups_ WHERE id=? AND user_id=?').bind(g.id, U),
            db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(g.id, U),
            db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(g.id, U),
            db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(g.id, U)
          ]);
      }
      await db.batch([
        db.prepare('DELETE FROM shots WHERE bot_id=? AND user_id=?').bind(id, U),
        db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(id, U),
        db.prepare('DELETE FROM bots WHERE id=? AND user_id=?').bind(id, U),
        db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
        db.prepare('DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE conv=? AND user_id=?)').bind(id, U),
        db.prepare('DELETE FROM files WHERE conv=? AND user_id=?').bind(id, U),
        db.prepare("DELETE FROM jobs WHERE bot_id=? AND user_id=? AND status='pending'").bind(id, U)
      ]);
      await gcForget(env, db, U, id); // 4.14: its Grok Bot（雲端）reply token stops working
      return ok();
    }
  }

  // groups
  const groupBody = async () => {
    const name = clean(body.name, 20),
      task = clean(body.task, 4000);
    const { bots, folders } = await loadAll(db, U);
    const members = (Array.isArray(body.members) ? body.members : []).filter(x => bots.some(b => b.id === x));
    if (!name || !members.length) throw new Error('名稱和成員都要填'); // rules are optional: members take turns in order
    return { name, task, members: JSON.stringify(members), folder: folderOk(folders, body.folder) };
  };
  if (path === 'groups' && m === 'POST') {
    let g;
    try {
      g = await groupBody();
    } catch (e) {
      return err(e.message);
    }
    const id = 'g-' + uid();
    await db
      .prepare('INSERT INTO groups_ (id,user_id,name,task,members,folder,created) VALUES (?,?,?,?,?,?,?)')
      .bind(id, U, g.name, g.task, g.members, g.folder, now())
      .run();
    await addMsg(db, U, id, 'sys', '群組已建立');
    return ok({ id });
  }
  if (path.startsWith('groups/')) {
    const id = path.slice(7);
    if (m === 'PUT') {
      let g;
      try {
        g = await groupBody();
      } catch (e) {
        return err(e.message);
      }
      await db
        .prepare('UPDATE groups_ SET name=?,task=?,members=?,folder=? WHERE id=? AND user_id=?')
        .bind(g.name, g.task, g.members, g.folder, id, U)
        .run();
      return ok();
    }
    if (m === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(id, U),
        db.prepare('DELETE FROM groups_ WHERE id=? AND user_id=?').bind(id, U),
        db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
        db.prepare('DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE conv=? AND user_id=?)').bind(id, U),
        db.prepare('DELETE FROM files WHERE conv=? AND user_id=?').bind(id, U),
        db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(id, U)
      ]);
      return ok();
    }
  }

  // 一次性整理: times still written in standing tasks vs the routines. GET only lists; POST posts the ✅待確認 to each bot (or {bot}).
  if (path === 'schedules/tidy' && (m === 'GET' || m === 'POST')) {
    const list = await tidyScan(env, db, U, {
      post: m === 'POST',
      bot: clean(m === 'GET' ? url.searchParams.get('bot') : body.bot, 64) || null
    });
    return m === 'POST' ? ok({ bots: list }) : J({ bots: list });
  }
  // routines (例行任務)
  if (path === 'routines' && m === 'POST') {
    const { bots, groups } = await loadAll(db, U);
    const conv = clean(body.conv, 64),
      name = clean(body.name, 40),
      times = cleanTimes(body.times);
    if (!bots.some(b => b.id === conv) && !groups.some(g => g.id === conv)) return err('找不到對話', 404);
    let trig;
    try {
      trig = triggerFrom(body);
    } catch (e) {
      return err(e.message);
    }
    if (!name || (!times.length && !trig.hook && !trig.watch)) return err('名稱和時間（或觸發方式）都要填');
    if (!clean(body.prompt, 2000)) return err(ROUTINE_NEEDS_PROMPT); // 每個排程有自己的說明: no falling back on the standing task
    const { date, hm } = localNow(env); // times already past today start tomorrow
    const fired = Object.fromEntries(times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date]));
    const id = 'r-' + uid();
    await db
      .prepare(
        'INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created,hook,watch) VALUES (?,?,?,?,?,?,1,?,?,?,?)'
      )
      .bind(
        id,
        U,
        conv,
        name,
        clean(body.prompt, 2000),
        JSON.stringify(times),
        JSON.stringify(fired),
        now(),
        trig.hook,
        trig.watch
      )
      .run();
    if (name === STANDBY) await db.prepare('UPDATE bots SET stood=1 WHERE id=? AND user_id=?').bind(conv, U).run();
    if (trig.hook) env.hooksChanged?.(); // 4.5: the host publishes where this new 交接網址 reaches it
    return ok({ id, hook: trig.hook });
  }
  if (path.startsWith('routines/')) {
    const id = path.slice(9);
    const r = await db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').bind(id, U).first();
    if (!r) return err('找不到例行任務', 404);
    if (m === 'PUT') {
      const name = clean(body.name ?? r.name, 40),
        times = body.times ? cleanTimes(body.times) : JSON.parse(r.times);
      let trig = { hook: r.hook, watch: r.watch };
      if (body.trigger !== undefined) {
        try {
          trig = triggerFrom(body, r);
        } catch (e) {
          return err(e.message);
        }
      }
      if (!name || (!times.length && !trig.hook && !trig.watch)) return err('名稱和時間（或觸發方式）都要填');
      const enabled = body.enabled === undefined ? r.enabled : body.enabled ? 1 : 0;
      const prompt = body.prompt === undefined ? r.prompt : clean(body.prompt, 2000);
      // an edit, or turning on an old routine that has no instruction of its own, needs one; turning it off never does
      if (
        !String(prompt || '').trim() &&
        (body.prompt !== undefined || body.name !== undefined || body.times || (enabled && !r.enabled))
      )
        return err(ROUTINE_NEEDS_PROMPT);
      let fired = r.fired;
      if ((enabled && !r.enabled) || body.times) {
        // turning on or changing times: don't fire times already past today
        const { date, hm } = localNow(env);
        fired = JSON.stringify(Object.fromEntries(times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date])));
      }
      await db
        .prepare('UPDATE routines SET name=?,prompt=?,times=?,enabled=?,fired=?,hook=?,watch=?,wstate=? WHERE id=?')
        .bind(
          name,
          prompt,
          JSON.stringify(times),
          enabled,
          fired,
          trig.hook,
          trig.watch,
          trig.watch === r.watch ? r.wstate : null,
          id
        )
        .run();
      if (trig.hook && trig.hook !== r.hook) env.hooksChanged?.();
      return ok({ hook: trig.hook });
    }
    if (m === 'DELETE') {
      await db.prepare('DELETE FROM routines WHERE id=?').bind(id).run();
      if (r.name === STANDBY) await db.prepare('UPDATE bots SET stood=1 WHERE id=? AND user_id=?').bind(r.conv, U).run(); // turned off by the person: stays off
      return ok();
    }
  }
}
