// Netlify Function: POST /api/report
// Competitive Benchmarker (T031) — a ReRev Labs / Athlete Site Pixie.
// Benchmarks an athlete's key metric against DETERMINISTIC recruiting standards by
// division (sourced live June 2026 from NCSA scholarship/recruiting-time pages and
// recruiting-service combine tables). Haiku (temp 0, no web search) writes ONLY the
// three narrative reads around the matched numbers; if it fails, templated reads are
// used so the tool never hard-fails.
// Guards mirror T028/T030: validate -> Turnstile -> daily cap -> per-IP -> 30d cache
//   -> compute -> narrative -> save (+token) -> email parent + notify internally.

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

const stripTags = (s) => String(s == null ? '' : s)
  .replace(/<\/?cite[^>]*>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// ---------- unit helpers ----------
const secToTime = (s) => {
  if (s == null) return '';
  if (s < 60) return s.toFixed(2).replace(/\.00$/, '.0') + 's';
  const m = Math.floor(s / 60);
  const r = (s - m * 60);
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
};
const inToMark = (v) => {
  if (v == null) return '';
  const ft = Math.floor(v / 12);
  const inch = Math.round((v - ft * 12) * 100) / 100;
  return ft + "'" + (Number.isInteger(inch) ? inch : inch.toFixed(1)) + '"';
};
const sec40 = (s) => (s == null ? '' : s.toFixed(2) + 's');

function parseTime(raw) {
  const s = String(raw || '').trim().replace(/s$/i, '');
  if (!s) return NaN;
  if (s.includes(':')) {
    const [m, sec] = s.split(':');
    const mm = parseFloat(m), ss = parseFloat(sec);
    if (!isFinite(mm) || !isFinite(ss)) return NaN;
    return mm * 60 + ss;
  }
  const v = parseFloat(s);
  return isFinite(v) ? v : NaN;
}
function parseMark(raw) {
  let s = String(raw || '').trim().toLowerCase().replace(/inches|in\b|"/g, '').trim();
  if (!s) return NaN;
  if (s.includes('m')) {
    const v = parseFloat(s);
    return isFinite(v) ? v * 39.3701 : NaN;
  }
  const m = s.match(/^(\d+)\s*['\-\s]\s*(\d+(?:\.\d+)?)$/);
  if (m) return parseInt(m[1], 10) * 12 + parseFloat(m[2]);
  const v = parseFloat(s);
  return isFinite(v) ? v : NaN;
}

// ---------- division ladders ----------
const LADDER_NCAA = ['D1', 'D2', 'D3', 'NAIA'];
const LADDER_FB = ['FBS', 'FCS', 'D2', 'D3/NAIA'];
const DIV_LABEL = { D1: 'NCAA D1', D2: 'NCAA D2', D3: 'NCAA D3', NAIA: 'NAIA', FBS: 'FBS (D1)', FCS: 'FCS (D1-AA)', 'D3/NAIA': 'D3 / NAIA' };

// ---------- benchmark data (competitive-recruit bar per division) ----------
// dir: 'lower' = faster/lower better (times, 40); 'higher' = bigger better (jumps/throws).
// unit: 'time' | 'mark' | 'dash'; vals in base unit (sec or inches).
const E = (label, dir, unit, vals, note) => ({ label, dir, unit, vals, note });

const DATA = {
  track: {
    label: 'Track & Field',
    ladder: LADDER_NCAA,
    note: 'Competitive-recruit bar at each level (NCSA scholarship standards, 2025-26).',
    events: {
      m_100:   E("Men's 100m", 'lower', 'time', { D1:10.41, D2:10.61, D3:10.94, NAIA:10.74 }),
      m_200:   E("Men's 200m", 'lower', 'time', { D1:20.84, D2:21.28, D3:21.75, NAIA:22.11 }),
      m_400:   E("Men's 400m", 'lower', 'time', { D1:46.20, D2:47.59, D3:47.98, NAIA:48.71 }),
      m_800:   E("Men's 800m", 'lower', 'time', { D1:107.14, D2:108.92, D3:114.94, NAIA:115.50 }),
      m_1600:  E("Men's 1600m", 'lower', 'time', { D1:245.89, D2:246.99, D3:255.88, NAIA:250.57 }),
      m_3200:  E("Men's 3200m", 'lower', 'time', { D1:534, D2:542, D3:560, NAIA:580 }),
      m_110h:  E("Men's 110m Hurdles", 'lower', 'time', { D1:14.01, D2:14.43, D3:14.76, NAIA:14.54 }),
      m_400h:  E("Men's 400m Hurdles", 'lower', 'time', { D1:50.76, D2:52.27, D3:51.96, NAIA:56.43 }),
      m_lj:    E("Men's Long Jump", 'higher', 'mark', { D1:289, D2:294, D3:284, NAIA:282 }),
      m_hj:    E("Men's High Jump", 'higher', 'mark', { D1:83, D2:83, D3:81, NAIA:80 }),
      m_sp:    E("Men's Shot Put", 'higher', 'mark', { D1:795, D2:698, D3:639, NAIA:670 }),
      w_100:   E("Women's 100m", 'lower', 'time', { D1:11.49, D2:11.97, D3:12.34, NAIA:12.18 }),
      w_200:   E("Women's 200m", 'lower', 'time', { D1:22.78, D2:24.26, D3:25.39, NAIA:24.82 }),
      w_400:   E("Women's 400m", 'lower', 'time', { D1:52.23, D2:55.11, D3:55.64, NAIA:56.74 }),
      w_800:   E("Women's 800m", 'lower', 'time', { D1:127.54, D2:129.22, D3:131.51, NAIA:135.23 }),
      w_1600:  E("Women's 1600m", 'lower', 'time', { D1:272.84, D2:287.55, D3:293.75, NAIA:295.99 }),
      w_3200:  E("Women's 3200m", 'lower', 'time', { D1:620, D2:650, D3:670, NAIA:680 }, 'D3 standard is published at 3000m.'),
      w_100h:  E("Women's 100m Hurdles", 'lower', 'time', { D1:13.51, D2:13.72, D3:14.39, NAIA:14.85 }),
      w_400h:  E("Women's 400m Hurdles", 'lower', 'time', { D1:59.92, D2:60.98, D3:61.31, NAIA:64.53 }),
      w_lj:    E("Women's Long Jump", 'higher', 'mark', { D1:253, D2:237, D3:224, NAIA:225 }),
      w_hj:    E("Women's High Jump", 'higher', 'mark', { D1:70, D2:67, D3:67, NAIA:66 }),
      w_sp:    E("Women's Shot Put", 'higher', 'mark', { D1:672, D2:600, D3:541, NAIA:533 }),
    },
  },
  swim: {
    label: 'Swimming (SCY)',
    ladder: LADDER_NCAA,
    note: 'Short Course Yards. Division bars derived from NCSA recruiting-time tiers (2025-26); NCSA notes NAIA tracks roughly with D3.',
    events: {
      m_50f:   E("Men's 50 Free", 'lower', 'time', { D1:20.5, D2:21.1, D3:21.4, NAIA:21.7 }),
      m_100f:  E("Men's 100 Free", 'lower', 'time', { D1:44.9, D2:45.9, D3:46.5, NAIA:47.8 }),
      m_200f:  E("Men's 200 Free", 'lower', 'time', { D1:98.5, D2:100.9, D3:101.8, NAIA:103.8 }),
      m_500f:  E("Men's 500 Free", 'lower', 'time', { D1:267.9, D2:275.5, D3:277.1, NAIA:282.8 }),
      m_100bk: E("Men's 100 Back", 'lower', 'time', { D1:49.0, D2:51.5, D3:52.1, NAIA:53.4 }),
      m_100br: E("Men's 100 Breast", 'lower', 'time', { D1:55.9, D2:58.1, D3:58.7, NAIA:59.8 }),
      m_100fly:E("Men's 100 Fly", 'lower', 'time', { D1:48.9, D2:50.5, D3:51.1, NAIA:52.1 }),
      m_200im: E("Men's 200 IM", 'lower', 'time', { D1:109.5, D2:113.5, D3:115.1, NAIA:117.1 }),
      w_50f:   E("Women's 50 Free", 'lower', 'time', { D1:22.9, D2:23.9, D3:24.1, NAIA:24.5 }),
      w_100f:  E("Women's 100 Free", 'lower', 'time', { D1:49.9, D2:51.9, D3:52.1, NAIA:53.1 }),
      w_200f:  E("Women's 200 Free", 'lower', 'time', { D1:107.9, D2:110.9, D3:112.6, NAIA:113.8 }),
      w_500f:  E("Women's 500 Free", 'lower', 'time', { D1:285.9, D2:299.9, D3:303.5, NAIA:305.1 }),
      w_100bk: E("Women's 100 Back", 'lower', 'time', { D1:53.9, D2:57.1, D3:58.1, NAIA:59.0 }),
      w_100br: E("Women's 100 Breast", 'lower', 'time', { D1:61.9, D2:64.9, D3:66.0, NAIA:66.9 }),
      w_100fly:E("Women's 100 Fly", 'lower', 'time', { D1:53.5, D2:56.5, D3:57.5, NAIA:58.2 }),
      w_200im: E("Women's 200 IM", 'lower', 'time', { D1:119.9, D2:125.0, D3:128.4, NAIA:129.3 }),
    },
  },
  football: {
    label: 'Football (40-yard dash)',
    ladder: LADDER_FB,
    note: 'Benchmarks the 40-yard dash, the cleanest combine measurable, by position (recruiting-service tables, 2026-27). Film and projectability outweigh raw numbers below FBS.',
    hw: {
      QB:{FBS:'6\'2"-6\'6" / 200-230', FCS:'6\'1"-6\'4" / 195-215', D2:'6\'0"-6\'3" / 190-210', 'D3/NAIA':'5\'11"-6\'3" / 185-210'},
      RB:{FBS:'5\'9"-6\'1" / 195-225', FCS:'5\'9"-6\'0" / 190-215', D2:'5\'8"-6\'0" / 185-210', 'D3/NAIA':'5\'8"-6\'0" / 180-210'},
      WR:{FBS:'6\'0"-6\'4" / 180-210', FCS:'5\'11"-6\'3" / 175-205', D2:'5\'10"-6\'3" / 170-200', 'D3/NAIA':'5\'10"-6\'3" / 170-200'},
      OL:{FBS:'6\'4"-6\'8" / 290-325', FCS:'6\'3"-6\'6" / 275-310', D2:'6\'2"-6\'6" / 270-305', 'D3/NAIA':'6\'2"-6\'5" / 260-295'},
      DL:{FBS:'6\'3"-6\'6" / 260-310', FCS:'6\'2"-6\'5" / 250-295', D2:'6\'1"-6\'5" / 240-285', 'D3/NAIA':'6\'1"-6\'4" / 230-280'},
      LB:{FBS:'6\'1"-6\'4" / 220-245', FCS:'6\'0"-6\'3" / 215-240', D2:'5\'11"-6\'2" / 210-235', 'D3/NAIA':'5\'11"-6\'2" / 205-230'},
      DB:{FBS:'5\'10"-6\'2" / 175-205', FCS:'5\'10"-6\'1" / 170-195', D2:'5\'9"-6\'1" / 170-195', 'D3/NAIA':'5\'9"-6\'0" / 165-190'},
    },
    events: {
      QB: E('Quarterback', 'lower', 'dash', { FBS:4.6, FCS:4.7, D2:4.7, 'D3/NAIA':4.8 }),
      RB: E('Running Back', 'lower', 'dash', { FBS:4.4, FCS:4.5, D2:4.5, 'D3/NAIA':4.6 }),
      WR: E('Wide Receiver', 'lower', 'dash', { FBS:4.3, FCS:4.4, D2:4.5, 'D3/NAIA':4.5 }),
      OL: E('Offensive Line', 'lower', 'dash', { FBS:5.0, FCS:5.1, D2:5.2, 'D3/NAIA':5.2 }),
      DL: E('Defensive Line', 'lower', 'dash', { FBS:4.8, FCS:4.9, D2:4.9, 'D3/NAIA':5.0 }),
      LB: E('Linebacker', 'lower', 'dash', { FBS:4.5, FCS:4.6, D2:4.7, 'D3/NAIA':4.7 }),
      DB: E('Defensive Back', 'lower', 'dash', { FBS:4.4, FCS:4.5, D2:4.5, 'D3/NAIA':4.6 }),
    },
  },
};

const fmtVal = (unit, v) => unit === 'mark' ? inToMark(v) : unit === 'dash' ? sec40(v) : secToTime(v);
const better = (dir, a, b) => dir === 'lower' ? a <= b : a >= b;
const gapStr = (dir, unit, athlete, target) => {
  const d = Math.abs(target - athlete);
  if (unit === 'mark') return inToMark(d);
  if (unit === 'dash') return d.toFixed(2) + 's';
  return d < 60 ? d.toFixed(2) + 's' : secToTime(d);
};

function buildBase(sportKey, eventKey, value) {
  const sport = DATA[sportKey];
  const ev = sport.events[eventKey];
  const ladder = sport.ladder;
  const reached = ladder.filter(d => better(ev.dir, value, ev.vals[d]));
  const top = ladder.find(d => reached.includes(d)) || null;
  let hero, heroSub;
  if (!top) {
    const easiest = ladder[ladder.length - 1];
    hero = 'Developing';
    heroSub = 'below the ' + DIV_LABEL[easiest] + ' bar — keep building';
  } else {
    const idx = ladder.indexOf(top);
    const nextUp = idx > 0 ? ladder[idx - 1] : null;
    if (!nextUp) {
      hero = DIV_LABEL[top];
      heroSub = 'at or above the top recruiting bar';
    } else {
      hero = 'High ' + top + ' / Low ' + nextUp;
      heroSub = 'reaches ' + DIV_LABEL[top] + ', approaching ' + DIV_LABEL[nextUp];
    }
  }
  const rows = [{ label: 'Your mark', value: fmtVal(ev.unit, value) + (ev.dir === 'lower' ? ' (lower is better)' : ' (higher is better)'), accent: true }];
  ladder.forEach(d => {
    const meet = better(ev.dir, value, ev.vals[d]);
    rows.push({
      label: DIV_LABEL[d] + ' bar',
      value: fmtVal(ev.unit, ev.vals[d]) + (meet ? '  ✓ you reach this' : '  — ' + gapStr(ev.dir, ev.unit, value, ev.vals[d]) + ' away'),
      accent: meet,
    });
  });
  if (sportKey === 'football' && sport.hw && sport.hw[eventKey] && top && sport.hw[eventKey][top]) {
    rows.push({ label: 'Typical size at ' + DIV_LABEL[top], value: sport.hw[eventKey][top] + ' (ht / wt)', accent: false });
  }
  let nextLevel = null, nextGap = null;
  if (top) {
    const idx = ladder.indexOf(top);
    if (idx > 0) { nextLevel = ladder[idx - 1]; nextGap = gapStr(ev.dir, ev.unit, value, ev.vals[nextLevel]); }
  } else {
    nextLevel = ladder[ladder.length - 1]; nextGap = gapStr(ev.dir, ev.unit, value, ev.vals[nextLevel]);
  }
  const verdict = top
    ? (ladder.indexOf(top) === 0 ? 'Recruitable at the top level' : 'On the board at ' + DIV_LABEL[top])
    : 'Building toward recruitable';
  const first_read = top
    ? 'Your ' + ev.label + ' mark of ' + fmtVal(ev.unit, value) + ' maps to ' + hero + '. ' + (nextLevel ? 'The gap to ' + DIV_LABEL[nextLevel] + ' is ' + nextGap + '.' : 'That is the top recruiting bar in this event.')
    : 'Your ' + ev.label + ' mark of ' + fmtVal(ev.unit, value) + ' is ' + nextGap + ' from the ' + DIV_LABEL[nextLevel] + ' bar. Honest, but there is a clear target to chase.';
  return { sport, ev, ladder, top, hero, heroSub, rows, verdict, first_read, nextLevel, nextGap, value };
}

function templatedReads(b, gradYear) {
  const evl = b.ev.label;
  return {
    stand: 'In ' + evl + ', your number lands at ' + b.hero + '. ' + (b.top ? 'That is a real, honest level coaches recognize, not hype.' : 'You are below the published bars right now, which simply means the work is in front of you, not behind you.'),
    next: b.nextLevel ? 'The realistic next step up is ' + DIV_LABEL[b.nextLevel] + ', about ' + b.nextGap + ' away. With grad year ' + gradYear + ', map that gap to the seasons you have left.' : 'You are already at the top recruiting bar for this event; from here it is about consistency, big meets, and getting in front of the right coaches.',
    coaches: 'Coaches read a number like this as a filter, not a verdict. They pair it with your trend, your competition, and your film. Keep stacking marks and make sure the right programs can actually find them.',
  };
}

async function aiReads(b, gradYear, key) {
  const prompt =
`You are writing three short, honest paragraphs for a parent using an athletic recruiting benchmarking tool. Use ONLY the facts below. Do not invent or change any number, time, mark, or division. Warm, plain, direct. No markdown, no lists, no headers, no em dashes.

FACTS
- Event: ${b.ev.label}.
- Athlete mark: ${fmtVal(b.ev.unit, b.value)} (${b.ev.dir === 'lower' ? 'lower is better' : 'higher is better'}).
- This maps to: ${b.hero}.
- ${b.nextLevel ? 'Next level up is ' + DIV_LABEL[b.nextLevel] + ', about ' + b.nextGap + ' away.' : 'This is at the top recruiting bar for the event.'}
- Graduation year: ${gradYear}.
- A recruiting time/mark is one input coaches use, alongside trend, competition level, and film.

Return ONLY a JSON object, no fences and no preamble, exactly:
{"stand":"2-3 sentences on where the athlete honestly stands","next":"2-3 sentences on the realistic next level and the gap, tied to grad year","coaches":"2-3 sentences on how coaches actually use this number"}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await r.json();
    if (!r.ok || data.error) return null;
    const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    if (!o.stand || !o.next || !o.coaches) return null;
    return { stand: stripTags(o.stand), next: stripTags(o.next), coaches: stripTags(o.coaches) };
  } catch (e) { return null; }
}

async function emailParent({ to, firstName, clean, shareUrl, key, from, replyTo }) {
  const html =
`<div style="font-family:Arial,Helvetica,sans-serif;background:#0A0A0A;color:#FFFFFF;padding:32px;border-radius:4px;max-width:520px;margin:0 auto;border:1px solid #2A2A2A">
  <div style="font-family:monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6f6f6f">Athlete Site / Competitive Benchmarker</div>
  <h1 style="font-size:22px;font-weight:800;margin:14px 0 6px;letter-spacing:-.02em">${firstName}, here is where your athlete actually stands.</h1>
  <p style="font-size:15px;line-height:1.5;color:#B8B8B8;margin:0 0 18px">Your athlete's number, benchmarked against real D1/D2/D3/NAIA recruiting standards.</p>
  <div style="border-left:3px solid #FF4D00;padding-left:14px;margin:0 0 22px">
    <div style="font-size:20px;font-weight:700">${clean.hero}</div>
    <div style="font-size:14px;color:#B8B8B8;margin-top:6px;line-height:1.5">${clean.first_read}</div>
  </div>
  <a href="${shareUrl}" style="display:inline-block;background:#FF4D00;color:#0A0A0A;text-decoration:none;font-family:monospace;font-weight:600;font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:13px 24px;border-radius:2px">View your full breakdown &rarr;</a>
  <p style="font-size:12px;color:#6f6f6f;margin:26px 0 0;line-height:1.5">Standards are recruiting benchmarks, not guarantees; coaches also weigh trend, competition, and film. You can download your card as an image from the link above.</p>
</div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject: `${firstName}, where your athlete stands`, html }),
  });
}

