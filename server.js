require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Stripe = require('stripe');
const Database = require('better-sqlite3');
const http = require('http');
const { exec } = require('child_process');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Database setup
const db = new Database(path.join(__dirname, 'data', 'app.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    stripe_customer_id TEXT,
    subscription_status TEXT DEFAULT 'inactive',
    subscription_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    filename TEXT NOT NULL,
    version TEXT DEFAULT '1.0',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Multer for admin uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// Middleware: require login
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// Middleware: require active subscription
function requireSubscription(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.subscription_status !== 'active') {
    return res.redirect('/dashboard?need_sub=1');
  }
  req.user = user;
  next();
}

// Home
app.get('/', (req, res) => {
  const tools = db.prepare("SELECT * FROM tools").all();
  res.render('index', { 
    loggedIn: !!req.session.userId,
    tools,
    price: '1.99'
  });
});

// Register
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.render('register', { error: 'Email and password (min 6 chars) required' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email.toLowerCase(), hash);
    req.session.userId = result.lastInsertRowid;
    res.redirect('/dashboard');
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.render('register', { error: 'Email already registered' });
    }
    res.render('register', { error: 'Registration failed' });
  }
});

// Login
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.render('login', { error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const tools = db.prepare('SELECT * FROM tools ORDER BY updated_at DESC').all();
  res.render('dashboard', { 
    user, 
    tools, 
    needSub: req.query.need_sub,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    priceId: process.env.STRIPE_PRICE_ID
  });
});

// Create Stripe Checkout session
app.post('/create-checkout-session', requireLogin, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    let customerId = user.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id.toString() }
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/dashboard`,
      metadata: { userId: user.id.toString() }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Success page
app.get('/success', requireLogin, (req, res) => {
  res.render('success');
});

// Download tool (protected)
app.get('/download/:id', requireSubscription, (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).send('Tool not found');
  const filePath = path.join(__dirname, 'uploads', tool.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');
  res.download(filePath, tool.name.replace(/\s+/g, '-') + '-' + tool.version + path.extname(tool.filename));
});

// Stripe webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.userId;
    const subscriptionId = session.subscription;
    db.prepare('UPDATE users SET subscription_status = ?, subscription_id = ? WHERE id = ?')
      .run('active', subscriptionId, userId);
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const status = sub.status === 'active' ? 'active' : 'inactive';
    db.prepare('UPDATE users SET subscription_status = ? WHERE subscription_id = ?')
      .run(status, sub.id);
  }

  res.json({ received: true });
});

// Admin routes
app.get('/admin', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin/dashboard');
  }
  res.render('admin-login', { error: 'Wrong password' });
});

app.get('/admin/dashboard', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  const tools = db.prepare('SELECT * FROM tools ORDER BY id DESC').all();
  res.render('admin', { tools });
});

app.post('/admin/upload', upload.single('file'), (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Forbidden');
  const { name, description, version } = req.body;
  if (!req.file || !name) return res.redirect('/admin/dashboard?error=missing');
  db.prepare('INSERT INTO tools (name, description, filename, version) VALUES (?, ?, ?, ?)')
    .run(name, description || '', req.file.filename, version || '1.0');
  res.redirect('/admin/dashboard');
});

app.post('/admin/delete/:id', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).send('Forbidden');
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (tool) {
    const filePath = path.join(__dirname, 'uploads', tool.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM tools WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/dashboard');
});

// PDF 翻译页面（需登录）
app.get('/pdf-tool', requireLogin, (req, res) => {
  res.render('pdf-tool');
});

// PDF 翻译 API（需登录）
app.post('/api/pdf-translate', requireLogin, upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'No file uploaded' });

  const { type, from, to } = req.body;
  const inputPath = req.file.path;
  const outputDir = path.join(__dirname, 'uploads', 'translated');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const cmd = `docker exec pdf2zh pdf2zh "/app/${path.basename(inputPath)}" -li ${from} -lo ${to} -s google`;
  
  exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(stderr || error);
      return res.json({ success: false, error: 'Translation failed' });
    }
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const resultName = type === 'mono' ? baseName + '-mono.pdf' : baseName + '-dual.pdf';
    res.json({ 
      success: true, 
      downloadUrl: '/download-translated/' + resultName
    });
  });
});

// 下载翻译后的文件
app.get('/download-translated/:filename', requireLogin, (req, res) => {
  const filePath = path.join(__dirname, 'uploads', 'translated', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Office Tools Pro running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
});
