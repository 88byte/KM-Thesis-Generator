import express from 'express';
import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';
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

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

async function dbInsert(entry) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('submissions').insert({
    name:          entry.name,
    submitted_at:  entry.submittedAt,
    status:        entry.status,
    event_tag:     entry.eventTag,
    profile_json:  entry.profileJson || null
  }).select('id').single();
  if (error) { console.error('Supabase insert error:', error.message); return null; }
  entry.dbId = data.id;
  return data.id;
}

async function dbUpdate(entry) {
  if (!supabase || !entry.dbId) return;
  const patch = {
    status:        entry.status,
    started_at:    entry.startedAt   || null,
    completed_at:  entry.completedAt || null,
    file_type:     entry.fileType    || null,
    duration_ms:   entry.durationMs  || null,
    drive_file_id: entry.driveFileId || null,
    error:         entry.error       || null
  };
  if (entry.thesisJson) patch.thesis_json = entry.thesisJson;
  const { error } = await supabase.from('submissions').update(patch).eq('id', entry.dbId);
  if (error) console.error('Supabase update error:', error.message);
}

async function seedFromSupabase() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .order('submitted_at', { ascending: false })
    .limit(200);
  if (error) { console.error('Supabase seed error:', error.message); return; }
  if (!data || data.length === 0) return;
  // Restore stats counters
  stats.submitted  = data.length;
  stats.completed  = data.filter(r => r.status === 'complete').length;
  stats.failed     = data.filter(r => r.status === 'failed').length;
  // Restore report list into memory
  stats.reports = data.map(r => ({
    dbId:         r.id,
    name:         r.name,
    submittedAt:  r.submitted_at,
    startedAt:    r.started_at,
    completedAt:  r.completed_at,
    status:       r.status,
    fileType:     r.file_type,
    durationMs:   r.duration_ms,
    driveFileId:  r.drive_file_id,
    thesisJson:   r.thesis_json  || null,
    profileJson:  r.profile_json || null,
    eventTag:     r.event_tag    || null,
    email:        r.email        || null,
    emailSentAt:  r.email_sent_at|| null,
    error:        r.error
  }));
  // Re-queue any jobs interrupted by the restart
  const interrupted = data.filter(r => r.status === 'queued' || r.status === 'generating');
  if (interrupted.length > 0) {
    console.log(`Re-queuing ${interrupted.length} interrupted submission(s)...`);
    for (const r of interrupted) {
      if (!r.profile_json) {
        console.log(`  Skipping ${r.name} — no profile_json stored (pre-dates durable queue)`);
        await supabase.from('submissions').update({ status: 'failed', error: 'Interrupted by server restart — profile not stored' }).eq('id', r.id);
        const inMem = stats.reports.find(m => m.dbId === r.id);
        if (inMem) { inMem.status = 'failed'; inMem.error = 'Interrupted — profile not stored'; }
        stats.failed++;
        continue;
      }
      const entry = stats.reports.find(m => m.dbId === r.id);
      if (entry && r.profile_json) {
        entry.status = 'queued';
        const p = r.profile_json;
        const firstName = p.name.split(' ')[0];
        const baseInstruction = `You are Kyle Mallien's senior acquisition strategist. Kyle is an INC 5000 entrepreneur and acquisition mentor. His methodology: F.U.E.L. (Find, Underwrite, Elevate, Legacy). Buy box: service-based, recession-proof, 10+ years operating, 10+ employees, $1M–$5M revenue, 20%+ margins, SBA 7(a), retiring founder ages 58–70. Return ONLY raw JSON — no markdown, no backticks, no preamble. Be hyper-specific to ${firstName}'s profile in every field.`;
        const { system1, system2 } = buildPrompts(firstName, baseInstruction);
        const profileBlock = `Name: ${p.name}\nProfession: ${p.profession}\nLocation: ${p.location}\nCapital Available: ${p.capital}\nIncome Goal: ${p.income}\nUnique Edge: ${p.edge}\nBusiness Ownership History: ${p.owned}\nTarget Categories: ${(p.categories||[]).join(', ')}\nTimeline: ${p.timeline}\nDebt Comfort: ${p.debt}\nGeographic Focus: ${p.geo}\nMotivation: ${p.motivation}\nBiggest Obstacle: ${p.obstacle}${p.extras ? '\nAdditional Notes: ' + p.extras : ''}`;
        runGeneration(entry, p, system1, system2, profileBlock);
        console.log(`  Re-queued: ${r.name}`);
      }
    }
  }
  console.log(`Seeded ${data.length} submissions from Supabase (${stats.completed} complete, ${stats.failed} failed)`);
}

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

