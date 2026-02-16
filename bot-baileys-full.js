// bot-baileys-full.js
// نظام واتساب متكامل: عزل تلقائي للمستخدمين (Auto-Isolation)، متعدد الحسابات
// Multi-User (UUID Based), Multi-Device WhatsApp Bot

const express = require('express');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const {
 default: makeWASocket,
 useMultiFileAuthState,
 fetchLatestBaileysVersion,
 DisconnectReason,
 delay
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

// --- إعدادات التخزين ---
// الهيكل: data_store/{UUID}/{accountId}/auth
const DATA_DIR = path.join(__dirname, 'data_store');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// تخزين الذاكرة الحية (RAM)
// sessions[userId][accountId] = { sock, qr, broadcast: {...} }
const sessions = {};

// --- دوال مساعدة لإدارة الملفات ---

function getUserDir(userId) {
   // التأكد من أن اسم المجلد آمن (فقط حروف وأرقام)
   const safeId = userId.replace(/[^a-zA-Z0-9-]/g, '');
   const dir = path.join(DATA_DIR, safeId);
   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
   return dir;
}

function getAccountDir(userId, accountId) {
   const dir = path.join(getUserDir(userId), 'sessions', accountId);
   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
   return dir;
}

// حفظ واسترجاع الحسابات
function saveUserAccounts(userId, accountsList) {
   const p = path.join(getUserDir(userId), 'accounts.json');
   fs.writeFileSync(p, JSON.stringify(accountsList, null, 2));
}

function loadUserAccounts(userId) {
   const p = path.join(getUserDir(userId), 'accounts.json');
   if (!fs.existsSync(p)) return [];
   try { return JSON.parse(fs.readFileSync(p)); } catch { return []; }
}

// حفظ واسترجاع التصنيفات
function loadCategories(userId) {
   const p = path.join(getUserDir(userId), 'categories.json');
   if (!fs.existsSync(p)) return { definitions: [], assignments: {} };
   try { return JSON.parse(fs.readFileSync(p)); } catch { return { definitions: [], assignments: {} }; }
}

function saveCategories(userId, data) {
   const p = path.join(getUserDir(userId), 'categories.json');
   fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// تهيئة الجلسة في الذاكرة
function initSessionMemory(userId, accountId) {
   if (!sessions[userId]) sessions[userId] = {};
   if (!sessions[userId][accountId]) {
       sessions[userId][accountId] = {
           sock: null,
           qr: null,
           broadcast: {
               isRunning: false,
               targetJids: [],
               currentIndex: 0,
               message: '',
               interval: 5
           }
       };
   }
   return sessions[userId][accountId];
}

// --- منطق الاتصال (Baileys Logic) ---

async function startBaileys(userId, accountId) {
   const session = initSessionMemory(userId, accountId);
   const authPath = path.join(getAccountDir(userId, accountId), 'auth_state');
   
   // إنشاء المجلد إذا لم يوجد
   if(!fs.existsSync(authPath)) fs.mkdirSync(authPath, {recursive: true});

   const { state, saveCreds } = await useMultiFileAuthState(authPath);
   const { version } = await fetchLatestBaileysVersion();

   const sock = makeWASocket({
       auth: state,
       printQRInTerminal: false,
       version,
       browser: ["WhatsApp Bot", "Chrome", "1.0"],
       connectTimeoutMs: 60000,
       syncFullHistory: false
   });

   session.sock = sock;

   sock.ev.on('creds.update', saveCreds);

   sock.ev.on('connection.update', async (update) => {
       const { connection, lastDisconnect, qr } = update;

       if (qr) {
           session.qr = await qrcode.toDataURL(qr);
       }

       if (connection === 'open') {
           session.qr = null;
           console.log(`[User:${userId.substr(0,5)}..][Acc:${accountId}] Connected ✅`);
       }

       if (connection === 'close') {
           const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
           session.qr = null;
           session.sock = null;

           if (shouldReconnect) {
               startBaileys(userId, accountId);
           } else {
               console.log(`[User:${userId}][Acc:${accountId}] Logged Out / Session Destroyed`);
           }
       }
   });

   return sock;
}

// حلقة النشر (Broadcast Loop)
async function runBroadcastLoop(userId, accountId) {
   const session = sessions[userId]?.[accountId];
   if (!session || !session.broadcast.isRunning || !session.sock) return;

   const b = session.broadcast;

   // التحقق من الانتهاء
   if (b.currentIndex >= b.targetJids.length) {
       b.isRunning = false;
       b.currentIndex = 0;
       b.targetJids = [];
       return;
   }

   const targetJid = b.targetJids[b.currentIndex];

   try {
       await session.sock.sendMessage(targetJid, { text: b.message });
       console.log(`[User:${userId}][Acc:${accountId}] Broadcast -> ${targetJid}`);
   } catch (e) {
       console.error(`[User:${userId}][Acc:${accountId}] Failed -> ${targetJid}`);
   }

   b.currentIndex++;

   if (b.isRunning) {
       // استخدام الفاصل الزمني المحدد من المستخدم
       const waitTime = (b.interval || 5) * 1000;
       setTimeout(() => runBroadcastLoop(userId, accountId), waitTime);
   }
}


// --- API Endpoints ---

// Middleware: التحقق من وجود معرف المستخدم
const checkUser = (req, res, next) => {
   const userId = req.headers['x-user-id'] || req.query.user || req.body.user;
   if (!userId) return res.status(400).json({ error: 'System Error: No User ID' });
   req.userId = userId;
   next();
};

// 1. إدارة الحسابات
app.get('/api/accounts', checkUser, (req, res) => {
   const accounts = loadUserAccounts(req.userId);
   res.json(accounts);
});

app.post('/api/accounts/add', checkUser, (req, res) => {
   const { name } = req.body;
   const accountId = 'acc_' + Math.random().toString(36).substr(2, 6);
   
   const accounts = loadUserAccounts(req.userId);
   accounts.push({ id: accountId, name: name || `حساب ${accounts.length + 1}` });
   saveUserAccounts(req.userId, accounts);
   
   // بدء الجلسة للحصول على QR
   startBaileys(req.userId, accountId);
   
   res.json({ success: true, accountId });
});

app.post('/api/accounts/delete', checkUser, (req, res) => {
   const { accountId } = req.body;
   let accounts = loadUserAccounts(req.userId);
   accounts = accounts.filter(a => a.id !== accountId);
   saveUserAccounts(req.userId, accounts);

   // إغلاق الاتصال وحذف الملفات
   if (sessions[req.userId]?.[accountId]?.sock) {
       sessions[req.userId][accountId].sock.end(undefined);
       delete sessions[req.userId][accountId];
   }
   const dir = getAccountDir(req.userId, accountId);
   fs.rmSync(dir, { recursive: true, force: true });

   res.json({ success: true });
});

// 2. حالة الاتصال (Status)
app.get('/api/status', checkUser, async (req, res) => {
   const accounts = loadUserAccounts(req.userId);
   const result = {};

   for (const acc of accounts) {
       let session = sessions[req.userId]?.[acc.id];
       
       // إعادة تهيئة الجلسة إذا كانت الخادم أعاد التشغيل
       if (!session) {
           startBaileys(req.userId, acc.id);
           session = initSessionMemory(req.userId, acc.id);
       }

       result[acc.id] = {
           name: acc.name,
           connected: !!session.sock?.user,
           qr: session.qr,
           broadcast: {
               isRunning: session.broadcast.isRunning,
               progress: session.broadcast.currentIndex,
               total: session.broadcast.targetJids.length
           }
       };
   }
   res.json(result);
});

// 3. التصنيفات
app.get('/api/categories', checkUser, (req, res) => {
   const data = loadCategories(req.userId);
   res.json(data.definitions);
});

app.post('/api/categories', checkUser, (req, res) => {
   const { action, name, color, id } = req.body;
   const data = loadCategories(req.userId);

   if (action === 'create') {
       data.definitions.push({ id: Math.random().toString(36).substr(2, 9), name, color });
   } else if (action === 'delete') {
       data.definitions = data.definitions.filter(c => c.id !== id);
       for (const [key, val] of Object.entries(data.assignments)) {
           if (val === id) delete data.assignments[key];
       }
   }
   saveCategories(req.userId, data);
   res.json({ success: true, categories: data.definitions });
});

// 4. المجموعات
app.get('/api/groups', checkUser, async (req, res) => {
   const { accountId } = req.query; // يمكن أن يكون 'all' أو معرف حساب محدد
   const accounts = loadUserAccounts(req.userId);
   const catData = loadCategories(req.userId);
   
   let allGroups = [];
   const targetAccounts = (accountId === 'all') ? accounts : accounts.filter(a => a.id === accountId);

   for (const acc of targetAccounts) {
       const session = sessions[req.userId]?.[acc.id];
       if (session?.sock?.user) {
           try {
               const list = await session.sock.groupFetchAllParticipating();
               const groups = Object.values(list).map(g => {
                   const assignedCatId = catData.assignments[g.id];
                   const catDef = catData.definitions.find(c => c.id === assignedCatId);
                   return {
                       jid: g.id,
                       subject: g.subject,
                       accountId: acc.id,
                       accountName: acc.name,
                       categoryId: assignedCatId || null,
                       categoryColor: catDef ? catDef.color : '#e0e0e0',
                       categoryName: catDef ? catDef.name : 'غير مصنف'
                   };
               });
               allGroups = allGroups.concat(groups);
           } catch (e) {
               // قد يكون الاتصال غير جاهز بعد
           }
       }
   }
   res.json(allGroups);
});

app.post('/api/assign-group', checkUser, (req, res) => {
   const { groupJid, categoryId } = req.body;
   const data = loadCategories(req.userId);

   if (categoryId) {
       const count = Object.values(data.assignments).filter(id => id === categoryId).length;
       if (count >= 300) return res.status(400).json({ error: 'الحد الأقصى للتصنيف هو 300 مجموعة' });
       data.assignments[groupJid] = categoryId;
   } else {
       delete data.assignments[groupJid];
   }

   saveCategories(req.userId, data);
   res.json({ success: true });
});

// 5. النشر (Broadcast)
app.post('/api/broadcast/start', checkUser, async (req, res) => {
   const { message, interval, targetAccount, targetType, selectedCategories } = req.body;
   
   if (!message) return res.status(400).json({ error: 'الرسالة فارغة' });

   const accountsList = loadUserAccounts(req.userId);
   const catData = loadCategories(req.userId);
   
   const activeAccounts = (targetAccount === 'all')
       ? accountsList
       : accountsList.filter(a => a.id === targetAccount);

   let startedCount = 0;

   for (const acc of activeAccounts) {
       const session = sessions[req.userId]?.[acc.id];
       if (session?.sock?.user) {
           const groupsMap = await session.sock.groupFetchAllParticipating();
           const allJids = Object.keys(groupsMap);
           let finalJids = [];

           if (targetType === 'all_groups') {
               finalJids = allJids;
           } else {
               finalJids = allJids.filter(jid => {
                   const assigned = catData.assignments[jid];
                   return assigned && selectedCategories.includes(assigned);
               });
           }

           if (finalJids.length > 0) {
               session.broadcast = {
                   isRunning: true,
                   message,
                   interval: parseInt(interval) || 5, // الفاصل الزمني المخصص
                   targetJids: finalJids,
                   currentIndex: 0
               };
               runBroadcastLoop(req.userId, acc.id);
               startedCount++;
           }
       }
   }

   if (startedCount === 0) return res.status(400).json({ error: 'لم يتم البدء. تأكد من الاتصال ووجود مجموعات.' });
   res.json({ success: true, accountsActivated: startedCount });
});

app.post('/api/broadcast/stop', checkUser, (req, res) => {
   const { targetAccount } = req.body;
   const accounts = loadUserAccounts(req.userId);
   const targets = (targetAccount === 'all') ? accounts : accounts.filter(a => a.id === targetAccount);

   targets.forEach(acc => {
       if (sessions[req.userId]?.[acc.id]) {
           sessions[req.userId][acc.id].broadcast.isRunning = false;
       }
   });

   res.json({ success: true });
});

// --- الواجهة الأمامية (HTML Dashboard) ---
app.get('/', (req, res) => {
   res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
   <meta charset="UTF-8">
   <meta name="viewport" content="width=device-width, initial-scale=1.0">
   <title>واتساب بوت - نظام المجموعات</title>
   <style>
       :root { --primary: #00a884; --dark: #111b21; --bg: #e9edef; --white: #fff; }
       body { font-family: 'Segoe UI', sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #333; }
       .container { max-width: 1200px; margin: 0 auto; background: var(--white); padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
       
       /* Tabs */
       .tabs { display: flex; border-bottom: 2px solid #ddd; margin-bottom: 25px; }
       .tab { padding: 12px 25px; cursor: pointer; font-weight: bold; color: #666; border-bottom: 4px solid transparent; transition: 0.3s; }
       .tab:hover { background: #f5f5f5; }
       .tab.active { border-bottom-color: var(--primary); color: var(--primary); }
       .tab-content { display: none; animation: fadeIn 0.3s; }
       .tab-content.active { display: block; }
       @keyframes fadeIn { from {opacity:0} to {opacity:1} }

       /* Grid System */
       .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
       .card { border: 1px solid #eee; padding: 20px; border-radius: 10px; background: #fafafa; position: relative; }
       .account-card { border-top: 5px solid var(--primary); background: #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
       
       /* UI Elements */
       input, select, textarea { width: 100%; padding: 10px; margin: 8px 0; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
       .btn { padding: 10px 20px; background: var(--primary); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; }
       .btn:hover { opacity: 0.9; }
       .btn-danger { background: #dc3545; }
       .btn-outline { background: transparent; border: 1px solid var(--primary); color: var(--primary); }
       
       .badge { padding: 4px 10px; border-radius: 15px; font-size: 0.85em; color: white; display: inline-block; }
       .online { background: #28a745; }
       .offline { background: #dc3545; }

       /* Tables */
       table { width: 100%; border-collapse: collapse; margin-top: 10px; }
       th, td { padding: 12px; text-align: right; border-bottom: 1px solid #eee; }
       th { background: #f8f9fa; }

       /* Loader */
       .loader { border: 3px solid #f3f3f3; border-top: 3px solid var(--primary); border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; display:inline-block; vertical-align:middle; }
       @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
   </style>
</head>
<body>

<div class="container">
   <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
       <div>
           <h2 style="margin:0; color:var(--dark);">🤖 لوحة التحكم الذكية</h2>
           <small style="color:#777;">نظام إدارة واتساب المتعدد</small>
       </div>
       <div>
           <span class="badge" style="background:#666;" id="userIdDisplay">جاري التحميل...</span>
           <button class="btn btn-outline" style="padding:5px 10px; font-size:0.8em;" onclick="resetSession()">تسجيل خروج (جلسة جديدة)</button>
       </div>
   </div>

   <div class="tabs">
       <div class="tab active" onclick="switchTab('accounts')">📱 الحسابات المتصلة</div>
       <div class="tab" onclick="switchTab('categories')">🗂️ التصنيفات</div>
       <div class="tab" onclick="switchTab('groups')">👥 إدارة المجموعات</div>
       <div class="tab" onclick="switchTab('broadcast')">📢 النشر الجماعي</div>
   </div>

   <!-- 1. تبويب الحسابات -->
   <div id="accounts" class="tab-content active">
       <div class="card" style="margin-bottom: 25px; border: 1px dashed #ccc;">
           <h3>➕ إضافة رقم واتساب جديد</h3>
           <div style="display:flex; gap:10px;">
               <input type="text" id="newAccName" placeholder="الاسم التعريفي (مثلاً: رقم خدمة العملاء)">
               <button class="btn" onclick="addAccount()">إنشاء وربط</button>
           </div>
       </div>
       <div id="accountsList" class="grid">
           <!-- سيتم ملؤه تلقائياً -->
       </div>
   </div>

   <!-- 2. تبويب التصنيفات -->
   <div id="categories" class="tab-content">
       <div class="card">
           <h3>إدارة التصنيفات</h3>
           <div style="display:flex; gap:10px; align-items:center;">
               <input type="text" id="catName" placeholder="اسم التصنيف (مثلاً: VIP)">
               <input type="color" id="catColor" value="#00a884" style="width:60px; height:40px; padding:0; border:none;">
               <button class="btn" onclick="addCategory()">إضافة</button>
           </div>
           <p style="font-size:0.85em; color:#e67e22;">⚠️ ملاحظة: كل تصنيف يمكنه احتواء 300 مجموعة كحد أقصى.</p>
       </div>
       <div id="categoriesGrid" class="grid" style="margin-top:20px;"></div>
   </div>

   <!-- 3. تبويب المجموعات -->
   <div id="groups" class="tab-content">
       <div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:15px;">
           <div style="display:flex; align-items:center; gap:10px;">
               <label>تصفية حسب الحساب:</label>
               <select id="groupsAccountFilter" onchange="loadGroups()" style="width:250px; margin:0;">
                   <option value="all">عرض مجموعات كل الحسابات</option>
               </select>
           </div>
           <button class="btn btn-outline" onclick="loadGroups()">🔄 تحديث القائمة</button>
       </div>
       
       <div style="max-height:600px; overflow-y:auto; border:1px solid #eee; border-radius:8px;">
           <table>
               <thead>
                   <tr>
                       <th>اسم المجموعة</th>
                       <th>الحساب المرتبط</th>
                       <th>التصنيف</th>
                       <th>إجراءات</th>
                   </tr>
               </thead>
               <tbody id="groupsTableBody">
                   <tr><td colspan="4" style="text-align:center;">جاري التحميل...</td></tr>
               </tbody>
           </table>
       </div>
       <p style="text-align:left; color:#666;">إجمالي المجموعات: <span id="groupsCount" style="font-weight:bold;">0</span></p>
   </div>

   <!-- 4. تبويب النشر -->
   <div id="broadcast" class="tab-content">
       <div class="grid">
           <div class="card">
               <h3>1️⃣ مصدر النشر</h3>
               <label>اختر الحساب المرسل:</label>
               <select id="broadcastAccountSelect">
                   <option value="all">🚀 كل الحسابات (نشر متزامن)</option>
               </select>
               <p style="font-size:0.8em; color:#666;">عند اختيار "كل الحسابات"، سيقوم كل رقم بالنشر للمجموعات الخاصة به.</p>
           </div>

           <div class="card">
               <h3>2️⃣ الجمهور المستهدف</h3>
               <div style="margin-bottom:10px;">
                   <label style="cursor:pointer;"><input type="radio" name="target" value="all_groups" checked onchange="toggleCats(false)"> إرسال للكل</label>
                   <label style="cursor:pointer; margin-right:15px;"><input type="radio" name="target" value="selected_cats" onchange="toggleCats(true)"> تصنيفات محددة</label>
               </div>
               
               <div id="broadcastCatsList" style="display:none; background:#fff; border:1px solid #ddd; padding:10px; border-radius:6px; max-height:200px; overflow-y:auto;">
                   <!-- Checkboxes -->
               </div>
           </div>

           <div class="card" style="grid-column: 1 / -1;">
               <h3>3️⃣ المحتوى والإعدادات</h3>
               <textarea id="broadcastMsg" rows="5" placeholder="اكتب نص الرسالة هنا..."></textarea>
               
               <div style="display:flex; align-items:center; gap:15px; margin-top:10px; background:#f9f9f9; padding:10px; border-radius:6px;">
                   <label>⏱️ الفاصل الزمني (ثواني):</label>
                   <input type="number" id="broadcastInterval" value="5" min="1" style="width:100px; margin:0;">
                   <span style="font-size:0.85em; color:#666;">الانتظار بين كل رسالة وأخرى لتجنب الحظر.</span>
               </div>

               <div style="margin-top:20px; display:flex; gap:15px;">
                   <button class="btn" style="flex:2; font-size:1.1em;" onclick="startBroadcast()">🚀 بدء الحملة الآن</button>
                   <button class="btn btn-danger" style="flex:1;" onclick="stopBroadcast()">⏹️ إيقاف</button>
               </div>
           </div>
       </div>
   </div>
</div>

<script>
   // --- User Isolation Logic (Client Side) ---
   // هذا الكود يضمن أن كل متصفح يحصل على معرف فريد خاص به
   function getUserId() {
       let id = localStorage.getItem('wa_bot_uuid');
       if (!id) {
           // توليد معرف فريد عشوائي
           id = 'user_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
           localStorage.setItem('wa_bot_uuid', id);
       }
       return id;
   }

   const userId = getUserId();
   document.getElementById('userIdDisplay').textContent = 'ID: ' + userId.substr(0, 8) + '...';

   function resetSession() {
       if(confirm('هل أنت متأكد؟ سيتم إنشاء معرف مستخدم جديد وإخفاء الحسابات الحالية (لن تحذف من الخادم، لكن لن تظهر لك).')) {
           localStorage.removeItem('wa_bot_uuid');
           location.reload();
       }
   }

   // --- Core Variables ---
   let categoriesList = [];
   let accountsList = [];

   // --- API Helper ---
   async function api(endpoint, method='GET', body=null) {
       const opts = {
           method,
           headers: {
               'Content-Type': 'application/json',
               'x-user-id': userId // إرسال المعرف في الهيدر
           }
       };
       if(body) {
           body.user = userId; // Fallback
           opts.body = JSON.stringify(body);
       }
       
       const url = endpoint + (endpoint.includes('?') ? '&' : '?') + 'user=' + userId;
       try {
           const res = await fetch(url, opts);
           return await res.json();
       } catch(e) {
           console.error(e);
           return { error: 'Connection Error' };
       }
   }

   // --- Tabs ---
   function switchTab(t) {
       document.querySelectorAll('.tab').forEach(e => e.classList.remove('active'));
       document.querySelectorAll('.tab-content').forEach(e => e.classList.remove('active'));
       
       document.querySelector('.tab[onclick="switchTab(\\''+t+'\\')"]').classList.add('active');
       document.getElementById(t).classList.add('active');
       
       if(t === 'groups') loadGroups();
   }

   // --- Init ---
   async function init() {
       await Promise.all([refreshAccounts(), refreshCategories()]);
       startStatusLoop();
   }

   // --- Accounts Functions ---
   async function addAccount() {
       const name = document.getElementById('newAccName').value;
       if(!name) return alert('يرجى كتابة اسم للحساب');
       
       const res = await api('/api/accounts/add', 'POST', { name });
       if(res.success) {
           document.getElementById('newAccName').value = '';
           refreshAccounts();
       }
   }

   async function deleteAccount(id) {
       if(confirm('هل أنت متأكد من حذف هذا الحساب؟ ستفقد الاتصال به.')) {
           await api('/api/accounts/delete', 'POST', { accountId: id });
           refreshAccounts();
       }
   }

   async function refreshAccounts() {
       accountsList = await api('/api/accounts');
       renderAccountSelects();
       // Trigger status update immediately
       const statusMap = await api('/api/status');
       renderAccountsGrid(statusMap);
   }

   // --- Realtime Status ---
   function startStatusLoop() {
       setInterval(async () => {
           const statusMap = await api('/api/status');
           renderAccountsGrid(statusMap);
       }, 4000);
   }

   function renderAccountsGrid(statusMap) {
       const container = document.getElementById('accountsList');
       if(accountsList.length === 0) {
           container.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#999; padding:20px;">لا توجد حسابات مضافة. ابدأ بإضافة حساب جديد.</div>';
           return;
       }

       container.innerHTML = accountsList.map(acc => {
           const st = statusMap[acc.id] || { connected: false };
           const isBroadcasting = st.broadcast?.isRunning;
           
           return \`
           <div class="card account-card">
               <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                   <h3 style="margin:0; font-size:1.1em;">\${acc.name}</h3>
                   <span class="badge \${st.connected ? 'online' : 'offline'}">\${st.connected ? 'متصل' : 'غير متصل'}</span>
               </div>
               
               \${!st.connected && st.qr ? \`
                   <div style="text-align:center; padding:10px; background:#f9f9f9; border-radius:8px;">
                       <img src="\${st.qr}" width="180" style="mix-blend-mode: multiply;">
                       <p style="margin:5px 0; font-size:0.9em; color:#555;">امسح الرمز للربط</p>
                   </div>
               \` : ''}
               
               \${st.connected ? \`<div style="text-align:center; padding:15px; color:#28a745;">✅ الحساب نشط وجاهز للعمل</div>\` : ''}

               \${isBroadcasting ? \`
                   <div style="margin-top:15px; background:#e3f2fd; padding:10px; border-radius:6px; font-size:0.9em;">
                       <strong>جاري النشر...</strong>
                       <div style="display:flex; justify-content:space-between; margin-top:5px;">
                           <span>التقدم: \${st.broadcast.progress}</span>
                           <span>العدد الكلي: \${st.broadcast.total}</span>
                       </div>
                       <div style="background:#ccc; height:6px; border-radius:3px; margin-top:5px; overflow:hidden;">
                           <div style="background:#2196f3; height:100%; width:\${(st.broadcast.progress/st.broadcast.total)*100}%"></div>
                       </div>
                   </div>
               \` : ''}
               
               <button class="btn btn-danger" style="width:100%; margin-top:15px; font-size:0.85em;" onclick="deleteAccount('\${acc.id}')">حذف الحساب</button>
           </div>
           \`;
       }).join('');
   }

   function renderAccountSelects() {
       const groupsFilter = document.getElementById('groupsAccountFilter');
       const broadcastSelect = document.getElementById('broadcastAccountSelect');
       
       const optionsHTML = '<option value="all">الكل (جميع الحسابات)</option>' +
           accountsList.map(a => \`<option value="\${a.id}">\${a.name}</option>\`).join('');
           
       // Only update if changes occurred to prevent UI flickering
       if(groupsFilter.children.length !== accountsList.length + 1) {
           groupsFilter.innerHTML = optionsHTML;
           broadcastSelect.innerHTML = optionsHTML;
       }
   }

   // --- Categories ---
   async function addCategory() {
       const name = document.getElementById('catName').value;
       const color = document.getElementById('catColor').value;
       if(!name) return;
       
       await api('/api/categories', 'POST', { action: 'create', name, color });
       document.getElementById('catName').value = '';
       refreshCategories();
   }

   async function deleteCategory(id) {
       if(confirm('حذف التصنيف؟ (ستبقى المجموعات لكن بدون تصنيف)')) {
           await api('/api/categories', 'POST', { action: 'delete', id });
           refreshCategories();
       }
   }

   async function refreshCategories() {
       categoriesList = await api('/api/categories');
       const grid = document.getElementById('categoriesGrid');
       
       if(categoriesList.length === 0) {
           grid.innerHTML = '<p style="color:#777;">لا توجد تصنيفات.</p>';
       } else {
           grid.innerHTML = categoriesList.map(c => \`
               <div class="card" style="border-left: 6px solid \${c.color}; display:flex; justify-content:space-between; align-items:center;">
                   <span style="font-weight:bold; font-size:1.1em;">\${c.name}</span>
                   <button class="btn btn-danger" style="padding:5px 10px;" onclick="deleteCategory('\${c.id}')">X</button>
               </div>
           \`).join('');
       }

       // Update Broadcast Checkboxes
       const bList = document.getElementById('broadcastCatsList');
       bList.innerHTML = categoriesList.map(c => \`
           <label style="display:flex; align-items:center; padding:8px; border-bottom:1px solid #eee;">
               <input type="checkbox" value="\${c.id}" class="bc-cat-chk" style="width:auto; margin-left:10px;">
               <span style="width:15px; height:15px; background:\${c.color}; border-radius:50%; margin-left:10px; display:inline-block;"></span>
               \${c.name}
           </label>
       \`).join('');
   }

   // --- Groups ---
   async function loadGroups() {
       const accId = document.getElementById('groupsAccountFilter').value;
       const tbody = document.getElementById('groupsTableBody');
       tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;"><div class="loader"></div> جاري الجلب...</td></tr>';
       
       const groups = await api('/api/groups?accountId=' + accId);
       document.getElementById('groupsCount').textContent = groups.length;

       if(groups.length === 0) {
           tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">لا توجد مجموعات. تأكد من اتصال الحسابات.</td></tr>';
           return;
       }
       
       let catOptions = '<option value="">-- بدون تصنيف --</option>';
       categoriesList.forEach(c => catOptions += \`<option value="\${c.id}">\${c.name}</option>\`);

       tbody.innerHTML = groups.map(g => \`
           <tr>
               <td style="font-weight:bold;">\${g.subject}</td>
               <td><span style="background:#eee; padding:2px 8px; border-radius:4px; font-size:0.9em;">\${g.accountName}</span></td>
               <td><span style="color:\${g.categoryColor}; font-weight:bold;">● \${g.categoryName}</span></td>
               <td>
                   <select onchange="assignGroup('\${g.jid}', this.value)" style="padding:5px; width:150px;">
                       \${catOptions.replace(\`value="\${g.categoryId}"\`, \`value="\${g.categoryId}" selected\`)}
                   </select>
               </td>
           </tr>
       \`).join('');
   }

   async function assignGroup(jid, catId) {
       const res = await api('/api/assign-group', 'POST', { groupJid: jid, categoryId: catId });
       if(!res.success) {
           alert(res.error || 'خطأ غير معروف');
           loadGroups(); // Revert
       }
   }

   // --- Broadcast ---
   function toggleCats(show) {
       document.getElementById('broadcastCatsList').style.display = show ? 'block' : 'none';
   }

   async function startBroadcast() {
       const account = document.getElementById('broadcastAccountSelect').value;
       const targetType = document.querySelector('input[name="target"]:checked').value;
       const message = document.getElementById('broadcastMsg').value;
       const interval = document.getElementById('broadcastInterval').value;

       let cats = [];
       if(targetType === 'selected_cats') {
           document.querySelectorAll('.bc-cat-chk:checked').forEach(c => cats.push(c.value));
           if(cats.length === 0) return alert('⚠️ اختر تصنيفاً واحداً على الأقل!');
       }

       const res = await api('/api/broadcast/start', 'POST', {
           targetAccount: account,
           targetType,
           message,
           interval,
           selectedCategories: cats
       });

       if(res.success) {
           alert(\`✅ تم بدء الحملة بنجاح على \${res.accountsActivated} حسابات\`);
           switchTab('accounts'); // Go to status to see progress
       } else {
           alert('❌ خطأ: ' + res.error);
       }
   }

   async function stopBroadcast() {
       const account = document.getElementById('broadcastAccountSelect').value;
       await api('/api/broadcast/stop', 'POST', { targetAccount: account });
       alert('تم إرسال أمر الإيقاف.');
   }

   // تشغيل النظام
   init();

</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
   console.log(`🚀 Server started on port ${PORT}`);
});


