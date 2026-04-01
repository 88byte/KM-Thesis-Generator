import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Go to Railway > Variables and add it.');
  process.exit(1);
}

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function saveThesisToDrive(name, htmlContent) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_DRIVE_FOLDER_ID) {
    console.log('Google Drive not configured — skipping.');
    return null;
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${name.replace(/\s+/g, '_')}_${date}_Thesis Report.html`;
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: 'text/html',
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    },
    media: { mimeType: 'text/html', body: htmlContent },
  });
  console.log('Saved to Drive:', fileName);
  return response.data.id;
}

app.post('/generate-thesis', async (req, res) => {
  const profile = req.body;
  if (!profile || !profile.name) {
    return res.status(400).json({ error: 'Missing profile data.' });
  }
  console.log('Generating thesis for:', profile.name);

  const systemPrompt = `You are Kyle Mallien's senior acquisition thesis writer. Kyle is an INC 5000 entrepreneur and business acquisition mentor. His methodology is the F.U.E.L. Process (Find, Underwrite, Elevate, Legacy). Buy box: service-based businesses, recession-proof, 10+ years operating, 10+ employees, $1M–$5M revenue, 20%+ profit margins, SBA 7(a) financing, founder-operated with retiring owner aged 58–70.

You must return a JSON object with EXACTLY these keys. No markdown, no backticks, just raw JSON.

{
  "metrics": {
    "revenue": "$1.5M – $3M",
    "margin": "22 – 30%",
    "income": "$330,000+",
    "timeline": "6–12 Months"
  },
  "thesis_overview": "<p>HTML paragraphs here...</p>",
  "strategic_edge": [
    { "title": "Edge Title", "body": "Explanation specific to this person..." },
    { "title": "Edge Title 2", "body": "..." },
    { "title": "Edge Title 3", "body": "..." }
  ],
  "income_projection": {
    "revenue_range": "$1.5M – $3M",
    "operating_margin": "22 – 30%",
    "base_income": "$330K – $600K",
    "growth_upside": "$150K – $500K+",
    "total_potential": "$480K – $1.1M+"
  },
  "target_categories": [
    {
      "rank": 1,
      "name": "Category Name",
      "schedule": "GSA Schedule or N/A",
      "margin": "22–30%",
      "why": "Specific reason tied to this person's background and edge..."
    },
    { "rank": 2, "name": "...", "schedule": "...", "margin": "...", "why": "..." },
    { "rank": 3, "name": "...", "schedule": "...", "margin": "...", "why": "..." }
  ],
  "fuel_steps": [
    { "number": "01", "phase": "FIND", "title": "Action title", "body": "Specific guidance for this person..." },
    { "number": "02", "phase": "FIND", "title": "Action title", "body": "..." },
    { "number": "03", "phase": "UNDERWRITE", "title": "Action title", "body": "..." },
    { "number": "04", "phase": "UNDERWRITE", "title": "Action title", "body": "..." },
    { "number": "05", "phase": "ELEVATE", "title": "Action title", "body": "..." },
    { "number": "06", "phase": "LEGACY", "title": "Action title", "body": "..." }
  ],
  "next_moves": [
    { "step": 1, "action": "Specific action this week", "detail": "More context..." },
    { "step": 2, "action": "Specific action this month", "detail": "More context..." },
    { "step": 3, "action": "Specific action in 60 days", "detail": "More context..." }
  ],
  "closing_insight": "One powerful closing paragraph personalised to this person's motivation and legacy goal."
}

Be hyper-specific to this person. Use their name, profession, and edge throughout. Every section must feel written exclusively for them. The thesis_overview should be 3 rich paragraphs.`;

  const userPrompt = `Generate the acquisition thesis JSON for this Elite Wealth Club attendee.

Name: ${profile.name}
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

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = message.content.map(b => b.text || '').join('');

    // Strip any accidental markdown fences
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const thesis = JSON.parse(clean);

    console.log('Thesis generated for', profile.name);

    let driveFileId = null;
    try {
      // Build a clean HTML version for Drive
      const driveHtml = buildDriveHtml(profile.name, thesis);
      driveFileId = await saveThesisToDrive(profile.name, driveHtml);
    } catch (driveErr) {
      console.error('Drive upload failed (non-fatal):', driveErr.message);
    }

    res.json({ thesis, driveFileId });

  } catch (err) {
    console.error('Error:', err.status, err.message);
    res.status(500).json({ error: 'Failed to generate thesis.', detail: err.message });
  }
});

