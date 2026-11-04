// 4.7 每個機器人預設範本: one tap makes a bot that already knows its role — 指定任務, 📌 rules, 例行任務 and a colour.
// (The team templates in templates.mjs make several bots and a 分區 at once; these make one bot.)
import { NAME_SPACE, NAME_SPACE_ERR } from './chat.mjs';
import { addMsg, bump, getSettings, loadAll, putSettings } from './db.mjs';
import { colorOk, engineOk, modelOk } from './engines.mjs';
import { noteSrc } from './memory-edit.mjs';
import { saveRoutine } from './routines.mjs';
import { cleanTimes, timesWords } from './schedule.mjs';
import { J, clean, err, folderOk, now, uid } from './util.mjs';

// key → avatar, colour, and per language: name, task, rules, routines [name, times, prompt]
export const ROLE_KEYS = ['support', 'housekeeping', 'report', 'booking', 'social', 'books'];
const LOOK = {
  support: ['💬', '#7EC4E6'],
  housekeeping: ['🧹', '#9BD39A'],
  report: ['📊', '#9DB4F0'],
  booking: ['🛎️', '#E8A87C'],
  social: ['📣', '#E79AB5'],
  books: ['🧾', '#BFCB7A']
};
export const ROLES = {
  'zh-TW': {
    support: {
      name: '客服',
      task: '看客人的新訊息（網站後台、LINE 官方帳號、電子郵件），依共用資料裡的商品、價格、營業時間擬好回覆，列給我確認。常見問題可以直接回。',
      rules: ['回覆客人一律用敬語、語氣親切，不超過三句', '價格、退款、折扣這類承諾先問我，不要自己答應', '我說「發送」前不要送出非常見問題的回覆'],
      routines: [['看新訊息', ['*/30'], '看一次客人的新訊息：常見問題照共用資料直接回；其他的擬好回覆列給我確認。沒有新訊息就只回「（略過）」。']]
    },
    housekeeping: {
      name: '房務',
      task: '依今天的入住、退房和續住，排出要打掃的房間清單（館別、房號、退房時間），有房務看板時更新上去。',
      rules: ['名單照館別、房號由小到大排', '同一房間同時有退房又有入住的，標「急」放最上面', '看不懂的訂房先列出來問我，不要猜'],
      routines: [['今日打掃清單', ['08:30'], '整理今天要打掃的房間清單（館別、房號、退房時間、是否當天入住），發給我；有房務看板網址就更新上去。']]
    },
    report: {
      name: '報表',
      task: '每天把營業資料（訂單、營收、來客數）整理成一則簡短日報：重點數字、跟昨天和上週同一天比、需要注意的事。',
      rules: ['數字一律附來源（哪個後台、哪張表）', '先寫三行重點，再附表格', '算不出來或資料缺漏時直接說，不要估'],
      routines: [['每日營業日報', ['21:00'], '整理今天的營業日報：訂單數、營收、來客數，跟昨天和上週同一天比較，列出需要注意的事。']]
    },
    booking: {
      name: '訂房',
      task: '打開共用資料裡寫的訂房平台後台，整理今天與明天的入住、退房、取消：房號、客人、晚數、備註。',
      rules: ['住宿日期換成「住哪幾晚」再分類（10/21-23＝住三晚，10/24 退房）', '一人多房、同房多組、延期、取消另外列出來給我決定', '不要在後台更改或取消任何訂單'],
      routines: [['今明兩天訂房', ['08:00'], '打開訂房後台，整理今天與明天的入住、退房、取消，列成清單發給我。']]
    },
    social: {
      name: '社群小編',
      task: '依店裡的活動、新品和節日，每週擬好社群貼文（Facebook、Instagram、LINE 官方帳號）：文案、hashtag、建議配圖，列給我確認。',
      rules: ['貼文要先給我看過，我說「發佈」前不要貼出', '語氣輕鬆親切，一篇不超過 150 字', '不要用誇大或保證效果的字眼'],
      routines: [['每週貼文草稿', ['10:00'], '擬好這週要發的 3 篇社群貼文草稿（文案、hashtag、建議配圖、建議發文時間），列給我確認。']]
    },
    books: {
      name: '記帳',
      task: '把我給的收據、發票、匯款截圖整理成記帳表（日期、項目、金額、分類、付款方式），放在輸出資料夾，月底做月結。',
      rules: ['金額看不清楚的標「待確認」，不要猜', '分類照共用資料的科目表，沒有的先列出來問我', '不要動銀行或付款相關的帳號設定'],
      routines: [['每週記帳整理', ['18:00'], '整理這週收到的收據和發票，更新記帳表，列出看不清楚或還沒分類的項目給我確認。']]
    }
  },
  en: {
    support: {
      name: 'Support',
      task: 'Check new customer messages (website, LINE official account, email) and draft replies using the shared notes (products, prices, opening hours) for me to approve. Answer common questions directly.',
      rules: ['Always reply politely and warmly, in three sentences or fewer', 'Ask me before promising prices, refunds or discounts', 'Do not send replies to unusual questions until I say “send”'],
      routines: [['Check new messages', ['*/30'], 'Check new customer messages once: answer common questions from the shared notes, draft the rest for me to approve. If there is nothing new, reply only “(skip)”.']]
    },
    housekeeping: {
      name: 'Housekeeping',
      task: 'From today’s check-ins, check-outs and stays, list the rooms to clean (building, room, check-out time) and update the housekeeping board if there is one.',
      rules: ['Sort by building, then room number', 'Rooms with a check-out and a check-in on the same day go first, marked “urgent”', 'List bookings you can’t read and ask me — don’t guess'],
      routines: [['Today’s cleaning list', ['08:30'], 'Make today’s list of rooms to clean (building, room, check-out time, same-day check-in) and send it to me; update the housekeeping board if there is a link.']]
    },
    report: {
      name: 'Reports',
      task: 'Every day, turn the sales data (orders, revenue, visitors) into a short daily report: key numbers, compared with yesterday and the same day last week, and anything to watch.',
      rules: ['Always say where each number comes from', 'Three lines of highlights first, then the table', 'If something can’t be calculated or data is missing, say so — don’t estimate'],
      routines: [['Daily sales report', ['21:00'], 'Write today’s sales report: orders, revenue and visitors, compared with yesterday and the same day last week, plus anything to watch.']]
    },
    booking: {
      name: 'Bookings',
      task: 'Open the booking dashboard listed in the shared notes and list today’s and tomorrow’s check-ins, check-outs and cancellations: room, guest, nights, notes.',
      rules: ['Turn stay dates into the nights stayed before sorting (10/21-23 = three nights, check-out 10/24)', 'List one guest with several rooms, shared rooms, changes and cancellations separately for me to decide', 'Never change or cancel bookings in the dashboard'],
      routines: [['Today and tomorrow', ['08:00'], 'Open the booking dashboard and list today’s and tomorrow’s check-ins, check-outs and cancellations for me.']]
    },
    social: {
      name: 'Social media',
      task: 'Every week, draft social posts (Facebook, Instagram, LINE official account) about the shop’s events, new items and holidays: text, hashtags, suggested photos — for me to approve.',
      rules: ['Show me every post first; do not publish until I say “post”', 'Friendly and light, 150 characters or fewer', 'No exaggerated or guaranteed claims'],
      routines: [['Weekly post drafts', ['10:00'], 'Draft this week’s 3 social posts (text, hashtags, suggested photo, suggested time) for me to approve.']]
    },
    books: {
      name: 'Bookkeeping',
      task: 'Turn the receipts, invoices and transfer screenshots I give you into a ledger (date, item, amount, category, payment method) in the output folder, and close the month at month-end.',
      rules: ['Mark amounts you can’t read as “to check” — don’t guess', 'Use the categories in the shared notes; ask me about new ones', 'Never touch bank or payment account settings'],
      routines: [['Weekly bookkeeping', ['18:00'], 'Sort this week’s receipts and invoices into the ledger and list anything unreadable or uncategorised for me to check.']]
    }
  },
  ja: {
    support: {
      name: 'カスタマー対応',
      task: 'お客様からの新しいメッセージ（サイト管理画面、LINE 公式アカウント、メール）を確認し、共有データの商品・価格・営業時間をもとに返信案を作って確認に出す。よくある質問はそのまま返信してよい。',
      rules: ['お客様への返信は丁寧で親しみやすく、3 文以内', '価格・返金・割引の約束は先に私に聞く', 'よくある質問以外は私が「送信」と言うまで送らない'],
      routines: [['新着メッセージ確認', ['*/30'], 'お客様の新着メッセージを確認：よくある質問は共有データどおり返信、それ以外は返信案を確認に出す。新着がなければ「（スキップ）」だけ返す。']]
    },
    housekeeping: {
      name: '客室清掃',
      task: '今日のチェックイン・チェックアウト・連泊から清掃する部屋のリスト（館、部屋番号、チェックアウト時刻）を作り、清掃ボードがあれば更新する。',
      rules: ['館、部屋番号の小さい順に並べる', '同じ日にチェックアウトとチェックインがある部屋は「急」として先頭に', '読めない予約は推測せずに私に聞く'],
      routines: [['今日の清掃リスト', ['08:30'], '今日清掃する部屋のリスト（館、部屋番号、チェックアウト時刻、当日チェックインの有無）を送る。清掃ボードの URL があれば更新する。']]
    },
    report: {
      name: 'レポート',
      task: '毎日、営業データ（注文、売上、来客数）を短い日報にまとめる：主要な数字、前日・前週同曜日との比較、注意点。',
      rules: ['数字には必ず出どころを書く', 'まず要点 3 行、次に表', '計算できない・データが足りないときは推測せずにそう書く'],
      routines: [['毎日の営業日報', ['21:00'], '今日の営業日報：注文数、売上、来客数を前日・前週同曜日と比べ、注意点を書く。']]
    },
    booking: {
      name: '予約管理',
      task: '共有データにある予約サイトの管理画面を開き、今日と明日のチェックイン・チェックアウト・キャンセル（部屋、お客様、泊数、備考）をまとめる。',
      rules: ['宿泊日は「何泊したか」に直してから分類する（10/21-23＝3 泊、10/24 チェックアウト）', '複数部屋・相部屋・延期・キャンセルは別にまとめて私が判断する', '管理画面で予約を変更・キャンセルしない'],
      routines: [['今日と明日の予約', ['08:00'], '予約管理画面を開き、今日と明日のチェックイン・チェックアウト・キャンセルをリストにして送る。']]
    },
    social: {
      name: 'SNS 担当',
      task: '店のイベント・新商品・季節の行事をもとに、毎週 SNS 投稿（Facebook、Instagram、LINE 公式アカウント）の文案・ハッシュタグ・写真案を作って確認に出す。',
      rules: ['投稿は必ず先に見せる。私が「投稿」と言うまで公開しない', '親しみやすい口調で 150 字以内', '誇大表現や効果の保証はしない'],
      routines: [['毎週の投稿案', ['10:00'], '今週の SNS 投稿案を 3 本（文案、ハッシュタグ、写真案、投稿時刻の提案）作って確認に出す。']]
    },
    books: {
      name: '記帳',
      task: '渡したレシート・請求書・振込のスクリーンショットを帳簿（日付、項目、金額、科目、支払方法）にまとめて出力フォルダに置き、月末に月次をまとめる。',
      rules: ['読めない金額は推測せず「要確認」にする', '科目は共有データの科目表に合わせ、ないものは先に聞く', '銀行や支払いのアカウント設定には触れない'],
      routines: [['毎週の記帳', ['18:00'], '今週のレシートと請求書を帳簿に整理し、読めない・未分類の項目を確認に出す。']]
    }
  }
};
const rolesFor = lang => ROLES[lang] || (String(lang).startsWith('zh') ? ROLES['zh-TW'] : ROLES.en);
export const roleList = lang =>
  ROLE_KEYS.map(k => {
    const r = rolesFor(lang)[k];
    return { key: k, avatar: LOOK[k][0], color: LOOK[k][1], name: r.name, task: r.task, rules: r.rules, routines: r.routines.map(([name, times, prompt]) => ({ name, times, prompt })) };
  });

