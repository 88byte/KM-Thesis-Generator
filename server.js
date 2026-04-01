import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── GOOGLE DRIVE (optional — only runs if credentials are set) ──────────────
async function saveThesisToDrive(name, htmlContent) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_DRIVE_FOLDER_ID) {
    console.log('Google Drive not configured — skipping upload.');
    return null;
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Save as HTML file in Drive folder
  const fileName = `${name.replace(/\s+/g, '_')}_Acquisition_Thesis_${new Date().toISOString().slice(0,10)}.html`;

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: 'text/html',
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: 'text/html',
      body: htmlContent,
    },
  });

  return response.data.id;
}

// ── MAIN ROUTE ──────────────────────────────────────────────────────────────
app.post('/generate-thesis', async (req, res) => {
  const profile = req.body;

  if (!profile || !profile.name) {
    return res.status(400).json({ error: 'Missing profile data.' });
  }

  const systemPrompt = `You are Kyle Mallien's acquisition thesis writer. Kyle is an INC 5000 entrepreneur, investor, and business acquisition mentor based in San Diego. His methodology is called the F.U.E.L. Process (Find, Underwrite, Elevate, Legacy). His acquisition criteria: service-based businesses, recession-proof, 10+ years in business, 10+ employees, $1M–$5M revenue, 20%+ profit margins, SBA 7(a) financing, founder-operated with retiring owner (ages 58–70).

Write a personalized acquisition investment thesis for the attendee. The tone is authoritative, premium, and confident — like a top-tier private equity memo but written for an individual. Use the language of wealth creation, legacy, and intelligent deal-making. Reference Kyle's framework and philosophy throughout. Everything must be hyper-specific to the person's profile — never generic.

IMPORTANT: Return ONLY valid HTML content using these exact elements:
- <h2> for section headers (THESIS OVERVIEW, YOUR STRATEGIC EDGE, TARGET ACQUISITION CATEGORIES, THE F.U.E.L. ROADMAP, INCOME PROJECTION, YOUR NEXT MOVES)
- <h3> for subsection headers
- <p> for paragraphs
- <ul><li> for bullet lists
- <strong> for emphasis
- Include a metrics line formatted EXACTLY as: |||METRICS|$Xm–$Xm|XX–XX%|$XXX,XXX+|X–X yrs|||

No markdown, no backticks, no explanations. Start directly with HTML content.`;

  const userPrompt = `Generate a personalized acquisition investment thesis for this attendee of Kyle Mallien's Elite Wealth Club event in Carlsbad.

ATTENDEE PROFILE:
Name: ${profile.name}
Profession/Background: ${profile.profession}
Location: ${profile.location}
Available Capital: ${profile.capital}
Income Goal: ${profile.income}
Unique Edge/Expertise: ${profile.edge}
Business Ownership History: ${profile.owned}
Target Categories: ${profile.categories.join(', ')}
Timeline: ${profile.timeline}
Debt Comfort: ${profile.debt}
Geographic Focus: ${profile.geo}
Motivation/Why: ${profile.motivation}
Biggest Obstacle: ${profile.obstacle}
${profile.extras ? 'Additional Notes: ' + profile.extras : ''}

Write a full, detailed thesis specific to ${profile.name.split(' ')[0]}. Include all 6 sections. Use their name, reference their specific profession and edge directly throughout. Make it powerful and personal.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const content = message.content.map(b => b.text || '').join('');

    // Optionally save to Google Drive
    let driveFileId = null;
    try {
      const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${profile.name} — Acquisition Thesis</title></head><body>${content}</body></html>`;
      driveFileId = await saveThesisToDrive(profile.name, fullHtml);
    } catch (driveErr) {
      console.error('Drive upload failed (non-fatal):', driveErr.message);
    }

    res.json({ content, driveFileId });

  } catch (err) {
    console.error('Anthropic error:', err);
    res.status(500).json({ error: 'Failed to generate thesis. Please try again.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Kyle Mallien Thesis API running on port ${PORT}`));