async function notifyInternal({ lead, clean, shareUrl, key, from, notifyTo }) {
  const subject = `[T031 · Competitive Benchmarker] New lead - ${lead.full_name}, ${clean.event_label} ${clean.mark}`;
  const html =
`<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.6">
  <p><b>New Competitive Benchmarker lead.</b></p>
  <p>Name: ${lead.full_name}<br>Email: ${lead.email}<br>Event: ${clean.event_label}<br>Mark: ${clean.mark}<br>Grad year: ${lead.grad_year}</p>
  <p>Maps to: ${clean.hero}</p>
  <p><a href="${shareUrl}">View their card</a></p>
</div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [notifyTo], subject, html }),
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Bad request.' }); }

  const fullName = String(body.full_name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const sport = String(body.sport || '').trim();
  const eventKey = String(body.event || '').trim();
  const metricRaw = String(body.metric || '').trim();
  const gradYear = parseInt(body.grad_year, 10);
  const token = String(body.turnstile_token || '');

  if (!fullName || fullName.length > 80) return json(400, { error: 'Please enter the parent or athlete name.' });
  if (email.length > 120 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Please enter a valid email.' });
  if (!DATA[sport] || !DATA[sport].events[eventKey]) return json(400, { error: 'Please pick a sport and event from the list.' });
  if (!(gradYear >= 2024 && gradYear <= 2035)) return json(400, { error: 'Please enter a graduation year between 2024 and 2035.' });

  const ev = DATA[sport].events[eventKey];
  const value = ev.unit === 'mark' ? parseMark(metricRaw) : parseTime(metricRaw);
  if (!isFinite(value) || value <= 0) return json(400, { error: 'Please enter the metric in the format shown (e.g. 1:58.49, 10.80, 24-1, or 4.62).' });

  const { ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, TURNSTILE_SECRET, DAILY_CAP, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, LEAD_NOTIFY_TO } = process.env;
  const cap = parseInt(DAILY_CAP || '200', 10);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(500, { error: 'The tool is not fully configured yet.' });

  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const base = 'https://' + (event.headers.host || 'competitive-benchmarker.netlify.app');

  if (TURNSTILE_SECRET) {
    try {
      const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
      if (ip) form.append('remoteip', ip);
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
      const j = await r.json();
      if (!j.success) return json(403, { error: 'Could not verify you are human. Please try again.' });
    } catch { return json(403, { error: 'Could not verify you are human. Please try again.' }); }
  }

  const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const countOf = (res) => parseInt((res.headers.get('content-range') || '*/0').split('/')[1] || '0', 10);

  try {
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    const r = await sb(`benchmark_reports?select=id&created_at=gte.${startOfDay.toISOString()}`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
    if (countOf(r) >= cap) return json(429, { error: "We're at capacity for today. Check back tomorrow." });
  } catch (e) {}

  if (ip) {
    try {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const r = await sb(`benchmark_reports?select=id&ip=eq.${encodeURIComponent(ip)}&created_at=gte.${since}`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
      if (countOf(r) >= 4) return json(429, { error: "You've run a few already. Give it a minute." });
    } catch (e) {}
  }

  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = await sb(`benchmark_reports?select=report,token&email=eq.${encodeURIComponent(email)}&sport=eq.${encodeURIComponent(sport)}&event_key=eq.${encodeURIComponent(eventKey)}&metric_raw=eq.${encodeURIComponent(metricRaw)}&created_at=gte.${since}&order=created_at.desc&limit=1`);
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length && rows[0].report) {
      return json(200, { ...rows[0].report, token: rows[0].token || null, share_path: rows[0].token ? `/report.html?t=${rows[0].token}` : null, cached: true });
    }
  } catch (e) {}

  const b = buildBase(sport, eventKey, value);
  let reads = ANTHROPIC_API_KEY ? await aiReads(b, gradYear, ANTHROPIC_API_KEY) : null;
  if (!reads) reads = templatedReads(b, gradYear);

  const cap600 = (s) => stripTags(s).slice(0, 600);
  const clean = {
    event_label: b.ev.label,
    mark: fmtVal(b.ev.unit, b.value),
    who: b.ev.label + ' · ' + fmtVal(b.ev.unit, b.value) + ' · Class of ' + gradYear,
    hero: stripTags(b.hero).slice(0, 40),
    hero_small: b.hero.length > 10,
    hero_sub: stripTags(b.heroSub).slice(0, 80),
    verdict: stripTags(b.verdict).slice(0, 120),
    first_read: stripTags(b.first_read).slice(0, 280),
    rows: b.rows.map(r => ({ label: stripTags(r.label).slice(0, 60), value: stripTags(r.value).slice(0, 160), accent: !!r.accent })),
    reads: [
      { kicker: 'Where you stand', text: cap600(reads.stand) },
      { kicker: 'The next level up', text: cap600(reads.next) },
      { kicker: 'How coaches use it', text: cap600(reads.coaches) },
    ],
  };

  const reportToken = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  try {
    await sb('benchmark_reports', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ full_name: fullName, email, sport, event_key: eventKey, gender: eventKey.startsWith('w_') ? 'F' : (eventKey.startsWith('m_') ? 'M' : null), metric_raw: metricRaw, grad_year: gradYear, verdict: clean.verdict, report: clean, ip: ip || null, token: reportToken }),
    });
  } catch (e) {}

  const shareUrl = `${base}/report.html?t=${reportToken}`;
  if (RESEND_API_KEY) {
    const from = EMAIL_FROM || 'onboarding@resend.dev';
    const replyTo = EMAIL_REPLY_TO || 'keyona@rerev.io';
    const firstName = (fullName.split(' ')[0] || 'there').slice(0, 40);
    try { await emailParent({ to: email, firstName, clean, shareUrl, key: RESEND_API_KEY, from, replyTo }); } catch (e) {}
    try { await notifyInternal({ lead: { full_name: fullName, email, grad_year: gradYear }, clean, shareUrl, key: RESEND_API_KEY, from, notifyTo: LEAD_NOTIFY_TO || replyTo }); } catch (e) {}
  }

  return json(200, { ...clean, token: reportToken, share_path: `/report.html?t=${reportToken}` });
};
