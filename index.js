// ============================================================
// TEAM | ProjectOneUSA — Single File API
// All routes + libs combined — flat structure for GitHub upload
// ============================================================
require('dotenv').config();
const express            = require('express');
const cors               = require('cors');
const rateLimit          = require('express-rate-limit');
const { createClient }   = require('@supabase/supabase-js');
const jwt                = require('jsonwebtoken');
const validator          = require('validator');
const https              = require('https');
const urlLib             = require('url');
const { Resend }         = require('resend');

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust Vercel's proxy
app.set('trust proxy', 1);

// ── Supabase client ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Resend client ──
const resend = new Resend(process.env.RESEND_API_KEY);

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5500',
    /\.pages\.dev$/,
    /\.vercel\.app$/
  ],
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

const submitLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 50, // relaxed for testing
  message: { error: 'Too many submissions. Please try again later.' }
});

// ============================================================
// HELPERS
// ============================================================
function sanitize(str) {
  if (!str) return null;
  return validator.escape(String(str).trim());
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'super_admin')
    return res.status(403).json({ error: 'Access denied. Super admin only.' });
  next();
}

// ============================================================
// DISCORD NOTIFICATION
// ============================================================
async function sendDiscordNotification(submission) {
  const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
  if (!WEBHOOK) { console.log('[Discord] No webhook URL set'); return; }

  const isPartner = submission.type === 'business_partner';
  const color     = isPartner ? 0xFFD000 : 0x26C7D9;
  const typeLabel = isPartner ? '🤝 Business Partner' : '🎯 Skilled Individual';

  const body = JSON.stringify({
    embeds: [{
      title:     `🔔 New Submission — ${typeLabel}`,
      color,
      timestamp: new Date().toISOString(),
      footer:    { text: 'TEAM | ProjectOneUSA — Submission System' },
      fields: [
        { name: '👤 Full Name', value: submission.full_name || '—', inline: true },
        { name: '📧 Email',     value: submission.email    || '—', inline: true },
        { name: '📱 Phone',     value: submission.phone    || 'Not provided', inline: true },
        ...(isPartner ? [
          { name: '🏢 Business',    value: submission.business_name    || '—', inline: true },
          { name: '🎯 Division',    value: submission.division_interest || '—', inline: true },
          { name: '💼 Opportunity', value: (submission.opportunity_desc || '—').substring(0, 200), inline: false }
        ] : [
          { name: '🎨 Skill', value: submission.skill_category  || '—', inline: true },
          { name: '📝 About', value: (submission.about_yourself || '—').substring(0, 200), inline: false }
        ])
      ]
    }]
  });

  const webhookUrl = WEBHOOK.replace('discordapp.com', 'discord.com');
  console.log('[Discord] Sending to:', webhookUrl.substring(0, 60) + '...');

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    console.log('[Discord] Response status:', res.status);
    if (res.ok) {
      console.log('[Discord] ✅ Sent successfully');
    } else {
      const text = await res.text();
      console.error('[Discord] ❌ Failed:', res.status, text);
    }
  } catch (err) {
    console.error('[Discord] ❌ Error:', err.message);
  }
}

// ============================================================
// EMAIL
// ============================================================
async function sendTeamEmail(submission) {
  const isPartner = submission.type === 'business_partner';
  try {
    await resend.emails.send({
      from:    process.env.EMAIL_FROM   || 'onboarding@resend.dev',
      to:      process.env.EMAIL_NOTIFY || 'project1usa.business@gmail.com',
      subject: `[TEAM] New ${isPartner ? 'Business Partner' : 'Skilled Individual'} — ${submission.full_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#26c7d9;">New ${isPartner ? 'Business Partner' : 'Skilled Individual'} Submission</h2>
          <p><strong>Name:</strong> ${submission.full_name}</p>
          <p><strong>Email:</strong> ${submission.email}</p>
          <p><strong>Phone:</strong> ${submission.phone || 'Not provided'}</p>
          ${isPartner ? `
            <p><strong>Business:</strong> ${submission.business_name    || '—'}</p>
            <p><strong>Division:</strong> ${submission.division_interest || '—'}</p>
            <p><strong>Opportunity:</strong> ${submission.opportunity_desc || '—'}</p>
          ` : `
            <p><strong>Skill:</strong> ${submission.skill_category  || '—'}</p>
            <p><strong>About:</strong> ${submission.about_yourself   || '—'}</p>
          `}
        </div>`
    });
    console.log('[Email] Team notified ✅');
  } catch (e) { console.error('[Email] Failed:', e.message); }
}