// ── Stats Store ──────────────────────────────────────────────────────────────
const SERVER_START = new Date();
const stats = {
  submitted: 0,
  completed: 0,
  failed: 0,
  reports: [] // last 200 kept in memory
};

function recordSubmission(name, profile) {
  stats.submitted++;
  const d = new Date();
  const eventTag = d.toLocaleString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();
  const entry = { dbId: null, name, submittedAt: d, eventTag, profileJson: profile, status: 'queued', email: null, emailSentAt: null, driveFileId: null, fileType: null, durationMs: null, error: null };
  stats.reports.unshift(entry);
  if (stats.reports.length > 200) stats.reports.pop();
  dbInsert(entry); // fire-and-forget
  return entry;
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

// Retry is handled in the background block so the slot can be
// released during backoff — keeping the queue moving for other attendees.

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

// ── Prompt builder — used by both fresh and re-queued generations ────────────
function buildPrompts(firstName, baseInstruction) {
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
    "days_1_30": { "objective": "one sentence...", "actions": [{"days": "Days 1–5", "action": "..."},{"days": "Days 5–10", "action": "..."},{"days": "Days 10–15", "action": "..."},{"days": "Days 15–20", "action": "..."},{"days": "Days 20–25", "action": "..."},{"days": "Days 25–30", "action": "..."}] },
    "days_31_70": { "objective": "one sentence...", "actions": [{"days": "Days 31–40", "action": "..."},{"days": "Days 40–50", "action": "..."},{"days": "Days 45–55", "action": "..."},{"days": "Days 50–60", "action": "..."},{"days": "Days 55–65", "action": "..."},{"days": "Days 60–70", "action": "..."}] },
    "days_71_100": { "objective": "one sentence...", "actions": [{"days": "Days 71–80", "action": "..."},{"days": "Days 78–85", "action": "..."},{"days": "Day 85", "action": "CLOSE — wire funds, transfer ownership, begin Day 1 integration"},{"days": "Week 1 Post-Close", "action": "..."},{"days": "Week 2 Post-Close", "action": "..."},{"days": "Month 1 Post-Close", "action": "..."}] }
  },
  "closing_insight": "one powerful paragraph..."
}`;

  const system2 = `${baseInstruction}

CRITICAL: All string values in the JSON must use \n for line breaks. Never use real newline characters inside a JSON string value.
SCRIPT DIRECTION: Every script must be written FROM ${firstName} (the buyer/attendee) TO an external party (a seller, broker, or business owner).