function buildDriveHtml(name, t) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>${name} — Acquisition Thesis</title>
<style>
  body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; color: #1a1a1a; line-height: 1.7; padding: 0 40px; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  h2 { font-size: 13px; letter-spacing: 0.2em; text-transform: uppercase; color: #8B6914; margin-top: 40px; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
  h3 { font-size: 18px; margin-top: 20px; }
  .metric-row { display: flex; gap: 16px; margin: 20px 0; }
  .metric { flex: 1; border: 1px solid #ddd; padding: 16px; text-align: center; }
  .metric-val { font-size: 22px; font-weight: bold; color: #8B6914; }
  .metric-lbl { font-size: 11px; text-transform: uppercase; color: #888; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  td, th { border: 1px solid #ddd; padding: 10px 14px; font-size: 14px; }
  th { background: #f5f0e8; font-weight: 600; text-align: left; }
  .step { margin: 16px 0; padding: 16px; border-left: 3px solid #C9A84C; }
  .step-num { font-size: 12px; color: #C9A84C; font-weight: 700; letter-spacing: 0.1em; }
</style>
</head><body>
<h1>${name}'s Acquisition Investment Thesis</h1>
<p style="color:#888;font-size:13px">Kyle Mallien · Elite Wealth Club · ${new Date().toLocaleDateString()}</p>

<div class="metric-row">
  <div class="metric"><div class="metric-val">${t.metrics.revenue}</div><div class="metric-lbl">Target Revenue</div></div>
  <div class="metric"><div class="metric-val">${t.metrics.margin}</div><div class="metric-lbl">Profit Margin</div></div>
  <div class="metric"><div class="metric-val">${t.metrics.income}</div><div class="metric-lbl">Income Goal</div></div>
  <div class="metric"><div class="metric-val">${t.metrics.timeline}</div><div class="metric-lbl">Timeline</div></div>
</div>

<h2>Thesis Overview</h2>
${t.thesis_overview}

<h2>Your Strategic Edge</h2>
${t.strategic_edge.map(e => `<h3>${e.title}</h3><p>${e.body}</p>`).join('')}

<h2>Income Projection Model</h2>
<table>
  <tr><th>Metric</th><th>Range</th></tr>
  <tr><td>Acquisition Revenue Range</td><td>${t.income_projection.revenue_range}</td></tr>
  <tr><td>Operating Margin</td><td>${t.income_projection.operating_margin}</td></tr>
  <tr><td>Owner Income (Base)</td><td>${t.income_projection.base_income}</td></tr>
  <tr><td>Growth Upside (Year 2–3)</td><td>${t.income_projection.growth_upside}</td></tr>
  <tr><td><strong>Total Potential Income</strong></td><td><strong>${t.income_projection.total_potential}</strong></td></tr>
</table>

<h2>Ranked Target Categories</h2>
${t.target_categories.map(c => `<h3>#${c.rank} — ${c.name} <small style="color:#888;font-size:13px">${c.margin} margins</small></h3><p>${c.why}</p>`).join('')}

<h2>The F.U.E.L. Playbook</h2>
${t.fuel_steps.map(s => `<div class="step"><div class="step-num">${s.number} · ${s.phase}</div><h3 style="margin:4px 0">${s.title}</h3><p>${s.body}</p></div>`).join('')}

<h2>Your Next Moves</h2>
${t.next_moves.map(m => `<h3>Step ${m.step}: ${m.action}</h3><p>${m.detail}</p>`).join('')}

<blockquote style="border-left:3px solid #C9A84C;padding:16px 20px;margin:32px 0;font-style:italic;font-size:17px">${t.closing_insight}</blockquote>

<p style="text-align:center;color:#888;font-size:11px;margin-top:48px;border-top:1px solid #eee;padding-top:16px">
  Confidential · Prepared Exclusively for ${name} · Kyle Mallien · kylemallien.com
</p>
</body></html>`;
}

app.get('/health', (req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('Kyle Mallien Thesis API running on port', PORT);
  console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING');
  console.log('Google Drive:', process.env.GOOGLE_DRIVE_FOLDER_ID ? 'configured' : 'not configured (optional)');
});