async function sendConfirmationEmail(submission) {
  const isPartner = submission.type === 'business_partner';
  const firstName = submission.full_name.split(' ')[0];
  try {
    await resend.emails.send({
      from:    process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to:      submission.email,
      subject: `We received your submission — TEAM | ProjectOneUSA`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#26c7d9;">TEAM | ProjectOneUSA</h2>
          <p>Hi ${firstName},</p>
          <p>Thank you for reaching out as a <strong>${isPartner ? 'Business Partner' : 'Skilled Individual'}</strong>.
             We have received your submission and will review it within <strong>48 hours</strong>.</p>
          <p>We will be in touch at <strong>${submission.email}</strong>.</p>
          <p>Follow us: <a href="https://www.facebook.com/Project1USA/" style="color:#26c7d9;">facebook.com/Project1USA</a></p>
          <hr>
          <p style="color:#999;font-size:12px;">TEAM | ProjectOneUSA · Sacramento, CA &amp; Philippines</p>
        </div>`
    });
    console.log('[Email] Confirmation sent ✅');
  } catch (e) { console.error('[Email] Confirmation failed:', e.message); }
}

// ============================================================
// ROUTES — HEALTH
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'TEAM | ProjectOneUSA API', time: new Date().toISOString() });
});

// ============================================================
// ROUTES — SUBMIT INDIVIDUAL
// ============================================================
app.post('/api/submit/individual', submitLimiter, async (req, res) => {
  try {
    console.log('[Submit Individual] Received request');
    const { full_name, email, phone, skill_category, about_yourself } = req.body;

    if (!full_name?.trim())
      return res.status(400).json({ error: 'Full name is required.' });
    if (!email || !validator.isEmail(email))
      return res.status(400).json({ error: 'A valid email is required.' });
    if (!skill_category?.trim())
      return res.status(400).json({ error: 'Please select your skill.' });
    if (!about_yourself || about_yourself.trim().length < 20)
      return res.status(400).json({ error: 'Please tell us more about yourself (min 20 characters).' });

    const submission = {
      type:           'skilled_individual',
      full_name:      sanitize(full_name),
      email:          validator.normalizeEmail(email),
      phone:          phone ? sanitize(phone) : null,
      skill_category: sanitize(skill_category),
      about_yourself: sanitize(about_yourself),
      ip_address:     req.ip,
      user_agent:     req.headers['user-agent'] || null
    };

    const { data, error } = await supabase.from('submissions').insert(submission).select().single();
    if (error) {
      console.error('[DB]', error);
      return res.status(500).json({ error: 'Failed to save. Please try again.' });
    }

    console.log('[Submit Individual] Saved to DB, firing notifications...');
    // AWAIT notifications before responding — Vercel cuts off after response
    const notifResults = await Promise.allSettled([
      sendDiscordNotification(data),
      sendTeamEmail(data),
      sendConfirmationEmail(data)
    ]);
    notifResults.forEach((r, i) => {
      const name = ['Discord','Email-Team','Email-Confirm'][i];
      console.log(`[${name}]`, r.status === 'fulfilled' ? 'sent ✅' : 'failed: ' + r.reason?.message);
    });

    return res.status(201).json({
      success: true,
      message: "Application received! We'll reach out within 48 hours.",
      id:      data.id
    });
  } catch (e) {
    console.error('[Submit Individual]', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ============================================================
// ROUTES — SUBMIT PARTNER
// ============================================================
app.post('/api/submit/partner', submitLimiter, async (req, res) => {
  try {
    const { full_name, email, phone, business_name, division_interest, opportunity_desc } = req.body;

    if (!full_name?.trim())
      return res.status(400).json({ error: 'Full name is required.' });
    if (!email || !validator.isEmail(email))
      return res.status(400).json({ error: 'A valid email is required.' });
    if (!business_name?.trim())
      return res.status(400).json({ error: 'Business name is required.' });
    if (!division_interest?.trim())
      return res.status(400).json({ error: 'Please select a division.' });
    if (!opportunity_desc || opportunity_desc.trim().length < 20)
      return res.status(400).json({ error: 'Please describe the opportunity (min 20 characters).' });

    const submission = {
      type:              'business_partner',
      full_name:         sanitize(full_name),
      email:             validator.normalizeEmail(email),
      phone:             phone ? sanitize(phone) : null,
      business_name:     sanitize(business_name),
      division_interest: sanitize(division_interest),
      opportunity_desc:  sanitize(opportunity_desc),
      ip_address:        req.ip,
      user_agent:        req.headers['user-agent'] || null
    };

    const { data, error } = await supabase.from('submissions').insert(submission).select().single();
    if (error) {
      console.error('[DB]', error);
      return res.status(500).json({ error: 'Failed to save. Please try again.' });
    }

    // AWAIT notifications before responding — Vercel cuts off after response
    const notifResults2 = await Promise.allSettled([
      sendDiscordNotification(data),
      sendTeamEmail(data),
      sendConfirmationEmail(data)
    ]);
    notifResults2.forEach((r, i) => {
      const name = ['Discord','Email-Team','Email-Confirm'][i];
      console.log(`[${name}]`, r.status === 'fulfilled' ? 'sent ✅' : 'failed: ' + r.reason?.message);
    });

    return res.status(201).json({
      success: true,
      message: "Partnership inquiry received! We'll reach out within 48 hours.",
      id:      data.id
    });
  } catch (e) {
    console.error('[Submit Partner]', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ============================================================
// ROUTES — AUTH
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase().trim(), password
    });

    if (authError || !authData?.user)
      return res.status(401).json({ error: 'Invalid email or password.' });

    const { data: adminUser, error: adminError } = await supabase
      .from('admin_users').select('*').eq('email', email.toLowerCase().trim()).single();

    if (adminError || !adminUser)
      return res.status(401).json({ error: 'Account not found. Contact Jose.' });
    if (!adminUser.is_active)
      return res.status(403).json({ error: 'Account deactivated. Contact Jose.' });

    await supabase.from('admin_users')
      .update({ last_login: new Date().toISOString() }).eq('id', adminUser.id);

    await supabase.from('audit_logs').insert({
      admin_id: adminUser.id, admin_name: adminUser.name,
      action: 'LOGIN', details: { ip: req.ip }
    });

    const token = jwt.sign(
      { id: adminUser.id, name: adminUser.name, email: adminUser.email, role: adminUser.role },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({ success: true, token, user: { id: adminUser.id, name: adminUser.name, email: adminUser.email, role: adminUser.role } });
  } catch (e) {
    console.error('[Auth Login]', e);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await supabase.from('audit_logs').insert({
    admin_id: req.user.id, admin_name: req.user.name, action: 'LOGOUT'
  }).catch(() => {});
  return res.json({ success: true });
});

// ============================================================
// ROUTES — ADMIN STATS
// ============================================================
app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const [
      { count: total }, { count: newCount },
      { count: individuals }, { count: partners }, { count: accepted }
    ] = await Promise.all([
      supabase.from('submissions').select('*', { count: 'exact', head: true }),
      supabase.from('submissions').select('*', { count: 'exact', head: true }).eq('status', 'new'),
      supabase.from('submissions').select('*', { count: 'exact', head: true }).eq('type', 'skilled_individual'),
      supabase.from('submissions').select('*', { count: 'exact', head: true }).eq('type', 'business_partner'),
      supabase.from('submissions').select('*', { count: 'exact', head: true }).eq('status', 'accepted')
    ]);
    return res.json({ total, new: newCount, individuals, partners, accepted });
  } catch (e) { return res.status(500).json({ error: 'Failed to fetch stats.' }); }
});

// ============================================================
// ROUTES — ADMIN SUBMISSIONS
// ============================================================
app.get('/api/admin/submissions/export/csv', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('submissions').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const headers = ['id','type','full_name','email','phone','skill_category','about_yourself','business_name','division_interest','opportunity_desc','status','created_at'];
    const rows    = data.map(row => headers.map(h => `"${String(row[h] ?? '').replace(/"/g,'""')}"`).join(','));
    const csv     = [headers.join(','), ...rows].join('\n');
    await supabase.from('audit_logs').insert({ admin_id: req.user.id, admin_name: req.user.name, action: 'EXPORT_CSV', details: { count: data.length } });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="team-submissions-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (e) { return res.status(500).json({ error: 'Failed to export.' }); }
});