Return this exact JSON structure:
{
  "scripts": {
    "ceo_letter": { "label": "Letter to Retiring Owner — Direct Mail", "subject": "", "body": "A warm peer-to-peer letter written BY ${firstName} TO a retiring business owner in their target vertical. References their professional background. Invites confidential 20-minute conversation. Signed: ${firstName}." },
    "email_followup": { "label": "Email Follow-Up to Owner — Day 7", "subject": "Following up on my letter — [Business Name]", "body": "Short follow-up email written BY ${firstName} TO the retiring owner referencing the physical letter. No pressure. Signed: ${firstName}." },
    "broker_outreach": { "label": "Email to Business Broker — Introduction", "subject": "Qualified Buyer — Seeking [vertical] business in [region]", "body": "Professional introduction email written BY ${firstName} TO a business broker. States buy box clearly. Mentions SBA pre-qualification. Requests to be added to buyer list. Signed: ${firstName}." },
    "discovery_call": { "label": "Discovery Call Script — 20 Minutes", "subject": "", "body": "Call script for ${firstName} to use when speaking with a seller.\n\nOPENER (2 min): ${firstName} thanks owner, establishes peer tone, no pressure.\n\nLEARN (8 min): Questions ${firstName} asks about seller timeline, succession plan, ideal outcome, owner involvement.\n\nEDUCATE (6 min): ${firstName} explains approach — not PE, will operate and grow, retain team, honor culture.\n\nCLOSE (4 min): ${firstName} asks seller to share financials for a closer look. Fully confidential." }
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
    {"day": "Day 30", "milestone": "..."},{"day": "Day 45", "milestone": "..."},{"day": "Day 60", "milestone": "..."},
    {"day": "Day 75", "milestone": "..."},{"day": "Day 90", "milestone": "..."},{"day": "Day 100", "milestone": "..."}
  ],
  "next_steps": [
    {"timeframe": "This Week", "action": "..."},{"timeframe": "Week 2", "action": "..."},
    {"timeframe": "Week 3", "action": "..."},{"timeframe": "Week 4", "action": "..."},
    {"timeframe": "Month 2", "action": "..."},{"timeframe": "Month 3", "action": "..."}
  ]
}`;
  return { system1, system2 };
}

// ── Main route ────────────────────────────────────────────────────────────────
app.post('/generate-thesis', async (req, res) => {
  const profile = req.body;
  if (!profile || !profile.name) return res.status(400).json({ error: 'Missing profile data.' });
  console.log('Received request for:', profile.name);
  const reportEntry = recordSubmission(profile.name, profile);

  const firstName = profile.name.split(' ')[0];
  const baseInstruction = `You are Kyle Mallien's senior acquisition strategist. Kyle is an INC 5000 entrepreneur and acquisition mentor. His methodology: F.U.E.L. (Find, Underwrite, Elevate, Legacy). Buy box: service-based, recession-proof, 10+ years operating, 10+ employees, $1M–$5M revenue, 20%+ margins, SBA 7(a), retiring founder ages 58–70. Return ONLY raw JSON — no markdown, no backticks, no preamble. Be hyper-specific to ${firstName}'s profile in every field.`;
  const { system1, system2 } = buildPrompts(firstName, baseInstruction);
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

    // Respond immediately so the thank-you page shows without waiting
  res.json({ queued: true, name: profile.name });

  runGeneration(reportEntry, profile, system1, system2, profileBlock);
});

// ── Core generation runner — also called on restart re-queue ─────────────────
async function runGeneration(reportEntry, profile, system1, system2, profileBlock) {
  if (activeCount >= MAX_CONCURRENT) {
    console.log(`Queuing for ${reportEntry.name} — position ${waitQueue.length + 1}`);
  }
  let raw1, raw2;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    await acquireSlot();
    try {
      console.log(`Generating thesis for ${reportEntry.name} — attempt ${attempt} (active: ${activeCount}/${MAX_CONCURRENT})`);
      reportEntry.status = 'generating';
      reportEntry.startedAt = new Date();
      dbUpdate(reportEntry);
      [raw1, raw2] = await Promise.all([
        callClaude(system1, `Generate Call 1 JSON for this attendee:\n\n${profileBlock}`),
        callClaude(system2, `Generate Call 2 JSON for this attendee:\n\n${profileBlock}`)
      ]);
      releaseSlot();
      break;
    } catch (err) {
      releaseSlot();
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('rate'));
      if (isRateLimit && attempt < RETRY_ATTEMPTS) {
        const wait = RETRY_DELAY_MS * attempt;
        console.log(`Rate limited for ${reportEntry.name} — retrying in ${wait/1000}s (attempt ${attempt}/${RETRY_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error(`Generation failed for ${reportEntry.name} after ${attempt} attempt(s):`, err.message);
        reportEntry.status = 'failed';
        reportEntry.error = err.message;
        reportEntry.durationMs = reportEntry.startedAt ? Date.now() - reportEntry.startedAt : null;
        stats.failed++;
        dbUpdate(reportEntry);
        return;
      }
    }
  }
  try {
    const part1 = safeParseJSON(raw1);
    const part2 = safeParseJSON(raw2);
    const thesis = { ...part1, ...part2 };
    console.log('Thesis generated for', reportEntry.name);
    const driveHtml = buildDriveHtml(reportEntry.name, thesis);
    const driveFileId = await saveThesisToDrive(reportEntry.name, driveHtml);
    reportEntry.status = 'complete';
    reportEntry.completedAt = new Date();
    reportEntry.driveFileId = driveFileId;
    reportEntry.fileType = process.env.PDFSHIFT_API_KEY ? 'pdf' : 'html';
    reportEntry.durationMs = reportEntry.startedAt ? Date.now() - reportEntry.startedAt : null;
    reportEntry.thesisJson = thesis;
    stats.completed++;
    dbUpdate(reportEntry);
  } catch (err) {
    console.error('Post-generation failed for', reportEntry.name, ':', err.message);
    reportEntry.status = 'failed';
    reportEntry.error = err.message;
    reportEntry.durationMs = reportEntry.startedAt ? Date.now() - reportEntry.startedAt : null;
    stats.failed++;
    dbUpdate(reportEntry);
  }
}