// make one bot from a role: name (or the role's, numbered when taken), colour, task, rules (from 範本), routines
export async function createFromRole(env, db, U, body) {
  const lang = (await getSettings(db, U)).lang || 'zh-TW';
  const key = String(body.role || '');
  if (!ROLE_KEYS.includes(key)) return { error: '沒有這個範本' };
  const r = rolesFor(body.lang || lang)[key];
  const { folders, bots } = await loadAll(db, U);
  let name = clean(body.name, 20) || r.name;
  if (NAME_SPACE.test(name)) return { error: NAME_SPACE_ERR };
  if (bots.some(b => b.name === name)) {
    if (clean(body.name, 20)) return { error: '已經有同名的機器人，名字要不同才能用 @ 叫它' };
    for (let i = 2; bots.some(b => b.name === name); i++) name = clean(r.name, 18) + i;
  }
  const color = body.color == null ? LOOK[key][1] : colorOk(body.color);
  if (color === undefined) return { error: '顏色不正確' };
  const id = uid(),
    engine = engineOk(body.engine);
  await db
    .prepare('INSERT INTO bots (id,user_id,name,task,folder,engine,model,avatar,color,created) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, U, name, r.task, folderOk(folders, body.folder), engine, modelOk(engine, body.model), LOOK[key][0], color, now())
    .run();
  await addMsg(db, U, id, 'sys', `已用「${r.name}」範本建立：指定任務、${r.rules.length} 條規則${r.routines.length ? '、例行任務' : ''}都設好了，可在詳細資料修改`);
  const st = await getSettings(db, U);
  st.memory = st.memory || {};
  st.memory[id] = r.rules.map(x => clean(x, 300));
  await putSettings(db, U, st);
  await noteSrc(db, U, 'rule', id, st.memory[id], 'tpl');
  if (body.routines !== false)
    for (const [rn, times, prompt] of r.routines)
      await saveRoutine(env, db, U, id, { name: clean(rn, 40), times: cleanTimes(times), prompt: clean(prompt, 2000) }, true);
  if (body.routines !== false && r.routines.length)
    await addMsg(db, U, id, 'sys', `例行任務：${r.routines.map(([rn, t]) => `「${rn}」${timesWords(cleanTimes(t))}`).join('、')}`);
  // its own routines are its schedule: no automatic 待命巡查 on top (it can still be turned on in 更多設定)
  await db.prepare('UPDATE bots SET stood=1 WHERE id=? AND user_id=?').bind(id, U).run();
  await bump(db, U);
  return { id, name };
}

export async function rolesRoutes(c) {
  const { env, db, path, m, url, body, U } = c;
  if (path === 'roles' && m === 'GET') {
    const lang = clean(url.searchParams.get('lang'), 8) || (await getSettings(db, U)).lang || 'zh-TW';
    return J({ roles: roleList(lang) });
  }
  if (path === 'roles/create' && m === 'POST') {
    const r = await createFromRole(env, db, U, body);
    if (r.error) return err(r.error);
    return J({ ok: true, id: r.id, name: r.name });
  }
  return null;
}