app.get('/api/admin/submissions/:id', requireAuth, async (req, res) => {
  try {
    const [{ data: sub, error: subErr }, { data: notes }] = await Promise.all([
      supabase.from('submissions').select('*').eq('id', req.params.id).single(),
      supabase.from('admin_notes').select('*').eq('submission_id', req.params.id).order('created_at', { ascending: true })
    ]);
    if (subErr) return res.status(404).json({ error: 'Submission not found.' });
    return res.json({ submission: sub, notes: notes || [] });
  } catch (e) { return res.status(500).json({ error: 'Failed to fetch.' }); }
});

app.get('/api/admin/submissions', requireAuth, async (req, res) => {
  try {
    const { type, status, search, page = 1, limit = 20 } = req.query;
    let query = supabase.from('submissions').select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (type)   query = query.eq('type', type);
    if (status) query = query.eq('status', status);
    if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,business_name.ilike.%${search}%`);
    const { data, error, count } = await query;
    if (error) throw error;
    return res.json({ submissions: data, total: count, page: Number(page), pages: Math.ceil(count / limit) });
  } catch (e) { return res.status(500).json({ error: 'Failed to fetch submissions.' }); }
});

app.patch('/api/admin/submissions/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['new','reviewed','contacted','accepted','rejected'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const { data, error } = await supabase.from('submissions').update({ status }).eq('id', req.params.id).select().single();
    if (error) throw error;
    await supabase.from('audit_logs').insert({ admin_id: req.user.id, admin_name: req.user.name, action: 'UPDATE_STATUS', target_id: req.params.id, details: { new_status: status } });
    return res.json({ success: true, submission: data });
  } catch (e) { return res.status(500).json({ error: 'Failed to update status.' }); }
});

app.delete('/api/admin/submissions/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('submissions').delete().eq('id', req.params.id);
    if (error) throw error;
    await supabase.from('audit_logs').insert({ admin_id: req.user.id, admin_name: req.user.name, action: 'DELETE_SUBMISSION', target_id: req.params.id });
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ error: 'Failed to delete.' }); }
});

// ============================================================
// ROUTES — ADMIN NOTES
// ============================================================
app.post('/api/admin/notes', requireAuth, async (req, res) => {
  try {
    const { submission_id, note } = req.body;
    if (!submission_id) return res.status(400).json({ error: 'submission_id required.' });
    if (!note?.trim())  return res.status(400).json({ error: 'Note cannot be empty.' });
    const { data, error } = await supabase.from('admin_notes')
      .insert({ submission_id, admin_id: req.user.id, admin_name: req.user.name, note: note.trim() })
      .select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, note: data });
  } catch (e) { return res.status(500).json({ error: 'Failed to add note.' }); }
});

// ============================================================
// ROUTES — ADMIN USERS (super admin only)
// ============================================================
app.get('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('admin_users')
      .select('id, name, email, role, is_active, last_login, created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return res.json({ users: data });
  } catch (e) { return res.status(500).json({ error: 'Failed to fetch users.' }); }
});

app.patch('/api/admin/users/:id/toggle', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { data: user } = await supabase.from('admin_users').select('is_active, name').eq('id', req.params.id).single();
    const { data, error } = await supabase.from('admin_users').update({ is_active: !user.is_active }).eq('id', req.params.id).select().single();
    if (error) throw error;
    await supabase.from('audit_logs').insert({ admin_id: req.user.id, admin_name: req.user.name, action: data.is_active ? 'ACTIVATE_USER' : 'DEACTIVATE_USER', target_id: req.params.id, details: { target_name: user.name } });
    return res.json({ success: true, user: data });
  } catch (e) { return res.status(500).json({ error: 'Failed.' }); }
});

// ============================================================
// ROUTES — AUDIT LOGS (super admin only)
// ============================================================
app.get('/api/admin/logs', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const { data, error, count } = await supabase.from('audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (error) throw error;
    return res.json({ logs: data, total: count });
  } catch (e) { return res.status(500).json({ error: 'Failed to fetch logs.' }); }
});

// ============================================================
// ERROR HANDLERS
// ============================================================

// ── TEST ENDPOINT — remove after debugging ──
app.get('/api/test-discord', async (req, res) => {
  const testSub = {
    type: 'skilled_individual',
    full_name: 'Test User',
    email: 'test@test.com',
    phone: '09123456789',
    skill_category: 'Web / App Development',
    about_yourself: 'This is a test notification from TEAM | ProjectOneUSA API'
  };
  try {
    console.log('[Test] Firing Discord notification...');
    await sendDiscordNotification(testSub);
    console.log('[Test] Firing team email...');
    await sendTeamEmail(testSub);
    return res.json({ success: true, message: 'Test notifications fired — check Discord and email.' });
  } catch (err) {
    console.error('[Test] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message });
});

app.listen(PORT, () => console.log(`✅ TEAM | ProjectOneUSA API running on port ${PORT}`));
module.exports = app;