function buildScreenHtml(name, t, submittedAt) {
  const date = submittedAt ? submittedAt.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  const firstName = name.split(' ')[0];
  const phaseConfig = [
    {key:'days_1_30', letter:'F', days:'Days 1–30', name:'FIND — Build Your Pipeline'},
    {key:'days_31_70', letter:'U', days:'Days 31–70', name:'UNDERWRITE — Qualify, Discover & Structure'},
    {key:'days_71_100', letter:'E+L', days:'Days 71–100', name:'ELEVATE & LEGACY — Close, Integrate & Build Wealth'}
  ];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — Acquisition Thesis</title>
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Montserrat:wght@400;500;600;700;800&family=Cinzel:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--gold:#C9A84C;--gold-light:#E8C97A;--gold-dark:#8B6914;--black:#0E0E0E;--r-bg:#FDFAF4;--r-paper:#FFFFFF;--r-ink:#1A1714;--r-ink2:#4A4540;--r-rule:#E8E0D0;--r-gold:#8B6914}
body{font-family:'Lora',Georgia,serif;background:var(--r-bg);color:var(--r-ink);line-height:1.75}

/* cover */
.cover{background:var(--black);padding:clamp(40px,6vw,80px) clamp(24px,5vw,64px) clamp(32px,5vw,56px);position:relative}
.cover::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--gold),var(--gold-light),var(--gold),transparent)}
.cover-eyebrow{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:var(--gold);margin-bottom:16px;opacity:0.75}
.cover-name{font-family:'Lora',serif;font-size:clamp(28px,5vw,52px);font-weight:300;color:#F0EAD6;line-height:1.1;margin-bottom:6px}
.cover-name span{background:linear-gradient(135deg,var(--gold-dark),var(--gold),var(--gold-light));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:500}
.cover-sub{font-family:'Lora',serif;font-size:clamp(14px,1.6vw,17px);color:rgba(240,234,214,0.5);font-style:italic;margin-bottom:28px}
.cover-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:rgba(201,168,76,0.2);border:1px solid rgba(201,168,76,0.2);max-width:560px}
@media(max-width:500px){.cover-metrics{grid-template-columns:repeat(2,1fr)}}
.m-box{background:rgba(255,255,255,0.03);padding:16px 12px;text-align:center}
.m-val{font-family:'Cinzel',serif;font-size:clamp(13px,1.8vw,18px);font-weight:600;color:var(--gold);display:block;margin-bottom:4px}
.m-lbl{font-family:'Montserrat',sans-serif;font-size:8px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(240,234,214,0.35)}
.cover-fuel{font-family:'Montserrat',sans-serif;font-size:9px;letter-spacing:0.2em;color:rgba(201,168,76,0.3);text-transform:uppercase;margin-top:20px}

/* toc */
.toc{background:#F7F2E8;border-bottom:1px solid var(--r-rule);padding:clamp(24px,4vw,40px) clamp(24px,5vw,64px)}
.toc-title{font-family:'Montserrat',sans-serif;font-size:9px;letter-spacing:0.3em;text-transform:uppercase;color:var(--r-gold);font-weight:700;margin-bottom:14px}
.toc-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--r-rule)}
.toc-num{font-family:'Cinzel',serif;font-size:10px;color:var(--r-gold);font-weight:600;min-width:28px}
.toc-lbl{font-family:'Montserrat',sans-serif;font-size:11px;color:var(--r-ink2);font-weight:500;letter-spacing:0.05em;text-transform:uppercase}

/* body */
.body{max-width:860px;margin:0 auto;padding:clamp(32px,5vw,56px) clamp(24px,5vw,56px)}
.section{margin-bottom:48px}
.sec-hdr{display:flex;align-items:center;gap:12px;margin-bottom:18px;padding-bottom:10px;border-bottom:1px solid var(--r-rule)}
.sec-num{font-family:'Cinzel',serif;font-size:10px;color:var(--r-gold);font-weight:600;min-width:22px}
.sec-title{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:var(--r-gold);font-weight:700}
p{font-size:clamp(15px,1.6vw,17px);line-height:1.85;margin-bottom:14px;color:var(--r-ink)}
strong{font-weight:600}

