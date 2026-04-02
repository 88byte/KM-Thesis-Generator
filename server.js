import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ─────────────────────────────────────────────────────────────────
function safeParseJSON(raw) {
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    let repaired = clean.replace(/,\s*$/, '');
    const openObj = (repaired.match(/\{/g)||[]).length - (repaired.match(/\}/g)||[]).length;
    const openArr = (repaired.match(/\[/g)||[]).length - (repaired.match(/\]/g)||[]).length;
    repaired += ']'.repeat(Math.max(0, openArr)) + '}'.repeat(Math.max(0, openObj));
    return JSON.parse(repaired); // throws if still broken
  }
}

async function callClaude(system, user) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return message.content.map(b => b.text || '').join('');
}

// ── Google Drive ─────────────────────────────────────────────────────────────
async function saveThesisToDrive(name, htmlContent) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_DRIVE_FOLDER_ID) {
    console.log('Google Drive not configured — skipping.');
    return null;
  }
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${name.replace(/\s+/g, '_')}_${date}_Thesis Report.html`;
  const response = await drive.files.create({
    requestBody: { name: fileName, mimeType: 'text/html', parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'text/html', body: htmlContent },
  });
  console.log('Saved to Drive:', fileName);
  return response.data.id;
}

// ── Main route ───────────────────────────────────────────────────────────────
app.post('/generate-thesis', async (req, res) => {
  const profile = req.body;
  if (!profile || !profile.name) return res.status(400).json({ error: 'Missing profile data.' });
  console.log('Generating thesis for:', profile.name);

  const profileBlock = `Name: ${profile.name}
Profession: ${profile.profession}
Location: ${profile.location}
Capital Available: ${profile.capital}
Income Goal: ${profile.income}
Unique Edge: ${profile.edge}
Business Ownership History: ${profile.owned}
Target Categories: ${profile.categories.join(', ')}
Timeline: ${profile.timeline}
Debt Comfort: ${profile.debt}
Geographic Focus: ${profile.geo}
Motivation: ${profile.motivation}
Biggest Obstacle: ${profile.obstacle}
${profile.extras ? 'Additional Notes: ' + profile.extras : ''}`;

  const firstName = profile.name.split(' ')[0];
  const baseInstruction = `You are Kyle Mallien's senior acquisition strategist. Kyle is an INC 5000 entrepreneur and acquisition mentor. His methodology: F.U.E.L. (Find, Underwrite, Elevate, Legacy). Buy box: service-based, recession-proof, 10+ years operating, 10+ employees, $1M–$5M revenue, 20%+ margins, SBA 7(a), retiring founder ages 58–70. Return ONLY raw JSON — no markdown, no backticks, no preamble. Be hyper-specific to ${firstName}'s profile in every field.`;

  // ── CALL 1: Strategic narrative + roadmap ──────────────────────────────────
  const system1 = `${baseInstruction}

Return this exact JSON structure:
{
  "metrics": { "revenue": "$X–$Y", "margin": "X–Y%", "income": "$XXX,XXX+", "timeline": "X–X Months" },
  "thesis_overview": "<p>paragraph 1</p><p>paragraph 2</p><p>paragraph 3</p>",
  "unfair_advantages": [
    {"title": "...", "body": "..."},
    {"title": "...", "body": "..."},
    {"title": "...", "body": "..."},
    {"title": "...", "body": "..."}
  ],
  "target_verticals": [
    {"rank": 1, "vertical": "...", "margin": "X–Y%", "why": "..."},
    {"rank": 2, "vertical": "...", "margin": "X–Y%", "why": "..."},
    {"rank": 3, "vertical": "...", "margin": "X–Y%", "why": "..."},
    {"rank": 4, "vertical": "...", "margin": "X–Y%", "why": "..."},
    {"rank": 5, "vertical": "...", "margin": "X–Y%", "why": "..."}
  ],
  "roadmap": {
    "days_1_30": {
      "objective": "one sentence...",
      "actions": [
        {"days": "Days 1–5", "action": "..."},
        {"days": "Days 5–10", "action": "..."},
        {"days": "Days 10–15", "action": "..."},
        {"days": "Days 15–20", "action": "..."},
        {"days": "Days 20–25", "action": "..."},
        {"days": "Days 25–30", "action": "..."}
      ]
    },
    "days_31_70": {
      "objective": "one sentence...",
      "actions": [
        {"days": "Days 31–40", "action": "..."},
        {"days": "Days 40–50", "action": "..."},
        {"days": "Days 45–55", "action": "..."},
        {"days": "Days 50–60", "action": "..."},
        {"days": "Days 55–65", "action": "..."},
        {"days": "Days 60–70", "action": "..."}
      ]
    },
    "days_71_100": {
      "objective": "one sentence...",
      "actions": [
        {"days": "Days 71–80", "action": "..."},
        {"days": "Days 78–85", "action": "..."},
        {"days": "Day 85", "action": "CLOSE — wire funds, transfer ownership, begin Day 1 integration"},
        {"days": "Week 1 Post-Close", "action": "..."},
        {"days": "Week 2 Post-Close", "action": "..."},
        {"days": "Month 1 Post-Close", "action": "..."}
      ]
    }
  },
  "closing_insight": "one powerful paragraph..."
}`;

  // ── CALL 2: Scripts + tables ───────────────────────────────────────────────
  const system2 = `${baseInstruction}

