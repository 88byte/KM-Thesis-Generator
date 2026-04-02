import express from 'express';
import { jsonrepair } from 'jsonrepair';
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

// ── Request Queue ─────────────────────────────────────────────────────────────
const MAX_CONCURRENT = 1; // Tier 1: 40k TPM — one report at a time (~20k tokens each)
const RETRY_ATTEMPTS = 4; // More retries since queue is tight
const RETRY_DELAY_MS = 60000; // 60s — full TPM window recovery between retries
let activeCount = 0;
const waitQueue = [];

function acquireSlot() {
  return new Promise(resolve => {
    if (activeCount < MAX_CONCURRENT) { activeCount++; resolve(); }
    else { waitQueue.push(resolve); }
  });
}

function releaseSlot() {
  activeCount--;
  if (waitQueue.length > 0) { activeCount++; waitQueue.shift()(); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeParseJSON(raw) {
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(jsonrepair(clean)); }
  catch (e) { console.error('JSON repair failed:', e.message.slice(0, 100)); throw e; }
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

async function callClaudeWithRetry(system, user) {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try { return await callClaude(system, user); }
    catch (err) {
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('rate'));
      if (isRateLimit && attempt < RETRY_ATTEMPTS) {
        const wait = RETRY_DELAY_MS * attempt;
        console.log(`Rate limited — retrying in ${wait/1000}s (attempt ${attempt}/${RETRY_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, wait));
      } else { throw err; }
    }
  }
}

// ── Google Drive ──────────────────────────────────────────────────────────────
async function htmlToPdf(htmlContent) {
  if (!process.env.PDFSHIFT_API_KEY) { console.log('PDFSHIFT_API_KEY not set — skipping.'); return null; }
  const response = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from('api:' + process.env.PDFSHIFT_API_KEY).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ source: htmlContent, landscape: false, use_print: true, margin: { top:'18mm', right:'18mm', bottom:'18mm', left:'18mm' } })
  });
  if (!response.ok) throw new Error('PDFShift error: ' + await response.text());
  return Buffer.from(await response.arrayBuffer());
}

async function saveThesisToDrive(name, htmlContent) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN || !process.env.GOOGLE_DRIVE_FOLDER_ID) {
    console.log('Google Drive not configured — skipping.'); return null;
  }
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const date = new Date().toISOString().slice(0, 10);
  let uploadBody = htmlContent, mimeType = 'text/html', ext = 'html';
  try {
    const pdfBuffer = await htmlToPdf(htmlContent);
    if (pdfBuffer) { uploadBody = pdfBuffer; mimeType = 'application/pdf'; ext = 'pdf'; console.log('PDF generated (' + pdfBuffer.length + ' bytes)'); }
  } catch (pdfErr) { console.error('PDFShift failed, falling back to HTML:', pdfErr.message); }
  const fileName = `${name.replace(/\s+/g, '_')}_${date}_Thesis Report.${ext}`;
  const { Readable } = await import('stream');
  const bodyStream = uploadBody instanceof Buffer ? Readable.from(uploadBody) : uploadBody;
  const response = await drive.files.create({
    requestBody: { name: fileName, mimeType, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType, body: bodyStream },
  });
  console.log('Saved to Drive:', fileName);
  return response.data.id;
}

// ── Main route ────────────────────────────────────────────────────────────────
app.post('/generate-thesis', async (req, res) => {
  const profile = req.body;
  if (!profile || !profile.name) return res.status(400).json({ error: 'Missing profile data.' });
  console.log('Received request for:', profile.name);

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

  const system2 = `${baseInstruction}

CRITICAL: All string values in the JSON must use \\n for line breaks. Never use real newline characters inside a JSON string value — that breaks JSON parsing.

Return this exact JSON structure:
{
  "scripts": {
    "ceo_letter": { "label": "CEO Personal Letter — Physical Mail", "subject": "", "body": "full personalized letter signed ${firstName}..." },
    "email_followup": { "label": "Email Follow-Up — Day 7 After Letter", "subject": "Following up on my letter — [Business Name]", "body": "short follow-up signed ${firstName}..." },
    "discovery_call": { "label": "Discovery Call Framework — 20 Minutes", "subject": "", "body": "OPENER (2 min): script...\\n\\nLEARN (8 min): questions...\\n\\nEDUCATE (6 min): script...\\n\\nCLOSE (4 min): script..." },
    "seller_intro": { "label": "Seller Introduction to Customers — Joint Letter", "subject": "An important message about [Business Name]", "body": "joint letter from seller and ${firstName}..." }
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

  // Respond immediately so the thank-you page shows without waiting
  res.json({ queued: true, name: profile.name });

  // Process in background with queue
  (async () => {
    if (activeCount >= MAX_CONCURRENT) {
      console.log(`Queuing for ${profile.name} — position ${waitQueue.length + 1}`);
    }
    await acquireSlot();

    let raw1, raw2;
    try {
      console.log(`Generating thesis for ${profile.name} (active: ${activeCount}/${MAX_CONCURRENT})`);
      [raw1, raw2] = await Promise.all([
        callClaudeWithRetry(system1, `Generate Call 1 JSON for this attendee:\n\n${profileBlock}`),
        callClaudeWithRetry(system2, `Generate Call 2 JSON for this attendee:\n\n${profileBlock}`)
      ]);
    } finally {
      releaseSlot();
    }

    try {
      const part1 = safeParseJSON(raw1);
      const part2 = safeParseJSON(raw2);
      const thesis = { ...part1, ...part2 };
      console.log('Thesis generated for', profile.name);

      const driveHtml = buildDriveHtml(profile.name, thesis);
      await saveThesisToDrive(profile.name, driveHtml);
    } catch (err) {
      console.error('Generation failed for', profile.name, ':', err.message);
    }
  })();
});

function buildDriveHtml(name, t) {
  const today = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  const phaseConfig = [
    {key:'days_1_30', letter:'F', days:'Days 1–30', name:'FIND — Build Your Pipeline'},
    {key:'days_31_70', letter:'U', days:'Days 31–70', name:'UNDERWRITE — Qualify, Discover & Structure'},
    {key:'days_71_100', letter:'E+L', days:'Days 71–100', name:'ELEVATE & LEGACY — Close, Integrate & Build Wealth'}
  ];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${name} — 100-Day Acquisition Roadmap</title>
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Montserrat:wght@400;500;600;700;800&family=Cinzel:wght@400;600;700&display=swap" rel="stylesheet">
<style>
@page{size:A4 portrait;margin:16mm 18mm}@page :first{margin:0}*,*::before,*::after{box-sizing:border-box}body{font-family:'Lora',Georgia,serif;font-size:10pt;line-height:1.75;color:#1A1714;background:#fff;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover{width:210mm;height:297mm;display:flex;flex-direction:column;justify-content:space-between;padding:22mm 20mm 18mm;background:#0E0E0E;color:#F0EAD6;page-break-after:always}
.cover-eyebrow{font-family:'Montserrat',sans-serif;font-size:7pt;letter-spacing:0.12em;text-transform:uppercase;color:#C9A84C;margin-bottom:28px}
.cover-name{font-family:'Cinzel',serif;font-size:32pt;font-weight:700;line-height:1.05;color:#C9A84C;margin-bottom:8px;word-break:break-word}
.cover-title{font-family:'Lora',serif;font-size:14pt;font-style:italic;color:rgba(240,234,214,0.7);margin-bottom:5px}
.cover-sub{font-family:'Montserrat',sans-serif;font-size:8pt;color:rgba(240,234,214,0.4);letter-spacing:0.06em}
.cover-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:rgba(201,168,76,0.2);border:1px solid rgba(201,168,76,0.2);margin-top:32px}
.cover-metric{background:rgba(255,255,255,0.04);padding:14px 10px;text-align:center}
.cover-metric-val{font-family:'Cinzel',serif;font-size:12pt;font-weight:600;color:#C9A84C;display:block;margin-bottom:4px}
.cover-metric-lbl{font-family:'Montserrat',sans-serif;font-size:6.5pt;letter-spacing:0.1em;text-transform:uppercase;color:rgba(240,234,214,0.4)}
.cover-fuel{font-family:'Montserrat',sans-serif;font-size:7.5pt;letter-spacing:0.12em;color:rgba(201,168,76,0.4);text-transform:uppercase;margin-top:16px;white-space:nowrap}
.cover-conf{font-family:'Montserrat',sans-serif;font-size:7pt;color:rgba(240,234,214,0.2);letter-spacing:0.06em}
.toc{padding:10mm 0 8mm}.section-eyebrow{font-family:'Montserrat',sans-serif;font-size:7pt;letter-spacing:0.25em;text-transform:uppercase;color:#8B6914;font-weight:700;margin-bottom:14px;padding-bottom:7px;border-bottom:2px solid #E8E0D0}
.toc-row{display:flex;align-items:baseline;padding:6px 0;border-bottom:1px solid #EEE8DC}
.toc-num{font-family:'Cinzel',serif;font-size:8.5pt;color:#8B6914;font-weight:600;min-width:30px}
.toc-label{font-family:'Montserrat',sans-serif;font-size:9pt;color:#3A3530;font-weight:500}
.section{margin-bottom:24px}.section-header{display:flex;align-items:center;gap:10px;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #E8E0D0;margin-top:24px}
.section-num{font-family:'Cinzel',serif;font-size:8.5pt;color:#8B6914;font-weight:600;min-width:22px}
.section-title{font-family:'Montserrat',sans-serif;font-size:8.5pt;letter-spacing:0.2em;text-transform:uppercase;color:#8B6914;font-weight:700}
p{margin:0 0 10px;font-size:10pt;line-height:1.78}strong{font-weight:600}
.criteria{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#E8E0D0;border:1px solid #E8E0D0;margin:12px 0}
.criteria-cell{background:#fff;padding:12px;text-align:center}.criteria-val{font-family:'Cinzel',serif;font-size:11pt;font-weight:600;color:#8B6914;display:block;margin-bottom:3px}
.criteria-lbl{font-family:'Montserrat',sans-serif;font-size:6.5pt;letter-spacing:0.12em;text-transform:uppercase;color:#A09070}
.advantage{border-left:3px solid #C9A84C;padding:10px 14px;margin:8px 0;background:#FAFAF5;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.advantage-title{font-family:'Montserrat',sans-serif;font-size:8.5pt;font-weight:700;color:#8B6914;margin-bottom:4px}
.advantage-body{font-size:9.5pt;line-height:1.72;color:#3A3530}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:9pt}thead{display:table-header-group}
thead th{background:#F0E8D5;padding:8px 10px;text-align:left;font-family:'Montserrat',sans-serif;font-size:7pt;letter-spacing:0.1em;text-transform:uppercase;color:#8B6914;font-weight:700;border-bottom:2px solid #D4C4A0}
tbody tr:nth-child(even) td{background:#FAFAF5}tbody tr:last-child td{background:#F5EDD8;font-weight:600;color:#6B4F10}
td{padding:8px 10px;border-bottom:1px solid #EEE8DC;color:#2A2520;line-height:1.55;vertical-align:top}
tr{break-inside:avoid;page-break-inside:avoid}
.phase{border:1px solid #E8E0D0;margin-bottom:16px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.phase-header{background:#F0E8D5;padding:10px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #E8E0D0;break-inside:avoid;page-break-inside:avoid}
.phase-letter{font-family:'Cinzel',serif;font-size:20pt;font-weight:700;color:#8B6914;line-height:1;min-width:28px}
.phase-days{font-family:'Montserrat',sans-serif;font-size:6.5pt;letter-spacing:0.15em;text-transform:uppercase;color:#A09070;font-weight:700}
.phase-name{font-family:'Montserrat',sans-serif;font-size:8.5pt;font-weight:700;color:#2A2520}
.phase-objective{padding:9px 16px;font-size:9pt;font-style:italic;color:#5A504A;border-bottom:1px solid #E8E0D0;background:#FDFAF4}
.phase table{margin:0}.phase thead th{font-size:6.5pt}.phase td{font-size:9pt}
.script{border:1px solid #E8E0D0;margin-bottom:16px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.script-label{background:#F0E8D5;padding:8px 14px;font-family:'Montserrat',sans-serif;font-size:7pt;letter-spacing:0.15em;text-transform:uppercase;color:#8B6914;font-weight:700;border-bottom:1px solid #E8E0D0;break-after:avoid;page-break-after:avoid}
.script-subject{padding:7px 14px;font-family:'Montserrat',sans-serif;font-size:8.5pt;font-weight:600;color:#3A3530;border-bottom:1px solid #E8E0D0;background:#FAFAF5;break-after:avoid;page-break-after:avoid}
.script-subject span{color:#8B6914}.script-body{padding:14px 16px;font-size:9.5pt;line-height:1.82;color:#1A1714;white-space:pre-wrap;word-wrap:break-word}
.closing{border-left:4px solid #C9A84C;padding:14px 18px;background:#F5EDD8;margin:24px 0;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.closing p{font-size:10.5pt;font-style:italic;line-height:1.75;margin:0}
.doc-footer{text-align:center;margin-top:32px;padding-top:12px;border-top:1px solid #E8E0D0;font-family:'Montserrat',sans-serif;font-size:7pt;color:#B0A890;letter-spacing:0.08em}
p{orphans:3;widows:3}h2,h3,.section-header,.phase-header,.script-label,.advantage-title{break-after:avoid;page-break-after:avoid}
</style></head><body>
<div class="cover"><div>
<div class="cover-eyebrow">F.U.E.L. · Elite Wealth Club · Carlsbad · ${today}</div>
<div class="cover-name">${name}</div>
<div class="cover-title">100-Day Acquisition Roadmap</div>
<div class="cover-sub">${t.metrics?.revenue||'$1M–$5M'} Target · ${t.metrics?.margin||'20%+'} Margins · Kyle Mallien Methodology</div>
<div class="cover-metrics">
<div class="cover-metric"><span class="cover-metric-val">${t.metrics?.revenue||'—'}</span><div class="cover-metric-lbl">Target Revenue</div></div>
<div class="cover-metric"><span class="cover-metric-val">${t.metrics?.margin||'—'}</span><div class="cover-metric-lbl">Profit Margin</div></div>
<div class="cover-metric"><span class="cover-metric-val">${t.metrics?.income||'—'}</span><div class="cover-metric-lbl">Income Goal</div></div>
<div class="cover-metric"><span class="cover-metric-val">${t.metrics?.timeline||'—'}</span><div class="cover-metric-lbl">Timeline</div></div>
</div>
<div class="cover-fuel">F · Find &nbsp; U · Underwrite &nbsp; E · Elevate &nbsp; L · Legacy</div>
</div><div class="cover-conf">Confidential · Prepared Exclusively for ${name} · Kyle Mallien · kylemallien.com · ${today}</div></div>
<div class="toc"><div class="section-eyebrow">Table of Contents</div>
${[['01','Thesis Overview'],['02','Acquisition Criteria'],['03','Your Unfair Advantages'],['04','Target Verticals — Ranked by Fit'],['05','100-Day Acquisition Roadmap'],['06','Outreach Scripts & Templates'],['07','Deal Structure Framework'],['08','Valuation & Income Model'],['09','Post-Acquisition Value Creation'],['10','SBA 7(a) Financing Path'],['11','Key Milestones & Success Metrics'],['12','Immediate Next Steps']].map(([n,l])=>`<div class="toc-row"><span class="toc-num">${n}</span><span class="toc-label">${l}</span></div>`).join('')}
</div>
<div class="section"><div class="section-header"><span class="section-num">01</span><span class="section-title">Thesis Overview</span></div>${t.thesis_overview||''}</div>
<div class="section"><div class="section-header"><span class="section-num">02</span><span class="section-title">Acquisition Criteria</span></div>
<p>Every deal must pass Kyle's buy box before an LOI is submitted. These are the non-negotiables.</p>
<div class="criteria">
<div class="criteria-cell"><span class="criteria-val">$1M – $5M</span><div class="criteria-lbl">Target Revenue</div></div>
<div class="criteria-cell"><span class="criteria-val">20 – 30%</span><div class="criteria-lbl">Profit Margins</div></div>
<div class="criteria-cell"><span class="criteria-val">10+ Years</span><div class="criteria-lbl">Operating History</div></div>
<div class="criteria-cell"><span class="criteria-val">10+ Staff</span><div class="criteria-lbl">Team in Place</div></div>
<div class="criteria-cell"><span class="criteria-val">SBA 7(a)</span><div class="criteria-lbl">Financing Path</div></div>
<div class="criteria-cell"><span class="criteria-val">Ages 58–70</span><div class="criteria-lbl">Seller Profile</div></div>
</div></div>
<div class="section"><div class="section-header"><span class="section-num">03</span><span class="section-title">Your Unfair Advantages</span></div>
${(t.unfair_advantages||[]).map(a=>`<div class="advantage"><div class="advantage-title">${a.title}</div><div class="advantage-body">${a.body}</div></div>`).join('')}</div>
<div class="section"><div class="section-header"><span class="section-num">04</span><span class="section-title">Target Verticals — Ranked by Fit</span></div>
<table><thead><tr><th style="width:22px">Rank</th><th style="width:130px">Vertical</th><th style="width:55px">Margin</th><th>Why It Fits</th></tr></thead><tbody>
${(t.target_verticals||[]).map(v=>`<tr><td style="font-family:'Cinzel',serif;color:#8B6914;font-weight:600">#${v.rank}</td><td><strong>${v.vertical}</strong></td><td>${v.margin}</td><td>${v.why}</td></tr>`).join('')}
</tbody></table></div>
<div class="section"><div class="section-header"><span class="section-num">05</span><span class="section-title">100-Day Acquisition Roadmap</span></div>
${phaseConfig.map(p=>{const ph=(t.roadmap||{})[p.key];return ph?`<div class="phase"><div class="phase-header"><div class="phase-letter">${p.letter}</div><div><div class="phase-days">${p.days}</div><div class="phase-name">${p.name}</div></div></div><div class="phase-objective">${ph.objective}</div><table><thead><tr><th style="width:90px">Days</th><th>Action</th></tr></thead><tbody>${(ph.actions||[]).map(a=>`<tr><td style="font-weight:600;color:#8B6914;white-space:nowrap">${a.days}</td><td>${a.action}</td></tr>`).join('')}</tbody></table></div>`:''}).join('')}</div>
<div class="section"><div class="section-header"><span class="section-num">06</span><span class="section-title">Outreach Scripts &amp; Templates</span></div>
${Object.values(t.scripts||{}).map(s=>`<div class="script"><div class="script-label">${s.label}</div>${s.subject?`<div class="script-subject"><span>Subject:</span> ${s.subject}</div>`:''}<div class="script-body">${s.body}</div></div>`).join('')}</div>
<div class="section"><div class="section-header"><span class="section-num">07</span><span class="section-title">Deal Structure Framework</span></div>
<table><thead><tr><th style="width:120px">Component</th><th style="width:80px">Target</th><th>Purpose</th></tr></thead><tbody>
${(t.deal_structure||[]).map(d=>`<tr><td><strong>${d.component}</strong></td><td>${d.target}</td><td>${d.purpose}</td></tr>`).join('')}</tbody></table></div>
<div class="section"><div class="section-header"><span class="section-num">08</span><span class="section-title">Valuation &amp; Income Model</span></div>
<table><thead><tr><th>Revenue</th><th>EBITDA (20%)</th><th>EBITDA (25%)</th><th>Purchase @ 3x</th><th>Purchase @ 5x</th></tr></thead><tbody>
${(t.valuation_model||[]).map(v=>`<tr><td>${v.revenue}</td><td>${v.ebitda_20}</td><td>${v.ebitda_25}</td><td>${v.at_3x}</td><td>${v.at_5x}</td></tr>`).join('')}</tbody></table></div>
<div class="section"><div class="section-header"><span class="section-num">09</span><span class="section-title">Post-Acquisition Value Creation</span></div>
${(t.value_creation_levers||[]).map(l=>`<div class="advantage"><div class="advantage-title">${l.title}</div><div class="advantage-body">${l.body}</div></div>`).join('')}</div>
<div class="section"><div class="section-header"><span class="section-num">10</span><span class="section-title">SBA 7(a) Financing Path</span></div>
<p>Most acquisitions in the $1–5M range qualify with 10–20% down. Seller carry (5–15%) further reduces equity required.</p>
<table><thead><tr><th>Deal Size</th><th>Down Payment (10%)</th><th>Seller Note (10%)</th><th>SBA Loan (80%)</th></tr></thead><tbody>
${(t.sba_financing||[]).map(s=>`<tr><td>${s.deal_size}</td><td>${s.down_10}</td><td>${s.seller_note_10}</td><td>${s.sba_80}</td></tr>`).join('')}</tbody></table></div>
<div class="section"><div class="section-header"><span class="section-num">11</span><span class="section-title">Key Milestones &amp; Success Metrics</span></div>
<table><thead><tr><th style="width:65px">Day</th><th>Milestone</th></tr></thead><tbody>
${(t.milestones||[]).map(m=>`<tr><td style="font-weight:600;color:#8B6914;white-space:nowrap">${m.day}</td><td>${m.milestone}</td></tr>`).join('')}</tbody></table></div>
<div class="section"><div class="section-header"><span class="section-num">12</span><span class="section-title">Immediate Next Steps</span></div>
<table><thead><tr><th style="width:75px">Timeframe</th><th>Action</th></tr></thead><tbody>
${(t.next_steps||[]).map(n=>`<tr><td style="font-weight:600;color:#8B6914;white-space:nowrap">${n.timeframe}</td><td>${n.action}</td></tr>`).join('')}</tbody></table></div>
<div class="closing"><p>${t.closing_insight||''}</p></div>
<div class="doc-footer">Confidential · Prepared Exclusively for ${name} · Kyle Mallien · kylemallien.com · ${today}</div>
</body></html>`;
}

app.get('/health', (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('Kyle Mallien Thesis API running on port', PORT);
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
  console.log('Google Drive:', process.env.GOOGLE_DRIVE_FOLDER_ID ? 'configured' : 'not configured');
});