/* criteria */
.criteria{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--r-rule);border:1px solid var(--r-rule);margin:16px 0}
@media(max-width:480px){.criteria{grid-template-columns:repeat(2,1fr)}}
.c-cell{background:var(--r-paper);padding:14px;text-align:center}
.c-val{font-family:'Cinzel',serif;font-size:clamp(13px,1.6vw,17px);font-weight:600;color:var(--r-gold);display:block;margin-bottom:3px}
.c-lbl{font-family:'Montserrat',sans-serif;font-size:8px;letter-spacing:0.15em;text-transform:uppercase;color:#A09070}

/* cards */
.card{border:1px solid var(--r-rule);border-left:3px solid var(--gold);padding:14px 18px;margin:10px 0;background:var(--r-paper)}
.card-title{font-family:'Montserrat',sans-serif;font-size:10px;font-weight:700;color:var(--r-gold);margin-bottom:6px;letter-spacing:0.05em}
.card-body{font-size:clamp(14px,1.5vw,16px);line-height:1.78;color:var(--r-ink2)}

/* tables */
table{width:100%;border-collapse:collapse;margin:14px 0;font-family:'Montserrat',sans-serif;font-size:12px}
thead th{background:#F0E8D5;padding:9px 12px;text-align:left;font-size:8px;letter-spacing:0.12em;text-transform:uppercase;color:var(--r-gold);font-weight:700;border-bottom:2px solid var(--r-rule)}
tbody tr:nth-child(even) td{background:#FAFAF5}
tbody tr:last-child td{background:#F5EDD8;font-weight:600;color:var(--r-gold)}
td{padding:9px 12px;border-bottom:1px solid var(--r-rule);color:var(--r-ink);vertical-align:top;line-height:1.5}

/* phases */
.phase{border:1px solid var(--r-rule);margin-bottom:16px}
.phase-hdr{background:#F0E8D5;padding:12px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--r-rule)}
.phase-letter{font-family:'Cinzel',serif;font-size:22px;font-weight:700;color:var(--r-gold);line-height:1;min-width:28px}
.phase-days{font-family:'Montserrat',sans-serif;font-size:7px;letter-spacing:0.18em;text-transform:uppercase;color:#A09070;font-weight:700}
.phase-name{font-family:'Montserrat',sans-serif;font-size:10px;font-weight:700;color:var(--r-ink)}
.phase-obj{padding:10px 16px;font-size:clamp(14px,1.5vw,16px);font-style:italic;color:var(--r-ink2);border-bottom:1px solid var(--r-rule);background:#FDFAF4}
.phase table{margin:0}

/* scripts */
.script{border:1px solid var(--r-rule);margin-bottom:16px}
.script-lbl{background:#F0E8D5;padding:8px 14px;font-family:'Montserrat',sans-serif;font-size:7.5px;letter-spacing:0.18em;text-transform:uppercase;color:var(--r-gold);font-weight:700;border-bottom:1px solid var(--r-rule)}
.script-sub{padding:7px 14px;font-family:'Montserrat',sans-serif;font-size:11px;font-weight:600;color:var(--r-ink2);border-bottom:1px solid var(--r-rule);background:#FAFAF5}
.script-sub span{color:var(--r-gold)}
.script-body{padding:14px 16px;font-size:clamp(14px,1.5vw,16px);line-height:1.85;color:var(--r-ink);white-space:pre-wrap;word-wrap:break-word}

/* closing */
.closing{border-left:4px solid var(--gold);padding:16px 20px;background:#F5EDD8;margin:32px 0}
.closing p{font-size:clamp(16px,1.8vw,19px);font-style:italic;line-height:1.75;margin:0}

/* print bar */
.print-bar{background:var(--black);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10}
.print-brand{font-family:'Cinzel',serif;font-size:12px;letter-spacing:0.1em;background:linear-gradient(135deg,var(--gold-dark),var(--gold));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:600}
.print-btn{font-family:'Montserrat',sans-serif;font-size:9px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;background:linear-gradient(135deg,var(--gold-dark),var(--gold));border:none;color:#000;padding:8px 16px;cursor:pointer;border-radius:2px}
@media print{.print-bar{display:none}}
</style></head><body>

<div class="print-bar">
  <div class="print-brand">Kyle Mallien · ${name}</div>
  <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
</div>

<div class="cover">
  <div class="cover-eyebrow">Elite Wealth Club · Carlsbad · ${date}</div>
  <div class="cover-name">${name}'s<br><span>100-Day Acquisition Roadmap</span></div>
  <div class="cover-sub">Prepared exclusively for ${firstName} · Kyle Mallien · 2025–2026</div>
  <div class="cover-metrics">
    <div class="m-box"><span class="m-val">${t.metrics?.revenue||'—'}</span><div class="m-lbl">Revenue</div></div>
    <div class="m-box"><span class="m-val">${t.metrics?.margin||'—'}</span><div class="m-lbl">Margin</div></div>
    <div class="m-box"><span class="m-val">${t.metrics?.income||'—'}</span><div class="m-lbl">Income Goal</div></div>
    <div class="m-box"><span class="m-val">${t.metrics?.timeline||'—'}</span><div class="m-lbl">Timeline</div></div>
  </div>
  <div class="cover-fuel">F · Find &nbsp; U · Underwrite &nbsp; E · Elevate &nbsp; L · Legacy</div>
</div>

<div class="toc">
  <div class="toc-title">Table of Contents</div>
  ${[['01','Thesis Overview'],['02','Acquisition Criteria'],['03','Your Unfair Advantages'],['04','Target Verticals — Ranked by Fit'],['05','100-Day Acquisition Roadmap'],['06','Outreach Scripts — Ready to Send'],['07','Deal Structure Framework'],['08','Valuation & Income Model'],['09','Post-Acquisition Value Creation'],['10','SBA 7(a) Financing Path'],['11','Key Milestones & Success Metrics'],['12','Immediate Next Steps']].map(([n,l])=>`<div class="toc-row"><span class="toc-num">${n}</span><span class="toc-lbl">${l}</span></div>`).join('')}
</div>

<div class="body">
  <div class="section"><div class="sec-hdr"><span class="sec-num">01</span><span class="sec-title">Thesis Overview</span></div>${t.thesis_overview||''}</div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">02</span><span class="sec-title">Acquisition Criteria</span></div>
    <p>Every deal must pass Kyle's buy box before an LOI is submitted.</p>
    <div class="criteria">
      <div class="c-cell"><span class="c-val">$1M–$5M</span><div class="c-lbl">Target Revenue</div></div>
      <div class="c-cell"><span class="c-val">20–30%</span><div class="c-lbl">Profit Margins</div></div>
      <div class="c-cell"><span class="c-val">10+ Years</span><div class="c-lbl">Operating History</div></div>
      <div class="c-cell"><span class="c-val">10+ Staff</span><div class="c-lbl">Team in Place</div></div>
      <div class="c-cell"><span class="c-val">SBA 7(a)</span><div class="c-lbl">Financing Path</div></div>
      <div class="c-cell"><span class="c-val">Ages 58–70</span><div class="c-lbl">Seller Profile</div></div>
    </div>
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">03</span><span class="sec-title">Your Unfair Advantages</span></div>
    ${(t.unfair_advantages||[]).map(a=>`<div class="card"><div class="card-title">${a.title}</div><div class="card-body">${a.body}</div></div>`).join('')}
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">04</span><span class="sec-title">Target Verticals — Ranked by Fit</span></div>
    <table><thead><tr><th>Rank</th><th>Vertical</th><th>Margin</th><th>Why It Fits</th></tr></thead><tbody>
    ${(t.target_verticals||[]).map(v=>`<tr><td style="font-family:'Cinzel',serif;color:var(--r-gold);font-weight:600">#${v.rank}</td><td><strong>${v.vertical}</strong></td><td>${v.margin}</td><td>${v.why}</td></tr>`).join('')}
    </tbody></table>
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">05</span><span class="sec-title">100-Day Acquisition Roadmap</span></div>
    ${phaseConfig.map(p=>{const ph=(t.roadmap||{})[p.key];return ph?`<div class="phase">
      <div class="phase-hdr"><div class="phase-letter">${p.letter}</div><div><div class="phase-days">${p.days}</div><div class="phase-name">${p.name}</div></div></div>
      <div class="phase-obj">${ph.objective}</div>
      <table><thead><tr><th style="width:110px">Days</th><th>Action</th></tr></thead><tbody>
      ${(ph.actions||[]).map(a=>`<tr><td style="font-weight:600;color:var(--r-gold);white-space:nowrap">${a.days}</td><td>${a.action}</td></tr>`).join('')}
      </tbody></table></div>`:''}).join('')}
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">06</span><span class="sec-title">Outreach Scripts — Ready to Send</span></div>
    ${Object.values(t.scripts||{}).map(s=>`<div class="script">
      <div class="script-lbl">${s.label}</div>
      ${s.subject?`<div class="script-sub"><span>Subject:</span> ${s.subject}</div>`:''}
      <div class="script-body">${s.body}</div>
    </div>`).join('')}
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">07</span><span class="sec-title">Deal Structure Framework</span></div>
    <table><thead><tr><th>Component</th><th>Target</th><th>Purpose</th></tr></thead><tbody>
    ${(t.deal_structure||[]).map(d=>`<tr><td><strong>${d.component}</strong></td><td>${d.target}</td><td>${d.purpose}</td></tr>`).join('')}
    </tbody></table>
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">08</span><span class="sec-title">Valuation &amp; Income Model</span></div>
    <table><thead><tr><th>Revenue</th><th>EBITDA (20%)</th><th>EBITDA (25%)</th><th>Purchase @ 3x</th><th>Purchase @ 5x</th></tr></thead><tbody>
    ${(t.valuation_model||[]).map(v=>`<tr><td>${v.revenue}</td><td>${v.ebitda_20}</td><td>${v.ebitda_25}</td><td>${v.at_3x}</td><td>${v.at_5x}</td></tr>`).join('')}
    </tbody></table>
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">09</span><span class="sec-title">Post-Acquisition Value Creation</span></div>
    ${(t.value_creation_levers||[]).map(l=>`<div class="card"><div class="card-title">${l.title}</div><div class="card-body">${l.body}</div></div>`).join('')}
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">10</span><span class="sec-title">SBA 7(a) Financing Path</span></div>
    <p>Most acquisitions in the $1–5M range qualify with 10–20% down.</p>
    <table><thead><tr><th>Deal Size</th><th>Down Payment (10%)</th><th>Seller Note (10%)</th><th>SBA Loan (80%)</th></tr></thead><tbody>
    ${(t.sba_financing||[]).map(s=>`<tr><td>${s.deal_size}</td><td>${s.down_10}</td><td>${s.seller_note_10}</td><td>${s.sba_80}</td></tr>`).join('')}
    </tbody></table>
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">11</span><span class="sec-title">Key Milestones &amp; Success Metrics</span></div>
    <table><thead><tr><th style="width:70px">Day</th><th>Milestone</th></tr></thead><tbody>
    ${(t.milestones||[]).map(m=>`<tr><td style="font-weight:600;color:var(--r-gold);white-space:nowrap">${m.day}</td><td>${m.milestone}</td></tr>`).join('')}
    </tbody></table>
  </div>

  <div class="section"><div class="sec-hdr"><span class="sec-num">12</span><span class="sec-title">Immediate Next Steps</span></div>
    <table><thead><tr><th style="width:80px">Timeframe</th><th>Action</th></tr></thead><tbody>
    ${(t.next_steps||[]).map(n=>`<tr><td style="font-weight:600;color:var(--r-gold);white-space:nowrap">${n.timeframe}</td><td>${n.action}</td></tr>`).join('')}
    </tbody></table>
  </div>

  <div class="closing"><p>${t.closing_insight||''}</p></div>

  <p style="text-align:center;font-family:'Montserrat',sans-serif;font-size:9px;color:#B0A890;letter-spacing:0.1em;margin-top:40px;padding-top:16px;border-top:1px solid var(--r-rule)">
    Confidential · Prepared Exclusively for ${name} · Kyle Mallien · kylemallien.com · ${date}
  </p>
</div>
</body></html>`;
}

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
<div class="section"><div class="section-header"><span class="section-num">06</span><span class="section-title">Your Outreach Scripts — Ready to Send</span></div>
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

app.get('/stats', (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    server: {
      startedAt: SERVER_START.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - SERVER_START) / 1000),
      driveConfigured: !!(process.env.GOOGLE_DRIVE_FOLDER_ID),
      pdfshiftConfigured: !!(process.env.PDFSHIFT_API_KEY),
      supabaseConfigured: !!(supabase),
      resendConfigured: !!(resend)
    },
    queue: {
      active: activeCount,
      waiting: waitQueue.length,
      maxConcurrent: MAX_CONCURRENT
    },
    totals: {
      submitted: stats.submitted,
      completed: stats.completed,
      failed: stats.failed,
      pending: stats.submitted - stats.completed - stats.failed
    },
    reports: stats.reports
  });
});

// ── Admin: Regenerate PDF ────────────────────────────────────────────────────
app.post('/regenerate/:id', async (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  const { data, error } = await supabase
    .from('submissions')
    .select('id, name, thesis_json')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Submission not found' });
  if (!data.thesis_json) return res.status(400).json({ error: 'No thesis JSON stored for this submission — was generated before Supabase integration' });

  try {
    console.log('Regenerating PDF for:', data.name);
    const driveHtml = buildDriveHtml(data.name, data.thesis_json);
    const driveFileId = await saveThesisToDrive(data.name, driveHtml);

    // Update the DB record with the new drive file id
    await supabase.from('submissions').update({ drive_file_id: driveFileId }).eq('id', data.id);

    // Update in-memory record too if it exists
    const inMem = stats.reports.find(r => r.dbId === data.id);
    if (inMem) inMem.driveFileId = driveFileId;

    res.json({ ok: true, driveFileId, name: data.name });
  } catch (err) {
    console.error('Regenerate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: View report as HTML in browser ────────────────────────────────────
app.get('/view/:id', async (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).send('<h2>Unauthorized</h2>');
  }
  if (!supabase) return res.status(503).send('<h2>Supabase not configured</h2>');

  const { data, error } = await supabase
    .from('submissions')
    .select('name, thesis_json, submitted_at')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).send('<h2>Report not found</h2>');
  if (!data.thesis_json) return res.status(400).send('<h2>No thesis data stored for this report — was generated before Supabase integration</h2>');

  res.setHeader('Content-Type', 'text/html');
  res.send(buildScreenHtml(data.name, data.thesis_json, new Date(data.submitted_at)));
});

// ── Admin: Send report by email ──────────────────────────────────────────────
app.post('/send-report/:id', async (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  if (!resend)   return res.status(503).json({ error: 'Resend not configured — add RESEND_API_KEY' });

  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const { data, error } = await supabase
    .from('submissions').select('id, name, thesis_json, file_type').eq('id', req.params.id).single();

  if (error || !data) return res.status(404).json({ error: 'Submission not found' });
  if (!data.thesis_json) return res.status(400).json({ error: 'No thesis JSON stored — report predates Supabase integration' });

  try {
    console.log('Sending report to', email, 'for', data.name);

    // Generate the PDF/HTML for attachment
    const driveHtml = buildDriveHtml(data.name, data.thesis_json);
    let attachContent, attachType, attachName;

    if (process.env.PDFSHIFT_API_KEY) {
      const pdfBuffer = await htmlToPdf(driveHtml);
      if (pdfBuffer) {
        attachContent = pdfBuffer.toString('base64');
        attachType = 'application/pdf';
        attachName = `${data.name.replace(/\s+/g,'_')}_Acquisition_Thesis.pdf`;
      }
    }

    if (!attachContent) {
      attachContent = Buffer.from(driveHtml).toString('base64');
      attachType = 'text/html';
      attachName = `${data.name.replace(/\s+/g,'_')}_Acquisition_Thesis.html`;
    }

    const firstName = data.name.split(' ')[0];
    await resend.emails.send({
      from: 'Kyle Mallien <support@kylemallien.com>',
      to: email,
      subject: `${firstName}, your 100-Day Acquisition Roadmap is ready`,
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px 24px;color:#1A1714">
          <p style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#8B6914;margin-bottom:16px">Kyle Mallien · Elite Wealth Club</p>
          <h1 style="font-size:28px;font-weight:400;margin-bottom:16px;line-height:1.2">${firstName}, your Acquisition Thesis is ready.</h1>
          <p style="font-size:16px;line-height:1.8;color:#3A3530;margin-bottom:20px">Your personalized 100-Day Acquisition Roadmap is attached. It includes your target verticals, outreach scripts, deal structure, valuation model, and your full F.U.E.L. playbook — all built specifically around your background and goals.</p>
          <p style="font-size:16px;line-height:1.8;color:#3A3530;margin-bottom:32px">Kyle will walk through this with you personally. In the meantime, review Section 06 — your outreach scripts are ready to use.</p>
          <hr style="border:none;border-top:1px solid #E8E0D0;margin:32px 0"/>
          <p style="font-size:13px;color:#8B6914;font-style:italic">Kyle Mallien · Business Acquisition Strategist<br>kylemallien.com</p>
        </div>`,
      attachments: [{ filename: attachName, content: attachContent }]
    });

    // Save email + timestamp to Supabase
    await supabase.from('submissions').update({
      email,
      email_sent_at: new Date().toISOString()
    }).eq('id', data.id);

    // Update in-memory
    const inMem = stats.reports.find(r => r.dbId === data.id);
    if (inMem) { inMem.email = email; inMem.emailSentAt = new Date(); }

    res.json({ ok: true, email, name: data.name });
  } catch (err) {
    console.error('Send report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: Bulk regenerate ────────────────────────────────────────────────────
app.post('/regenerate-bulk', async (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'ids array required' });

  // Respond immediately — regeneration happens in background
  res.json({ ok: true, queued: ids.length, message: `Queued ${ids.length} report(s) for regeneration` });

  // Process sequentially in background through the existing slot queue
  (async () => {
    console.log(`Bulk regenerate: ${ids.length} reports queued`);
    for (const id of ids) {
      try {
        const { data, error } = await supabase
          .from('submissions').select('id, name, thesis_json').eq('id', id).single();
        if (error || !data || !data.thesis_json) {
          console.log(`Bulk regen skip ${id}: no thesis JSON`); continue;
        }
        await acquireSlot();
        try {
          console.log('Bulk regen:', data.name);
          const driveHtml = buildDriveHtml(data.name, data.thesis_json);
          const driveFileId = await saveThesisToDrive(data.name, driveHtml);
          await supabase.from('submissions').update({ drive_file_id: driveFileId }).eq('id', data.id);
          const inMem = stats.reports.find(r => r.dbId === data.id);
          if (inMem) inMem.driveFileId = driveFileId;
          console.log('Bulk regen complete:', data.name);
        } finally {
          releaseSlot();
        }
      } catch (err) {
        console.error('Bulk regen error for', id, ':', err.message);
      }
    }
    console.log('Bulk regenerate finished');
  })();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log('Kyle Mallien Thesis API running on port', PORT);
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
  console.log('Google Drive:     ', process.env.GOOGLE_DRIVE_FOLDER_ID ? 'configured' : 'not configured');
  console.log('Supabase:         ', supabase ? 'configured' : 'not configured — stats will not persist');
  console.log('Resend:           ', resend  ? 'configured' : 'not configured — email delivery unavailable');
  console.log('Resend:           ', resend ? 'configured' : 'not configured — email delivery unavailable');
  if (supabase) await seedFromSupabase();
});