Return this exact JSON structure:
{
  "scripts": {
    "ceo_letter": {
      "label": "CEO Personal Letter — Physical Mail",
      "subject": "",
      "body": "full personalized letter text, signed ${firstName}..."
    },
    "email_followup": {
      "label": "Email Follow-Up — Day 7 After Letter",
      "subject": "Following up on my letter — [Business Name]",
      "body": "short follow-up email text, signed ${firstName}..."
    },
    "discovery_call": {
      "label": "Discovery Call Framework — 20 Minutes",
      "subject": "",
      "body": "OPENER (2 min): script...\\n\\nLEARN (8 min): questions...\\n\\nEDUCATE (6 min): script...\\n\\nCLOSE (4 min): script..."
    },
    "seller_intro": {
      "label": "Seller Introduction to Customers — Joint Letter",
      "subject": "An important message about [Business Name]",
      "body": "joint letter from seller and ${firstName} to existing customers..."
    }
  },
  "deal_structure": [
    {"component": "Cash at Close", "target": "60–70%", "purpose": "Gives seller certainty — competitive vs. broker deals"},
    {"component": "Earnout (12–24 mo)", "target": "20–30%", "purpose": "Bridges valuation gap, keeps owner engaged post-close"},
    {"component": "Seller Note (3–5 yr)", "target": "10%", "purpose": "Aligns seller with long-term success. Subordinated debt."},
    {"component": "EBITDA Multiple", "target": "3–5x", "purpose": "Sweet spot for asset-light service businesses under $5M"},
    {"component": "Deal Structure", "target": "Asset Deal", "purpose": "Step-up in tax basis. Maximizes FF&E depreciation."},
    {"component": "Owner Transition", "target": "12–24 Months", "purpose": "Customer retention and knowledge transfer post-close"}
  ],
  "valuation_model": [
    {"revenue": "$1,000,000", "ebitda_20": "$200,000", "ebitda_25": "$250,000", "at_3x": "$600K – $750K", "at_5x": "$1.0M – $1.25M"},
    {"revenue": "$2,000,000", "ebitda_20": "$400,000", "ebitda_25": "$500,000", "at_3x": "$1.2M – $1.5M", "at_5x": "$2.0M – $2.5M"},
    {"revenue": "$3,000,000", "ebitda_20": "$600,000", "ebitda_25": "$750,000", "at_3x": "$1.8M – $2.25M", "at_5x": "$3.0M – $3.75M"},
    {"revenue": "$5,000,000", "ebitda_20": "$1,000,000", "ebitda_25": "$1,250,000", "at_3x": "$3.0M – $3.75M", "at_5x": "$5.0M – $6.25M"}
  ],
  "value_creation_levers": [
    {"title": "...", "body": "specific lever for ${firstName}..."},
    {"title": "...", "body": "..."},
    {"title": "...", "body": "..."},
    {"title": "...", "body": "..."}
  ],
  "sba_financing": [
    {"deal_size": "$1,000,000", "down_10": "$100,000", "seller_note_10": "$100,000", "sba_80": "$800,000"},
    {"deal_size": "$2,000,000", "down_10": "$200,000", "seller_note_10": "$200,000", "sba_80": "$1,600,000"},
    {"deal_size": "$3,500,000", "down_10": "$350,000", "seller_note_10": "$350,000", "sba_80": "$2,800,000"},
    {"deal_size": "$5,000,000", "down_10": "$500,000", "seller_note_10": "$500,000", "sba_80": "$4,000,000"}
  ],
  "milestones": [
    {"day": "Day 30", "milestone": "..."},
    {"day": "Day 45", "milestone": "..."},
    {"day": "Day 60", "milestone": "..."},
    {"day": "Day 75", "milestone": "..."},
    {"day": "Day 90", "milestone": "..."},
    {"day": "Day 100", "milestone": "..."}
  ],
  "next_steps": [
    {"timeframe": "This Week", "action": "..."},
    {"timeframe": "Week 2", "action": "..."},
    {"timeframe": "Week 3", "action": "..."},
    {"timeframe": "Week 4", "action": "..."},
    {"timeframe": "Month 2", "action": "..."},
    {"timeframe": "Month 3", "action": "..."}
  ]
}`;

  try {
    // Run both calls in parallel
    console.log('Running two parallel API calls...');
    const [raw1, raw2] = await Promise.all([
      callClaude(system1, `Generate Call 1 JSON for this attendee:\n\n${profileBlock}`),
      callClaude(system2, `Generate Call 2 JSON for this attendee:\n\n${profileBlock}`)
    ]);

    const part1 = safeParseJSON(raw1);
    const part2 = safeParseJSON(raw2);

    // Merge into single thesis object
    const thesis = { ...part1, ...part2 };
    console.log('Thesis generated for', profile.name);

    let driveFileId = null;
    try {
      const driveHtml = buildDriveHtml(profile.name, thesis);
      driveFileId = await saveThesisToDrive(profile.name, driveHtml);
    } catch (driveErr) {
      console.error('Drive upload failed (non-fatal):', driveErr.message);
    }

    res.json({ thesis, driveFileId });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Failed to generate thesis.', detail: err.message });
  }
});

function buildDriveHtml(name, t) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name} — Acquisition Thesis</title>
<style>
body{font-family:Georgia,serif;max-width:900px;margin:40px auto;color:#1a1a1a;line-height:1.7;padding:0 40px}
h1{font-size:32px;margin-bottom:4px}
h2{font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#8B6914;margin-top:48px;border-bottom:2px solid #e8e0d0;padding-bottom:8px}
h3{font-size:18px;margin:20px 0 8px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e8e0d0;border:1px solid #e8e0d0;margin:24px 0}
.metric{background:#fff;padding:20px;text-align:center}
.metric-val{font-size:20px;font-weight:700;color:#8B6914;display:block;margin-bottom:4px}
.metric-lbl{font-size:10px;text-transform:uppercase;color:#888;letter-spacing:0.1em}
table{width:100%;border-collapse:collapse;margin:20px 0;font-size:14px}
th{background:#f5f0e8;padding:10px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#8B6914;border-bottom:2px solid #e8e0d0}
td{padding:11px 14px;border-bottom:1px solid #e8e0d0}
.advantage{border-left:3px solid #C9A84C;padding:14px 18px;margin:12px 0;background:#fafaf5}
.advantage-title{font-weight:700;font-size:13px;letter-spacing:0.05em;color:#8B6914;margin-bottom:4px}
.phase{background:#f5f0e8;border-left:4px solid #C9A84C;padding:20px 24px;margin:20px 0}
.phase-title{font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:#8B6914;font-weight:700;margin-bottom:8px}
.script-box{background:#fffdf5;border:1px solid #e8e0d0;padding:20px 24px;margin:16px 0;white-space:pre-wrap;font-family:Georgia,serif;font-size:15px;line-height:1.7}
.script-label{font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#8B6914;font-weight:700;margin-bottom:10px}
blockquote{border-left:4px solid #C9A84C;margin:32px 0;padding:16px 24px;background:#f5edd8;font-style:italic;font-size:17px}
</style></head><body>
<h1>${name}'s 100-Day Acquisition Roadmap</h1>
<p style="color:#888;font-size:13px">Kyle Mallien · Elite Wealth Club · ${new Date().toLocaleDateString()}</p>
<div class="metrics">
<div class="metric"><span class="metric-val">${t.metrics?.revenue||''}</span><div class="metric-lbl">Target Revenue</div></div>
<div class="metric"><span class="metric-val">${t.metrics?.margin||''}</span><div class="metric-lbl">Profit Margin</div></div>
<div class="metric"><span class="metric-val">${t.metrics?.income||''}</span><div class="metric-lbl">Income Goal</div></div>
<div class="metric"><span class="metric-val">${t.metrics?.timeline||''}</span><div class="metric-lbl">Timeline</div></div>
</div>
<h2>Thesis Overview</h2>${t.thesis_overview||''}
<h2>Unfair Advantages</h2>${(t.unfair_advantages||[]).map(a=>`<div class="advantage"><div class="advantage-title">${a.title}</div><div>${a.body}</div></div>`).join('')}
<h2>Target Verticals — Ranked by Fit</h2>
<table><thead><tr><th>Rank</th><th>Vertical</th><th>Margin</th><th>Why It Fits</th></tr></thead><tbody>
${(t.target_verticals||[]).map(v=>`<tr><td>#${v.rank}</td><td>${v.vertical}</td><td>${v.margin}</td><td>${v.why}</td></tr>`).join('')}
</tbody></table>
<h2>100-Day Roadmap</h2>
${['days_1_30','days_31_70','days_71_100'].map((k,i)=>{const ph=t.roadmap?.[k];const labels=['F — FIND (Days 1–30)','U — UNDERWRITE (Days 31–70)','E+L — ELEVATE & LEGACY (Days 71–100)'];return ph?`<div class="phase"><div class="phase-title">${labels[i]}</div><p><em>${ph.objective}</em></p><table><thead><tr><th>Days</th><th>Action</th></tr></thead><tbody>${(ph.actions||[]).map(a=>`<tr><td style="white-space:nowrap;width:130px">${a.days}</td><td>${a.action}</td></tr>`).join('')}</tbody></table></div>`:''}).join('')}
<h2>Outreach Scripts</h2>
${Object.values(t.scripts||{}).map(s=>`<div class="script-label">${s.label}${s.subject?` — Subject: ${s.subject}`:''}</div><div class="script-box">${s.body}</div>`).join('')}
<h2>Deal Structure</h2>
<table><thead><tr><th>Component</th><th>Target</th><th>Purpose</th></tr></thead><tbody>
${(t.deal_structure||[]).map(d=>`<tr><td>${d.component}</td><td>${d.target}</td><td>${d.purpose}</td></tr>`).join('')}
</tbody></table>
<h2>Valuation & Income Model</h2>
<table><thead><tr><th>Revenue</th><th>EBITDA (20%)</th><th>EBITDA (25%)</th><th>Purchase @ 3x</th><th>Purchase @ 5x</th></tr></thead><tbody>
${(t.valuation_model||[]).map(v=>`<tr><td>${v.revenue}</td><td>${v.ebitda_20}</td><td>${v.ebitda_25}</td><td>${v.at_3x}</td><td>${v.at_5x}</td></tr>`).join('')}
</tbody></table>
<h2>Value Creation Levers</h2>${(t.value_creation_levers||[]).map(l=>`<div class="advantage"><div class="advantage-title">${l.title}</div><div>${l.body}</div></div>`).join('')}
<h2>SBA 7(a) Financing</h2>
<table><thead><tr><th>Deal Size</th><th>Down (10%)</th><th>Seller Note (10%)</th><th>SBA Loan (80%)</th></tr></thead><tbody>
${(t.sba_financing||[]).map(s=>`<tr><td>${s.deal_size}</td><td>${s.down_10}</td><td>${s.seller_note_10}</td><td>${s.sba_80}</td></tr>`).join('')}
</tbody></table>
<h2>Key Milestones</h2>
<table><thead><tr><th>Day</th><th>Milestone</th></tr></thead><tbody>
${(t.milestones||[]).map(m=>`<tr><td style="white-space:nowrap;width:80px">${m.day}</td><td>${m.milestone}</td></tr>`).join('')}
</tbody></table>
<h2>Immediate Next Steps</h2>
<table><thead><tr><th>Timeframe</th><th>Action</th></tr></thead><tbody>
${(t.next_steps||[]).map(n=>`<tr><td style="white-space:nowrap;width:100px">${n.timeframe}</td><td>${n.action}</td></tr>`).join('')}
</tbody></table>
<blockquote>${t.closing_insight||''}</blockquote>
<p style="text-align:center;color:#aaa;font-size:11px;margin-top:48px;border-top:1px solid #eee;padding-top:16px">Confidential · Prepared Exclusively for ${name} · Kyle Mallien · kylemallien.com</p>
</body></html>`;
}

app.get('/health', (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('Kyle Mallien Thesis API running on port', PORT);
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
  console.log('Google Drive:', process.env.GOOGLE_DRIVE_FOLDER_ID ? 'configured' : 'not configured');
});
